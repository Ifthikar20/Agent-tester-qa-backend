/**
 * Agentic monitoring — rules.
 *
 * A rule is a sentence a QA engineer types ("font size must not exceed 18px",
 * "must keep exactly 5 rows", "must always be visible"). It is compiled ONCE
 * into a CheckSpec that monitor-evaluate.js runs on every change the page
 * reports:
 *
 *   { summary, checks: [{ id, metric, op, value, min, max, tolerance,
 *     compareToBaseline, message }], clauses: [{ text, outcome, checkIds }],
 *     needsLlmJudgment, judgmentHint, source }
 *
 * `clauses` is the honest half: every clause the engineer wrote, in order,
 * and what became of it — `checks` (the ids it turned into), `judgment` (it
 * cannot be a number; a reviewer judges it on each confirmed change, with
 * proxies meanwhile) or `not_understood` — so a panel can say which words
 * took, before the monitor exists.
 *
 * A rule about the whole page (`:page`, compilePageRule) is the one kind
 * neither compiler reads word by word: it can only be about the layout or the
 * words, and the diff of two page snapshots answers it (monitor-evaluate.js
 * diffPage).
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
import { METRICS, OPS, METRIC_LABELS, METRIC_UNITS, NUMERIC_METRICS, PAGE_TOLERANCE_PX, metric, coerce, describePageDiff } from './monitor-evaluate.js';

export const SEVERITIES = ['low', 'medium', 'high'];
export const CLAUSE_OUTCOMES = ['checks', 'judgment', 'not_understood'];
const CLAUSES_MAX = 12;
const CLAUSE_MAX = 200;

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
  // The clauses, tied to checks that exist: a clause that names none was not understood.
  const ids = new Set(out.checks.map((c) => c.id));
  out.clauses = [];
  for (const raw of Array.isArray(spec && spec.clauses) ? spec.clauses : []) {
    if (!raw || typeof raw !== 'object') continue;
    const text = String(raw.text ?? '').trim().slice(0, CLAUSE_MAX);
    if (!text) continue;
    const outcome = CLAUSE_OUTCOMES.includes(raw.outcome) ? raw.outcome : 'checks';
    const checkIds = (Array.isArray(raw.checkIds) ? raw.checkIds : []).map(String).filter((id) => ids.has(id));
    out.clauses.push({ text, outcome: outcome === 'checks' && !checkIds.length ? 'not_understood' : outcome, checkIds });
    if (out.clauses.length >= CLAUSES_MAX) break;
  }
  // A judgment clause's checks are proxies: they say the element changed, not
  // that the rule broke — a reviewer decides that (monitor.js). Marked, so the
  // engine can tell a failing proxy from a failing rule; and every such spec
  // watches the markup too, since a change that moves no number is still a
  // change the clause may be about.
  const judged = new Set(out.clauses.filter((c) => c.outcome === 'judgment').flatMap((c) => c.checkIds));
  for (const c of out.checks) c.judgment = judged.has(c.id);
  if (out.clauses.some((c) => c.outcome === 'judgment')) {
    out.needsLlmJudgment = true;
    if (!out.judgmentHint) out.judgmentHint = out.clauses.filter((c) => c.outcome === 'judgment').map((c) => c.text).join('; ').slice(0, 500);
    if (!out.checks.some((c) => c.metric === 'htmlHash')) {
      let id = 'html';
      while (seen.has(id)) id = 'html' + (++n);
      out.checks.push({ id, metric: 'htmlHash', op: 'unchanged', value: null, min: null, max: null, tolerance: null, compareToBaseline: false, message: 'The markup must not change without being judged', judgment: true });
      for (const c of out.clauses) if (c.outcome === 'judgment') c.checkIds.push(id);
    } else {
      for (const c of out.checks) if (c.metric === 'htmlHash') c.judgment = true;
    }
  }
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
/** How much of a rule, a label and a selector is kept — here, where the preview and the engine both read them. */
export const RULE_MAX = 500;
export const LABEL_MAX = 80;
export const SELECTOR_MAX = 1000;
/** The reserved selector of a monitor on the whole page (core.js measurePage). */
export const PAGE_SELECTOR = ':page';

/**
 * The checks a rule would compile to, for a panel to show BEFORE the monitor
 * exists: "this is the script that will run on every visit". The mock
 * compiler's answer, from the snapshot the pick carried — pure, so no page,
 * no lock and no model are needed to preview a sentence. Null for no rule.
 */
export function previewSpec({ ruleText, tag, selector, label, baseline } = {}) {
  const rule = String(ruleText ?? '').trim().slice(0, RULE_MAX);
  if (!rule) return null;
  const base = baseline && typeof baseline === 'object' && !Array.isArray(baseline) ? baseline : null;
  const element = {
    tag: String(tag ?? base?.tag ?? '').slice(0, 40),
    selector: String(selector ?? '').slice(0, SELECTOR_MAX),
    label: String(label ?? '').slice(0, LABEL_MAX),
    textPreview: String(base?.text ?? '').slice(0, 120),
  };
  return compileMock({ ruleText: rule, element, baseline: base });
}

/** The same document: origin and path, ignoring query, hash and a trailing slash. */
export function sameDoc(a, b) {
  if (!a || !b) return false;
  try { const ua = new URL(a), ub = new URL(b); return ua.origin === ub.origin && ua.pathname.replace(/\/+$/, '') === ub.pathname.replace(/\/+$/, ''); } catch { return a === b; }
}
/** A snapshot as an incident keeps it and a card sees it: the text cut short, a page's blocks left out. */
export function compactSnapshot(s) {
  if (!s) return null;
  const out = Object.assign({}, s);
  if (typeof out.text === 'string' && out.text.length > 500) out.text = out.text.slice(0, 500) + '…';
  // A page's blocks stay in the store, where the next diff needs them; a card and an incident get the count.
  if (Array.isArray(out.blocks)) delete out.blocks;
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
  if (/\b(characters?|chars?|letters)\b/.test(c)) push('textLength');
  // "3 cards" / "the items" count children; "the card" names the element itself,
  // so that phrase is set aside before the count words are looked for — "the
  // card must keep 3 items" still counts. "the item count" is a count.
  const counted = c.replace(/\b(the|this|that|my|our) (child|item|entry|option|card|column)\b(?! (count|number|total))/g, ' ');
  if (/\b(children|child|items?|entries|options?|list items?|cards?|columns?)\b/.test(counted) && !found.includes('rowCount')) push('childElementCount');
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
  const m = s.match(/(-?\d+(?:\.\d+)?)\s*(px|pixels?|pt|%|percent|per cent|pct|rows?|items?|characters?|chars?)?/);
  const unit = m ? (m[2] || '') : '';
  return m ? { n: parseFloat(m[1]), unit: /^(%|percent|per cent|pct)$/.test(unit) ? '%' : unit } : null;
}
function quoted(s) {
  const m = s.match(/["“”']([^"“”']{1,120})["“”']/);
  return m ? m[1] : null;
}
const NEGATOR = "(?:not|never|no longer|shouldn'?t|mustn'?t|can'?t|cannot|don'?t|doesn'?t|won'?t|isn'?t|aren'?t)";
function hasNegation(s) { return new RegExp('\\b' + NEGATOR + '\\b').test(s); }
// The negated forms first: "not be smaller than" is a minimum although "smaller than" alone is
// a maximum. Every negator hasNegation knows, and a word or two of filler ("not get ANY bigger
// than", "must not END UP bigger than") between the negator and the comparison.
const FILL = '(?:\\w+ ){0,2}?';
const MORE = '(?:any |much |even |a lot )?';
const MAX_NEG = new RegExp('\\b' + NEGATOR + ' ' + FILL + '(exceed|go (over|above|beyond|past)|(?:(be|get|become|grow|end up) )?' + MORE + '(more|bigger|larger|taller|wider|higher|greater|longer) than|(be|get|become) (over|above|beyond|past)|grow (beyond|past|over|above|to more than|larger than|bigger than|taller than|wider than)|surpass|pass)\\b');
const MIN_NEG = new RegExp('\\b' + NEGATOR + ' ' + FILL + '((?:(be|get|become|end up) )?' + MORE + '(less|smaller|lower|shorter|narrower|fewer) than|(be|get|become|go|drop|fall|sink|dip) (under|below)|shrink (below|under|smaller than))\\b');
const MAX_WORD = /\b(no more than|no (wider|taller|bigger|larger|greater|higher|longer) than|at most|maximum|max|under|below|less than|smaller than|up to|within|capped? at|not more than|cannot exceed|can'?t exceed|shouldn'?t exceed|mustn'?t exceed|not larger than|not bigger than|not taller than|not wider than|or less|or smaller|or lower)\b/;
const MIN_WORD = /\b(at least|minimum|min|no (less|smaller|narrower|shorter|fewer|lower) than|more than|greater than|over|above|bigger than|larger than|taller than|wider than|or more|or larger|or bigger|not less than|not fewer than)\b/;
/** lte, gte, or null when the clause names no bound ("stay 16px"). */
function boundOp(clause) {
  if (MAX_NEG.test(clause)) return 'lte';
  if (MIN_NEG.test(clause)) return 'gte';
  const isMax = MAX_WORD.test(clause), isMin = MIN_WORD.test(clause);
  if (isMax) return 'lte';
  return isMin ? 'gte' : null;
}
// A clause that is only a measurement ("60px tall" after "under 120px wide") borrows the bound
// before it — a size bound only, and only from the clause just before: a count ("5 rows") is
// exactly five, and a bound does not carry across a clause about something else.
const BORROWS = new Set(['width', 'height']);
// "not under 12px or over 20px": one clause, two bounds, the negation shared. Not "or less" and
// not "shrink or grow", which are one bound and one freeze.
const OR = /\s+or\s+(?!(?:less|smaller|lower|fewer|shorter|narrower|more|larger|bigger|greater|higher|taller|wider|longer|so|grow|grows|shrink|shrinks|expand|expands|increase|increases|decrease|decreases)\b(?! than))/;
const BOUND_TAIL = /\b(over|above|under|below|beyond|past|more than|less than|bigger than|smaller than|larger than|wider than|taller than|narrower than|shorter than|fewer than|exceed|exceeds)\b/;
const BOUND_WORDS = /\b(must|should|be|is|are|stay|stays|keep|keeps|remain|remains|exceed|not|never|under|over|at|than|within|exactly|max|min|maximum|minimum|least|most|less|more|below|above|up to|between|by)\b/;
// "180 by 50", "320x200": width, then height.
const DIMS = /(-?\d+(?:\.\d+)?)\s*(?:px|pixels?)?\s*(?:by|x|×)\s*(-?\d+(?:\.\d+)?)/;

/**
 * English → checks, by regular expression. The phrasing README's table lists
 * is what this understands; anything else falls back to "nothing may change"
 * with needsLlmJudgment set, which is honest about what it could not read.
 */
export function compileMock({ ruleText, element, baseline }) {
  if ((element && element.tag === 'page') || (baseline && baseline.kind === 'page')) return compilePageRule(ruleText);
  const text = String(ruleText || '').toLowerCase().replace(/\s+/g, ' ').trim();
  // The rule is read in lower case, but a quoted phrase is compared as the
  // engineer wrote it — "Checkout" stays "Checkout" on the card.
  const caseOf = new Map();
  for (const m of String(ruleText || '').matchAll(/["“”']([^"“”']{1,120})["“”']/g)) caseOf.set(m[1].toLowerCase(), m[1]);
  // "between 300 and 400" is one clause: that "and" joins the bounds, not two rules.
  const SPLIT = /\s*(?:;|,|\band\b(?<!\bbetween\s+-?\d+(?:\.\d+)?\s*(?:px|pixels?)?\s+and)|\balso\b|\bplus\b|\.)\s*/i;
  const rawClauses = text.split(SPLIT).map((s) => s.trim()).filter(Boolean);
  // The same clauses as the engineer wrote them, for the record of what became of each.
  const rawWritten = String(ruleText || '').replace(/\s+/g, ' ').trim().split(SPLIT).map((s) => s.trim()).filter(Boolean);
  // A clause that only names a metric ("width" in "width and height must not change")
  // borrows the intent of the clause that follows it.
  const INTENT = /\b(not|never|no|exceed|change|changes|stay|stays|remain|remains|keep|keeps|must|should|be|is|are|within|under|over|least|most|more|less|than|same|unchanged|visible|hidden|contain|contains|say|says|between|by|grow|shrink|exact|exactly|above|below|max|min|maximum|minimum)\b|\d/;
  const clauses = [];
  const written = [];
  for (let i = 0; i < rawClauses.length; i++) {
    const c = rawClauses[i];
    if (!INTENT.test(c) && i + 1 < rawClauses.length) { rawClauses[i + 1] = c + ' ' + rawClauses[i + 1]; rawWritten[i + 1] = (rawWritten[i] ?? c) + ' and ' + (rawWritten[i + 1] ?? rawClauses[i + 1]); }
    else { clauses.push(c); written.push(rawWritten[i] ?? c); }
  }
  const checks = [];
  let needsLlmJudgment = false;
  let lastMetrics = [];
  let lastOp = null;
  const addCheck = (check) => { checks.push(Object.assign({ id: 'c' + (checks.length + 1), value: null, min: null, max: null, tolerance: null, compareToBaseline: false, message: '' }, check)); };
  const baselineVal = (m) => metric(baseline, m);
  // What became of each clause, in the engineer's words (normalizeSpec ties the ids to the checks that survive).
  const clauseRows = [];

  clauses.forEach((clause, i) => {
    const before = checks.length;
    const outcome = compileClause(clause);
    const checkIds = checks.slice(before).map((c) => c.id);
    clauseRows.push({ text: written[i] ?? clause, outcome: checkIds.length ? outcome : 'not_understood', checkIds });
  });
  /**
   * One clause → its checks; the word says whether they are the rule or proxies for a reviewer.
   * "A or B" is compiled as two halves of one clause: the second borrows the first's metrics,
   * and its negation when it names a bound of its own ("not under 12px or over 20px").
   */
  function compileClause(clause) {
    const parts = clause.split(OR);
    if (parts.length > 1) {
      const negator = (parts[0].match(new RegExp('\\b' + NEGATOR + '\\b')) || [])[0] || null;
      const outcomes = parts.map((part, i) => {
        const carried = i > 0 && negator && !hasNegation(part) && BOUND_TAIL.test(part) ? `${negator} be ${part}` : part;
        return compilePart(carried);
      });
      return outcomes.includes('judgment') ? 'judgment' : 'checks';
    }
    return compilePart(clause);
  }
  function compilePart(clause) {
    let metrics = detectMetrics(clause, element);
    if (!metrics.length) metrics = lastMetrics;
    const numberInfo = firstNumber(clause);
    const q0 = quoted(clause);
    const q = q0 == null ? null : (caseOf.get(q0) ?? q0);
    const neg = hasNegation(clause);

    // "contains / says 'X'"
    if (q && /\b(contain|contains|include|includes|say|says|read|reads|show|shows|mention|mentions|display|displays)\b/.test(clause)) {
      addCheck({ metric: 'text', op: neg ? 'not_contains' : 'contains', value: q });
      lastMetrics = ['text']; lastOp = null;
      return 'checks';
    }
    // presence / visibility
    if (metrics.includes('visible') || metrics.includes('exists')) {
      const wantsHidden = /\b(hidden|invisible|not visible|not shown|not displayed|not appear|gone|absent|not exist|not be present|should disappear|must disappear)\b/.test(clause) && !/\b(never|not) (be )?(hidden|invisible)\b/.test(clause) && !/not (disappear|vanish|go missing|be removed)/.test(clause);
      if (wantsHidden) addCheck({ metric: 'visible', op: 'visible', value: 'false' });
      else { addCheck({ metric: 'exists', op: 'exists', value: 'true' }); addCheck({ metric: 'visible', op: 'visible', value: 'true' }); }
      lastMetrics = ['visible']; lastOp = null;
      return 'checks';
    }
    // A percentage is of something the snapshot does not measure: never read as pixels. The
    // metric it names is held still and a reviewer judges the change, like any other sentence
    // the numbers cannot carry.
    if (numberInfo && numberInfo.unit === '%') {
      const held = metrics.filter((m) => NUMERIC_METRICS.has(m));
      for (const m of (held.length ? held : ['width', 'height'])) addCheck({ metric: m, op: 'unchanged' });
      needsLlmJudgment = true; lastMetrics = held.length ? held : ['width', 'height']; lastOp = null;
      return 'judgment';
    }
    // "180 by 50": a width and a height, under one bound — before the delta rule, which would
    // read "by 50". Not when the clause is about moving ("10px by 10px"), counting, or a grid.
    const dims = metrics.includes('x') || metrics.includes('rowCount') || metrics.includes('childElementCount') || /\b(grid|matrix|layout|move|moves|shift|shifts)\b/.test(clause) ? null : clause.match(DIMS);
    if (dims) {
      const op = boundOp(clause);
      if (!op && neg) {
        // "must not get biger than 180 by 50": a bound the table cannot read on a negated
        // sentence is not "exactly 180 by 50"; the size is held still and a reviewer judges it.
        addCheck({ metric: 'width', op: 'unchanged' }); addCheck({ metric: 'height', op: 'unchanged' });
        needsLlmJudgment = true; lastMetrics = ['width', 'height']; lastOp = null;
        return 'judgment';
      }
      addCheck({ metric: 'width', op: op ?? 'eq', value: dims[1] });
      addCheck({ metric: 'height', op: op ?? 'eq', value: dims[2] });
      lastMetrics = ['width', 'height'];
      lastOp = op;
      return 'checks';
    }
    if (!metrics.length) {
      const target = (element && TEXTY_TAGS.has(element.tag)) ? ['fontSize', 'text', 'width', 'height'] : ['width', 'height', 'text'];
      if (numberInfo) metrics = [(element && TEXTY_TAGS.has(element.tag) && numberInfo.n < 100) ? 'fontSize' : 'height'];
      else { for (const m of target) addCheck({ metric: m, op: 'unchanged' }); needsLlmJudgment = true; lastMetrics = target; lastOp = null; return 'judgment'; }
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
      lastMetrics = metrics; lastOp = null;
      return 'checks';
    }
    if (numberInfo) {
      const between = clause.match(/between\s+(-?\d+(?:\.\d+)?)\s*(?:px|pixels?)?\s*(?:and|-|–|to)\s*(-?\d+(?:\.\d+)?)/);
      const explicit = boundOp(clause);
      // "must not be 20px" is a value to avoid; a negated bound the table cannot read ("must
      // not be ovre 100px tall") is held still for a reviewer rather than read as "exactly".
      const avoid = !explicit && !between && neg && new RegExp('\\b' + NEGATOR + ' (be|stay|remain|equal) (?:at |exactly |set to )?-?\\d').test(clause);
      if (!explicit && !between && neg && !avoid) {
        for (const m of metrics) if (NUMERIC_METRICS.has(m)) addCheck({ metric: m, op: 'unchanged' });
        needsLlmJudgment = true; lastMetrics = metrics; lastOp = null;
        return 'judgment';
      }
      const borrowed = !explicit && !BOUND_WORDS.test(clause) ? lastOp : null;
      for (const m of metrics) {
        if (!NUMERIC_METRICS.has(m)) continue;
        if (between) { addCheck({ metric: m, op: 'between', min: parseFloat(between[1]), max: parseFloat(between[2]) }); continue; }
        const n = numberInfo.n;
        const op = explicit ?? (avoid ? 'neq' : (borrowed && BORROWS.has(m) ? borrowed : 'eq'));
        if (op === 'eq') addCheck({ metric: m, op, value: String(n), tolerance: m === 'rowCount' || m === 'childElementCount' ? 0 : null });
        else addCheck({ metric: m, op, value: String(n) });
      }
      lastMetrics = metrics;
      lastOp = explicit ?? borrowed ?? null;
      return 'checks';
    }
    // no number: "must not shrink" / "must not grow" is a delta of zero, not a freeze — growing is
    // allowed after the first, shrinking after the second. Both named is neither: a freeze.
    const shrinks = /\b(shrink|shrinks|decrease|smaller|narrower|shorter)\b/.test(clause);
    const grows = /\b(grow|grows|increase|bigger|larger|taller|wider|expand|expands)\b/.test(clause);
    const dir = !neg || (shrinks && grows) ? null : shrinks ? 'gte' : grows ? 'lte' : null;
    if (dir && metrics.some((m) => NUMERIC_METRICS.has(m))) {
      for (const m of metrics) if (NUMERIC_METRICS.has(m)) addCheck({ metric: m, op: dir, value: '0', compareToBaseline: true, message: (METRIC_LABELS[m] || m).replace(/^./, (ch) => ch.toUpperCase()) + ' must not ' + (dir === 'gte' ? 'shrink' : 'grow') });
      lastMetrics = metrics; lastOp = null;
      return 'checks';
    }
    // stability rules
    const wantsUnchanged = neg || /\b(unchanged|same|constant|stable|as is|as-is|stay put|fixed|lock|locked|intact|remain|remains|keep|keeps|maintain|maintains|preserve|preserves)\b/.test(clause);
    let judged = false;
    for (const m of metrics) {
      if (m === 'x' || m === 'y' || wantsUnchanged || !NUMERIC_METRICS.has(m)) addCheck({ metric: m, op: 'unchanged' });
      else {
        // e.g. "font size should be bigger" — cannot be stated deterministically; keep it stable and flag for judgment
        addCheck({ metric: m, op: 'unchanged' });
        needsLlmJudgment = true;
        judged = true;
      }
    }
    lastMetrics = metrics; lastOp = null;
    return judged ? 'judgment' : 'checks';
  }
  if (!checks.length) {
    for (const m of ['width', 'height', 'fontSize', 'text']) addCheck({ metric: m, op: 'unchanged' });
    needsLlmJudgment = true;
    clauseRows.length = 0;
    clauseRows.push({ text: String(ruleText || '').replace(/\s+/g, ' ').trim().slice(0, CLAUSE_MAX), outcome: 'judgment', checkIds: checks.map((c) => c.id) });
  }
  // Drop duplicates and unchanged checks whose baseline metric is unavailable (e.g. rowCount on a non-table).
  // A clause whose checks were duplicates of an earlier clause's keeps pointing at the ones kept.
  const seen = new Map();
  const alias = {};
  const usable = checks.filter((c) => {
    const key = [c.metric, c.op, c.value, c.min, c.max, c.compareToBaseline].join('|');
    if (seen.has(key)) { alias[c.id] = seen.get(key); return false; }
    seen.set(key, c.id);
    return c.op !== 'unchanged' || baselineVal(c.metric) != null;
  });
  for (const row of clauseRows) row.checkIds = [...new Set(row.checkIds.map((id) => alias[id] ?? id))];
  const judged = clauseRows.filter((r) => r.outcome === 'judgment').map((r) => r.text);
  return normalizeSpec({ summary: '', checks: usable.length ? usable : checks, clauses: clauseRows, needsLlmJudgment, judgmentHint: needsLlmJudgment ? (judged.join('; ') || ruleText) : null }, 'mock');
}

// ---- the whole page ----------------------------------------------------------------------
const PAGE_LAYOUT_WORDS = /\b(layout|layouts|position|positions|positioned|move|moves|moved|moving|shift|shifts|shifted|size|sizes|sized|resize|resized|align|aligned|alignment|spacing|gap|gaps|overlap|overlaps|structure|arrangement|arranged|place|places|placement|design|look|looks|appearance|visual|visually|render|renders|rendering|style|styles|styling|box|boxes|section|sections|element|elements|block|blocks|shape|geometry|jump|jumps|reflow)\b/;
const PAGE_TEXT_WORDS = /\b(text|texts|copy|wording|words|content|contents|label|labels|caption|captions|heading|headings|title|titles|say|says|said|read|reads|spelling|typo|typos|number|numbers|price|prices|sentence|sentences|paragraph|paragraphs|string|strings|reworded|rewritten|written|message|messages)\b/;
const PAGE_ANY_WORDS = /\b(nothing|anything|any|everything|whole|entire|all|page|screen|ui|change|changes|changed|different|same|as is|as-is|stable|unchanged|identical|regress|regression|regressions|break|breaks|broken)\b/;
const PAGE_MESSAGES = {
  layout: (tol) => `The layout must not change: nothing added, removed, moved or resized by more than ${tol}px`,
  content: () => 'The words must not change: nothing reworded, added or removed',
};
/**
 * A rule about the whole page. It can say one of three things — the layout
 * must hold, the words must hold, or nothing may change — and a number of
 * pixels loosens how far a block may drift before it has moved. Anything
 * else ("the page must still look professional") is watched for any change
 * and left to a reviewer, the way a judgment clause on an element is. The
 * spec is its own shape (`kind: 'page'`): the evaluator answers it with
 * diffPage, never with a metric of one element, and `ignore` is filled in by
 * the engine with the blocks the page changes on its own.
 */
export function compilePageRule(ruleText) {
  const raw = String(ruleText || '').replace(/\s+/g, ' ').trim().slice(0, RULE_MAX);
  const text = raw.toLowerCase();
  const layout = PAGE_LAYOUT_WORDS.test(text);
  const words = PAGE_TEXT_WORDS.test(text);
  const understood = layout || words || PAGE_ANY_WORDS.test(text) || hasNegation(text);
  const which = layout && !words ? ['layout'] : words && !layout ? ['content'] : ['layout', 'content'];
  const px = text.match(/(\d+(?:\.\d+)?)\s*(?:px|pixels?)\b/);
  const tolerance = px ? Math.max(0, Math.min(200, parseFloat(px[1]))) : PAGE_TOLERANCE_PX;
  const checks = which.map((m) => ({ id: m, metric: m, op: 'unchanged', value: null, min: null, max: null, tolerance: null, compareToBaseline: true, message: PAGE_MESSAGES[m](tolerance), judgment: !understood }));
  const clauses = [{ text: raw.slice(0, CLAUSE_MAX), outcome: understood ? 'checks' : 'judgment', checkIds: checks.map((c) => c.id) }];
  const what = which.length === 2 ? 'Nothing on the page may change: not its layout, not its words' : which[0] === 'layout' ? 'The page’s layout must not change' : 'The page’s words must not change';
  return {
    kind: 'page', summary: `${what} (moves under ${tolerance}px and whatever changes on its own are ignored)`.slice(0, 160),
    checks, clauses, needsLlmJudgment: !understood, judgmentHint: understood ? null : raw.slice(0, 500), source: 'mock', tolerance, ignore: [],
  };
}

// ---- the mock judge ------------------------------------------------------------------------
function pct(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number' || a === 0) return null;
  return Math.abs((b - a) / a);
}
/** The explanation an incident opens with — the numbers, in sentences, at once. */
export function judgeMock({ label, selector, ruleText, violations, diff, judgment = false }) {
  // Only a judgment clause's proxies failed: the element changed, and whether
  // the rule still holds is a question the mock cannot answer. Said so.
  if (judgment) {
    const page = diff && diff.pageChanges ? [describePageDiff(diff.pageChanges, 'layout'), describePageDiff(diff.pageChanges, 'content')].filter((t) => t !== 'nothing measurable').join('; ') : null;
    const changed = Object.entries(diff || {}).filter(([k]) => k !== 'htmlChanged' && k !== 'pageChanges').slice(0, 4).map(([k, val]) => (Array.isArray(val) ? METRIC_LABELS[k] + ' ' + val[0] + ' → ' + val[1] : k));
    const what = [page, diff && diff.htmlChanged ? 'its markup changed' : null, changed.length ? changed.join(', ') : null].filter(Boolean).join('; ') || 'it changed';
    return {
      violation: true, severity: 'medium',
      explanation: '"' + label + '" (' + selector + ') changed under the rule "' + ruleText + '": ' + what + '. Whether the rule still holds is a judgment, not a number — set ANTHROPIC_API_KEY and Claude decides from the markup and the clips on each confirmed change; until then every change is reported.',
      source: 'mock', at: Date.now(),
    };
  }
  const v = (violations && violations[0]) || { metric: 'exists', message: 'The element changed', actual: null, expected: null, baseline: null };
  const others = Object.entries(diff || {}).filter(([k]) => k !== v.metric && k !== 'htmlChanged' && k !== 'pageChanges').slice(0, 4).map(([k, val]) => (Array.isArray(val) ? METRIC_LABELS[k] + ' ' + val[0] + ' → ' + val[1] : k));
  let severity = 'low';
  if (v.metric === 'exists' || v.metric === 'visible') severity = 'high';
  else if (v.metric === 'layout' || v.metric === 'content') {
    // Something went or many things moved is worse than one thing reworded.
    const t = (diff && diff.pageChanges && diff.pageChanges.totals) || {};
    severity = (t.removed || 0) > 0 || (t.added || 0) + (t.moved || 0) >= 10 ? 'high' : 'medium';
  } else {
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
  else if (v.metric === 'htmlHash') explanation += 'Its markup changed.';
  else if (v.metric === 'layout') explanation += 'The layout changed: ' + v.actual + '.';
  else if (v.metric === 'content') explanation += 'The words changed: ' + v.actual + '.';
  else explanation += 'Its ' + metricLabel + ' is now ' + v.actual + unit + ' but the rule expects ' + v.expected + (v.baseline != null ? ' (baseline ' + v.baseline + unit + ')' : '') + '.';
  if (others.length) explanation += ' Side effects: ' + others.join(', ') + '.';
  if (violations && violations.length > 1) explanation += ' ' + (violations.length - 1) + ' other check' + (violations.length > 2 ? 's' : '') + ' failed as well.';
  return {
    violation: true, severity, explanation,
    source: 'mock', at: Date.now(),
  };
}
