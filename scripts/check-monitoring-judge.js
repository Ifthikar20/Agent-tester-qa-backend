/**
 * A rule that is not a number, judged: the engine alone, no browser, a
 * scripted model.
 *
 *   node scripts/check-monitoring-judge.js
 *
 * "The call to action must stay the most prominent element" compiles to a
 * judgment clause: proxies say the element changed, and whether the rule
 * broke is Claude's to say (monitor-resolver.js JUDGE_DIRECT_SYSTEM). This
 * drives the engine (monitor.js) with a fake page agent and a fake resolver
 * that answers scripted verdicts, and asserts what each answer does:
 *
 *   1  compile        a judgment clause, its proxies marked, the markup watched
 *   2  a change       opens a `judging` incident and asks the judge — with the clause, both excerpts, direct
 *   3  judged fine    resolved by the judge, the new state adopted as the baseline, the same state not asked again
 *   4  judged broken  the incident stands as `open`, in Claude's words
 *   5  no answer      the incident stands as `open`, saying why; the budget holds
 */
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as monitoring from '../monitor.js';
import { createBudget } from '../monitor-resolver.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORG = 'check-mon-judge';
let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(56)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(56)} ${d}`); };
const section = (t) => console.log(`\n— ${t} ${'—'.repeat(Math.max(2, 56 - t.length))}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = () => rmSync(join(ROOT, '.ghostclick', ORG), { recursive: true, force: true });
cleanup();

// ---- a page that never was, and a model that answers from a script ------------------
const snap = (htmlHash, extra = {}) => ({
  ts: Date.now(), url: 'http://x.test/', exists: true, visible: true, inViewport: true, tag: 'a', id: 'cta', classes: ['cta'], positioning: 'static',
  rect: { x: 10, y: 10, w: 120, h: 40 }, docRect: { x: 10, y: 10, w: 120, h: 40 },
  styles: { fontSize: '16px', fontWeight: '700', color: 'rgb(0, 0, 0)', backgroundColor: 'rgb(255, 0, 0)', display: 'block', visibility: 'visible', opacity: '1' },
  metrics: { fontSizePx: 16, lineHeightPx: 19.2, opacity: 1 }, text: 'Buy now', textLength: 7,
  counts: { children: 0, descendants: 0, rows: null, openDetails: 0 }, htmlHash, env: {}, sig: htmlHash, ...extra,
});
const excerptWith = (cls) => ({ html: `<a id="cta" class="${cls}" href="/buy">Buy now</a>`, path: ['body', 'header.top'], siblings: ['a.nav "Pricing"'], children: [], childCount: 0 });
let current = snap('aaaa');
let currentExcerpt = excerptWith('cta');
const agent = {
  alive: () => true, url: () => 'http://x.test/', armed: new Set(),
  async measure() { return { ...current }; },
  async excerpt() { return { ...currentExcerpt }; },
  async screenshotElement() { return null; },
  async arm() { return true; }, async disarm() { return true; }, async flash() { return true; }, async measureAll() { return { monitors: [] }; },
};
const verdicts = [];
const resolver = {
  unavailable: null, calls: [],
  async compile() { return null; },
  async judge(input) {
    this.calls.push(input);
    const v = verdicts.shift();
    if (!v) { this.unavailable = 'APIConnectionError'; return null; }
    return { ...v, source: 'claude', at: Date.now(), model: 'test-model' };
  },
};
// Events are kept as they were said: the engine goes on mutating the objects it emitted.
const events = [];
// One compile (which the scripted model declines) and three judgments; the fifth question finds it spent.
const budget = createBudget({ max: 4 });
monitoring.configure({
  emitTo: (org, ev) => { if (org === ORG) events.push(JSON.parse(JSON.stringify(ev))); },
  log: { error() {}, warn() {}, info() {} },
  llm: { mode: 'claude', model: 'test-model', key: { have: true, from: 'environment' } },
  resolver, budget, isIdle: () => true, judgeIntervalMs: 0,
});
const engine = monitoring.forOrg(ORG);
engine.attach(agent);
const settle = async (pred, ms = 4000) => { const t = Date.now() + ms; while (Date.now() < t) { if (pred()) return true; await wait(50); } return pred(); };
const incidentsOf = () => engine.listIncidents(null);

// ---------------------------------------------------------------------------
section('1 · compile');
const m = await engine.create({ selector: '#cta', ruleText: 'the call to action must stay the most prominent element', tag: 'a', label: 'CTA' });
{
  const cl = m.spec.clauses;
  if (cl.length === 1 && cl[0].outcome === 'judgment') ok('one clause, to be judged', cl[0].text); else bad('one clause, to be judged', JSON.stringify(cl));
  const html = m.spec.checks.find((c) => c.metric === 'htmlHash');
  if (html && html.judgment === true && html.op === 'unchanged' && m.spec.checks.every((c) => c.judgment)) ok('its proxies are marked, the markup among them', m.spec.checks.map((c) => `${c.id}:${c.metric}`).join(' ')); else bad('its proxies are marked, the markup among them', JSON.stringify(m.spec.checks));
  if (m.baselineExcerpt?.html.includes('class="cta"') && m.state === 'ok') ok('the baseline carries the markup', m.baselineExcerpt.path.join(' > ')); else bad('the baseline carries the markup', JSON.stringify(m.baselineExcerpt));
}

// ---------------------------------------------------------------------------
section('2 · a change asks the judge');
verdicts.push({ violation: false, severity: 'low', explanation: 'The link gained a class that changes nothing visible. It is still the header’s most prominent element.' });
current = snap('bbbb'); currentExcerpt = excerptWith('cta cta--tracked');
engine.ingest({ monitorId: m.id, snapshot: { ...current }, reason: 'report' });
{
  const opened = await settle(() => events.some((e) => e.t === 'incident.opened'));
  const inc = opened ? events.find((e) => e.t === 'incident.opened').incident : null;
  if (inc && inc.status === 'judging' && inc.judgment === true) ok('a judging incident opens', inc.id); else bad('a judging incident opens', JSON.stringify(inc && { status: inc.status, judgment: inc.judgment }));
  if (inc?.violations.some((v) => v.metric === 'htmlHash') && inc.after?.excerpt?.html.includes('cta--tracked')) ok('the markup check failed and the after markup is on it'); else bad('the markup check failed and the after markup is on it', JSON.stringify(inc?.violations));
  await settle(() => resolver.calls.length >= 1);
  const call = resolver.calls[0];
  if (call && call.direct === true && /most prominent/.test(call.judgmentHint) && call.beforeExcerpt?.html.includes('class="cta"') && call.afterExcerpt?.html.includes('cta--tracked')) ok('asked directly, with the clause and both excerpts'); else bad('asked directly, with the clause and both excerpts', JSON.stringify(call && { direct: call.direct, hint: call.judgmentHint, before: call.beforeExcerpt?.html, after: call.afterExcerpt?.html }));
}

// ---------------------------------------------------------------------------
section('3 · judged fine');
{
  const resolved = await settle(() => events.some((e) => e.t === 'incident.resolved'));
  const inc = resolved ? events.find((e) => e.t === 'incident.resolved').incident : null;
  if (inc && inc.resolvedBy === 'judge' && inc.verdict?.source === 'claude' && inc.verdict.violation === false) ok('resolved by the judge, with its verdict', inc.verdict.explanation.slice(0, 50)); else bad('resolved by the judge, with its verdict', JSON.stringify(inc && { by: inc.resolvedBy, verdict: inc.verdict }));
  const mm = engine.get(m.id);
  if (mm.baseline.htmlHash === 'bbbb' && mm.baselineExcerpt.html.includes('cta--tracked') && mm.state === 'ok' && mm.openIncidentId === null) ok('the new state is the baseline, the monitor ok', `htmlHash ${mm.baseline.htmlHash}`); else bad('the new state is the baseline, the monitor ok', JSON.stringify({ hash: mm.baseline.htmlHash, state: mm.state, open: mm.openIncidentId }));
  const before = incidentsOf().length;
  engine.ingest({ monitorId: m.id, snapshot: { ...current }, reason: 'report' });
  await wait(1200);
  if (incidentsOf().length === before && engine.get(m.id).state === 'ok') ok('the same state is not asked about again'); else bad('the same state is not asked about again', `${incidentsOf().length} incidents`);
  if (engine.status().counts.open === 0) ok('nothing counts as open'); else bad('nothing counts as open', String(engine.status().counts.open));
}

// ---------------------------------------------------------------------------
section('4 · judged broken');
verdicts.push({ violation: true, severity: 'high', explanation: 'The call to action lost its cta class and is now a plain link. It is no longer the most prominent element.' });
current = snap('cccc'); currentExcerpt = excerptWith('plain');
const from4 = events.length;
engine.ingest({ monitorId: m.id, snapshot: { ...current }, reason: 'report' });
{
  await settle(() => events.slice(from4).some((e) => e.t === 'incident.opened'));
  const id = events.slice(from4).find((e) => e.t === 'incident.opened')?.incident?.id;
  const stood = await settle(() => events.slice(from4).some((e) => e.t === 'incident.updated' && e.incident.id === id && e.incident.status === 'open' && e.incident.verdict?.source === 'claude'));
  const inc = stood ? engine.incident(id) : null;
  if (inc && inc.status === 'open' && inc.verdict.violation === true && /plain link/.test(inc.verdict.explanation)) ok('the incident stands, in Claude’s words', inc.verdict.severity); else bad('the incident stands, in Claude’s words', JSON.stringify(inc && { status: inc.status, verdict: inc.verdict }));
  if (engine.status().counts.open === 1 && engine.listIncidents('open').length === 1) ok('and counts as open'); else bad('and counts as open', String(engine.status().counts.open));
  if (engine.get(m.id).baseline.htmlHash === 'bbbb') ok('the baseline did not move'); else bad('the baseline did not move', engine.get(m.id).baseline.htmlHash);
  await engine.resolve(id, 'manual');
}

// ---------------------------------------------------------------------------
section('5 · no answer');
current = snap('dddd'); currentExcerpt = excerptWith('other');
const from5 = events.length;
engine.ingest({ monitorId: m.id, snapshot: { ...current }, reason: 'report' });
{
  await settle(() => events.slice(from5).some((e) => e.t === 'incident.opened'));
  const id = events.slice(from5).find((e) => e.t === 'incident.opened')?.incident?.id;
  const settled = await settle(() => events.slice(from5).some((e) => e.t === 'incident.updated' && e.incident.id === id && e.incident.status === 'open'));
  const inc = settled ? engine.incident(id) : null;
  if (inc && inc.status === 'open' && inc.verdict?.source === 'error' && inc.verdict.unjudged === 'APIConnectionError' && /set ANTHROPIC_API_KEY|judgment/.test(inc.verdict.explanation)) ok('a dead model leaves the incident open, saying why', inc.verdict.unjudged); else bad('a dead model leaves the incident open, saying why', JSON.stringify(inc && { status: inc.status, verdict: inc.verdict }));
  await engine.resolve(id, 'manual');
  if (budget.used() === 4 && resolver.calls.length === 3) ok('every question came out of the budget, the compile too', `${budget.used()}/${budget.max}`); else bad('every question came out of the budget, the compile too', `${budget.used()}/${budget.max}, ${resolver.calls.length} judge calls`);
  // The next question has no budget left: the incident stands at once.
  current = snap('eeee'); currentExcerpt = excerptWith('another');
  const from = events.length;
  engine.ingest({ monitorId: m.id, snapshot: { ...current }, reason: 'report' });
  await settle(() => events.slice(from).some((e) => e.t === 'incident.opened'));
  const id2 = events.slice(from).find((e) => e.t === 'incident.opened')?.incident?.id;
  const stood = await settle(() => events.slice(from).some((e) => e.t === 'incident.updated' && e.incident.id === id2 && e.incident.status === 'open'));
  const inc2 = stood ? engine.incident(id2) : null;
  if (inc2 && inc2.status === 'open' && /budget/.test(inc2.verdict?.unjudged ?? '') && resolver.calls.length === 3) ok('a spent budget does the same, without asking', inc2.verdict.unjudged); else bad('a spent budget does the same, without asking', JSON.stringify(inc2 && { status: inc2.status, verdict: inc2.verdict, calls: resolver.calls.length }));
}

engine.detach();
cleanup();
console.log(failures ? `\n  ${failures} failure${failures === 1 ? '' : 's'}\n` : '\n  all green\n');
process.exit(failures ? 1 : 0);
