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

/** Only the metrics that changed between two snapshots: { fontSize: [16, 36], … }. */
export function diff(baseline, snapshot) {
  const out = {};
  if (!baseline || !snapshot) return out;
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
  return {
    exists: true, visible: !!snap.visible,
    fontSize: metric(snap, 'fontSize'), width: fmt(metric(snap, 'width')), height: fmt(metric(snap, 'height')),
    rowCount: metric(snap, 'rowCount'), textLength: metric(snap, 'textLength'), childElementCount: metric(snap, 'childElementCount'),
  };
}
