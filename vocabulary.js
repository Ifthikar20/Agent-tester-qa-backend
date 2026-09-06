/**
 * The vocabulary: every verb the language has, declared once.
 *
 * A verb used to be spread across eight files — parsed in flow.js, written back
 * in flow.js, executed in ops.js, gated in ops.js, drawn in diagram.js, echoed
 * in ConsoleView.vue, produced in recorder.js, and copied into the extension.
 * Adding one meant finding all eight, and `showOp`'s `default: return null`
 * meant a step nobody had taught to write itself was silently dropped from the
 * script rather than reported.
 *
 * So each verb is one row here:
 *
 *   op / assert   the IR it produces
 *   syntax        how it is written, tried in order
 *   show          how it is written back        (the inverse of syntax)
 *   label         how it is drawn, short
 *   check         what makes it valid           (true, or the reason it is not)
 *
 * This module is PURE. It imports nothing, touches no browser and no disk,
 * because flow.js is copied verbatim into the browser extension and must not
 * drag Playwright along with it. The `run` half of each verb lives in ops.js,
 * which attaches itself to this table by name and refuses to load if the two
 * sets ever differ.
 */

// ------------------------------------------------------------------ literals

/** Strip one layer of surrounding single quotes. */
export const unq = (s) => String(s ?? '').trim().replace(/^'(.*)'$/s, '$1');

/**
 * `'a' * 20` -> 'aaa…'; `$KEY` -> a vault reference; else a literal.
 *
 * There is no expression evaluation here on purpose — repetition is the one
 * thing a test genuinely needs to say (a field's length limit) and it is
 * spelled as a bounded literal rather than as code.
 */
export function value(raw) {
  const s = String(raw ?? '').trim();
  if (s.startsWith('$')) return { valueRef: `secrets.${s.slice(1)}` };

  const rep = s.match(/^'(.*)'\s*[*×]\s*(\d+)$/s);
  if (rep) return { value: rep[1].repeat(Math.min(Number(rep[2]), 500)) };

  const n = s.match(/^(\d+)\s*chars?$/);
  if (n) return { value: 'a'.repeat(Math.min(Number(n[1]), 500)) };

  return { value: unq(s) };
}

/** `'Sign in' : button` -> `button:Sign in`, the target grammar targets.js speaks. */
export function target(raw) {
  // The strategy half may carry a scope prefix — `navigation/link`, `nth2/link`.
  const m = String(raw ?? '').trim().match(/^(.*?)\s*:\s*((?:[A-Za-z0-9]+\/)?[A-Za-z]+)$/s);
  // A bare alias, e.g. `auth.submit`. Still goes through parseTarget later.
  if (!m) return unq(raw);
  return `${m[2].trim()}:${unq(m[1])}`;
}

/**
 * `navigation/link:Pricing` -> `'Pricing' : navigation/link`
 *
 * The scope rides with the strategy rather than being dropped, because a
 * script that silently forgets WHICH Pricing link you meant is a script that
 * clicks the footer on Tuesday.
 */
export const showTarget = (t) => {
  const i = String(t ?? '').indexOf(':');
  return i < 1 ? String(t ?? '') : `'${t.slice(i + 1)}' : ${t.slice(0, i)}`;
};

/** Vault references are named, never expanded — not here, not anywhere. */
const showValue = (s) => (s.valueRef ? `$${s.valueRef.replace(/^secrets\./, '')}` : `'${s.value}'`);

// ---------------------------------------------------------------- the verbs

/**
 * One row per surface form. Order matters inside `syntax` and across rows:
 * `scroll to top` must be tried before `scroll to <target>`, or "top" becomes
 * the name of an element nobody has.
 */
export const VERBS = [
  {
    op: 'click',
    syntax: [{ re: /^click\s+(.+)$/i, ir: (m) => ({ target: target(m[1]) }) }],
    show: (s) => `click ${showTarget(s.target)}`,
    label: (s, t) => `click ${t(s.target, 16)}`,
  },
  {
    // Go there and stay, without clicking — for a menu that only exists while
    // the pointer is on whatever opens it.
    op: 'hover',
    syntax: [{ re: /^hover\s+(.+)$/i, ir: (m) => ({ target: target(m[1]) }) }],
    show: (s) => `hover ${showTarget(s.target)}`,
    label: (s, t) => `hover ${t(s.target, 16)}`,
  },
  {
    op: 'fill',
    syntax: [{
      re: /^fill\s+(.+?)\s*=\s*(.+)$/i,
      ir: (m) => ({ target: target(m[1]), ...value(m[2]) }),
    }],
    show: (s) => `fill ${showTarget(s.target)} = ${showValue(s)}`,
    label: (s, t) => (s.valueRef ? `fill ${t(s.target, 12)} ← vault` : `fill ${t(s.target, 17)}`),
  },
  {
    op: 'wait',
    syntax: [{ re: /^wait\s+(\d+)\s*ms$/i, ir: (m) => ({ ms: Number(m[1]) }) }],
    show: (s) => `wait ${s.ms}ms`,
    label: (s) => `wait ${s.ms}ms`,
  },
  {
    // Moving the page is an action, not scenery. `top` and `bottom` mean the
    // same thing at any viewport; anything else scrolls a named element in.
    op: 'scroll',
    syntax: [
      { re: /^scroll\s+to\s+(top|bottom)$/i, ir: (m) => ({ to: m[1].toLowerCase() }) },
      { re: /^scroll\s+to\s+(.+)$/i, ir: (m) => ({ target: target(m[1]) }) },
    ],
    show: (s) => `scroll to ${s.to ?? showTarget(s.target)}`,
    label: (s, t) => (s.to ? `scroll ${s.to}` : `scroll to ${t(s.target, 12)}`),
    check: (s) => s.target || s.to === 'top' || s.to === 'bottom'
      || 'scroll needs a target, or "top"/"bottom"',
  },

  // ------------------------------------------------------------- assertions

  {
    op: 'expect',
    assert: 'valueEquals',
    syntax: [{
      re: /^check\s+(.+?)\s+is\s+(.+)$/i,
      ir: (m) => ({ target: target(m[1]), ...value(m[2]) }),
    }],
    // Written back as a LENGTH, not as the text: the value may have come from
    // the vault, and a script is a thing people paste into tickets.
    show: (s) => `check ${showTarget(s.target)} is ${String(s.value).length} chars`,
    label: (s, t) => `${t(s.target, 8)} = ${String(s.value).length} chars`,
  },
  {
    op: 'expect',
    assert: 'atTop',
    syntax: [{ re: /^check\s+at\s+top$/i, ir: () => ({}) }],
    show: () => 'check at top',
    label: () => 'at top of page',
  },
  {
    // What the last navigation did, which the final URL cannot tell you: a
    // friendly 404 has a perfectly good URL, and so does a link that 301s
    // through a path nobody maintains.
    op: 'expect',
    assert: 'status',
    syntax: [{ re: /^check\s+status\s+(\d{3})$/i, ir: (m) => ({ value: Number(m[1]) }) }],
    show: (s) => `check status ${s.value}`,
    label: (s) => `HTTP ${s.value}`,
  },
  {
    op: 'expect',
    assert: 'redirects',
    syntax: [
      { re: /^check\s+no\s+redirects?$/i, ir: () => ({ value: 0 }) },
      { re: /^check\s+(\d+)\s+redirects?$/i, ir: (m) => ({ value: Number(m[1]) }) },
    ],
    show: (s) => (s.value === 0 ? 'check no redirect' : `check ${s.value} redirects`),
    label: (s) => (s.value === 0 ? 'no redirect' : `${s.value} redirects`),
  },
  {
    op: 'expect',
    assert: 'via',
    syntax: [{ re: /^check\s+redirect\s+via\s+(.+)$/i, ir: (m) => ({ value: unq(m[1]) }) }],
    show: (s) => `check redirect via '${s.value}'`,
    label: (s, t) => `via ${t(s.value, 14)}`,
  },
  {
    op: 'expect',
    assert: 'textVisible',
    syntax: [{ re: /^see\s+(.+)$/i, ir: (m) => ({ value: unq(m[1]) }) }],
    show: (s) => `see '${s.value}'`,
    label: (s, t) => `text: ${t(s.value, 12)}`,
  },
  {
    // Arriving somewhere is written as a node shape, not an edge action, so
    // this row has no `syntax` and never writes itself back into a label.
    op: 'expect',
    assert: 'urlContains',
    syntax: [],
    show: () => null,
    label: (s, t) => `url ~ ${t(s.value, 12)}`,
  },
  {
    // Likewise: the entry node is the goto.
    op: 'goto',
    syntax: [],
    show: () => null,
    label: (s, t) => `▶ ${t(s.url, 54)}`,
  },
];

// ------------------------------------------------------------------ the API

const key = (op, assert) => (assert ? `${op}:${assert}` : op);
const BY_KEY = new Map(VERBS.map((v) => [key(v.op, v.assert), v]));

/** Every op name the language knows — what ops.js must supply a runner for. */
export const OP_NAMES = [...new Set(VERBS.map((v) => v.op))];

/** The row that describes a step, or undefined if nothing does. */
export const verbFor = (step) => BY_KEY.get(key(step?.op, step?.assert));

/**
 * One clause of an edge label -> one IR step.
 *
 * Mermaid is permissive; this runner must not be. An unreadable action is a
 * hard error, never a silently skipped step — otherwise a typo passes.
 */
export function parseAction(clause) {
  const s = String(clause ?? '').trim();
  if (!s) return null;

  for (const v of VERBS) {
    for (const { re, ir } of v.syntax) {
      const m = s.match(re);
      if (m) return { op: v.op, ...(v.assert ? { assert: v.assert } : {}), ...ir(m) };
    }
  }
  throw new Error(`Unreadable edge action "${s}"`);
}

/**
 * One IR step -> how it is written. `null` means "this one is a node, not an
 * edge action" — the two url/text assertions and the goto.
 *
 * A step whose op is not in the table is an error rather than a `null`: being
 * quietly dropped from a script you are about to trust is worse than a stop.
 */
export function showAction(step) {
  const v = verbFor(step);
  if (!v) throw new Error(`No way to write "${key(step?.op, step?.assert)}" back as text`);
  return v.show(step);
}

/**
 * One IR step -> its label in a diagram. `trunc` is supplied by the caller
 * because only the caller knows the budget for the shape it is drawing.
 */
export function labelAction(step, trunc) {
  const v = verbFor(step);
  return v ? v.label(step, trunc) : trunc(step.op, 24);
}

/** True, or the reason this step is not valid. Shape only — see ops.js for the rest. */
export function checkAction(step) {
  const v = verbFor(step);
  if (!v) return `unknown op "${key(step?.op, step?.assert)}"`;
  return v.check ? v.check(step) : true;
}
