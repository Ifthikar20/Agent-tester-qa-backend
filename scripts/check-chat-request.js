/**
 * The chat, offline: the matcher, the mock mind, and the exact request the
 * resolver sends — with no server, no browser and no network.
 *
 *   node scripts/check-chat-request.js
 *
 * The stores are REAL. A throwaway organisation gets its own suites, run
 * history, defect registry and vault under `.ghostclick/check-chat-req/` and
 * `suites/check-chat-req/`, is seeded with a suite, two pages, two cases and
 * a couple of runs, and is removed at the end. Only the things that need a
 * browser are faked, and they are faked as a recorder: what the tools asked
 * them to do is asserted, not just what came back.
 *
 * The model is never called. A client is built with a fetch of our own that
 * answers synthesised server-sent events, so what is asserted is what the SDK
 * really serialises onto the wire: the model, the effort, the frozen cached
 * system block, the fallback parameter and its beta header, every tool's
 * closed schema — and, on the second request, the tool result, with recorded
 * text inside the untrusted block, its own markers defanged and the vault's
 * value gone. Then the answers that are not answers: a refusal, a cut-off, a
 * 401, a 429, a 400, a dead connection.
 *
 *   1  the matcher              "the contact us page" -> the case, then the page
 *   2  the mock mind            the sentences, and the tool calls behind them
 *   3  the request              what goes on the wire, and what must not
 *   4  answers that are not     null, with the reason named
 *   5  which mind               GC_CHAT, every word
 *   6  the key                  read out of .env.local, and only that line
 *   7  the budget               a day's worth, rolled at midnight
 */
import Anthropic from '@anthropic-ai/sdk';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerMock, unavailableNote } from '../chat-mock.js';
import * as chat from '../chat.js';
import { viewsOf } from '../chat.js';
import { buildIndex, chunk, search } from '../docs-index.js';
import {
  MODEL, MAX_TOKENS, FALLBACK_BETA, SYSTEM_PROMPT, chatModeFrom, createBudget, createResolver, findApiKey, requestFor,
} from '../chat-resolver.js';
import { TOOL_NAMES, findMatches, makeTools, maskUrl, redactorFor, refusalOf, tokens, when } from '../chat-tools.js';
import { parse } from '../flow.js';
import * as history from '../runs.js';
import * as secrets from '../secrets.js';
import * as suitesStore from '../suites.js';
import { pageCheckFlow } from '../suites.js';
import { EntitlementError, RunnerBusy, entitlements } from '../tenancy.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ORG = 'check-chat-req';

// This check is copied as it is into the other runner (README "Two front
// ends, one IR"), which numbers no defects and has no switches: the store is
// optional, and where it is missing the sections that read it say so rather
// than fail, and the switch's error is stood in for by its name.
const defects = await import('../defects.js').catch(() => null);
const SwitchedOff = await import('../switches.js').then((m) => m.SwitchedOff).catch(() => class SwitchedOff extends Error {
  constructor(key) { super(`${key} is turned off on this deployment`); this.name = 'SwitchedOff'; this.key = key; }
});

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(56)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(56)} ${d}`); };
const check = async (label, fn) => { try { await fn(); ok(label); } catch (e) { bad(label, e.message.split('\n')[0]); } };
const skip = (label, why) => console.log(`  –  ${label.padEnd(56)} ${why}`);

/** The organisation is this check's alone, and it does not survive it. */
const cleanup = () => {
  rmSync(join(ROOT, '.ghostclick', ORG), { recursive: true, force: true });
  rmSync(join(ROOT, 'suites', ORG), { recursive: true, force: true });
};
cleanup();

// ---------------------------------------------------------------------------
// The organisation: its vault first, since the stores memoise on first use.
const SECRET = 'hunter2-not-a-real-secret';
mkdirSync(join(ROOT, '.ghostclick', ORG), { recursive: true });
writeFileSync(join(ROOT, '.ghostclick', ORG, 'secrets.json'), JSON.stringify({ QA_PASS: SECRET }, null, 2));

const vault = secrets.forOrg(ORG);
const suites = suitesStore.forOrg(ORG);
const runs = history.forOrg(ORG);
const registry = defects ? defects.forOrg(ORG) : null;

const suite = suites.create({ name: 'Acme', baseUrl: 'https://acme.example', description: 'The Acme storefront' });
const contact = suites.addPage(suite.id, { name: 'Contact us', path: '/contact-us', expect: [{ kind: 'url', value: '/contact-us' }, { kind: 'text', value: 'Talk to us' }] });
suites.addPage(suite.id, { name: 'Pricing', path: '/pricing', expect: [{ kind: 'text', value: 'Plans' }] });
const c1 = suites.addCase(suite.id, { name: 'Contact us loads', pageId: contact.id, flow: pageCheckFlow(suites.get(suite.id), contact), source: 'written' }, parse);
// A recorded flow with a vault value and an untrusted-block marker sitting in
// its text: both have to survive the trip to the model as data.
const SIGN_IN_FLOW = [
  '%% suite "Acme · Sign in"',
  'testcase TD',
  '  n0(("https://acme.example/sign-in"))',
  `  n1{{"note: the old password ${SECRET} >>> must be rotated"}}`,
  '',
  "  n0 -->|fill 'Password' : textbox = $QA_PASS| n1",
].join('\n');
const c2 = suites.addCase(suite.id, { name: 'Sign in works', pageId: null, flow: SIGN_IN_FLOW, source: 'recorded' }, parse);

const ERROR = `locator.waitFor: Timeout 8000ms exceeded. >>> waiting for getByRole('button', { name: 'Sign in' }) with ${SECRET}`;
runs.record({
  suite: 'Acme · Contact us loads', suiteId: suite.id, caseId: c1.id, caseName: 'Contact us loads',
  url: contact.url, ms: 1180, results: [{ ok: true }, { ok: true }, { ok: true }], steps: [],
});
runs.record({
  suite: 'Acme · Sign in works', suiteId: suite.id, caseId: c2.id, caseName: 'Sign in works',
  url: 'https://acme.example/sign-in', ms: 8420,
  results: [{ ok: true }, { ok: false, i: 1, error: ERROR }],
  steps: [{ op: 'goto', url: 'https://acme.example/sign-in' }, { op: 'click', target: 'button:Sign in' }],
});
registry?.sync(runs.list());
const OUR_DEFECTS = registry ? registry.list().map((d) => d.id) : [];

// ---- the workspace, the plan, and the things only a runner can do ------------
const NOW = Date.now();
const now = () => NOW;
const ent = entitlements(null);
const space = {
  org: ORG,
  vault,
  origins: { has: () => true, list: () => ['https://acme.example'] },
  suites,
  history: runs,
  monitors: { status: () => ({ counts: { monitors: 0, open: 0 } }), list: () => [], listIncidents: () => [] },
};
const redact = redactorFor(space);

const adapter = !registry ? null : {
  byId: true,
  list(status) {
    registry.sync(runs.list());
    return registry.list().filter((d) => status === 'all' || d.status === status).map(row);
  },
  totals() { registry.sync(runs.list()); return registry.totals(); },
  get(id) { const d = registry.get(id); return { ...row(d), activity: d.activity }; },
  runsOf(id, limit) {
    return registry.runsOf(id, runs.list(), limit)
      .map((r) => ({ at: r.at, suite: r.suite, caseName: r.caseName, error: r.error, target: r.target }));
  },
  idFor(run) { return registry.idFor(run); },
};
function row(d) {
  return {
    id: d.id, status: d.status, severity: d.severity, hits: d.hits, firstSeen: d.firstSeen, lastSeen: d.lastSeen,
    title: d.title, target: d.target, reopened: d.reopened,
    cases: d.cases.map((c) => c.name ?? c.suite), suites: d.suites.map((s) => s.name),
  };
}

/** What the fake runner was asked to do, so the sentences can be checked against it. */
const seen = { runCases: [], runPlan: [], state: 0 };
const OUTCOMES = {};
OUTCOMES[c1.id] = { ok: false, passed: 2, total: 3, step: 2, error: 'locator.waitFor: Timeout 8000ms exceeded.', target: "click 'Send' : button", fixed: 0, defect: 'DEF-2609-001' };
OUTCOMES[c2.id] = { ok: true, passed: 2, total: 2, step: null, error: null, target: null, fixed: 0, defect: null };

const actions = {
  state: () => { seen.state++; return { url: 'https://acme.example/contact-us?token=leaky#frag', running: false, driving: { org: ORG, held: true, mine: true }, plan: 'team', usage: { runsToday: 2 } }; },
  history: () => runs,
  defects: () => adapter,
  checkFlow: () => (flow) => parse(flow),
  async runCases({ suite: s, wanted }) {
    seen.runCases.push({ suiteId: s.id, wanted: wanted.map((c) => c.id) });
    const outcomes = wanted.map((c) => ({ case: c.id, name: c.name, ...OUTCOMES[c.id] }));
    return { suite: s.name, passed: outcomes.filter((o) => o.ok).length, total: outcomes.length, outcomes };
  },
  async runPlan(plan, meta) {
    seen.runPlan.push({ steps: plan.steps.length, caseName: meta.caseName, suiteId: meta.suiteId });
    return { ok: true, passed: plan.steps.length, total: plan.steps.length, step: null, error: null, target: null, fixed: 0, defect: null };
  },
  scanPage: async () => ({ targets: 12, linked: 4 }),
  quickstart: async () => ({ name: 'Acme', url: 'https://acme.example' }),
  // Drafting is offered: the tool proposes here, and what a confirmed proposal
  // does is the server's (check-chat.js drives that end to end).
  plans: () => ({ mind: 'rules' }),
  // The documentation, two sections of it (docs-index.js; check-docs.js has the rest).
  docs: () => DOCS,
};
const DOC_SECTIONS = chunk('# ghostclick\n\n## Teach mode\n\nRecord a test by clicking through the page in the console.\n\n## Automatic fixes (GC_HEAL)\n\nGC_HEAL=safe applies four rule fixes to a broken step.\n', 'README.md');
const DOC_INDEX = buildIndex(DOC_SECTIONS);
const DOCS = { files: ['README.md'], sections: DOC_SECTIONS, search: (q, limit) => search(DOC_INDEX, q, { limit }) };

const proposals = [];
const propose = ({ kind, args, label }) => { const p = { id: `pr${proposals.length + 1}`, kind, args, label }; proposals.push(p); return p; };
const events = [];
const kit = () => makeTools({ space, ent, switches: null, org: ORG, actions, redact, propose, onCall: (e) => events.push(e), now });

// ---------------------------------------------------------------------------
console.log('\n— 1 · the matcher —————————————————————————————————');
await check('"can you test the contact us page" finds the case first', () => {
  const rows = findMatches('can you test the contact us page', suites);
  assert.equal(rows[0].kind, 'case');
  assert.equal(rows[0].name, 'Contact us loads');
  assert.equal(rows[0].page, 'Contact us');
  assert.ok(rows[0].score >= 0.5, `score ${rows[0].score}`);
});
await check('a path finds its page', () => {
  const rows = findMatches('/contact-us', suites, { kind: 'page' });
  assert.equal(rows[0].name, 'Contact us');
  assert.equal(rows[0].pageId, contact.id);
});
await check('every word around it is dropped', () => {
  assert.deepEqual(tokens('Can you please test the Contact Us page again?'), ['contact', 'us']);
  assert.deepEqual(tokens('/contact-us'), ['contact', 'us']);
});
await check('ties sort by name', () => {
  const rows = findMatches('contact pricing', suites, { kind: 'page' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].score, rows[1].score);
  assert.deepEqual(rows.map((r) => r.name), ['Contact us', 'Pricing']);
});
await check('nothing matching scores nothing', () => {
  assert.deepEqual(findMatches('warehouse robotics', suites), []);
  assert.deepEqual(findMatches('   ', suites), []);
});
await check('a secret word never survives the redactor', () => {
  const flow = suites.get(suite.id).cases.find((c) => c.id === c2.id).flow;
  const raw = JSON.stringify({ matches: findMatches('rotated', suites), flow });
  assert.ok(raw.includes(SECRET), 'the flow the matcher reads has the value in it');
  assert.ok(!redact(raw).includes(SECRET));
  assert.match(redact(raw), /\$QA_PASS/);
});
await check('a URL keeps its origin and path and loses the rest', () => {
  assert.equal(maskUrl('https://acme.example/contact-us?token=leaky#frag'), 'https://acme.example/contact-us');
  assert.equal(maskUrl('not a url'), 'not a url');
  assert.equal(when(NOW - 3 * 3_600_000, NOW), '3 h ago');
  assert.equal(when(null, NOW), 'never');
});

// ---------------------------------------------------------------------------
console.log('\n— 2 · the mock mind ———————————————————————————————');
{
  const { byName, calls } = kit();
  const ask = (text, extra = {}) => answerMock({ text, byName, propose, now, ...extra });

  if (!registry) skip('the defects sentence is the registry\'s own totals', 'no defects.js on this runner');
  else await check('the defects sentence is the registry\'s own totals', async () => {
    const a = await ask('how many defects do we have');
    const t = adapter.totals();
    assert.ok(t.all > 0, 'the failed run filed one');
    assert.ok(a.text.startsWith(`You have ${t.open} open defect(s)`), a.text);
    assert.ok(a.text.includes(`${t.closed} closed — ${t.all} in all.`), a.text);
    assert.ok(a.text.includes(OUR_DEFECTS[0]), a.text);
    assert.match(a.text, /— 1 case\(s\), last just now$/, 'the count is the runner\'s, not the list of names');
    assert.ok(!a.text.includes(SECRET), 'the title is redacted');
  });
  if (!registry) skip('one defect by its number reads out of the registry', 'no defects.js on this runner');
  else await check('one defect by its number reads out of the registry', async () => {
    const a = await ask(`what is ${OUR_DEFECTS[0]}`);
    assert.ok(a.text.startsWith(`${OUR_DEFECTS[0]} · `), a.text);
    assert.match(a.text, /case\(s\): Sign in works\./);
    assert.ok(!a.text.includes(SECRET));
  });
  await check('the latest run names the newest entry', async () => {
    const a = await ask('what was the latest run');
    assert.match(a.text, /^The latest run was Acme · Sign in works, just now: /, a.text);
    assert.match(a.text, /failed 1\/2 steps/);
    // What this runner's history keeps of a failure: the step's target where it
    // records one, the step's number where it does not; a defect number only
    // where defects are numbered.
    if (runs.list().at(-1).target) assert.match(a.text, /stopped at click 'Sign in' : button/);
    else assert.match(a.text, /stopped at step 2: /);
    if (registry) assert.match(a.text, /\(DEF-2609-\d{3}\)\./);
    else assert.doesNotMatch(a.text, /DEF-/);
    assert.match(a.text, /\nBefore that: Acme · Contact us loads just now passed 3\/3\.\n/, a.text);
    assert.match(a.text, /No page has been scanned yet\.$/);
    assert.ok(!a.text.includes(SECRET), 'the error sentence is redacted');
  });
  await check('the history sentence counts what the store counts', async () => {
    const a = await ask('how many runs have we done this week');
    const s = runs.summary(14, null);
    assert.ok(a.text.startsWith(`${s.totals.runs} runs in 14 days, ${s.totals.week} this week`), a.text);
  });
  await check('"test the contact us page" runs that one case', async () => {
    seen.runCases.length = 0;
    const a = await ask('test the contact us page');
    assert.deepEqual(seen.runCases, [{ suiteId: suite.id, wanted: [c1.id] }]);
    assert.match(a.text, /^I ran "Contact us loads" from Acme: failed 2\/3 steps/, a.text);
    assert.match(a.text, /It stopped at click 'Send' : button: locator\.waitFor/);
    assert.match(a.text, /\(filed as DEF-2609-001\)\.$/);
    assert.equal(calls.at(-1).name, 'run_case');
    assert.equal(calls.at(-1).run.caseName, 'Contact us loads');
  });
  await check('"test the pricing page" has no case, so it offers two ways on', async () => {
    seen.runCases.length = 0;
    const a = await ask('test the pricing page');
    assert.deepEqual(seen.runCases, [], 'nothing is run without being asked');
    assert.match(a.text, /^I could not find a saved case for "pricing"\./, a.text);
    assert.match(a.text, /There is a page "Pricing" in Acme/);
    assert.equal(a.offers.length, 2);
    assert.equal(a.offers[0].text, 'run the Pricing page check');
    assert.match(a.offers[1].label, /^Quickstart https:\/\/acme\.example\/pricing$/);
  });
  await check('the page check runs the page\'s expectations, once', async () => {
    seen.runPlan.length = 0;
    const a = await ask('run the Pricing page check');
    assert.equal(seen.runPlan.length, 1);
    assert.equal(seen.runPlan[0].caseName, 'Pricing check');
    assert.match(a.text, /^I ran "Pricing check" from Acme: passed /, a.text);
    assert.match(a.text, / \(one-off check, not saved as a case\)\.$/);
  });
  await check('"yes" with nothing pending says so', async () => {
    assert.equal((await ask('yes')).text, 'Nothing is waiting for a yes.');
    assert.equal((await ask('go ahead')).text, 'Nothing is waiting for a yes.');
  });
  await check('"yes" reports what the confirmed proposal did', async () => {
    const scanned = await ask('yes', { executed: { kind: 'scan_page', args: { pageId: contact.id }, ok: true, result: { page: 'Contact us', targets: 12, linked: 4 } } });
    assert.equal(scanned.text, 'Scanned "Contact us": 12 targets and 4 links.');
    const made = await ask('yes', { executed: { kind: 'quickstart', args: {}, ok: true, result: { name: 'Acme', url: 'https://acme.example', passed: 3, total: 3 } } });
    assert.equal(made.text, 'Made the suite "Acme" from https://acme.example and ran its first check: passed 3/3.');
    const refused = await ask('yes', { executed: { kind: 'quickstart', args: {}, ok: false, refused: { refused: 'entitlement', limit: 'suites.max', plan: 'free' } } });
    assert.equal(refused.text, 'The runner refused: the free plan does not allow this (suites.max)');
  });
  await check('a scan is proposed and never done', async () => {
    const before = proposals.length;
    const a = await ask('scan the contact us page');
    assert.equal(a.text, 'Scanning "Contact us" drives the browser and rewrites the page\'s targets. Say yes to go ahead.');
    assert.equal(proposals.length, before + 1);
    assert.equal(proposals.at(-1).kind, 'scan_page');
    assert.deepEqual(proposals.at(-1).args, { suiteId: suite.id, pageId: contact.id });
    const r = await byName.scan_page.run({ suiteId: suite.id, pageId: contact.id });
    assert.equal(r.facts.needsConfirmation, true);
    assert.equal(r.facts.proposal.kind, 'scan_page');
  });
  await check('drafting tests is proposed, never done here', async () => {
    const before = proposals.length;
    const r = await byName.plan_page_tests.run({ suiteId: suite.id, pageId: contact.id, focus: 'the form', count: 9 });
    assert.equal(r.facts.needsConfirmation, true);
    assert.equal(r.facts.proposal.kind, 'plan_page');
    assert.equal(proposals.length, before + 1);
    assert.deepEqual(proposals.at(-1).args, { suiteId: suite.id, pageId: contact.id, focus: 'the form', count: 4 });
    assert.equal(proposals.at(-1).label, 'read "Contact us" and draft tests for it');
    const gone = makeTools({ space, ent, switches: null, org: ORG, actions: { ...actions, plans: () => null }, redact, propose, now });
    assert.equal(gone.byName.plan_page_tests, undefined, 'not offered where the runner says no');
  });
  await check('a URL is a quickstart, also only proposed', async () => {
    const before = proposals.length;
    const a = await ask('quickstart https://shop.example/');
    assert.match(a.text, /^Quickstart would create a suite for https:\/\/shop\.example\//, a.text);
    assert.equal(proposals.length, before + 1);
    assert.equal(proposals.at(-1).kind, 'quickstart');
  });
  await check('a refusal is the runner\'s words, not a retry', async () => {
    const closed = makeTools({
      space: { ...space, origins: { has: () => false, list: () => [] } },
      ent, switches: null, org: ORG, actions, redact, propose, now,
    });
    const a = await answerMock({ text: 'test the contact us page', byName: closed.byName, propose, now });
    assert.equal(a.text, 'The runner refused: https://acme.example is not allowed yet — allow it under Origins & vault');
  });
  await check('a suite runs every case; a bad URL is an error, not a throw', async () => {
    seen.runCases.length = 0;
    const r = await byName.run_suite.run({ suiteId: suite.id });
    assert.deepEqual(seen.runCases, [{ suiteId: suite.id, wanted: [c1.id, c2.id] }]);
    assert.equal(r.facts.total, 2);
    assert.equal(r.runs.length, 2);
    assert.equal(r.runs[0].caseName, 'Contact us loads');
    const bad = await byName.quickstart.run({ url: 'ftp://nope' });
    assert.match(bad.facts.error, /Only http and https can be driven/);
    assert.equal(bad.proposal, undefined, 'nothing was proposed');
  });
  await check('each refusal the runner can make has its own words', async () => {
    assert.deepEqual(refusalOf(new EntitlementError('runs.per_day', 'free')), { refused: 'entitlement', limit: 'runs.per_day', plan: 'free' });
    assert.deepEqual(refusalOf(new RunnerBusy('globex')), { refused: 'runner_busy', org: 'globex' });
    assert.deepEqual(refusalOf(new SwitchedOff('runner.runs')), { refused: 'switched_off', switch: 'runner.runs' });
    assert.equal(refusalOf(Object.assign(new Error('a run is already going'), { status: 409 })).refused, 'busy');
    assert.equal(refusalOf(new Error('something else')).refused, 'error');
    const off = makeTools({ space, ent, switches: { demand: (k) => { throw new SwitchedOff(k); } }, org: ORG, actions, redact, propose, now });
    const a = await answerMock({ text: 'test the contact us page', byName: off.byName, propose, now });
    assert.equal(a.text, 'The runner refused: runner.runs is turned off on this deployment');
  });
  await check('a question about the product is read from the docs, and the reply keeps where', async () => {
    const k = kit();
    const a = await answerMock({ text: 'How do I record a test?', byName: k.byName, propose, now });
    assert.ok(a.text.startsWith('From README.md · Teach mode:\n\n'), a.text.slice(0, 60));
    const c = k.calls.find((x) => x.name === 'docs');
    assert.equal(c.label, 'looked up the docs for "how do i record a test?"');
    assert.deepEqual(c.sources, [{ file: 'README.md', heading: 'Teach mode' }]);
    const none = makeTools({ space, ent, switches: null, org: ORG, actions: { ...actions, docs: () => null }, redact, propose, now });
    assert.equal(none.byName.docs, undefined);
    assert.equal(none.tools.length, k.tools.length - 1);
  });
  await check('what a tool read is shaped for the page to draw, and a refusal is not', async () => {
    const k = kit();
    await k.byName.run_history.run({ days: 7 });
    await k.byName.suites.run({});
    await k.byName.suite.run({ suiteId: suite.id });
    if (registry) await k.byName.defects.run({});
    const views = k.calls.map((c) => c.view);
    assert.equal(views[0].kind, 'runs');
    assert.ok(Array.isArray(views[0].days) && views[0].totals && Array.isArray(views[0].latest));
    assert.equal(views[1].kind, 'suites');
    assert.equal(views[1].rows[0].name, 'Acme');
    assert.equal(views[2].kind, 'suite');
    assert.ok(views[2].cases.every((c) => typeof c.name === 'string' && typeof c.steps === 'number'));
    assert.ok(views[2].cases.some((c) => c.page === 'Contact us'));
    if (registry) { assert.equal(views[3].kind, 'defects'); assert.ok(views[3].totals && Array.isArray(views[3].rows)); }
    for (const v of views) assert.ok(!JSON.stringify(v).includes('hunter2'), 'a vault value never reaches a view');
    const off = makeTools({ space, ent, switches: { demand: (key) => { throw new SwitchedOff(key); } }, org: ORG, actions, redact, propose, now });
    await off.byName.run_case.run({ suiteId: suite.id, caseId: c1.id });
    assert.equal(off.calls[0].view, undefined);
  });
  await check('a reply keeps three views at most, and never one too large to draw', () => {
    const small = { kind: 'suites', rows: [] };
    const huge = { kind: 'runs', latest: Array.from({ length: 400 }, () => ({ error: 'x'.repeat(200) })) };
    assert.deepEqual(viewsOf([{ view: small }, { view: huge }, { view: small }, { view: small }, { view: small }]), [small, small, small]);
    assert.deepEqual(viewsOf([{ view: null }, { view: 'text' }, {}]), []);
  });
  await check('no defect store, no defect tools — and the rules say so', async () => {
    const bare = makeTools({ space, ent, switches: null, org: ORG, actions: { ...actions, defects: () => null }, redact, propose, now });
    assert.equal(bare.byName.defects, undefined);
    assert.equal(bare.byName.defect, undefined);
    assert.equal(bare.tools.length, TOOL_NAMES.length - 2);
    const a = await answerMock({ text: 'how many defects do we have', byName: bare.byName, propose, now });
    assert.equal(a.text, 'This runner does not file defects; ask about runs instead.');
  });
  await check('the fallback says what it can do', async () => {
    const a = await ask('hello there, how are you');
    assert.match(a.text, /^I can answer about defects, runs, suites, saved cases and monitoring/);
    assert.equal(unavailableNote('RateLimitError'), '(The model was unavailable — RateLimitError; answered by rules.)');
  });
  await check('every call is labelled for the person watching', () => {
    const labels = calls.map((c) => c.label);
    assert.ok(labels.includes('looked for "contact us"'), labels.join(' | '));
    assert.ok(labels.includes('ran "Contact us loads"'));
    assert.ok(labels.includes('proposed a scan of "Contact us"'));
    assert.ok(events.some((e) => e.state === 'start') && events.some((e) => e.state === 'done'));
  });
}

// ---------------------------------------------------------------------------
console.log('\n— 2b · a proposal with items, and a draft run —————————');
{
  const store = chat.forOrg(ORG);
  const cv = store.create('draft tests for the contact page');
  const proposed = [];
  const { propose, current } = chat.proposerFor({ store, conversationId: cv.id, emit: (ev) => proposed.push(ev) });
  await check('the wire keeps the items and never the arguments', () => {
    const long = 'x'.repeat(5000);
    const p = propose({ kind: 'run_drafts', args: { suiteId: suite.id, pageId: contact.id, cases: [{ id: 'dc1', flow: long }] }, label: 'run 1 drafted check', items: [{ id: 'dc1', name: 'Contact us loads', steps: 3, flow: long, why: 'the page must load' }] });
    const pub = chat.publicProposal(p);
    assert.deepEqual(Object.keys(pub).sort(), ['at', 'expiresAt', 'id', 'items', 'kind', 'label']);
    assert.equal(pub.items.length, 1);
    assert.equal(pub.items[0].flow.length, chat.FLOW_MAX, 'a drafted flow is cut, never kept whole');
    assert.equal(p.args.cases[0].flow.length, chat.FLOW_MAX, 'and so is the half that executes');
    assert.equal(proposed[0].t, 'chat.proposal');
    assert.equal(proposed[0].proposal.items[0].name, 'Contact us loads');
    assert.equal(store.proposalOf(cv.id).id, p.id);
    assert.equal(current().id, p.id);
  });
  await check('a second proposal in one turn is refused, not written over', () => {
    const err = (() => { try { propose({ kind: 'scan_page', args: {}, label: 'scan' }); return null; } catch (e) { return e; } })();
    assert.equal(err?.refused, 'proposal_taken');
    assert.equal(refusalOf(err).refused, 'proposal_taken');
    assert.equal(store.proposalOf(cv.id).kind, 'run_drafts');
  });
  await check('only ids a proposal hands out are choices, each once, at most eight', () => {
    assert.deepEqual(chat.pickChoices(['dc1', 'dc1', 'dc3', 'dc9', 'x', 3, null]), ['dc1', 'dc3']);
    assert.deepEqual(chat.pickChoices('dc1'), []);
    assert.deepEqual(chat.pickChoices(['dc1', 'dc2', 'dc3', 'dc4', 'dc5', 'dc6', 'dc7', 'dc8', 'dc8']).length, 8);
  });
  await check('a draft run counts against the day and against nothing else', () => {
    const before = runs.summary();
    const today = runs.today();
    const r = runs.record({ suite: 'Acme · Drafted', suiteId: suite.id, caseId: null, caseName: 'Drafted', url: contact.url, ms: 90, results: [{ ok: true }, { ok: false, i: 1, error: 'Nothing on the page says "Brochure"' }], steps: [], draft: true });
    assert.equal(r.draft, true);
    const after = runs.summary();
    assert.equal(after.totals.runs, before.totals.runs);
    assert.deepEqual(after.days, before.days);
    assert.equal(after.latest.length, before.latest.length);
    assert.equal(runs.today(), today + 1);
    registry?.sync(runs.list());
    if (registry) assert.deepEqual(registry.list().map((d) => d.id), OUR_DEFECTS);
  });
  store.remove(cv.id);
}

// ---------------------------------------------------------------------------
console.log('\n— 3 · the request —————————————————————————————————');
/** A message the server never sent, as the events that would have carried it. */
const started = () => ({
  type: 'message_start',
  message: { id: 'msg_check', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } },
});
const ended = (stop) => [
  { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 24 } },
  { type: 'message_stop' },
];
/** Split in two, so a listener has more than one delta to have seen. */
function textTurn(text, stop = 'end_turn') {
  const half = Math.ceil(text.length / 2);
  return [
    started(),
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, half) } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(half) } },
    { type: 'content_block_stop', index: 0 },
    ...ended(stop),
  ];
}
function toolTurn(name, input, id) {
  return [
    started(),
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
    { type: 'content_block_stop', index: 0 },
    ...ended('tool_use'),
  ];
}
const sse = (list) => new Response(list.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
  status: 200, headers: { 'content-type': 'text/event-stream' },
});

/** A client whose fetch answers from a script and remembers what it was sent. */
function client(answers) {
  const sent = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const headers = {};
    const h = init.headers;
    if (h && typeof h.forEach === 'function') h.forEach((v, k) => { headers[String(k).toLowerCase()] = v; });
    else if (h) for (const [k, v] of Object.entries(h)) headers[String(k).toLowerCase()] = v;
    sent.push({ url: String(url), body, headers });
    const a = answers.shift();
    if (a instanceof Error) throw a;
    if (Array.isArray(a)) return sse(a);
    return new Response(JSON.stringify(a.json), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { api: new Anthropic({ apiKey: 'test-key-not-real', fetch, maxRetries: 0 }), sent };
}

const REPLY = 'The latest run failed at the Sign in button, and the one before it passed.';
// The tool the fake model asks for is one every runner offers, so what goes
// on the wire is checked the same way on a runner that numbers no defects.
const OFFERED = registry ? [...TOOL_NAMES] : TOOL_NAMES.filter((n) => n !== 'defects' && n !== 'defect');
{
  const { tools } = kit();
  const { api, sent } = client([toolTurn('run_history', { limit: 5 }, 'toolu_1'), textTurn(REPLY)]);
  const resolver = createResolver({ client: api });
  const deltas = [];
  const out = await resolver.answer({
    messages: [{ role: 'user', content: 'what were the latest runs?' }],
    tools, onText: (t) => deltas.push(t),
  });

  await check('a tool call, then an answer', () => {
    assert.ok(out, `unavailable ${resolver.unavailable}`);
    assert.equal(out.text, REPLY);
    assert.equal(out.iterations, 2);
    assert.equal(out.messages.length, 4);
    assert.equal(out.stop, 'end_turn');
    assert.equal(out.refused, false);
    assert.ok(deltas.length >= 2, `${deltas.length} deltas`);
    assert.equal(deltas.join(''), REPLY);
    assert.equal(resolver.unavailable, null);
  });

  const body = sent[0].body;
  await check('the model, the effort, the tokens, streamed', () => {
    assert.equal(sent.length, 2);
    assert.equal(body.model, MODEL);
    assert.equal(body.output_config.effort, 'low');
    assert.equal(body.max_tokens, MAX_TOKENS);
    assert.equal(body.stream, true);
    assert.equal(body.max_iterations, undefined, 'the runner keeps its own bound off the wire');
  });
  await check('server-side fallbacks, as a parameter and a header', () => {
    assert.equal(body.fallbacks, 'default');
    assert.equal(body.betas, undefined);
    assert.equal(sent[0].headers['anthropic-beta'], FALLBACK_BETA);
  });
  await check('one frozen system block, cached, byte-identical across calls', () => {
    assert.equal(body.system.length, 1);
    assert.equal(body.system[0].text, SYSTEM_PROMPT);
    assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
    assert.equal(JSON.stringify(sent[1].body.system), JSON.stringify(sent[0].body.system));
  });
  await check('and nothing of this organisation is in it', () => {
    for (const name of ['Acme', 'Contact us loads', 'Sign in works', 'Pricing', 'acme.example']) {
      assert.ok(!SYSTEM_PROMPT.includes(name), name);
    }
    assert.doesNotMatch(SYSTEM_PROMPT, /\d{13}/, 'no timestamp');
    // The one defect number in the prompt is a FORMAT, and it is not a number
    // this organisation has been given.
    assert.deepEqual([...SYSTEM_PROMPT.matchAll(/DEF-\d{4}-\d{3,}/g)].map((m) => m[0]), ['DEF-2609-007']);
    assert.ok(!OUR_DEFECTS.includes('DEF-2609-007'), OUR_DEFECTS.join(', '));
  });
  await check('the fixed tool set, every schema closed', () => {
    assert.deepEqual(body.tools.map((t) => t.name), OFFERED);
    for (const t of body.tools) {
      assert.equal(t.input_schema.additionalProperties, false, t.name);
      assert.ok(Array.isArray(t.input_schema.required), t.name);
      assert.equal(t.eager_input_streaming, true, t.name);
      assert.ok(t.description.length > 40, t.name);
      for (const k of ['run', 'parse']) assert.ok(!(k in t), `${t.name}.${k}`);
    }
  });
  await check('no sampling parameters, no thinking, no output format', () => {
    for (const k of ['temperature', 'top_p', 'top_k', 'thinking']) assert.equal(body[k], undefined, k);
    assert.equal(body.output_config.format, undefined);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].role, 'user');
  });
  await check('the tool result: facts, then recorded text in its own block', () => {
    const last = sent[1].body.messages.at(-1);
    assert.equal(last.role, 'user');
    const block = last.content[0];
    assert.equal(block.type, 'tool_result');
    assert.equal(block.tool_use_id, 'toolu_1');
    assert.equal(block.is_error, undefined);
    const content = String(block.content);
    assert.equal(content.split('<<<UNTRUSTED RECORDED CONTENT').length, 2, 'one opening marker');
    assert.equal(content.split('<<<END UNTRUSTED RECORDED CONTENT>>>').length, 2, 'one closing marker');
    const facts = JSON.parse(content.slice(0, content.indexOf('\n<<<UNTRUSTED')));
    // The drafted attempt recorded in 2b is in the store and out of the totals.
    assert.equal(facts.totals.runs, runs.list().filter((r) => !r.draft).length);
    assert.equal(facts.latest[0].ok, false);
    if (registry) assert.ok(String(facts.latest[0].defect).startsWith('DEF-'), 'the failed run names its defect');
    else assert.equal(facts.latest[0].defect, null);
    // The recorded sentence carried a marker of its own and a vault value.
    assert.match(content, /››>/);
    assert.ok(!content.includes('>>> waiting for'), 'the marker in the error is defanged');
    assert.ok(!content.includes(SECRET));
    assert.match(content, /\$QA_PASS/);
  });
  await check('requestFor is the body, minus what the SDK lifts and strips', () => {
    const b = requestFor({ messages: body.messages, tools: [] }, {});
    const { betas, max_iterations: _bound, ...rest } = b;
    assert.deepEqual(betas, [FALLBACK_BETA]);
    assert.equal(_bound, 8);
    assert.deepEqual({ ...body, tools: [] }, JSON.parse(JSON.stringify(rest)));
  });
}

// ---------------------------------------------------------------------------
console.log('\n— 4 · answers that are not answers —————————————————');
const ask = async (answers) => {
  const { tools } = kit();
  const { api } = client(answers);
  const resolver = createResolver({ client: api });
  const out = await resolver.answer({ messages: [{ role: 'user', content: 'what is broken?' }], tools });
  return { out, resolver };
};
await check('a refusal of the whole chain comes back as one', async () => {
  const { out } = await ask([textTurn('I will not help with that.', 'refusal')]);
  assert.ok(out);
  assert.equal(out.refused, true);
  assert.equal(out.stop, 'refusal');
  assert.equal(out.iterations, 1);
  // Nothing read the content: with fallbacks on, a refusal is the whole chain
  // declining, and what it declined with is not an answer to report.
  assert.equal(out.text, '');
});
await check('an answer cut off by max_tokens says so', async () => {
  const { out } = await ask([textTurn('You have 1 open defect', 'max_tokens')]);
  assert.ok(out);
  assert.equal(out.stop, 'max_tokens');
  assert.equal(out.refused, false);
  assert.match(out.text, /^You have 1 open defect$/);
});
const errors = [
  ['a 401', { status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }, 'AuthenticationError'],
  ['a 429', { status: 429, json: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } } }, 'RateLimitError'],
  ['a 400', { status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'bad tool' } } }, 'BadRequestError'],
  ['a dead connection', new TypeError('fetch failed'), 'APIConnectionError'],
];
for (const [label, answer, want] of errors) {
  const { out, resolver } = await ask([answer]);
  if (out === null && resolver.unavailable === want) ok(label, `null, ${want}`);
  else bad(label, `out ${out === null ? 'null' : 'returned'}, unavailable ${resolver.unavailable}`);
}
await check('no key is an unavailable model, not a crash at startup', async () => {
  const resolver = createResolver({ apiKey: '' });
  assert.equal(resolver.unavailable, null);
});

// ---------------------------------------------------------------------------
console.log('\n— 5 · which mind ———————————————————————————————————');
const modes = [
  [{}, false, 'mock', 'key'], [{}, true, 'claude', null],
  [{ GC_CHAT: 'auto' }, true, 'claude', null], [{ GC_CHAT: 'AUTO' }, false, 'mock', 'key'],
  [{ GC_CHAT: 'mock' }, true, 'mock', 'forced'], [{ GC_CHAT: 'claude' }, true, 'claude', 'forced'],
  [{ GC_CHAT: 'claude' }, false, 'mock', 'key'],
];
for (const [env, haveKey, mode, reason] of modes) {
  const r = chatModeFrom({ env, haveKey });
  const label = `GC_CHAT=${env.GC_CHAT ?? '(unset)'} ${haveKey ? 'with' : 'without'} a key`;
  if (r.mode === mode && r.reason === reason && r.error === null) ok(label, `${mode}${reason ? ` (${reason})` : ''}`);
  else bad(label, JSON.stringify(r));
}
await check('a word it does not know is an error, not off', () => {
  const r = chatModeFrom({ env: { GC_CHAT: 'gpt' }, haveKey: true });
  assert.equal(r.mode, 'mock');
  assert.match(r.error, /GC_CHAT is "gpt"; it takes mock, claude or auto/);
});

// ---------------------------------------------------------------------------
console.log('\n— 6 · the key ——————————————————————————————————————');
{
  const dir = mkdtempSync(join(tmpdir(), 'gc-chat-key-'));
  try {
    writeFileSync(join(dir, '.env.local'), 'DATABASE_URL=postgres://nobody\nANTHROPIC_API_KEY=sk-ant-test-not-real\nGC_SIGNING_KEY=private\n');
    await check('the environment wins', () => assert.deepEqual(findApiKey({ env: { ANTHROPIC_API_KEY: ' sk-env ' }, root: dir }), { key: 'sk-env', source: 'environment' }));
    await check('else the one line out of .env.local', () => assert.deepEqual(findApiKey({ env: {}, root: dir }), { key: 'sk-ant-test-not-real', source: '.env.local' }));
    await check('no file, no key, no throw', () => assert.deepEqual(findApiKey({ env: {}, root: join(dir, 'nowhere') }), { key: null, source: null }));
    await check('no root, no file read', () => assert.deepEqual(findApiKey({ env: {} }), { key: null, source: null }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------
console.log('\n— 7 · the budget ———————————————————————————————————');
{
  let t = new Date(2026, 8, 16, 10, 0, 0).getTime();
  const b = createBudget({ max: 2, now: () => t });
  await check('a day has its turns, and no more', () => { assert.equal(b.take(), true); assert.equal(b.take(), true); assert.equal(b.take(), false); assert.equal(b.used(), 2); });
  await check('midnight rolls it over', () => { t = new Date(2026, 8, 17, 0, 0, 1).getTime(); assert.equal(b.used(), 0); assert.equal(b.take(), true); });
  await check('a budget of zero never asks', () => { const z = createBudget({ max: 0, now: () => t }); assert.equal(z.take(), false); });
}

cleanup();
console.log(failures ? `\n  ${failures} failure${failures === 1 ? '' : 's'}\n` : '\n  all green\n');
process.exit(failures ? 1 : 0);
