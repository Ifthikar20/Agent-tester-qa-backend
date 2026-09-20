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
 *   6  a false alarm  a plain page rule's incident, judged a false alarm: closed by the judge, its defect with it,
 *                     the state as it is now the baseline; judged real, it stands
 *   7  another width  a whole page read at 820px is anticipated; the second reading is kept as that width's own
 *                     baseline after one question; a control gone at 820px is judged against it; a "yes" at a
 *                     third width opens an incident and holds the width strictly until somebody resolves it
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

// ---------------------------------------------------------------------------
section('6 · a false alarm on a plain rule');
// The engine's timers are unref'd (a server has sockets to keep it alive; this check has none): held open until the end.
const keepAlive = setInterval(() => {}, 1000);
// A rule the arithmetic answers ("nothing on the page may change") and an
// incident it opened; Claude reads the change as a false alarm. The incident
// closes by the judge — not only on a judged clause — its defect with it, and
// the state as it is now is the baseline. Judged real, it stands.
const defectEvents = [];
monitoring.configure({ budget: createBudget({ max: 10 }), defects: (org, event, { incident }) => { defectEvents.push([event, incident?.id ?? null]); return event === 'removed' ? null : 'DEF-2609-777'; } });
const block = (k, t, y, text, extra = {}) => ({ k, t, x: 40, y, w: 600, h: 40, ...(text != null ? { text, th: 'h' + text.replace(/\W/g, '') } : {}), ...extra });
const pageSnap = (blocks, env = { innerWidth: 1180, innerHeight: 760 }) => ({
  ts: Date.now(), url: 'http://x.test/', exists: true, visible: true, inViewport: true, kind: 'page', tag: 'page', id: '', classes: [], positioning: 'static',
  rect: { x: 0, y: 0, w: env.innerWidth, h: 2400 }, docRect: { x: 0, y: 0, w: env.innerWidth, h: 2400 }, styles: {}, metrics: { fontSizePx: null, lineHeightPx: null, opacity: 1 },
  title: 'x', text: blocks.map((b) => b.text ?? '').join(' '), textLength: 100, counts: { children: 1, descendants: blocks.length, rows: null, openDetails: 0, blocks: blocks.length },
  htmlHash: 'p' + blocks.map((b) => b.k + b.y + (b.th ?? '') + (b.lh ?? '')).join(''), blocks, truncated: false, env: { ...env, dpr: 1, scrollX: 0, scrollY: 0, scroll: { x: 0, y: 0 } }, sig: 'page|' + blocks.length,
});
const BLOCKS = [
  block('b1', 'h1', 20, 'Acme'), block('b2', 'p', 80, 'Every order, every carrier, one dashboard.'),
  block('b3', 'a', 140, 'Pricing', { c: 1, lh: 'L1', lp: '/pricing' }), block('b4', 'button', 200, 'Create account', { c: 1, lh: 'B1', lp: 'type=button' }),
  block('b5', 'aside', 260, null, { h: 120 }), block('b6', 'p', 280, 'Shown beside the notes on a desktop.', { p: 'b5' }),
];
/** The page as the fake agent will re-measure it, and the report the watcher would have sent. */
const feed = (snap, reason = 'report') => { current = snap; engine.ingest({ monitorId: pm.id, snapshot: { ...snap }, reason }); };
current = pageSnap(BLOCKS); currentExcerpt = { html: 'h1 "Acme" @40,20 600x40', path: [], siblings: [], children: [], childCount: 6 };
const pm = await engine.create({ selector: ':page', ruleText: 'Nothing on the page may change', label: 'Whole page' });
{
  if (pm.spec.kind === 'page' && pm.spec.checks.map((c) => c.id).join(',') === 'logic,elements,content,alignment' && pm.spec.needsLlmJudgment === false) ok('a plain page rule: four checks, nothing to judge', pm.spec.checks.map((c) => c.id).join(' ')); else bad('a plain page rule: four checks, nothing to judge', JSON.stringify(pm.spec));
  verdicts.push({ violation: false, severity: 'low', explanation: 'The paragraph was reworded to say the same thing. Nothing a user would notice changed.' });
  const from = events.length;
  feed(pageSnap(BLOCKS.map((b) => (b.k === 'b2' ? block('b2', 'p', 80, 'Every order, every carrier, one dashboard — reworded.') : b))));
  await settle(() => events.slice(from).some((e) => e.t === 'incident.opened'));
  const opened = events.slice(from).find((e) => e.t === 'incident.opened')?.incident;
  if (opened && opened.status === 'open' && opened.judgment === false && opened.violations.map((v) => v.metric).join(',') === 'content') ok('the reworded paragraph opens an ordinary content incident', opened.id); else bad('the reworded paragraph opens an ordinary content incident', JSON.stringify(opened && { status: opened.status, judgment: opened.judgment, v: opened.violations.map((x) => x.metric) }));
  const resolved = await settle(() => events.slice(from).some((e) => e.t === 'incident.resolved' && e.incident.id === opened?.id));
  const inc = resolved ? engine.incident(opened.id) : null;
  if (inc && inc.resolvedBy === 'judge' && inc.verdict?.source === 'claude' && inc.verdict.violation === false) ok('judged a false alarm: resolved by the judge', inc.verdict.explanation.slice(0, 50)); else bad('judged a false alarm: resolved by the judge', JSON.stringify(inc && { by: inc.resolvedBy, status: inc.status, verdict: inc.verdict }));
  const mm = engine.get(pm.id);
  if (mm.state === 'ok' && mm.openIncidentId === null && /reworded/.test(mm.baseline.blocks.find((b) => b.k === 'b2')?.text ?? '')) ok('the monitor is ok and the reworded page is its baseline'); else bad('the monitor is ok and the reworded page is its baseline', JSON.stringify({ state: mm.state, open: mm.openIncidentId }));
  if (defectEvents.some(([e, id]) => e === 'opened' && id === opened?.id) && defectEvents.some(([e, id]) => e === 'resolved' && id === opened?.id) && inc?.defect === 'DEF-2609-777') ok('its defect was filed and closed with it', inc.defect); else bad('its defect was filed and closed with it', JSON.stringify(defectEvents));
  const call = resolver.calls.at(-1);
  if (call?.diff?.pageChanges?.totals?.content === 1 && call.diff.pageChanges.scrolled === null && call.direct === false) ok('the judge saw the totals by category, and no scroll', JSON.stringify(call.diff.pageChanges.totals).slice(0, 60) + '…'); else bad('the judge saw the totals by category, and no scroll', JSON.stringify(call?.diff));
  // Judged real: the incident stands as an ordinary open one, in Claude's words.
  verdicts.push({ violation: true, severity: 'high', explanation: 'The Pricing link now points at a different page. A test that follows it lands elsewhere.' });
  const from2 = events.length;
  feed(pageSnap(engine.get(pm.id).baseline.blocks.map((b) => (b.k === 'b3' ? { ...b, lh: 'L2', lp: '/pricing-2' } : b))));
  await settle(() => events.slice(from2).some((e) => e.t === 'incident.opened'));
  const id2 = events.slice(from2).find((e) => e.t === 'incident.opened')?.incident?.id;
  const stood = await settle(() => events.slice(from2).some((e) => e.t === 'incident.updated' && e.incident.id === id2 && e.incident.verdict?.source === 'claude'));
  const inc2 = stood ? engine.incident(id2) : null;
  if (inc2 && inc2.status === 'open' && inc2.verdict.violation === true && inc2.violations[0].metric === 'logic' && engine.get(pm.id).state === 'violated') ok('judged real: a logic incident stands, in Claude’s words', inc2.verdict.explanation.slice(0, 50)); else bad('judged real: a logic incident stands, in Claude’s words', JSON.stringify(inc2 && { status: inc2.status, verdict: inc2.verdict, v: inc2.violations.map((x) => x.metric) }));
  await engine.resolve(id2, 'manual');
}

// ---------------------------------------------------------------------------
section('7 · the whole page at another width');
{
  // The same page read at 820px: the aside is not shown and everything sits
  // elsewhere — anticipated, not reported. One reading is a window being
  // dragged; the second at that width is kept as the width's own baseline,
  // after one question to Claude. Then a control gone at 820px is judged
  // against that baseline; and at a third width a "yes" from Claude opens an
  // incident and holds the width strictly until somebody resolves it.
  const base = engine.get(pm.id).baseline;
  const at820 = (blocks) => pageSnap(blocks, { innerWidth: 820, innerHeight: 1100 });
  const narrowBlocks = base.blocks.filter((b) => b.k !== 'b5' && b.k !== 'b6').map((b, i) => ({ ...b, x: 20, y: 30 + i * 90, w: 780 }));
  verdicts.push({ violation: false, severity: 'low', explanation: 'At 820px the sidebar is hidden and the page is one column. That is the responsive layout, not a regression.' });
  let from = events.length;
  feed(at820(narrowBlocks));
  await settle(() => events.slice(from).some((e) => e.t === 'monitor.tick' && e.monitorId === pm.id));
  const tick = events.slice(from).find((e) => e.t === 'monitor.tick' && e.monitorId === pm.id);
  if (tick && tick.ok === true && tick.metrics?.viewport?.width === 820 && tick.metrics.viewport.baseline === 1180 && tick.metrics.viewport.adopted === false) ok('one reading at 820px: ok, noted on the tick, not yet kept', JSON.stringify(tick.metrics.viewport)); else bad('one reading at 820px: ok, noted on the tick, not yet kept', JSON.stringify(tick?.metrics));
  if (!engine.get(pm.id).baselines) ok('a window being dragged keeps nothing'); else bad('a window being dragged keeps nothing', JSON.stringify(Object.keys(engine.get(pm.id).baselines)));
  from = events.length;
  feed(at820(narrowBlocks), 'heartbeat');
  const kept = await settle(() => events.slice(from).some((e) => e.t === 'log' && /kept as the 820px baseline/.test(e.msg)));
  const keptLog = kept ? events.slice(from).find((e) => e.t === 'log' && /kept as the 820px baseline/.test(e.msg)).msg : '';
  if (kept && /measured at 820px; the baseline is 1180px: 2 blocks are not shown at this width, which a responsive layout may do on purpose — kept as the 820px baseline \(Claude: At 820px/.test(keptLog)) ok('the second is kept as the 820px baseline, after one question', keptLog.slice(0, 70) + '…'); else bad('the second is kept as the 820px baseline, after one question', keptLog || 'no log line');
  const q = resolver.calls.at(-1);
  if (q?.violations?.[0]?.checkId === 'viewport' && /measured at 820px/.test(q.violations[0].message) && q.diff?.pageChanges?.viewport?.hidden === 2 && q.diff.pageChanges.viewport.anticipated === true) ok('the question carried the viewport note and what is hidden', q.violations[0].message.slice(0, 60) + '…'); else bad('the question carried the viewport note and what is hidden', JSON.stringify(q && { v: q.violations, viewport: q.diff?.pageChanges?.viewport }));
  const pub = engine.publicMonitor(engine.get(pm.id));
  if (pub.baselines?.['820'] && !pub.baselines['820'].blocks && pub.baselines['820'].counts.blocks === 4 && engine.get(pm.id).baselines['820'].blocks.length === 4 && pub.baseline.env.innerWidth === 1180) ok('baselines[820] kept whole in the store, compacted for the API; the 1180px baseline untouched'); else bad('baselines[820] kept whole in the store, compacted for the API; the 1180px baseline untouched', JSON.stringify(pub.baselines));
  if (!events.slice(from).some((e) => e.t === 'incident.opened')) ok('and no incident opened'); else bad('and no incident opened');
  // A control gone at 820px is judged against the 820px baseline: an elements incident, in Claude's words too.
  verdicts.push({ violation: true, severity: 'high', explanation: 'The Create account button is gone at this width. A user on a tablet cannot sign up.' });
  from = events.length;
  feed(at820(narrowBlocks.filter((b) => b.k !== 'b4')));
  await settle(() => events.slice(from).some((e) => e.t === 'incident.opened'));
  const gone = events.slice(from).find((e) => e.t === 'incident.opened')?.incident;
  if (gone?.violations[0]?.metric === 'elements' && gone.before.snapshot.env.innerWidth === 820 && gone.diff.pageChanges.viewport === null && /Create account/.test(gone.violations[0].actual)) ok('a button gone at 820px: an elements incident against the 820px baseline', gone.violations[0].actual.slice(0, 60)); else bad('a button gone at 820px: an elements incident against the 820px baseline', JSON.stringify(gone && { v: gone.violations.map((x) => [x.metric, x.actual]), w: gone.before?.snapshot?.env?.innerWidth, viewport: gone.diff?.pageChanges?.viewport }));
  await settle(() => gone && engine.incident(gone.id).verdict?.source === 'claude');
  if (gone && engine.incident(gone.id).status === 'open' && engine.get(pm.id).state === 'violated') ok('judged real, it stands'); else bad('judged real, it stands', JSON.stringify(gone && { status: engine.incident(gone.id).status, state: engine.get(pm.id).state }));
  if (gone) await engine.resolve(gone.id, 'manual');
  const after = engine.get(pm.id);
  if (after.state === 'ok' && after.baselines['820'].blocks.length === 3 && after.baseline.blocks.length === 6) ok('resolved by hand at 820px: the 820px baseline moves, the 1180px one does not', `${after.baselines['820'].blocks.length} blocks at 820, ${after.baseline.blocks.length} at 1180`); else bad('resolved by hand at 820px: the 820px baseline moves, the 1180px one does not', JSON.stringify({ state: after.state, b820: after.baselines?.['820']?.blocks?.length, b1180: after.baseline.blocks.length }));
  // A third width, where Claude says the re-flow itself is a regression: an
  // incident in its words, the width held strictly, nothing kept until resolved.
  const at375 = (blocks) => pageSnap(blocks, { innerWidth: 375, innerHeight: 667 });
  const phoneBlocks = base.blocks.filter((b) => b.k !== 'b5' && b.k !== 'b6' && b.k !== 'b3').map((b, i) => ({ ...b, x: 10, y: 20 + i * 70, w: 355 }));
  verdicts.push({ violation: true, severity: 'high', explanation: 'At 375px the Pricing link is gone, not merely re-flowed. A phone user cannot reach pricing.' });
  from = events.length;
  feed(at375(phoneBlocks));
  await settle(() => events.slice(from).some((e) => e.t === 'monitor.tick' && e.monitorId === pm.id));
  feed(at375(phoneBlocks), 'heartbeat');
  await settle(() => events.slice(from).some((e) => e.t === 'incident.opened'));
  const held = events.slice(from).find((e) => e.t === 'incident.opened')?.incident;
  if (held && held.verdict?.source === 'claude' && held.verdict.violation === true && held.status === 'open' && held.violations.some((x) => x.metric === 'elements') && !engine.get(pm.id).baselines['375'] && engine.get(pm.id).widthVerdicts?.['375']) ok('a "yes" at 375px: an incident in Claude’s words, nothing kept, the width held', held.violations.map((x) => x.metric).join(',')); else bad('a "yes" at 375px: an incident in Claude’s words, nothing kept, the width held', JSON.stringify(held && { status: held.status, verdict: held.verdict, v: held.violations.map((x) => x.metric), baselines: Object.keys(engine.get(pm.id).baselines ?? {}) }));
  const openHere = () => engine.listIncidents('open').filter((i) => i.monitorId === pm.id).length;
  if (engine.get(pm.id).state === 'violated' && openHere() === 1) ok('and counts as open'); else bad('and counts as open', JSON.stringify({ state: engine.get(pm.id).state, open: openHere() }));
  from = events.length;
  feed(at375(phoneBlocks), 'heartbeat');
  await wait(1200);
  if (engine.get(pm.id).state === 'violated' && !events.slice(from).some((e) => e.t === 'incident.resolved')) ok('the next reading at 375px does not talk it out of it'); else bad('the next reading at 375px does not talk it out of it');
  if (held) await engine.resolve(held.id, 'manual');
  const finished = engine.get(pm.id);
  if (finished.state === 'ok' && finished.baselines['375']?.blocks.length === 3 && !finished.widthVerdicts) ok('resolved by hand: the reading is the 375px baseline and the width is held no more'); else bad('resolved by hand: the reading is the 375px baseline and the width is held no more', JSON.stringify({ state: finished.state, b375: finished.baselines?.['375']?.blocks?.length, held: finished.widthVerdicts }));
}

clearInterval(keepAlive);
engine.detach();
cleanup();
console.log(failures ? `\n  ${failures} failure${failures === 1 ? '' : 's'}\n` : '\n  all green\n');
process.exit(failures ? 1 : 0);
