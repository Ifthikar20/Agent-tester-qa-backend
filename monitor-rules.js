/**
 * Agentic monitoring — rules.
 *
 * A rule is a sentence a QA engineer types ("font size must not exceed 18px",
 * "must keep exactly 5 rows", "must always be visible"). It is compiled ONCE
 * into a CheckSpec that monitor-evaluate.js runs on every change the page
 * reports:
 *
 *   { summary, checks: [{ id, metric, op, value, min, max, tolerance,
 *     compareToBaseline, message }], needsLlmJudgment, judgmentHint, source }
 *
 * Two compilers produce that shape. The mock one below is regular expressions
 * over English: instant, offline, and what every deployment has — it
 * understands the phrasing README's table lists, and it is what a monitor runs
 * on from the moment it is created. Claude (monitor-resolver.js) understands
 * anything and resolves relative phrases against the baseline; its answer
 * replaces the mock's when it lands, and only after `checkSpec` has
 * re-validated it — a model's answer is data, the way heal treats a decision.
 * Verdicts are the same story: `judgeMock` writes the explanation an incident
 * opens with, and `checkVerdict` is the shape a model's has to pass.
 *
 * Ported from the monitoring proof of concept's server/rules.js, minus zod: the
 * closed JSON schemas the model is asked to fill live in monitor-resolver.js,
 * and the shape is enforced here by hand.
 */
import { METRICS, OPS, METRIC_LABELS, METRIC_UNITS, NUMERIC_METRICS, metric, coerce } from './monitor-evaluate.js';

export const SEVERITIES = ['low', 'medium', 'high'];

// ---- the shapes ---------------------------------------------------------------
function unitFor(m) { return METRIC_UNITS[m] || ''; }
function humanValue(m, v) {
  const c = coerce(v);
  if (typeof c === 'number') return c + unitFor(m);
  return String(c);
}
/** The sentence a check fails with when the compiler gave it none. */
export function defaultMessage(check) {
  const label = METRIC_LABELS[check.metric] || check.metric;
  const cap = label.charAt(0).toUpperCase() + label.slice(1);
  const rel = check.compareToBaseline ? ' relative to the baseline' : '';
  const v = check.value;
  switch (check.op) {
    case 'lte': return cap + ' must not exceed ' + humanValue(check.metric, v) + rel;
    case 'gte': return cap + ' must be at least ' + humanValue(check.metric, v) + rel;
    case 'eq': return cap + ' must be ' + humanValue(check.metric, v) + rel;
    case 'neq': return cap + ' must not be ' + humanValue(check.metric, v);
    case 'between': return cap + ' must stay between ' + check.min + unitFor(check.metric) + ' and ' + check.max + unitFor(check.metric) + rel;
    case 'unchanged': return cap + ' must not change';
    case 'contains': return cap + ' must contain "' + v + '"';
    case 'not_contains': return cap + ' must not contain "' + v + '"';
    case 'exists': return coerce(v) === false ? 'The element must not be present' : 'The element must stay present on the page';
    case 'visible': return coerce(v) === false ? 'The element must stay hidden' : 'The element must stay visible';
    default: return cap + ' ' + check.op;
  }
}
/**
 * Whatever a compiler produced, in the one shape the evaluator reads: unknown
 * metrics and operators dropped, ids made unique, values stringified, numbers
 * numbered, every check given a sentence.
 */
export function normalizeSpec(spec, source) {
  const out = { summary: String((spec && spec.summary) || '').slice(0, 160), checks: [], needsLlmJudgment: !!(spec && spec.needsLlmJudgment), judgmentHint: (spec && spec.judgmentHint) || null, source: source || 'unknown' };
  const seen = new Set();
  let n = 0;
  for (const raw of (spec && spec.checks) || []) {
    if (!raw || !METRICS.includes(raw.metric) || !OPS.includes(raw.op)) continue;
    n++;
    let id = raw.id && !seen.has(raw.id) ? String(raw.id) : 'c' + n;
    while (seen.has(id)) id = 'c' + (++n);
    seen.add(id);
    const check = {
      id, metric: raw.metric, op: raw.op,
      value: raw.value == null ? null : String(raw.value),
      min: raw.min == null ? null : Number(raw.min),
      max: raw.max == null ? null : Number(raw.max),
      tolerance: raw.tolerance == null ? null : Number(raw.tolerance),
      compareToBaseline: !!raw.compareToBaseline,
      message: '',
    };
    check.message = raw.message && String(raw.message).trim() ? String(raw.message).trim() : defaultMessage(check);
    out.checks.push(check);
  }
  if (!out.summary) out.summary = out.checks.map((c) => c.message).join('; ').slice(0, 160);
  if (typeof out.judgmentHint === 'string') out.judgmentHint = out.judgmentHint.slice(0, 500);
  return out;
}

/** A model's CheckSpec, believed only once it normalises to at least one check. */
export function checkSpec(parsed, source = 'claude') {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.checks)) return null;
  const spec = normalizeSpec(parsed, source);
  return spec.checks.length ? spec : null;
}

const VERDICT_TEXT_MAX = 2000;
const sentence = (v) => (typeof v === 'string' ? v.trim().slice(0, VERDICT_TEXT_MAX) : '');
/** A model's verdict, believed only in the shape the incident card draws. */
export function checkVerdict(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.violation !== 'boolean') return null;
  if (!SEVERITIES.includes(parsed.severity)) return null;
  const explanation = sentence(parsed.explanation);
  if (!explanation) return null;
  return {
    violation: parsed.violation, severity: parsed.severity, explanation,
  };
}

// ---- which mind -------------------------------------------------------------------
/**
 * GC_MONITOR_LLM: auto (the default — Claude when there is a key, the mock
 * compiler and judge otherwise), mock, or claude. A word the runner does not
 * know is an error the boot refuses on, never read as off: a typo would
 * otherwise turn off exactly what it was written to turn on.
 */
export function llmModeFrom({ env = process.env, haveKey = false } = {}) {
  const raw = env.GC_MONITOR_LLM ?? '';
  const word = String(raw).trim().toLowerCase();
  if (word && !['auto', 'mock', 'claude'].includes(word)) {
    return { mode: 'mock', reason: null, error: `GC_MONITOR_LLM is "${raw}"; it takes mock, claude or auto` };
  }
  if (word === 'mock') return { mode: 'mock', reason: 'forced', error: null };
  if (word === 'claude') return haveKey ? { mode: 'claude', reason: 'forced', error: null } : { mode: 'mock', reason: 'key', error: null };
  return haveKey ? { mode: 'claude', reason: null, error: null } : { mode: 'mock', reason: 'key', error: null };
}

// ---- small helpers the engine and the checks share ----------------------------------
/** The same document: origin and path, ignoring query, hash and a trailing slash. */
export function sameDoc(a, b) {
  if (!a || !b) return false;
  try { const ua = new URL(a), ub = new URL(b); return ua.origin === ub.origin && ua.pathname.replace(/\/+$/, '') === ub.pathname.replace(/\/+$/, ''); } catch { return a === b; }
}
/** A snapshot as an incident keeps it: the text cut to what a card can show. */
export function compactSnapshot(s) {
  if (!s) return null;
  const out = Object.assign({}, s);
  if (typeof out.text === 'string' && out.text.length > 500) out.text = out.text.slice(0, 500) + '…';
  return out;
}
/** Which checks are failing, as one string — so "the same failure" is a comparison. */
export function violationKey(res) {
  if (!res) return '';
  return res.missing ? 'missing' : res.violations.map((v) => v.checkId).sort().join(',');
}

// ---- the mock compiler -----------------------------------------------------------------
export const TEXTY_TAGS = new Set(['p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'li', 'td', 'th', 'label', 'button', 'small', 'strong', 'em', 'b', 'i', 'blockquote', 'summary', 'legend', 'caption', 'dt', 'dd']);

function detectMetrics(clause, element) {
  const c = clause;
  const found = [];
  const push = (m) => { if (!found.includes(m)) found.push(m); };
  if (/font[\s-]?size|text[\s-]?size|type[\s-]?size|size of (the |this )?(text|font|copy|type|heading|title|paragraph|label)|\bfont\b/.test(c)) push('fontSize');
  if (/line[\s-]?height|leading/.test(c)) push('lineHeight');
  if (/\b(bold|boldness|weight)\b/.test(c)) push('fontWeight');
  if (/\bbackground/.test(c)) push('backgroundColor');
  else if (/\bcolou?r\b/.test(c)) push('color');
  if (/\bopacity|transparen|faded?\b/.test(c)) push('opacity');
  if (/\b(tall|taller|height|high|higher)\b/.test(c)) push('height');
  if (/\b(wide|wider|width|narrow|narrower)\b/.test(c)) push('width');
  if (/\brows?\b/.test(c)) push('rowCount');
  if (/\b(children|child|items?|entries|options?|list items?|cards?|columns?)\b/.test(c) && !found.includes('rowCount')) push('childElementCount');
  if (/\b(visible|visibility|shown|displayed|display|appear|appears|hidden|invisible|hide|hides)\b/.test(c)) push('visible');
  if (/\b(exist|exists|present|presence|removed|deleted|missing|disappear|disappears|vanish|there)\b/.test(c)) push('exists');
  if (/\b(text|copy|wording|words|label|caption|content|say|says|read|reads|title)\b/.test(c) && !found.includes('fontSize')) push('text');
  if (/\b(position|positioned|move|moves|moved|shift|shifts|shifted|location|place|jump|jumps)\b/.test(c)) { push('x'); push('y'); }
  if (/\b(size|dimension|dimensions|big|bigger|small|smaller|large|larger|grow|grows|shrink|shrinks|expand|expands|resize)\b/.test(c) && !found.length) {
    const tag = element && element.tag;
    if (/\b(text|font|copy|paragraph|heading|title|label)\b/.test(c) || (TEXTY_TAGS.has(tag) && /\b(text|font)\b/.test(c))) push('fontSize');
    else { push('width'); push('height'); }
  }
  return found;
}

function firstNumber(s) {
  const m = s.match(/(-?\d+(?:\.\d+)?)\s*(px|pixels?|pt|%|rows?|items?|characters?|chars?)?/);
  return m ? { n: parseFloat(m[1]), unit: m[2] || '' } : null;
}
function quoted(s) {
  const m = s.match(/["“”']([^"“”']{1,120})["“”']/);
  return m ? m[1] : null;
}
function hasNegation(s) { return /\b(not|never|no longer|shouldn'?t|mustn'?t|can'?t|cannot|don'?t|doesn'?t|won'?t)\b/.test(s); }

/**
 * English → checks, by regular expression. The phrasing README's table lists
 * is what this understands; anything else falls back to "nothing may change"
 * with needsLlmJudgment set, which is honest about what it could not read.
 */
export function compileMock({ ruleText, element, baseline }) {
  const text = String(ruleText || '').toLowerCase().replace(/\s+/g, ' ').trim();
  // The rule is read in lower case, but a quoted phrase is compared as the
  // engineer wrote it — "Checkout" stays "Checkout" on the card.
  const caseOf = new Map();
  for (const m of String(ruleText || '').matchAll(/["“”']([^"“”']{1,120})["“”']/g)) caseOf.set(m[1].toLowerCase(), m[1]);
  const rawClauses = text.split(/\s*(?:;|,|\band\b|\balso\b|\bplus\b|\.)\s*/).map((s) => s.trim()).filter(Boolean);
  // A clause that only names a metric ("width" in "width and height must not change")
  // borrows the intent of the clause that follows it.
  const INTENT = /\b(not|never|no|exceed|change|changes|stay|stays|remain|remains|keep|keeps|must|should|be|is|are|within|under|over|least|most|more|less|than|same|unchanged|visible|hidden|contain|contains|say|says|between|by|grow|shrink|exact|exactly|above|below|max|min|maximum|minimum)\b|\d/;
  const clauses = [];
  for (let i = 0; i < rawClauses.length; i++) {
    const c = rawClauses[i];
    if (!INTENT.test(c) && i + 1 < rawClauses.length) rawClauses[i + 1] = c + ' ' + rawClauses[i + 1];
    else clauses.push(c);
  }
  const checks = [];
  let needsLlmJudgment = false;
  let lastMetrics = [];
  const addCheck = (check) => { checks.push(Object.assign({ id: 'c' + (checks.length + 1), value: null, min: null, max: null, tolerance: null, compareToBaseline: false, message: '' }, check)); };
  const baselineVal = (m) => metric(baseline, m);

  for (const clause of clauses) {
    let metrics = detectMetrics(clause, element);
    if (!metrics.length) metrics = lastMetrics;
    const numberInfo = firstNumber(clause);
    const q0 = quoted(clause);
    const q = q0 == null ? null : (caseOf.get(q0) ?? q0);
    const neg = hasNegation(clause);

    // "contains / says 'X'"
    if (q && /\b(contain|contains|include|includes|say|says|read|reads|show|shows|mention|mentions|display|displays)\b/.test(clause)) {
      addCheck({ metric: 'text', op: neg ? 'not_contains' : 'contains', value: q });
      lastMetrics = ['text'];
      continue;
    }
    // presence / visibility
    if (metrics.includes('visible') || metrics.includes('exists')) {
      const wantsHidden = /\b(hidden|invisible|not visible|not shown|not displayed|not appear|gone|absent|not exist|not be present|should disappear|must disappear)\b/.test(clause) && !/\b(never|not) (be )?(hidden|invisible)\b/.test(clause) && !/not (disappear|vanish|go missing|be removed)/.test(clause);
      if (wantsHidden) addCheck({ metric: 'visible', op: 'visible', value: 'false' });
      else { addCheck({ metric: 'exists', op: 'exists', value: 'true' }); addCheck({ metric: 'visible', op: 'visible', value: 'true' }); }
      lastMetrics = ['visible'];
      continue;
    }
    if (!metrics.length) {
      const target = (element && TEXTY_TAGS.has(element.tag)) ? ['fontSize', 'text', 'width', 'height'] : ['width', 'height', 'text'];
      if (numberInfo) metrics = [(element && TEXTY_TAGS.has(element.tag) && numberInfo.n < 100) ? 'fontSize' : 'height'];
      else { for (const m of target) addCheck({ metric: m, op: 'unchanged' }); needsLlmJudgment = true; lastMetrics = target; continue; }
    }
    // relative deltas: "not grow by more than 20px", "not change by more than 5px"
    const byMatch = clause.match(/\bby (?:more than |over |at most |up to )?(-?\d+(?:\.\d+)?)/);
    if (byMatch && metrics.some((m) => NUMERIC_METRICS.has(m))) {
      const d = parseFloat(byMatch[1]);
      for (const m of metrics) {
        if (!NUMERIC_METRICS.has(m)) continue;
        if (/\b(grow|increase|bigger|larger|taller|wider|expand|go up|rise)\b/.test(clause)) addCheck({ metric: m, op: 'lte', value: String(d), compareToBaseline: true });
        else if (/\b(shrink|decrease|smaller|narrower|shorter|go down|drop|fall)\b/.test(clause)) addCheck({ metric: m, op: 'gte', value: String(-d), compareToBaseline: true });
        else addCheck({ metric: m, op: 'unchanged', tolerance: d });
      }
      lastMetrics = metrics;
      continue;
    }
    if (numberInfo) {
      const between = clause.match(/between\s+(-?\d+(?:\.\d+)?)\s*(?:px|pixels?)?\s*(?:and|-|–|to)\s*(-?\d+(?:\.\d+)?)/);
      for (const m of metrics) {
        if (!NUMERIC_METRICS.has(m)) continue;
        if (between) { addCheck({ metric: m, op: 'between', min: parseFloat(between[1]), max: parseFloat(between[2]) }); continue; }
        const n = numberInfo.n;
        const isMax = /\b(not|never|no longer)\s+(exceed|go (over|above|beyond|past)|be (more|bigger|larger|taller|wider|higher|greater|longer) than|grow (beyond|past|over|above|to more than|larger than|bigger than|taller than|wider than)|surpass|pass)\b|\b(no more than|at most|maximum|max|under|below|less than|smaller than|up to|within|capped? at|not more than|cannot exceed|can'?t exceed|shouldn'?t exceed|mustn'?t exceed|not larger than|not bigger than|not taller than|not wider than|or less|or smaller|or lower)\b/.test(clause);
        const isMin = /\b(not|never)\s+(be (less|smaller|lower|shorter|narrower|fewer) than|go (under|below)|shrink (below|under|smaller than)|drop below|fall below)\b|\b(at least|minimum|min|more than|greater than|over|above|bigger than|larger than|taller than|wider than|or more|or larger|or bigger|not less than|not fewer than)\b/.test(clause);
        if (isMax && !isMin) addCheck({ metric: m, op: 'lte', value: String(n) });
        else if (isMin && !isMax) addCheck({ metric: m, op: 'gte', value: String(n) });
        else if (isMax && isMin) addCheck({ metric: m, op: 'lte', value: String(n) });
        else addCheck({ metric: m, op: 'eq', value: String(n), tolerance: m === 'rowCount' || m === 'childElementCount' ? 0 : null });
      }
      lastMetrics = metrics;
      continue;
    }
    // no number: stability rules
    const wantsUnchanged = neg || /\b(unchanged|same|constant|stable|as is|as-is|stay put|fixed|lock|locked|intact|remain|remains|keep|keeps|maintain|maintains|preserve|preserves)\b/.test(clause);
    for (const m of metrics) {
      if (m === 'x' || m === 'y' || wantsUnchanged || !NUMERIC_METRICS.has(m)) addCheck({ metric: m, op: 'unchanged' });
      else {
        // e.g. "font size should be bigger" — cannot be stated deterministically; keep it stable and flag for judgment
        addCheck({ metric: m, op: 'unchanged' });
        needsLlmJudgment = true;
      }
    }
    lastMetrics = metrics;
  }
  if (!checks.length) {
    for (const m of ['width', 'height', 'fontSize', 'text']) addCheck({ metric: m, op: 'unchanged' });
    needsLlmJudgment = true;
  }
  // Drop duplicates and unchanged checks whose baseline metric is unavailable (e.g. rowCount on a non-table).
  const seen = new Set();
  const usable = checks.filter((c) => {
    const key = [c.metric, c.op, c.value, c.min, c.max, c.compareToBaseline].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return c.op !== 'unchanged' || baselineVal(c.metric) != null;
  });
  return normalizeSpec({ summary: '', checks: usable.length ? usable : checks, needsLlmJudgment, judgmentHint: needsLlmJudgment ? ruleText : null }, 'mock');
}

// ---- the mock judge ------------------------------------------------------------------------
function pct(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number' || a === 0) return null;
  return Math.abs((b - a) / a);
}
/** The explanation an incident opens with — the numbers, in sentences, at once. */
export function judgeMock({ label, selector, ruleText, violations, diff }) {
  const v = (violations && violations[0]) || { metric: 'exists', message: 'The element changed', actual: null, expected: null, baseline: null };
  const others = Object.entries(diff || {}).filter(([k]) => k !== v.metric && k !== 'htmlChanged').slice(0, 4).map(([k, val]) => (Array.isArray(val) ? METRIC_LABELS[k] + ' ' + val[0] + ' → ' + val[1] : k));
  let severity = 'low';
  if (v.metric === 'exists' || v.metric === 'visible') severity = 'high';
  else {
    const change = pct(Number(v.baseline), Number(v.actual));
    if (change != null && change >= 0.5) severity = 'high';
    else if (change != null && change >= 0.2) severity = 'medium';
    else if (change == null) severity = 'medium';
  }
  const metricLabel = METRIC_LABELS[v.metric] || v.metric;
  const unit = METRIC_UNITS[v.metric] || '';
  let explanation = '"' + label + '" (' + selector + ') broke the rule "' + ruleText + '". ';
  if (v.metric === 'exists') explanation += 'The element can no longer be found on the page.';
  else if (v.metric === 'visible') explanation += 'The element is ' + (v.actual === false ? 'no longer visible' : 'visible although it should be hidden') + '.';
  else explanation += 'Its ' + metricLabel + ' is now ' + v.actual + unit + ' but the rule expects ' + v.expected + (v.baseline != null ? ' (baseline ' + v.baseline + unit + ')' : '') + '.';
  if (others.length) explanation += ' Side effects: ' + others.join(', ') + '.';
  if (violations && violations.length > 1) explanation += ' ' + (violations.length - 1) + ' other check' + (violations.length > 2 ? 's' : '') + ' failed as well.';
  return {
    violation: true, severity, explanation,
    source: 'mock', at: Date.now(),
  };
}
