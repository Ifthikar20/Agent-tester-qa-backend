/**
 * Agentic monitoring — the deterministic half.
 *
 * A monitor's rule is compiled ONCE into a CheckSpec (monitor-rules.js, by the
 * mock compiler or by Claude), and from then on every change the page reports
 * is judged HERE, by arithmetic, with no model in the loop: metric out of the
 * snapshot, compare, tolerance, verdict. That is what makes an incident open
 * within a second of the change and makes the same change give the same
 * answer every time. Pure: no I/O, no timers, nothing read from the process.
 *
 * A snapshot is what the page agent (monitor/page/core.js `measure`) sends:
 * `{ exists, visible, rect, docRect, styles, metrics, text, textLength, counts,
 * htmlHash, … }`, or `{ exists: false }` when the element is gone.
 *
 * A monitor on the whole page (`:page`) reports a snapshot of BLOCKS instead
 * (core.js measurePage), and is judged by diffPage below: what was added,
 * what went, what moved, what was reworded — against a rule about the layout
 * or the words, never a number about one element.
 *
 * Ported as-is from the monitoring proof of concept's server/evaluate.js.
 */

export const METRICS = ['width', 'height', 'x', 'y', 'fontSize', 'lineHeight', 'fontWeight', 'color', 'backgroundColor', 'opacity',
  'visible', 'exists', 'text', 'textLength', 'childElementCount', 'rowCount', 'htmlHash'];
export const OPS = ['lte', 'gte', 'eq', 'neq', 'between', 'unchanged', 'contains', 'not_contains', 'exists', 'visible'];
export const NUMERIC_METRICS = new Set(['width', 'height', 'x', 'y', 'fontSize', 'lineHeight', 'fontWeight', 'opacity', 'textLength', 'childElementCount', 'rowCount']);
export const METRIC_LABELS = {
  width: 'width', height: 'height', x: 'horizontal position', y: 'vertical position', fontSize: 'font size', lineHeight: 'line height',
  fontWeight: 'font weight', color: 'text color', backgroundColor: 'background color', opacity: 'opacity', visible: 'visibility',
  exists: 'presence', text: 'text', textLength: 'text length', childElementCount: 'child count', rowCount: 'row count', htmlHash: 'markup',
  layout: 'layout', content: 'words',
};
export const METRIC_UNITS = { width: 'px', height: 'px', x: 'px', y: 'px', fontSize: 'px', lineHeight: 'px' };

function weightToNumber(w) {
  if (w == null) return null;
  if (typeof w === 'number') return w;
  const s = String(w).toLowerCase();
  if (s === 'normal') return 400;
  if (s === 'bold') return 700;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/** A check value ("20", "true", "Shipped") as a number, a boolean or a string. */
export function coerce(v) {
  if (v == null) return null;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  const s = String(v).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
  return s;
}

/** One metric out of a snapshot, or null when the snapshot cannot say. */
export function metric(snap, name) {
  if (!snap) return null;
  if (name === 'exists') return !!snap.exists;
  if (!snap.exists) return null;
  switch (name) {
    case 'width': return snap.rect ? snap.rect.w : null;
    case 'height': return snap.rect ? snap.rect.h : null;
    case 'x': return snap.docRect ? snap.docRect.x : null;
    case 'y': return snap.docRect ? snap.docRect.y : null;
    case 'fontSize': return snap.metrics ? snap.metrics.fontSizePx : null;
    case 'lineHeight': return snap.metrics ? snap.metrics.lineHeightPx : null;
    case 'opacity': return snap.metrics ? snap.metrics.opacity : null;
    case 'fontWeight': return weightToNumber(snap.styles && snap.styles.fontWeight);
    case 'color': return snap.styles ? snap.styles.color : null;
    case 'backgroundColor': return snap.styles ? snap.styles.backgroundColor : null;
    case 'visible': return !!snap.visible;
    case 'text': return snap.text == null ? null : snap.text;
    case 'textLength': return snap.textLength == null ? null : snap.textLength;
    case 'childElementCount': return snap.counts ? snap.counts.children : null;
    case 'rowCount': return snap.counts ? snap.counts.rows : null;
    case 'htmlHash': return snap.htmlHash == null ? null : snap.htmlHash;
    default: return null;
  }
}

export function defaultTolerance(check) {
  if (check.metric === 'opacity') return 0.01;
  if (!NUMERIC_METRICS.has(check.metric)) return 0;
  if (check.metric === 'rowCount' || check.metric === 'childElementCount') return 0;
  if (check.op === 'unchanged' || check.compareToBaseline) return 1;
  if (check.op === 'eq' || check.op === 'neq') return 0.5;
  return 0;
}

function fmt(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Math.round(v * 10) / 10;
  if (typeof v === 'string') return v.length > 80 ? v.slice(0, 77) + '…' : v;
  return v;
}
function unit(m) { return METRIC_UNITS[m] || ''; }

/** What a check expects, in words a violation can carry: "≤ 20px (baseline 16px + 4px)". */
export function describeExpected(c, base) {
  const u = unit(c.metric);
  const v = coerce(c.value);
  const rel = c.compareToBaseline && typeof base === 'number';
  const bound = (x) => (rel ? Math.round((base + Number(x)) * 10) / 10 : x);
  const relNote = (x) => (rel ? ' (baseline ' + fmt(base) + u + (Number(x) >= 0 ? ' + ' : ' − ') + Math.abs(Number(x)) + u + ')' : '');
  switch (c.op) {
    case 'lte': return '≤ ' + bound(v) + u + relNote(v);
    case 'gte': return '≥ ' + bound(v) + u + relNote(v);
    case 'eq': return '= ' + (typeof v === 'number' ? bound(v) + u : String(v)) + (typeof v === 'number' ? relNote(v) : '');
    case 'neq': return '≠ ' + String(v) + u;
    case 'between': return bound(c.min) + u + ' – ' + bound(c.max) + u;
    case 'unchanged': return 'unchanged from baseline ' + (base == null ? '' : fmt(base) + u);
    case 'contains': return 'contains "' + v + '"';
    case 'not_contains': return 'does not contain "' + v + '"';
    case 'exists': return v === false ? 'absent' : 'present';
    case 'visible': return v === false ? 'hidden' : 'visible';
    default: return c.op;
  }
}

const MISSING_VIOLATION = { checkId: 'missing', metric: 'exists', op: 'exists', expected: 'present', actual: false, baseline: true, message: 'The element is no longer on the page: the selector no longer matches anything.' };

/**
 * evaluate(spec, baseline, snapshot) -> { ok, missing, violations[], skipped[] }
 *
 * A missing element fails every rule except one that only asks for absence.
 * A check whose metric the snapshot cannot supply is skipped, not failed: a
 * row count on a paragraph is a rule that cannot be judged, not a broken page.
 */
export function evaluate(spec, baseline, snapshot) {
  if (spec && spec.kind === 'page') return evaluatePage(spec, baseline, snapshot);
  const checks = (spec && Array.isArray(spec.checks)) ? spec.checks : [];
  const violations = [];
  const skipped = [];
  if (!snapshot || !snapshot.exists) {
    const onlyAbsence = checks.length > 0 && checks.every((c) => c.op === 'exists' && coerce(c.value) === false);
    if (onlyAbsence) return { ok: true, missing: false, violations, skipped };
    return { ok: false, missing: true, violations: [Object.assign({}, MISSING_VIOLATION)], skipped };
  }
  for (const c of checks) {
    const actual = metric(snapshot, c.metric);
    const base = metric(baseline, c.metric);
    if (actual == null) { skipped.push({ checkId: c.id, reason: 'metric unavailable: ' + c.metric }); continue; }
    const isNum = typeof actual === 'number';
    const tol = c.tolerance != null ? Number(c.tolerance) : defaultTolerance(c);
    const rel = !!c.compareToBaseline && typeof base === 'number';
    const v = coerce(c.value);
    const bound = (x) => (rel ? base + Number(x) : Number(x));
    let pass = true;
    switch (c.op) {
      case 'lte': if (!isNum || typeof v !== 'number') { skipped.push({ checkId: c.id, reason: 'non-numeric comparison' }); continue; } pass = actual <= bound(v) + tol; break;
      case 'gte': if (!isNum || typeof v !== 'number') { skipped.push({ checkId: c.id, reason: 'non-numeric comparison' }); continue; } pass = actual >= bound(v) - tol; break;
      case 'between': if (!isNum || c.min == null || c.max == null) { skipped.push({ checkId: c.id, reason: 'between needs numeric min/max' }); continue; } pass = actual >= bound(c.min) - tol && actual <= bound(c.max) + tol; break;
      case 'eq': pass = isNum && typeof v === 'number' ? Math.abs(actual - bound(v)) <= tol : String(actual).toLowerCase() === String(v).toLowerCase(); break;
      case 'neq': pass = isNum && typeof v === 'number' ? Math.abs(actual - bound(v)) > tol : String(actual).toLowerCase() !== String(v).toLowerCase(); break;
      case 'unchanged':
        if (base == null) { skipped.push({ checkId: c.id, reason: 'no baseline for ' + c.metric }); continue; }
        pass = isNum && typeof base === 'number' ? Math.abs(actual - base) <= tol : actual === base;
        break;
      case 'contains': pass = String(actual).toLowerCase().includes(String(v == null ? '' : v).toLowerCase()); break;
      case 'not_contains': pass = !String(actual).toLowerCase().includes(String(v == null ? '' : v).toLowerCase()); break;
      case 'exists': pass = !!snapshot.exists === (v == null ? true : !!v); break;
      case 'visible': pass = !!snapshot.visible === (v == null ? true : !!v); break;
      default: skipped.push({ checkId: c.id, reason: 'unknown op ' + c.op }); continue;
    }
    if (!pass) {
      violations.push({ checkId: c.id, metric: c.metric, op: c.op, expected: describeExpected(c, base), actual: fmt(actual), baseline: fmt(base), message: c.message || (METRIC_LABELS[c.metric] + ' ' + c.op) });
    }
  }
  return { ok: violations.length === 0, missing: false, violations, skipped };
}

/** Only the metrics that changed between two snapshots: { fontSize: [16, 36], … } — or, for the whole page, { pageChanges } (diffPage). */
export function diff(baseline, snapshot, spec = null) {
  const out = {};
  if (!baseline || !snapshot) return out;
  if (isPageSnapshot(baseline) && isPageSnapshot(snapshot)) return { pageChanges: diffPage(baseline, snapshot, { tolerance: spec?.tolerance, ignore: spec?.ignore }) };
  if (!!baseline.exists !== !!snapshot.exists) out.exists = [!!baseline.exists, !!snapshot.exists];
  if (!baseline.exists || !snapshot.exists) return out;
  for (const m of METRICS) {
    if (m === 'exists') continue;
    const a = metric(baseline, m), b = metric(snapshot, m);
    if (a == null && b == null) continue;
    if (m === 'htmlHash') { if (a !== b) out.htmlChanged = true; continue; }
    if (typeof a === 'number' && typeof b === 'number') { if (Math.abs(a - b) > 0.5) out[m] = [fmt(a), fmt(b)]; continue; }
    if (a !== b) out[m] = [fmt(a), fmt(b)];
  }
  return out;
}

/** The live numbers a monitor card shows. */
export function summarize(snap) {
  if (!snap || !snap.exists) return { exists: false };
  if (snap.kind === 'page') {
    return {
      exists: true, visible: true, kind: 'page', blocks: snap.counts?.blocks ?? (Array.isArray(snap.blocks) ? snap.blocks.length : null),
      fontSize: null, width: fmt(metric(snap, 'width')), height: fmt(metric(snap, 'height')), rowCount: null, textLength: metric(snap, 'textLength'), childElementCount: null,
    };
  }
  return {
    exists: true, visible: !!snap.visible,
    fontSize: metric(snap, 'fontSize'), width: fmt(metric(snap, 'width')), height: fmt(metric(snap, 'height')),
    rowCount: metric(snap, 'rowCount'), textLength: metric(snap, 'textLength'), childElementCount: metric(snap, 'childElementCount'),
  };
}

// ---- the whole page ---------------------------------------------------------------
/** A move or a resize smaller than this, in px, is not a change: sub-pixel layout and a scrollbar's width are not news. */
export const PAGE_TOLERANCE_PX = 4;
/** How many of each kind of change an incident names; the totals are exact. */
export const PAGE_SAMPLES = 6;
/** What a page rule can be about: where things are, and what they say. */
export const PAGE_METRICS = ['layout', 'content'];
export const isPageSnapshot = (s) => !!s && s.kind === 'page' && Array.isArray(s.blocks);

const brief = (b) => ({ k: b.k, t: b.t, id: b.id || null, text: b.text ?? null, x: b.x, y: b.y, w: b.w, h: b.h });
const hasWords = (b) => typeof b.text === 'string' && b.text.length > 0;
const tolOf = (t) => (Number.isFinite(Number(t)) && Number(t) >= 0 ? Number(t) : PAGE_TOLERANCE_PX);

/** Two page snapshots, block by block, whole: what diffPage samples from and what the engine learns volatility from. */
function comparePage(baseline, snapshot, tolerance, ignore) {
  const skip = new Set(Array.isArray(ignore) ? ignore : []);
  const tol = tolOf(tolerance);
  const was = new Map(), is = new Map();
  for (const b of baseline.blocks) if (b && b.k && !skip.has(b.k)) was.set(b.k, b);
  for (const b of snapshot.blocks) if (b && b.k && !skip.has(b.k)) is.set(b.k, b);
  const added = [], removed = [], moved = [], changed = [];
  for (const [k, b] of was) if (!is.has(k)) removed.push(b);
  for (const [k, b] of is) if (!was.has(k)) added.push(b);
  for (const [k, a] of was) {
    const b = is.get(k);
    if (!b) continue;
    // A fixed or sticky block is compared by size only: where it is depends on the scroll.
    const pinned = a.f || b.f;
    const dx = pinned ? 0 : b.x - a.x, dy = pinned ? 0 : b.y - a.y, dw = b.w - a.w, dh = b.h - a.h;
    if (Math.abs(dx) > tol || Math.abs(dy) > tol || Math.abs(dw) > tol || Math.abs(dh) > tol) moved.push({ ...b, dx, dy, dw, dh });
    if ((a.th ?? a.text ?? null) !== (b.th ?? b.text ?? null)) changed.push({ k, t: b.t, id: b.id || null, before: a.text ?? '', after: b.text ?? '' });
  }
  return { added, removed, moved, changed };
}

/**
 * diffPage(baseline, snapshot, { tolerance, ignore }) -> what moved.
 *
 * The blocks that appeared, went, moved or were resized by more than
 * `tolerance`, or say something else — as totals, exact, and as samples,
 * capped at PAGE_SAMPLES each. `ignore` is the keys of blocks known to change
 * on their own (a ticker, a clock), learned when the monitor was made
 * (monitor.js), which are not news. `layout` and `content` are the two
 * questions a page rule asks, answered: words that appeared or went count
 * for both.
 */
export function diffPage(baseline, snapshot, { tolerance = PAGE_TOLERANCE_PX, ignore = [] } = {}) {
  const { added, removed, moved, changed } = comparePage(baseline, snapshot, tolerance, ignore);
  const totals = { added: added.length, removed: removed.length, moved: moved.length, changed: changed.length };
  return {
    kind: 'page', totals, blocks: [baseline.blocks.length, snapshot.blocks.length],
    layout: totals.added + totals.removed + totals.moved > 0,
    content: totals.changed + added.filter(hasWords).length + removed.filter(hasWords).length > 0,
    added: added.slice(0, PAGE_SAMPLES).map(brief),
    removed: removed.slice(0, PAGE_SAMPLES).map(brief),
    moved: moved.slice(0, PAGE_SAMPLES).map((b) => ({ ...brief(b), dx: b.dx, dy: b.dy, dw: b.dw, dh: b.dh })),
    changed: changed.slice(0, PAGE_SAMPLES),
  };
}

/** The keys of every block that differs between two page snapshots — what a monitor learns to ignore from two readings of a page nobody touched. */
export function changedKeys(baseline, snapshot, { tolerance = PAGE_TOLERANCE_PX } = {}) {
  if (!isPageSnapshot(baseline) || !isPageSnapshot(snapshot)) return [];
  const { added, removed, moved, changed } = comparePage(baseline, snapshot, tolerance, []);
  return [...new Set([...added, ...removed, ...moved, ...changed].map((b) => b.k))];
}

const short = (t, n = 40) => (typeof t === 'string' && t.length > n ? t.slice(0, n - 1) + '…' : (t ?? ''));
/** `section#orders "Orders"` — a block, named for a sentence. */
export function blockName(b) {
  if (!b) return 'a block';
  let s = String(b.t || 'block') + (b.id ? '#' + b.id : '');
  if (b.text) s += ' “' + short(b.text) + '”';
  return s;
}
/** `down 32px, 30px taller` — how a block moved. */
export function moveWords(b) {
  const out = [];
  if (b.dy) out.push((b.dy > 0 ? 'down ' : 'up ') + Math.abs(Math.round(b.dy)) + 'px');
  if (b.dx) out.push((b.dx > 0 ? 'right ' : 'left ') + Math.abs(Math.round(b.dx)) + 'px');
  if (b.dh) out.push(Math.abs(Math.round(b.dh)) + 'px ' + (b.dh > 0 ? 'taller' : 'shorter'));
  if (b.dw) out.push(Math.abs(Math.round(b.dw)) + 'px ' + (b.dw > 0 ? 'wider' : 'narrower'));
  return out.join(', ') || 'moved';
}
/**
 * What moved, in one sentence fragment: "4 added (td “#10046”, …); 9 moved
 * (section#faq down 30px, …)" for the layout, "1 reworded (p “Every order…” →
 * “Every order… (copy changed…)”)" for the words.
 */
export function describePageDiff(d, which = 'layout') {
  if (!d || d.kind !== 'page') return 'the page changed';
  const bits = [];
  const few = (list, f) => list.slice(0, 3).map(f).join(', ') + (list.length > 3 || (d.totals[list === d.added ? 'added' : list === d.removed ? 'removed' : list === d.moved ? 'moved' : 'changed'] > list.length) ? ', …' : '');
  if (which === 'content') {
    if (d.totals.changed) bits.push(d.totals.changed + ' reworded (' + few(d.changed, (b) => blockName({ t: b.t, id: b.id, text: b.before }) + ' → “' + short(b.after) + '”') + ')');
    const addedWords = d.added.filter(hasWords), removedWords = d.removed.filter(hasWords);
    if (addedWords.length) bits.push('new words (' + few(addedWords, blockName) + ')');
    if (removedWords.length) bits.push('words gone (' + few(removedWords, blockName) + ')');
  } else {
    if (d.totals.added) bits.push(d.totals.added + ' added (' + few(d.added, blockName) + ')');
    if (d.totals.removed) bits.push(d.totals.removed + ' removed (' + few(d.removed, blockName) + ')');
    if (d.totals.moved) bits.push(d.totals.moved + ' moved or resized (' + few(d.moved, (b) => blockName(b) + ' ' + moveWords(b)) + ')');
  }
  return bits.join('; ') || 'nothing measurable';
}

const PAGE_MISSING = { checkId: 'missing', metric: 'exists', op: 'exists', expected: 'present', actual: false, baseline: true, message: 'The page could not be measured.' };
/**
 * A page rule, judged: each check is one of the two questions, and fails
 * when diffPage answers yes. A snapshot taken at another viewport width is
 * skipped, not failed — a page reflows at another width, and that is not a
 * change anybody made.
 */
export function evaluatePage(spec, baseline, snapshot) {
  const checks = Array.isArray(spec.checks) ? spec.checks : [];
  const violations = [];
  const skipped = [];
  if (!snapshot || !snapshot.exists) return { ok: false, missing: true, violations: [Object.assign({}, PAGE_MISSING)], skipped };
  if (!isPageSnapshot(baseline) || !isPageSnapshot(snapshot)) return { ok: true, missing: false, violations, skipped: checks.map((c) => ({ checkId: c.id, reason: 'no page snapshot to compare' })) };
  const wa = baseline.env && baseline.env.innerWidth, wb = snapshot.env && snapshot.env.innerWidth;
  if (wa && wb && wa !== wb) return { ok: true, missing: false, violations, skipped: checks.map((c) => ({ checkId: c.id, reason: 'measured at another width (' + wb + 'px; the baseline is ' + wa + 'px)' })) };
  const d = diffPage(baseline, snapshot, { tolerance: spec.tolerance, ignore: spec.ignore });
  for (const c of checks) {
    if (!PAGE_METRICS.includes(c.metric)) { skipped.push({ checkId: c.id, reason: 'not a page metric: ' + c.metric }); continue; }
    if (!d[c.metric]) continue;
    violations.push({
      checkId: c.id, metric: c.metric, op: 'unchanged',
      expected: c.metric === 'layout' ? 'the layout as it was' : 'the words as they were',
      actual: describePageDiff(d, c.metric), baseline: d.blocks[0] + ' blocks',
      message: c.message || (c.metric === 'layout' ? 'The layout must not change' : 'The words must not change'),
    });
  }
  return { ok: violations.length === 0, missing: false, violations, skipped, page: d };
}
