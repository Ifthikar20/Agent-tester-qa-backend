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
  layout: 'layout', content: 'words', logic: 'what it does', elements: 'elements', alignment: 'alignment',
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
export function evaluate(spec, baseline, snapshot, opts = {}) {
  if (spec && spec.kind === 'page') return evaluatePage(spec, baseline, snapshot, opts);
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
export function diff(baseline, snapshot, spec = null, { strict = false } = {}) {
  const out = {};
  if (!baseline || !snapshot) return out;
  if (isPageSnapshot(baseline) && isPageSnapshot(snapshot)) return { pageChanges: diffPage(baseline, snapshot, { tolerance: spec?.tolerance, ignore: spec?.ignore, strict }) };
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

/**
 * The live numbers a monitor card shows. For the whole page, `page` is what
 * the last evaluation forgave or anticipated (monitor.js: `{ scrolled,
 * viewport }`), so the card can say a scroll was ignored or a reading at
 * another width is compared with care.
 */
export function summarize(snap, page = null) {
  if (!snap || !snap.exists) return { exists: false };
  if (snap.kind === 'page') {
    return {
      exists: true, visible: true, kind: 'page', blocks: snap.counts?.blocks ?? (Array.isArray(snap.blocks) ? snap.blocks.length : null),
      fontSize: null, width: fmt(metric(snap, 'width')), height: fmt(metric(snap, 'height')), rowCount: null, textLength: metric(snap, 'textLength'), childElementCount: null,
      scrolled: page?.scrolled ?? null, viewport: page?.viewport ?? null,
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
/**
 * What a page rule can be about — the five questions a diff of two page
 * snapshots answers: what the page DOES (`logic`: a link, a form or a control
 * that now points or behaves differently), which ELEMENTS it has (a control or
 * a box added, removed or renamed), its CONTENT (words reworded, appeared or
 * gone), its LAYOUT (a block moved or resized past the tolerance — anything
 * added or removed counts too) and its ALIGNMENT (a block that now overlaps
 * another, runs past the page's edge or sits off the canvas). "Nothing on the
 * page may change" asks the first, second, third and fifth; the fourth is for
 * a rule that names it, with its pixel tolerance.
 */
export const PAGE_METRICS = ['logic', 'elements', 'content', 'layout', 'alignment'];
/** The questions still asked of a reading taken at another viewport width, where hidden blocks and geometry are a responsive layout's own business. */
export const RESPONSIVE_METRICS = ['logic', 'content'];

/** The two categories that read positions, and so mean nothing across a baseline taken before positions were measured in page space. */
export const GEOMETRY_METRICS = ['layout', 'alignment'];

/** Said once, when a monitor made before that change takes its first reading after it. */
export const UPGRADED_NOTE = 'the baseline was measured before positions were taken in page space, so this reading becomes the new baseline';
export const isPageSnapshot = (s) => !!s && s.kind === 'page' && Array.isArray(s.blocks);
const BOX_TAGS = new Set(['nav', 'main', 'header', 'footer', 'aside', 'section', 'article', 'form', 'table', 'dialog']);

const brief = (b) => ({ k: b.k, t: b.t, id: b.id || null, text: b.text ?? null, x: b.x, y: b.y, w: b.w, h: b.h, ...(b.c ? { c: 1 } : {}) });
const hasWords = (b) => typeof b.text === 'string' && b.text.length > 0;
const isControl = (b) => !!b && b.c === 1;
/** A block whose coming or going changes what a test can find: a control, or a box that arranges things. */
const isElement = (b) => isControl(b) || BOX_TAGS.has(b && b.t);
const tolOf = (t) => (Number.isFinite(Number(t)) && Number(t) >= 0 ? Number(t) : PAGE_TOLERANCE_PX);
const reword = (a, b) => ({ k: a.k, t: b.t, id: b.id || null, before: a.text ?? '', after: b.text ?? '' });

/**
 * The blocks that are no longer where things fit: one that now overlaps a
 * block it did not overlap before (never one it sits in or that sits in it —
 * the `p` chain — and never a fixed one, whose place is the viewport's), one
 * pushed past the document's width, one off the canvas altogether. Matched
 * blocks only: a block that appeared is the elements' or the content's
 * business, and two blocks that overlapped in the baseline are the design.
 */
function misalignments(pairs, baseline, snapshot, tol) {
  const free = pairs.filter(([a, b]) => !a.f && !b.f);
  if (!free.length) return [];
  const chainIn = (map) => {
    const memo = new Map();
    return (b) => {
      let s = memo.get(b.k);
      if (s) return s;
      s = new Set();
      for (let cur = b, hops = 0; cur && cur.p && hops < 64; hops++) { s.add(cur.p); cur = map.get(cur.p); }
      memo.set(b.k, s);
      return s;
    };
  };
  const overlapsOf = (list, above) => {
    const out = new Set();
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) <= tol || Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) <= tol) continue;
        if (above(a).has(b.k) || above(b).has(a.k)) continue;
        out.add(a.k + '|' + b.k);
      }
    }
    return out;
  };
  const wasMap = new Map(free.map(([a]) => [a.k, a])), isMap = new Map(free.map(([, b]) => [b.k, b]));
  const before = overlapsOf([...wasMap.values()], chainIn(wasMap));
  const now = overlapsOf([...isMap.values()], chainIn(isMap));
  const out = [];
  const seen = new Set();
  for (const key of now) {
    if (before.has(key)) continue;
    const [k1, k2] = key.split('|');
    if (seen.has(k1)) continue;
    seen.add(k1);
    out.push({ ...brief(isMap.get(k1)), how: 'overlaps', with: brief(isMap.get(k2)) });
  }
  const docW = snapshot.rect ? snapshot.rect.w : null, docW0 = baseline.rect ? baseline.rect.w : null;
  const off = (x) => x.x + x.w < 0 || x.y + x.h < 0;
  const past = (x, w) => w != null && x.x + x.w > w + tol;
  for (const [a, b] of free) {
    if (seen.has(b.k)) continue;
    if (off(b) && !off(a)) { seen.add(b.k); out.push({ ...brief(b), how: 'off-canvas' }); }
    else if (past(b, docW) && !past(a, docW0)) { seen.add(b.k); out.push({ ...brief(b), how: 'clipped' }); }
  }
  return out;
}

/**
 * Two page snapshots, block by block, whole: what diffPage samples from and
 * what the engine learns volatility from. Before anything is bucketed, a
 * UNIFORM SHIFT is looked for — every block that is not fixed moved by the
 * same distance, nothing resized, nothing came or went — and taken out: that
 * is the page scrolled between the two readings (or slid by a smooth-scroll
 * library that moves a wrapper with a transform, which the capture's scroll
 * walk cannot see), not a page that changed. A partial shift — an inserted
 * banner pushes only what is below it — is not a scroll and stays.
 */
function comparePage(baseline, snapshot, tolerance, ignore) {
  const skip = new Set(Array.isArray(ignore) ? ignore : []);
  const tol = tolOf(tolerance);
  const was = new Map(), is = new Map();
  for (const b of baseline.blocks) if (b && b.k && !skip.has(b.k)) was.set(b.k, b);
  for (const b of snapshot.blocks) if (b && b.k && !skip.has(b.k)) is.set(b.k, b);
  const added = [], removed = [], pairs = [];
  for (const [k, b] of was) if (!is.has(k)) removed.push(b);
  for (const [k, b] of is) if (!was.has(k)) added.push(b);
  for (const [k, a] of was) { const b = is.get(k); if (b) pairs.push([a, b]); }
  // A fixed or sticky block is compared by size only: where it is depends on the scroll.
  const moves = pairs.map(([a, b]) => { const pinned = !!(a.f || b.f); return { a, b, pinned, dx: pinned ? 0 : b.x - a.x, dy: pinned ? 0 : b.y - a.y, dw: b.w - a.w, dh: b.h - a.h }; });
  let scrolled = null;
  const free = moves.filter((m) => !m.pinned);
  if (free.length && !added.length && !removed.length) {
    const sx = free[0].dx, sy = free[0].dy;
    const uniform = free.every((m) => Math.abs(m.dx - sx) <= tol && Math.abs(m.dy - sy) <= tol && Math.abs(m.dw) <= tol && Math.abs(m.dh) <= tol);
    if (uniform && (Math.abs(sx) > tol || Math.abs(sy) > tol)) {
      scrolled = { dx: Math.round(sx), dy: Math.round(sy) };
      for (const m of free) { m.dx -= sx; m.dy -= sy; }
    }
  }
  const moved = [], changed = [], renamed = [], logic = [];
  for (const m of moves) {
    const { a, b, dx, dy, dw, dh } = m;
    if (Math.abs(dx) > tol || Math.abs(dy) > tol || Math.abs(dw) > tol || Math.abs(dh) > tol) moved.push({ ...b, dx, dy, dw, dh });
    if ((a.th ?? a.text ?? null) !== (b.th ?? b.text ?? null)) (isControl(a) || isControl(b) ? renamed : changed).push(reword(a, b));
    // Only when both readings hashed what the block does: a baseline from before that was measured says nothing about it.
    if (a.lh != null && b.lh != null && a.lh !== b.lh) logic.push({ k: a.k, t: b.t, id: b.id || null, text: b.text ?? null, before: a.lp ?? '', after: b.lp ?? '' });
  }
  // Alignment is judged where the blocks would be had the page not scrolled: the shift taken out of every free block.
  const placed = scrolled ? moves.map((m) => [m.a, m.pinned ? m.b : { ...m.b, x: m.b.x - scrolled.dx, y: m.b.y - scrolled.dy }]) : pairs;
  const alignment = misalignments(placed, baseline, snapshot, tol);
  return { added, removed, moved, changed, renamed, logic, alignment, scrolled };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/** The sentence a reading at another width carries: what a responsive layout may do on purpose is said, never counted. */
function viewportNote(width, base, hidden, shown) {
  const head = `measured at ${width}px; the baseline is ${base}px: `;
  if (!hidden && !shown) return head + 'every block is still shown, re-flowed for this width';
  const parts = [];
  if (hidden) parts.push(`${plural(hidden, 'block is', 'blocks are')} not shown at this width`);
  if (shown) parts.push(`${plural(shown, 'block is', 'blocks are')} shown only here`);
  return head + parts.join(' and ') + ', which a responsive layout may do on purpose';
}

/**
 * diffPage(baseline, snapshot, { tolerance, ignore, strict }) -> what changed, by category.
 *
 * A uniform shift is forgiven first (`scrolled`, see comparePage). The rest is
 * bucketed five ways — `logic`, `elements`, `content`, `layout`, `alignment`,
 * each a boolean the evaluator reads, with exact `totals` and samples capped
 * at PAGE_SAMPLES — beside the raw buckets `added`, `removed`, `moved` and
 * `changed` a card has always drawn. `ignore` is the keys of blocks known to
 * change on their own (a ticker, a clock), learned when the monitor was made
 * (monitor.js), which are not news.
 *
 * A reading at another viewport width is anticipated responsive behaviour:
 * `viewport` says so, and only what the page does and what it says are still
 * counted — a block hidden at that width, a re-flow, a control that has no
 * room are what a responsive layout does on purpose. `strict` turns that off
 * (the judge read the re-flow as a regression, monitor.js): every category
 * counts, the note stays.
 */
export function diffPage(baseline, snapshot, { tolerance = PAGE_TOLERANCE_PX, ignore = [], strict = false } = {}) {
  const c = comparePage(baseline, snapshot, tolerance, ignore);
  const wa = baseline.env && baseline.env.innerWidth, wb = snapshot.env && snapshot.env.innerWidth;
  const otherWidth = !!(wa && wb && wa !== wb);
  const anticipated = otherWidth && !strict;
  // A baseline taken before positions were measured in page space (env.scroll
  // says whether they were) cannot be compared with one that is: every free
  // block differs by whatever the page was scrolled to when the baseline was
  // taken, which reads as the whole page having moved. What it says about
  // which blocks exist and what they say is still true, so only the two
  // geometry categories stand down, and monitor.js takes this reading as the
  // new baseline (upgraded) so the next one compares properly.
  const upgraded = !!(snapshot.env && snapshot.env.scroll && !(baseline.env && baseline.env.scroll));
  const addedEls = c.added.filter(isElement), removedEls = c.removed.filter(isElement);
  const addedWords = c.added.filter(hasWords), removedWords = c.removed.filter(hasWords);
  const zero = (n) => (anticipated ? 0 : n);
  const zeroGeo = (n) => (anticipated || upgraded ? 0 : n);
  const totals = {
    added: c.added.length, removed: c.removed.length, moved: c.moved.length, changed: c.changed.length,
    logic: c.logic.length,
    elements: zero(addedEls.length + removedEls.length + c.renamed.length),
    elementsAdded: zero(addedEls.length), elementsRemoved: zero(removedEls.length), elementsRenamed: zero(c.renamed.length),
    content: c.changed.length + zero(addedWords.length + removedWords.length),
    wordsAdded: zero(addedWords.length), wordsRemoved: zero(removedWords.length),
    layout: zeroGeo(c.added.length + c.removed.length + c.moved.length),
    alignment: zeroGeo(c.alignment.length),
  };
  const elementChanges = [
    ...addedEls.map((b) => ({ ...brief(b), how: 'added' })),
    ...removedEls.map((b) => ({ ...brief(b), how: 'removed' })),
    ...c.renamed.map((b) => ({ ...b, how: 'renamed' })),
  ].slice(0, PAGE_SAMPLES);
  return {
    kind: 'page', totals, blocks: [baseline.blocks.length, snapshot.blocks.length],
    scrolled: c.scrolled,
    upgraded: upgraded ? { note: UPGRADED_NOTE } : null,
    viewport: otherWidth ? { width: wb, baseline: wa, hidden: c.removed.length, shown: c.added.length, anticipated, note: viewportNote(wb, wa, c.removed.length, c.added.length) } : null,
    logic: totals.logic > 0, elements: totals.elements > 0, content: totals.content > 0, layout: totals.layout > 0, alignment: totals.alignment > 0,
    added: c.added.slice(0, PAGE_SAMPLES).map(brief),
    removed: c.removed.slice(0, PAGE_SAMPLES).map(brief),
    moved: c.moved.slice(0, PAGE_SAMPLES).map((b) => ({ ...brief(b), dx: b.dx, dy: b.dy, dw: b.dw, dh: b.dh })),
    changed: c.changed.slice(0, PAGE_SAMPLES),
    logicChanges: c.logic.slice(0, PAGE_SAMPLES),
    elementChanges,
    alignmentChanges: c.alignment.slice(0, PAGE_SAMPLES),
  };
}

/** The keys of every block that differs between two page snapshots — what a monitor learns to ignore from two readings of a page nobody touched. */
export function changedKeys(baseline, snapshot, { tolerance = PAGE_TOLERANCE_PX } = {}) {
  if (!isPageSnapshot(baseline) || !isPageSnapshot(snapshot)) return [];
  const { added, removed, moved, changed, renamed, logic } = comparePage(baseline, snapshot, tolerance, []);
  return [...new Set([...added, ...removed, ...moved, ...changed, ...renamed, ...logic].map((b) => b.k))];
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
/** `a “Blog” now points at /blog-2 instead of /blog` — what a block does now, against what it did. */
export function logicWords(b) {
  const name = blockName({ t: b.t, id: b.id, text: b.text });
  if (b.t === 'a' || b.t === 'form') {
    if (b.before === b.after) return name + ' now points somewhere else under ' + (b.after || 'the same path');
    return name + ' now points at ' + (b.after || 'nothing') + ' instead of ' + (b.before || 'nothing');
  }
  return name + ' is now ' + (b.after || 'plain') + ' (was ' + (b.before || 'plain') + ')';
}
/** `p “Every order…” now overlaps section#faq` — a block that is no longer where things fit. */
export function alignWords(b) {
  const name = blockName(b);
  if (b.how === 'overlaps') return name + ' now overlaps ' + blockName(b.with);
  if (b.how === 'clipped') return name + ' now runs past the page’s edge';
  return name + ' is now off the page';
}
const renameWords = (b) => blockName({ t: b.t, id: b.id, text: b.before }) + ' → “' + short(b.after) + '”';
/**
 * What changed, in one sentence fragment per category: "4 added (td “#10046”, …);
 * 9 moved (section#faq down 30px, …)" for the layout, "1 reworded (p “Every
 * order…” → “Every order… (copy changed…)”)" for the words, "1 does something
 * else (a “Blog” now points at /blog-2 instead of /blog)" for the logic, "1
 * removed (button “Create account”)" for the elements, "1 misaligned (section#b
 * now overlaps section#a)" for the alignment.
 */
export function describePageDiff(d, which = 'layout') {
  if (!d || d.kind !== 'page') return 'the page changed';
  const t = d.totals || {};
  const bits = [];
  const few = (list, total, f = blockName) => (list || []).slice(0, 3).map(f).join(', ') + ((total ?? (list || []).length) > 3 ? ', …' : '');
  if (which === 'content') {
    if (t.changed) bits.push(t.changed + ' reworded (' + few(d.changed, t.changed, renameWords) + ')');
    const addedWords = (d.added || []).filter(hasWords), removedWords = (d.removed || []).filter(hasWords);
    if (t.wordsAdded !== 0 && addedWords.length) bits.push('new words (' + few(addedWords, t.wordsAdded) + ')');
    if (t.wordsRemoved !== 0 && removedWords.length) bits.push('words gone (' + few(removedWords, t.wordsRemoved) + ')');
  } else if (which === 'logic') {
    if (t.logic) bits.push(t.logic + (t.logic === 1 ? ' does' : ' do') + ' something else (' + few(d.logicChanges, t.logic, logicWords) + ')');
  } else if (which === 'elements') {
    const by = (how) => (d.elementChanges || []).filter((b) => b.how === how);
    if (t.elementsAdded) bits.push(t.elementsAdded + ' added (' + few(by('added'), t.elementsAdded) + ')');
    if (t.elementsRemoved) bits.push(t.elementsRemoved + ' removed (' + few(by('removed'), t.elementsRemoved) + ')');
    if (t.elementsRenamed) bits.push(t.elementsRenamed + ' renamed (' + few(by('renamed'), t.elementsRenamed, renameWords) + ')');
  } else if (which === 'alignment') {
    if (t.alignment) bits.push(t.alignment + ' misaligned (' + few(d.alignmentChanges, t.alignment, alignWords) + ')');
  } else {
    if (t.added) bits.push(t.added + ' added (' + few(d.added, t.added) + ')');
    if (t.removed) bits.push(t.removed + ' removed (' + few(d.removed, t.removed) + ')');
    if (t.moved) bits.push(t.moved + ' moved or resized (' + few(d.moved, t.moved, (b) => blockName(b) + ' ' + moveWords(b)) + ')');
  }
  return bits.join('; ') || 'nothing measurable';
}
/** What a page diff forgave or anticipated, as sentences: a scroll between the readings, a reading at another width. */
export function pageNotes(d) {
  const out = [];
  if (d && d.scrolled) out.push('a scroll of ' + Math.max(Math.abs(d.scrolled.dx), Math.abs(d.scrolled.dy)) + 'px between readings was ignored');
  if (d && d.viewport && d.viewport.note) out.push(d.viewport.note);
  return out;
}

const PAGE_MISSING = { checkId: 'missing', metric: 'exists', op: 'exists', expected: 'present', actual: false, baseline: true, message: 'The page could not be measured.' };
const PAGE_EXPECTED = {
  logic: 'links, forms and controls doing what they did', elements: 'the same elements', content: 'the words as they were',
  layout: 'the layout as it was', alignment: 'nothing overlapping, clipped or off the page',
};
const PAGE_DEFAULT_MESSAGES = {
  logic: 'What the page does must not change', elements: 'The elements must not change', content: 'The words must not change',
  layout: 'The layout must not change', alignment: 'Nothing may overlap, clip or leave the page',
};
/**
 * A page rule, judged: each check is one of the five questions, and fails
 * when diffPage answers yes. At another viewport width only what the page
 * does and what it says are judged; the rest is skipped with the reason — a
 * page reflows at another width, and that is not a change anybody made —
 * unless `strict` says the re-flow itself is under question.
 */
export function evaluatePage(spec, baseline, snapshot, { strict = false } = {}) {
  const checks = Array.isArray(spec.checks) ? spec.checks : [];
  const violations = [];
  const skipped = [];
  if (!snapshot || !snapshot.exists) return { ok: false, missing: true, violations: [Object.assign({}, PAGE_MISSING)], skipped };
  if (!isPageSnapshot(baseline) || !isPageSnapshot(snapshot)) return { ok: true, missing: false, violations, skipped: checks.map((c) => ({ checkId: c.id, reason: 'no page snapshot to compare' })) };
  const d = diffPage(baseline, snapshot, { tolerance: spec.tolerance, ignore: spec.ignore, strict });
  for (const c of checks) {
    if (!PAGE_METRICS.includes(c.metric)) { skipped.push({ checkId: c.id, reason: 'not a page metric: ' + c.metric }); continue; }
    if (d.upgraded && GEOMETRY_METRICS.includes(c.metric)) { skipped.push({ checkId: c.id, reason: d.upgraded.note }); continue; }
    if (d.viewport && d.viewport.anticipated && !RESPONSIVE_METRICS.includes(c.metric)) { skipped.push({ checkId: c.id, reason: d.viewport.note }); continue; }
    if (!d[c.metric]) continue;
    violations.push({
      checkId: c.id, metric: c.metric, op: 'unchanged',
      expected: PAGE_EXPECTED[c.metric], actual: describePageDiff(d, c.metric), baseline: d.blocks[0] + ' blocks',
      message: c.message || PAGE_DEFAULT_MESSAGES[c.metric],
    });
  }
  return { ok: violations.length === 0, missing: false, violations, skipped, page: d };
}
