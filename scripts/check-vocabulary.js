/**
 * The vocabulary, checked against itself.
 *
 * A verb is four things — how it is written, how it is written back, how it is
 * drawn, and what runs it — and until they lived in one table they were four
 * files that drifted. The worst drift was silent: `showOp` returned null for a
 * step it did not recognise and `toFlow` dropped it, so a recording could hand
 * you a script that was missing a click and still looked fine.
 *
 * So this walks the table itself. Every row must round-trip, draw, and run, and
 * every row must bring a sample — which means a verb added tomorrow without
 * finishing it fails here rather than in front of somebody.
 *
 *   node scripts/check-vocabulary.js       (no browser, no server)
 */
import assert from 'node:assert';
import { VERBS, OP_NAMES, parseAction, showAction, labelAction } from '../vocabulary.js';
import { parse, toFlow, asFlowchart } from '../flow.js';
import { OPS } from '../ops.js';

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(46)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(46)} ${d}`); };
const key = (v) => (v.assert ? `${v.op}:${v.assert}` : v.op);

/**
 * One representative step per row. Deliberately not generated from the table —
 * a sample written by hand is the thing that would notice if a row's `ir` and
 * its `show` agreed with each other but not with what anyone meant.
 */
const SAMPLES = {
  'click':               [{ op: 'click', target: 'navigation/link:Pricing' }],
  'hover':               [{ op: 'hover', target: 'link:Products' }],
  'fill':                [{ op: 'fill', target: 'textbox:Email', value: 'qa@example.com' },
                          { op: 'fill', target: 'label:Password', valueRef: 'secrets.QA_PASS' }],
  'wait':                [{ op: 'wait', ms: 500 }],
  'scroll':              [{ op: 'scroll', to: 'top' }, { op: 'scroll', to: 'bottom' },
                          { op: 'scroll', target: 'contentinfo/link:Docs' }],
  'expect:valueEquals':  [{ op: 'expect', assert: 'valueEquals', target: 'profile.username', value: 'a'.repeat(20) }],
  'expect:atTop':        [{ op: 'expect', assert: 'atTop' }],
  'expect:status':       [{ op: 'expect', assert: 'status', value: 404 }],
  'expect:redirects':    [{ op: 'expect', assert: 'redirects', value: 0 },
                          { op: 'expect', assert: 'redirects', value: 2 }],
  'expect:via':          [{ op: 'expect', assert: 'via', value: '/go/tracked' }],
  'expect:textVisible':  [{ op: 'expect', assert: 'textVisible', value: 'Profile saved' }],
  // These two are node shapes, not edge actions: they draw and run, but they
  // are never written into a label, so they have no round-trip to check.
  'expect:urlContains':  [{ op: 'expect', assert: 'urlContains', value: '/settings' }],
  'goto':                [{ op: 'goto', url: 'http://localhost:3000/demo.html' }],
};

console.log('\n— every verb is finished ——————————————————————————');

const missing = VERBS.filter((v) => !SAMPLES[key(v)]).map(key);
if (missing.length) bad('every row brings a sample', missing.join(', '));
else ok('every row brings a sample', `${VERBS.length} rows`);

const extra = Object.keys(SAMPLES).filter((k) => !VERBS.some((v) => key(v) === k));
if (extra.length) bad('and no sample outlives its row', extra.join(', '));
else ok('and no sample outlives its row');

// --------------------------------------------------------------- round-trip
console.log('\n— written back, it says the same thing —————————————');

let round = 0;
for (const v of VERBS) {
  for (const step of SAMPLES[key(v)] ?? []) {
    const text = showAction(step);
    if (!v.syntax.length) {
      if (text !== null) bad(`${key(v)} is a node, so it writes nothing`, String(text));
      continue;
    }
    if (typeof text !== 'string' || !text) { bad(`${key(v)} writes itself back`, String(text)); continue; }
    try {
      assert.deepStrictEqual(parseAction(text), step);
      round++;
    } catch {
      bad(`${key(v)} round-trips`, `"${text}" -> ${JSON.stringify(parseAction(text))}`);
    }
  }
}
if (round) ok('parse → write → parse is a fixed point', `${round} forms`);

// A value is written back as its LENGTH on purpose: it may have come from the
// vault, and a script is a thing people paste into tickets. So the round-trip
// for this one preserves the length, not the text — say so out loud rather
// than leaving it as a surprise.
const secretish = { op: 'expect', assert: 'valueEquals', target: 'profile.username', value: 'hunter2hunter2hunter' };
const written = showAction(secretish);
if (!written.includes('hunter2') && parseAction(written).value.length === secretish.value.length) {
  ok('a checked value is written as a length', written);
} else {
  bad('a checked value is written as a length', written);
}

// --------------------------------------------------------------- draw & run
console.log('\n— and it draws, and it runs ————————————————————————');

const undrawn = [];
for (const v of VERBS) {
  for (const step of SAMPLES[key(v)] ?? []) {
    const l = labelAction(step, (s, n) => String(s ?? '').slice(0, n));
    if (typeof l !== 'string' || !l.trim() || l.trim() === step.op) undrawn.push(key(v));
  }
}
if (undrawn.length) bad('every verb draws as more than its name', [...new Set(undrawn)].join(', '));
else ok('every verb draws as more than its name');

const unrun = OP_NAMES.filter((n) => !OPS[n]);
const undeclared = Object.keys(OPS).filter((n) => !OP_NAMES.includes(n));
if (unrun.length || undeclared.length) bad('the table and the runners match', [...unrun, ...undeclared].join(', '));
else ok('the table and the runners match', OP_NAMES.join(' '));

// A step the table does not know must STOP, not vanish. This is the actual bug
// that motivated the table: `showOp`'s `default: return null` meant toFlow
// dropped the step and handed you a shorter script without a word.
try {
  toFlow({ suite: 'x', steps: [{ op: 'goto', url: 'http://localhost:3000/' }, { op: 'teleport', target: 'link:X' }] });
  bad('an unknown step stops rather than vanishing', 'it was dropped silently');
} catch (e) {
  ok('an unknown step stops rather than vanishing', e.message.slice(0, 40));
}

// -------------------------------------------------------------- the document
console.log('\n— the case is not a picture ————————————————————————');

// The whole point of the rename: a name mermaid cannot lex is kept by the test
// and only tidied in the drawing.
const brackets = toFlow({ suite: 'Brackets', steps: [
  { op: 'goto', url: 'http://localhost:3000/site.html' },
  { op: 'click', target: 'link:Download (PDF) [2024]' },
  { op: 'expect', assert: 'urlContains', value: '/files' },
] });
const kept = parse(brackets).steps[1].target;
if (kept === 'link:Download (PDF) [2024]') ok('a bracketed name survives the case', kept);
else bad('a bracketed name survives the case', kept);

const drawn = asFlowchart(brackets);
if (!/[([]PDF/.test(drawn) && /Download PDF 2024/.test(drawn)) ok('and is tidied only in the picture');
else bad('and is tidied only in the picture', drawn.split('\n').find((l) => l.includes('Download')) ?? '');

if (/^testcase TD$/m.test(brackets) && /^flowchart TD$/m.test(drawn)) {
  ok('stored as a testcase, drawn as a flowchart');
} else {
  bad('stored as a testcase, drawn as a flowchart', brackets.split('\n')[1]);
}

// Every case on disk was written before the rename.
const legacy = `%% suite "Old"
flowchart TD
  n0(("http://localhost:3000/site.html"))
  n1["/pricing"]
  n0 -->|click 'Pricing' : navigation/link| n1`;
try {
  const p = parse(legacy);
  if (p.steps.length === 3) ok('a case written as flowchart still parses', `${p.steps.length} steps`);
  else bad('a case written as flowchart still parses', `${p.steps.length} steps`);
} catch (e) { bad('a case written as flowchart still parses', e.message); }

// --------------------------------------------------------- readable at length
console.log('\n— a long transition stays readable —————————————————');

const long = toFlow({ suite: 'Long', steps: [
  { op: 'goto', url: 'https://example.com/learn' },
  { op: 'scroll', to: 'top' },
  { op: 'click', target: 'navigation/link:Learn' },
  { op: 'click', target: 'navigation/link:Changelog' },
  { op: 'expect', assert: 'urlContains', value: '/changelog' },
] });
const widest = Math.max(...long.split('\n').map((l) => l.length));
if (widest < 60) ok('four actions do not become one long line', `widest line ${widest} chars`);
else bad('four actions do not become one long line', `widest line ${widest} chars`);

try {
  assert.deepStrictEqual(parse(long).steps, parse(asFlowchart(long)).steps);
  ok('and the folded-up picture means the same');
} catch { bad('and the folded-up picture means the same'); }

console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — every verb parses, writes itself back, draws and runs, and a\n'
    + '       case keeps what the picture has to throw away.\n');
process.exit(failures ? 1 : 0);
