/**
 * Agentic monitoring, end to end: a runner of this check's own, in mock mode,
 * driven over the API and the socket exactly the way the UI drives it.
 *
 *   node scripts/check-monitoring.js
 *   BASE_URL=http://localhost:3000 node scripts/check-monitoring.js   # a running runner, in mock mode
 *
 * The page under test is public/monitor.html: a hero paragraph, a sign-up
 * button, a five-row table, a ticker that never stops — and a panel of real
 * buttons that break each of them, pressed here through the flow language
 * (`click button:Grow text`), so the change reaches the page the way a run's
 * would. No model: `GC_MONITOR_LLM=mock`, and the runner says so first.
 *
 *   1  which mind             mock, and nothing armed
 *   2  a monitor needs a page  409 before a page; then a rule, its checks, its clause, its markup, its baseline shot
 *   2c what the preview says    clause by clause, and Compile with Claude refused on a mock runner
 *   3  a change opens an incident   the numbers, the after shot, the mock verdict
 *   4  and recovery closes it       resolved by `auto`
 *   5  churn stays quiet            a ticker and a clock are not incidents
 *   6  rows, visibility, accepting  exactly N rows; always visible; manual resolve → acknowledged
 *   6b a rule the table cannot read  a judgment clause, a markup-only change, a verdict that asks for a key
 *   6c the whole page, watched     blocks, not one element; a ticker learned and ignored; a swapped class is
 *                                   not a change; new words are; a new row is a layout incident that names it
 *   6d scrolling is not a change   public/monitor-scroll.html scrolls an inner main: a scroll of 1090px reads
 *                                   the same; a link re-pointed, a button gone, copy reworded, two sections
 *                                   overlapping are the four incidents "nothing may change" stands for; the
 *                                   content slid by a transform is forgiven; an iPad's width is anticipated
 *   7  pause, resume, delete        quiet while paused; gone means gone, shot and all
 *   8  reloads and other pages      re-armed after a reload; not on this page, not missing
 *   8b every visit runs the check   the visit is counted; late is not missing; gone is
 *   9  picking from the canvas      hover + click on the video chooses, and never clicks through;
 *                                   the panel is told what is hovered, what was picked, and a miss
 *  10  secrets never reach a snapshot
 *  11  cleanup
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import WebSocket from 'ws';
import { BUNDLE } from '../monitor-page.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.GC_MONITOR_PORT) || 3405;
const EXTERNAL = process.env.BASE_URL || null;
const BASE = EXTERNAL || `http://localhost:${PORT}`;
const WS_URL = `${BASE.replace(/^http/, 'ws')}/ws`;
const FIXTURE = `${BASE}/monitor.html`;
const SCROLL = `${BASE}/monitor-scroll.html`;
const OTHER = `${BASE}/demo.html`;
const HERO = '[data-testid="hero-copy"]';
const STATE = join(ROOT, '.ghostclick', 'local');

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(50)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(50)} ${d}`); };
const section = (t) => console.log(`\n— ${t} ${'—'.repeat(Math.max(2, 50 - t.length))}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const isPng = (buf) => buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, json };
}
async function bytes(path) {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
}

/**
 * A viewer: a socket that remembers what it was told. Frames arrive as binary
 * and everything else as JSON on the same connection, so they are kept apart
 * here once. `until` waits for a message from `from` on — take `at()` before
 * the act, so a message from before it cannot satisfy the wait.
 */
function viewer() {
  const ws = new WebSocket(WS_URL);
  const v = { ws, msgs: [], frames: 0, greeting: null };
  ws.on('message', (data, isBinary) => {
    if (isBinary) { v.frames++; return; }
    let m;
    try { m = JSON.parse(data); } catch { return; }
    v.msgs.push(m);
    if (m.t === 'ready' && !v.greeting) v.greeting = m;
  });
  v.open = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  v.send = (m) => ws.send(JSON.stringify(m));
  v.at = () => v.msgs.length;
  v.until = async (pred, ms = 8000, from = 0) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      for (let i = from; i < v.msgs.length; i++) if (pred(v.msgs[i])) return v.msgs[i];
      await wait(50);
    }
    return null;
  };
  v.none = async (pred, ms, from = 0) => (await v.until(pred, ms, from)) === null;
  return v;
}

/** Open a page the way the console does, allowing its origin if the runner asks. */
async function open(v, url) {
  const from = v.at();
  v.send({ t: 'open', url });
  const answer = await v.until((m) => (m.t === 'targets' && m.url && m.url.startsWith(url)) || m.t === 'needs.origin', 15000, from);
  if (answer?.t === 'needs.origin') {
    v.send({ t: 'origin.add', origin: answer.origin, thenOpen: url });
    await v.until((m) => m.t === 'origins', 5000, from);
    const again = v.at();
    v.send({ t: 'open', url });
    return !!(await v.until((m) => m.t === 'targets' && m.url && m.url.startsWith(url), 15000, again));
  }
  return !!answer;
}
/** One line of the flow language, run; the run's end, or null. */
async function run(v, line) {
  const from = v.at();
  v.send({ t: 'command', text: line, pace: 0 });
  return v.until((m) => m.t === 'run.end' || (m.t === 'refused' && m.of === 'run'), 20000, from);
}
const create = (label, selector, ruleText) => api('POST', '/api/monitors', { selector, label, ruleText });
async function sweep() {
  const { json } = await api('GET', '/api/monitors');
  for (const m of json?.monitors ?? []) if (String(m.label).startsWith('check-')) await api('DELETE', `/api/monitors/${m.id}`);
}
const incidentFor = (v, id, from, ms = 10000) => v.until((m) => m.t === 'incident.opened' && m.incident.monitorId === id, ms, from);
const stateOf = async (id) => (await api('GET', '/api/monitors')).json?.monitors.find((m) => m.id === id) ?? null;
const metricsOf = (m) => (m?.metrics ? `${m.metrics.width}×${m.metrics.height}, ${m.metrics.textLength} chars` : 'no metrics');
/** A page just armed is late for any verdict for ARM_GRACE_MS (monitor.js); a wait a little longer than that settles it. */
const ARM_WAIT = 8000;

// ---------------------------------------------------------------- a runner
let child = null;
let out = '';
if (!EXTERNAL) {
  child = spawn(process.execPath, [join(ROOT, 'server.js')], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), GC_MONITOR_LLM: 'mock', HOME_URL: 'about:blank', GC_PACE_MS: '0', GC_SETTLE_MS: '120', GC_TIMEOUT_MS: '4000' },
  });
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
}
let probe = null;
const done = async () => {
  try { await probe?.close(); } catch { /* gone */ }
  // The store writes half a second after the last change, and a killed
  // process on Windows runs no signal handler: give the sweep time to land.
  if (child) { await wait(800); child.kill(); }
  console.log(failures ? `\n  ${failures} failure${failures === 1 ? '' : 's'}\n` : '\n  all green\n');
  process.exit(failures ? 1 : 0);
};

let up = false;
for (let i = 0; i < 120 && !up; i++) {
  up = await fetch(`${BASE}/healthz`).then((r) => r.json()).then((j) => !!j.browser).catch(() => false);
  if (!up) await wait(500);
}
if (!up) { bad('a runner is up', `nothing on ${BASE}\n${out.trim().split('\n').slice(-8).join('\n')}`); await done(); }

const v = viewer();
await v.open;
await v.until((m) => m.t === 'ready', 5000);
await sweep();
const STARTED = Date.now();

// ---------------------------------------------------------------------------
section('1 · which mind');
{
  const { status, json } = await api('GET', '/api/monitoring');
  if (status === 200 && json?.llm?.mode === 'mock') ok('the runner says mock', `model ${json.llm.model}`);
  else { bad('the runner says mock', `status ${status}, ${JSON.stringify(json?.llm)} — this check needs GC_MONITOR_LLM=mock`); await done(); }
  if (json.picking === false) ok('nothing is being picked'); else bad('nothing is being picked', String(json.picking));
  if (json.budget && typeof json.budget.max === 'number') ok('the budget is reported', `${json.budget.used}/${json.budget.max}`); else bad('the budget is reported');
}

// ---------------------------------------------------------------------------
section('2 · a monitor needs a page');
{
  const r = await api('POST', '/api/monitors', { selector: 'p', ruleText: 'text must not change' });
  if (r.status === 409 && /Nothing is open/.test(r.json?.error ?? '')) ok('409 before anything is open', r.json.error);
  else bad('409 before anything is open', `${r.status} ${JSON.stringify(r.json)}`);
}
if (!(await open(v, FIXTURE))) { bad('the fixture opens', 'no targets for it'); await done(); }
ok('the fixture opens', FIXTURE);
{
  const r = await api('POST', '/api/monitors', { selector: '#nothing-here', ruleText: 'text must not change' });
  if (r.status === 422) ok('422 for an element that is not there', r.json.error); else bad('422 for an element that is not there', `${r.status} ${JSON.stringify(r.json)}`);
  const b = await api('POST', '/api/monitors', { selector: HERO });
  if (b.status === 400) ok('400 without a rule'); else bad('400 without a rule', String(b.status));
}
let hero = null;
{
  const from = v.at();
  const r = await create('check-hero', HERO, 'font size must not exceed 18px');
  hero = r.json?.monitor ?? null;
  if (r.status === 200 && hero) ok('a monitor is created', hero.id); else { bad('a monitor is created', `${r.status} ${JSON.stringify(r.json)}`); await done(); }
  const c = hero.spec?.checks?.[0];
  if (c && c.metric === 'fontSize' && c.op === 'lte' && c.value === '18' && hero.specSource === 'mock') ok('the rule compiled to fontSize ≤ 18', 'by the mock');
  else bad('the rule compiled to fontSize ≤ 18', JSON.stringify(hero.spec));
  if (hero.baseline?.metrics?.fontSizePx === 16 && hero.metrics?.fontSize === 16) ok('the baseline was measured live', '16px'); else bad('the baseline was measured live', JSON.stringify(hero.metrics));
  if (hero.spec?.clauses?.length === 1 && hero.spec.clauses[0].outcome === 'checks' && hero.spec.clauses[0].checkIds[0] === 'c1') ok('and says the one clause became that check', hero.spec.clauses[0].text); else bad('and says the one clause became that check', JSON.stringify(hero.spec?.clauses));
  const ex = hero.baselineExcerpt;
  if (ex?.html?.includes('<p class="hero-copy"') && !/<script|onclick/.test(ex.html) && Array.isArray(ex.path) && ex.path.at(-1) === 'div.hero') ok('the markup excerpt was taken, sanitised, with where it sits', `${ex.path.join(' > ')} · ${ex.html.length} chars`); else bad('the markup excerpt was taken, sanitised, with where it sits', JSON.stringify(ex)?.slice(0, 200));
  if (hero.state === 'ok' && hero.onPage === true) ok('state ok, on this page'); else bad('state ok, on this page', `${hero.state} ${hero.onPage}`);
  if (await v.until((m) => m.t === 'monitor.changed' && m.monitor.id === hero.id, 5000, from)) ok('monitor.changed reached the socket'); else bad('monitor.changed reached the socket');
  if (hero.baselineShot) {
    const s = await bytes(`/api/monitors/shots/${encodeURIComponent(hero.baselineShot)}`);
    if (s.status === 200 && isPng(s.buf)) ok('the baseline shot is a PNG behind the gate', `${s.buf.length} bytes`); else bad('the baseline shot is a PNG behind the gate', `status ${s.status}`);
  } else bad('the baseline shot is a PNG behind the gate', 'no baselineShot');
  const dot = await api('GET', `/api/monitors/shots/${encodeURIComponent('../x.png')}`);
  if (dot.status === 400) ok('a name with a path in it is refused', '400'); else bad('a name with a path in it is refused', String(dot.status));
  const none = await api('GET', '/api/monitors/shots/m_00000000-baseline.png');
  if (none.status === 404) ok('a shot that is not there is a 404'); else bad('a shot that is not there is a 404', String(none.status));
}

// ---------------------------------------------------------------------------
section('2b · a monitor belongs to a project');
{
  const suite = (await api('GET', '/api/suites')).json?.suites?.[0] ?? null;
  if (!suite) ok('(no suite on this runner — project attribution skipped)');
  else {
    const r = await api('POST', '/api/monitors', { selector: HERO, label: 'check-project', ruleText: 'text must not change', suiteId: suite.id });
    const pm = r.json?.monitor ?? null;
    if (r.status === 200 && pm?.suiteId === suite.id) ok('made from a suite, it carries the suite', `${pm.id} → ${suite.id}`); else bad('made from a suite, it carries the suite', `${r.status} ${JSON.stringify(r.json)}`);
    const mine = (await api('GET', `/api/monitors?suite=${encodeURIComponent(suite.id)}`)).json?.monitors ?? [];
    if (pm && mine.some((m) => m.id === pm.id)) ok('?suite= lists it'); else bad('?suite= lists it', JSON.stringify(mine.map((m) => m.id)));
    // One made with no project is the suite's only when its page is on the suite's origin.
    let sameOrigin = false;
    try { sameOrigin = new URL(hero.url).origin === new URL(suite.origin ?? suite.baseUrl).origin; } catch { /* not URLs */ }
    const heroListed = mine.some((m) => m.id === hero.id);
    if (heroListed === sameOrigin) ok(sameOrigin ? 'and one made with no project on its origin' : 'and not one made with no project elsewhere', hero.url);
    else bad('a monitor with no project follows its origin', `${hero.url} listed: ${heroListed}`);
    const inc = await api('GET', `/api/incidents?suite=${encodeURIComponent(suite.id)}`);
    if (inc.status === 200 && Array.isArray(inc.json?.incidents)) ok('?suite= on incidents answers too', `${inc.json.incidents.length} for it`); else bad('?suite= on incidents answers too', String(inc.status));
    const nope = await api('GET', '/api/monitors?suite=no-such-suite');
    if (nope.status === 404) ok('an unknown suite is a 404'); else bad('an unknown suite is a 404', String(nope.status));
    const refused = await api('POST', '/api/monitors', { selector: HERO, label: 'check-project-2', ruleText: 'text must not change', suiteId: 'no-such-suite' });
    if (refused.status === 400) ok('making one for an unknown suite is a 400', refused.json?.error); else bad('making one for an unknown suite is a 400', String(refused.status));
    if (pm) await api('DELETE', `/api/monitors/${pm.id}`);
  }
}

// ---------------------------------------------------------------------------
section('2c · what the preview says, clause by clause');
{
  const p = await api('POST', '/api/monitors/preview', { ruleText: 'font size must not exceed 18px and the badge must look right', tag: 'p', selector: HERO, baseline: hero.baseline });
  const cl = p.json?.spec?.clauses ?? [];
  if (p.status === 200 && p.json.spec.source === 'mock' && cl.map((c) => c.outcome).join(',') === 'checks,judgment') ok('the mock names the clause it could not read', `"${cl[1]?.text}" → judgment`); else bad('the mock names the clause it could not read', JSON.stringify(p.json?.spec?.clauses));
  const c = await api('POST', '/api/monitors/compile', { ruleText: 'font size must not exceed 18px', tag: 'p', selector: HERO, baseline: hero.baseline });
  if (c.status === 409 && c.json?.error === 'no_model' && c.json.spec?.source === 'mock') ok('Compile with Claude is refused on a mock runner, with the mock’s spec', c.json.message?.slice(0, 60)); else bad('Compile with Claude is refused on a mock runner, with the mock’s spec', `${c.status} ${JSON.stringify(c.json)?.slice(0, 120)}`);
}

// ---------------------------------------------------------------------------
section('3 · a change opens an incident');
let incident = null;
{
  const from = v.at();
  const end = await run(v, 'click button:Grow text');
  if (end?.t === 'run.end' && end.ok) ok('the fault was pressed through the flow language'); else bad('the fault was pressed through the flow language', JSON.stringify(end));
  const opened = await incidentFor(v, hero.id, from);
  incident = opened?.incident ?? null;
  if (incident) ok('incident.opened within ten seconds', incident.id); else { bad('incident.opened within ten seconds'); await done(); }
  const vio = incident.violations?.[0];
  if (vio && vio.metric === 'fontSize' && Number(vio.actual) > 18) ok('the violation carries the numbers', `actual ${vio.actual}, expected ${vio.expected}`); else bad('the violation carries the numbers', JSON.stringify(vio));
  if (incident.diff?.fontSize?.[1] === 36) ok('the diff says 16 → 36', JSON.stringify(incident.diff.fontSize)); else bad('the diff says 16 → 36', JSON.stringify(incident.diff));
  if (/f-grow/.test(incident.after?.excerpt?.html ?? '') && !/f-grow/.test(incident.before?.excerpt?.html ?? '') && incident.before?.excerpt?.html) ok('the markup before and after rides with the incident', 'class f-grow appeared'); else bad('the markup before and after rides with the incident', JSON.stringify({ before: incident.before?.excerpt?.html?.slice(0, 60), after: incident.after?.excerpt?.html?.slice(0, 60) }));
  if (incident.verdict?.source === 'mock' && /36px/.test(incident.verdict.explanation)) ok('a mock verdict, at once', incident.verdict.severity); else bad('a mock verdict, at once', JSON.stringify(incident.verdict));
  if (incident.after?.screenshot) {
    const s = await bytes(`/api/monitors/shots/${encodeURIComponent(incident.after.screenshot)}`);
    if (s.status === 200 && isPng(s.buf)) ok('the after shot is a PNG', incident.after.screenshotKind); else bad('the after shot is a PNG', String(s.status));
  } else bad('the after shot is a PNG', 'none taken');
  if (await v.until((m) => m.t === 'monitor.changed' && m.monitor.id === hero.id && m.monitor.state === 'violated', 5000, from)) ok('the monitor is violated'); else bad('the monitor is violated');
  if (await v.until((m) => m.t === 'monitor.tick' && m.monitorId === hero.id && m.ok === false, 5000, from)) ok('a tick said ok:false'); else bad('a tick said ok:false');
  if (await v.until((m) => m.t === 'log' && /incident: check-hero/.test(m.msg), 5000, from)) ok('and the log said so'); else bad('and the log said so');
  // An incident is a defect too (defects.js): filed under a number as it opens, with the monitor and the incident's evidence.
  if (/^DEF-\d{4}-\d{3,}$/.test(incident.defect ?? '')) ok('the incident names the defect it was filed as', incident.defect); else bad('the incident names the defect it was filed as', JSON.stringify(incident.defect));
  const filed = (await api('GET', '/api/defects')).json?.defects.find((d) => d.id === incident.defect);
  if (filed && filed.kind === 'monitor' && filed.status === 'open' && filed.monitor?.id === hero.id && filed.monitor.incidentId === incident.id && filed.evidence?.after === incident.after?.screenshot && filed.evidence.violations[0]?.metric === 'fontSize') ok('and the Defects page lists it, from the monitor, with the evidence', `${filed.id} · ${filed.severity} · ${filed.title}`); else bad('and the Defects page lists it, from the monitor, with the evidence', String(JSON.stringify(filed)).slice(0, 200));
  if (await v.until((m) => m.t === 'defects.changed' && m.changes.some((c) => c.kind === 'filed' && c.id === incident.defect), 5000, from)) ok('and the sockets heard the filing'); else bad('and the sockets heard the filing');
}

// ---------------------------------------------------------------------------
section('4 · and recovery closes it');
{
  const from = v.at();
  await run(v, 'click button:Reset all');
  const resolved = await v.until((m) => m.t === 'incident.resolved' && m.incident.id === incident.id, 10000, from);
  if (resolved?.incident.resolvedBy === 'auto') ok('incident.resolved by auto', resolved.incident.id); else bad('incident.resolved by auto', JSON.stringify(resolved?.incident?.resolvedBy));
  if (await v.until((m) => m.t === 'monitor.changed' && m.monitor.id === hero.id && m.monitor.state === 'ok', 5000, from)) ok('the monitor is ok again'); else bad('the monitor is ok again');
  const list = await api('GET', '/api/incidents?status=resolved');
  if (list.json?.incidents.some((i) => i.id === incident.id)) ok('it is listed as resolved'); else bad('it is listed as resolved');
  const open_ = await api('GET', '/api/incidents?status=open');
  if (!open_.json?.incidents.some((i) => i.id === incident.id)) ok('and not as open'); else bad('and not as open');
  const closedDefect = (await api('GET', `/api/defects/${incident.defect}`)).json?.defect;
  if (closedDefect?.status === 'closed' && /recovered on its own/.test(closedDefect.activity.at(-1)?.text ?? '')) ok('and its defect closed with it', closedDefect.activity.at(-1).text); else bad('and its defect closed with it', JSON.stringify(closedDefect && { status: closedDefect.status, last: closedDefect.activity.at(-1) }));
}

// ---------------------------------------------------------------------------
section('5 · churn stays quiet');
{
  const from = v.at();
  await wait(3000);
  if (await v.none((m) => m.t === 'incident.opened', 1, from)) ok('three seconds of ticker and clock, no incident'); else bad('three seconds of ticker and clock, no incident');
}

// ---------------------------------------------------------------------------
section('6 · rows, visibility, accepting the current state');
let rows = null;
let submit = null;
{
  rows = (await create('check-rows', '[data-testid="orders-table"]', 'must keep exactly 5 rows')).json?.monitor;
  submit = (await create('check-submit', '#signup-submit', 'must always be visible')).json?.monitor;
  if (rows?.spec.checks[0].metric === 'rowCount' && rows.metrics.rowCount === 5) ok('a table monitor: rowCount = 5'); else bad('a table monitor: rowCount = 5', JSON.stringify(rows?.spec));
  if (submit?.spec.checks.some((c) => c.metric === 'visible')) ok('a button monitor: must stay visible'); else bad('a button monitor: must stay visible', JSON.stringify(submit?.spec));
  let from = v.at();
  await run(v, 'click button:Remove table row');
  const rowInc = (await incidentFor(v, rows.id, from))?.incident;
  if (rowInc?.violations[0].metric === 'rowCount' && Number(rowInc.violations[0].actual) === 4) ok('four rows is an incident', rowInc.violations[0].expected); else bad('four rows is an incident', JSON.stringify(rowInc?.violations));
  from = v.at();
  await run(v, 'click button:Hide submit');
  const subInc = (await incidentFor(v, submit.id, from))?.incident;
  if (subInc?.violations.some((x) => x.metric === 'visible')) ok('a hidden button is an incident', subInc.violations[0].message); else bad('a hidden button is an incident', JSON.stringify(subInc?.violations));

  from = v.at();
  const r = await api('POST', `/api/incidents/${rowInc.id}/resolve`);
  if (r.json?.incident?.resolvedBy === 'manual' && r.json?.monitor?.state === 'acknowledged') ok('manual resolve → acknowledged', 'the rule still fails, so it stays quiet'); else bad('manual resolve → acknowledged', `${r.status} ${JSON.stringify(r.json?.monitor?.state)}`);
  await wait(3000);
  if (await v.none((m) => m.t === 'incident.opened' && m.incident.monitorId === rows.id, 1, from)) ok('nothing reopens while the same thing is wrong'); else bad('nothing reopens while the same thing is wrong');
  const missing = await api('POST', '/api/incidents/i_00000000/resolve');
  if (missing.status === 404) ok('an unknown incident is a 404'); else bad('an unknown incident is a 404', String(missing.status));

  from = v.at();
  await run(v, 'click button:Reset all');
  if (await v.until((m) => m.t === 'monitor.changed' && m.monitor.id === rows.id && m.monitor.state === 'ok', 10000, from)) ok('five rows again: acknowledged → ok'); else bad('five rows again: acknowledged → ok');
  if (await v.until((m) => m.t === 'incident.resolved' && m.incident.id === subInc?.id && m.incident.resolvedBy === 'auto', 10000, from)) ok('the button is back: resolved by auto'); else bad('the button is back: resolved by auto');
}

// ---------------------------------------------------------------------------
section('6b · a rule the table cannot read waits for a key');
{
  const from = v.at();
  const r = await create('check-judge', HERO, 'the call to action must stay the most prominent element');
  const jm = r.json?.monitor ?? null;
  const cl = jm?.spec?.clauses?.[0];
  if (jm && cl?.outcome === 'judgment' && jm.spec.checks.some((c) => c.metric === 'htmlHash' && c.judgment === true)) ok('compiles to a judgment clause with a markup check', `${cl.text} → ${jm.spec.checks.map((c) => c.id).join(',')}`); else { bad('compiles to a judgment clause with a markup check', JSON.stringify(jm?.spec)?.slice(0, 200)); await done(); }
  const end = await run(v, 'click button:Swap class');
  if (end?.t === 'run.end' && end.ok) ok('a class with no style was swapped in'); else bad('a class with no style was swapped in', JSON.stringify(end));
  const opened = await incidentFor(v, jm.id, from);
  const inc = opened?.incident ?? null;
  if (inc && inc.status === 'open' && inc.judgment === true && inc.violations.some((x) => x.metric === 'htmlHash')) ok('a markup-only change opens an incident on a mock runner', inc.id); else { bad('a markup-only change opens an incident on a mock runner', JSON.stringify(inc && { status: inc.status, judgment: inc.judgment, v: inc.violations.map((x) => x.metric) })); await done(); }
  if (inc.verdict?.source === 'mock' && /set ANTHROPIC_API_KEY/.test(inc.verdict.explanation)) ok('whose verdict says a key is needed to judge it', inc.verdict.severity); else bad('whose verdict says a key is needed to judge it', JSON.stringify(inc.verdict));
  if (/f-swapped/.test(inc.after?.excerpt?.html ?? '') && !/f-swapped/.test(inc.before?.excerpt?.html ?? '')) ok('and carries the swapped class in the after markup'); else bad('and carries the swapped class in the after markup', inc.after?.excerpt?.html?.slice(0, 80));
  const open = await api('GET', '/api/incidents?status=open');
  if (open.json?.incidents?.some((i) => i.id === inc.id)) ok('listed as open'); else bad('listed as open');
  const back = await run(v, 'click button:Reset all');
  if (back?.ok && await v.until((m) => m.t === 'incident.resolved' && m.incident.id === inc.id, 10000, from)) ok('Reset all resolves it'); else bad('Reset all resolves it');
  await api('DELETE', `/api/monitors/${jm.id}`);
}

// ---------------------------------------------------------------------------
section('6c · the whole page, watched');
{
  // Two monitors on `:page`: one about the layout, one about the words. The
  // ticker and the clock change while the baseline settles and are learned
  // as the page's own churn; a class with no style changes nothing a person
  // can see; a deploy that rewords the hero is news for one, a row added to
  // the table for both — and the incident says what was added and what moved
  // to make room.
  // 12px, not the default 4: the ticker's count grows a digit wider now and
  // then and pushes the uptime beside it 8px right — a move the rule is
  // allowed to forgive, where a row's 40px is not.
  const page = (await create('check-page', ':page', 'no block may move by more than 12px')).json?.monitor;
  const pageText = (await create('check-page-text', ':page', 'the text must not change')).json?.monitor;
  if (page?.spec?.kind === 'page' && page.spec.checks.length === 1 && page.spec.checks[0].metric === 'layout' && page.spec.tolerance === 12) ok('a monitor on the whole page, about its layout', `${page.baseline?.counts?.blocks} blocks, 12px of give`); else { bad('a monitor on the whole page, about its layout', JSON.stringify(page?.spec ?? page).slice(0, 200)); await done(); }
  if (pageText?.spec?.kind === 'page' && pageText.spec.checks.length === 1 && pageText.spec.checks[0].metric === 'content') ok('and one about its words', pageText.spec.summary.slice(0, 60)); else { bad('and one about its words', JSON.stringify(pageText?.spec ?? pageText).slice(0, 200)); await done(); }
  const blocks = page.baseline?.counts?.blocks ?? 0;
  if (blocks >= 20 && !page.baseline.blocks && page.metrics?.kind === 'page' && page.metrics.blocks === blocks) ok('the API carries the block count, not the blocks', `${blocks} blocks, ${page.metrics.width}×${page.metrics.height}`); else bad('the API carries the block count, not the blocks', JSON.stringify({ blocks, raw: !!page.baseline?.blocks, metrics: page.metrics }));
  if (page.spec.ignore?.length >= 2 && page.specSource === 'mock') ok('the ticker and the clock were learned as its own churn', `${page.spec.ignore.length} blocks ignored`); else bad('the ticker and the clock were learned as its own churn', JSON.stringify({ ignore: page.spec.ignore, source: page.specSource }));
  if (page.selector === ':page' && page.label === 'check-page' && page.tag === 'page' && page.state === 'ok') ok('selector :page, tag page, state ok'); else bad('selector :page, tag page, state ok', JSON.stringify({ selector: page.selector, tag: page.tag, state: page.state }));
  if (/^h1 "Acme Orders"/m.test(page.baselineExcerpt?.html ?? '') && /section#orders/.test(page.baselineExcerpt?.html ?? '')) ok('its excerpt is the page’s outline', page.baselineExcerpt.html.split('\n')[0]); else bad('its excerpt is the page’s outline', (page.baselineExcerpt?.html ?? '').slice(0, 80));
  const shot = page.baselineShot ? await bytes(`/api/monitors/shots/${encodeURIComponent(page.baselineShot)}`) : null;
  if (shot && shot.status === 200 && isPng(shot.buf)) ok('with a baseline shot of the viewport'); else bad('with a baseline shot of the viewport', String(shot?.status));
  const pageIds = new Set([page.id, pageText.id]);
  const anyIncident = (m) => m.t === 'incident.opened' && pageIds.has(m.incident.monitorId);

  let from = v.at();
  await wait(3500);
  if (await v.none(anyIncident, 1, from)) ok('three seconds of ticker and clock: nothing opened'); else bad('three seconds of ticker and clock: nothing opened', 'the page’s own churn was reported');
  from = v.at();
  await run(v, 'click button:Swap class');
  await wait(3000);
  if (await v.none(anyIncident, 1, from)) ok('a class with no style is not a change anyone can see'); else bad('a class with no style is not a change anyone can see');
  await run(v, 'click button:Reset all');
  await wait(800);

  from = v.at();
  await run(v, 'click button:Change text');
  const worded = (await incidentFor(v, pageText.id, from))?.incident;
  if (worded?.violations[0]?.metric === 'content') ok('reworded copy is an incident for the words', worded.violations[0].actual.slice(0, 70)); else { bad('reworded copy is an incident for the words', JSON.stringify(worded?.violations)); }
  const pc = worded?.diff?.pageChanges;
  if (pc && pc.totals.changed >= 1 && pc.changed.some((b) => b.t === 'p' && /Every order/.test(b.before) && /copy changed/.test(b.after))) ok('and the diff quotes before and after', `${pc.changed[0].before.slice(0, 24)}… → …${pc.changed[0].after.slice(-30)}`); else bad('and the diff quotes before and after', JSON.stringify(pc?.changed).slice(0, 200));
  if (worded?.verdict?.source === 'mock' && /words changed/i.test(worded.verdict.explanation)) ok('a verdict in words, at once', worded.verdict.severity); else bad('a verdict in words, at once', JSON.stringify(worded?.verdict).slice(0, 200));
  if (worded?.selector === ':page' && worded.before?.snapshot && !worded.before.snapshot.blocks && worded.before.snapshot.counts?.blocks) ok('the incident’s snapshots carry the count, not the blocks'); else bad('the incident’s snapshots carry the count, not the blocks', JSON.stringify(worded?.before?.snapshot).slice(0, 120));
  from = v.at();
  await run(v, 'click button:Reset all');
  if (await v.until((m) => m.t === 'incident.resolved' && m.incident.id === worded?.id, 10000, from)) ok('the copy put back resolves it'); else bad('the copy put back resolves it');
  await wait(2500);
  const settled = await stateOf(page.id);
  if (settled?.state === 'ok') ok('and the layout monitor is ok', settled.stats.incidents ? `it opened ${settled.stats.incidents} on the reflow, since resolved` : 'the reflow did not move it'); else bad('and the layout monitor is ok', JSON.stringify(settled?.state));

  from = v.at();
  await run(v, 'click button:Add table row');
  const grew = (await incidentFor(v, page.id, from))?.incident;
  if (grew?.violations[0]?.metric === 'layout') ok('a new row is a layout incident', grew.violations[0].actual.slice(0, 70)); else { bad('a new row is a layout incident', JSON.stringify(grew?.violations)); }
  const gc = grew?.diff?.pageChanges;
  if (gc && gc.totals.added >= 4 && gc.added.some((b) => b.t === 'td' && /10046/.test(b.text))) ok('the diff names what was added', `${gc.totals.added} added: ${gc.added.map((b) => b.text).join(', ')}`); else bad('the diff names what was added', JSON.stringify(gc?.added).slice(0, 200));
  if (gc && gc.totals.moved >= 2 && gc.moved.some((b) => (b.t === 'table' || b.t === 'section') && b.dh > 12) && gc.moved.some((b) => b.dy > 12)) ok('and what grew and what moved down to make room', `${gc.totals.moved} moved: ${gc.moved.slice(0, 3).map((b) => `${b.t}${b.id ? '#' + b.id : ''} dy=${b.dy} dh=${b.dh}`).join(', ')}`); else bad('and what grew and what moved down to make room', JSON.stringify(gc?.moved).slice(0, 300));
  if (grew?.verdict?.source === 'mock' && /added/.test(grew.verdict.explanation) && /10046/.test(grew.verdict.explanation)) ok('the verdict says so in a sentence', grew.verdict.explanation.slice(0, 90) + '…'); else bad('the verdict says so in a sentence', JSON.stringify(grew?.verdict).slice(0, 200));
  if (grew?.after?.screenshot && grew.after.screenshotKind === 'viewport') ok('the after shot is the viewport'); else bad('the after shot is the viewport', JSON.stringify({ shot: grew?.after?.screenshot, kind: grew?.after?.screenshotKind }));
  if (await v.until((m) => m.t === 'log' && /incident: check-page — The layout must not change: nothing added, removed, moved or resized by more than 12px/.test(m.msg), 5000, from)) ok('and the log said so'); else bad('and the log said so');
  from = v.at();
  await run(v, 'click button:Reset all');
  if (await v.until((m) => m.t === 'incident.resolved' && m.incident.id === grew?.id, 10000, from)) ok('the row taken out resolves it'); else bad('the row taken out resolves it');

  // A reload arms the page monitor again: the estimate that arrives late is
  // late, not a block that went — nothing opens on a visit to an unchanged page.
  from = v.at();
  await open(v, FIXTURE);
  await wait(ARM_WAIT);
  if (await v.none(anyIncident, 1, from)) ok('a reload of an unchanged page opens nothing', 'the late paragraph was waited for'); else bad('a reload of an unchanged page opens nothing');
  const after = await stateOf(page.id);
  if (after?.state === 'ok' && (after.stats?.visits ?? 0) >= 1) ok('and counted as a visit', `${after.stats.visits} visit${after.stats.visits === 1 ? '' : 's'}`); else bad('and counted as a visit', JSON.stringify({ state: after?.state, visits: after?.stats?.visits }));
  for (const id of pageIds) await api('DELETE', `/api/monitors/${id}`);
}

// ---------------------------------------------------------------------------
section('6d · the whole page: scrolling is not a change');
{
  // public/monitor-scroll.html scrolls an inner <main> under a fixed header —
  // the turbo.ai shape, where window.scrollY stays 0 while everything moves.
  // First in a browser of the check's own, the page bundle injected: the
  // capture reads the same blocks at the same document coordinates before and
  // after a scroll of 1090px, and says how far the scroller went.
  const own = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--disable-dev-shm-usage'] });
  try {
    const p = await own.newPage({ viewport: { width: 1180, height: 760 } });
    await p.addInitScript({ content: BUNDLE });
    await p.goto(SCROLL);
    const measure = () => p.evaluate(() => window.__gcMonitor.measurePage());
    const before = await measure();
    await p.evaluate(() => { document.getElementById('scroller').scrollTop = 1090; });
    await p.waitForTimeout(100);
    const after = await measure();
    const moved = after.blocks.filter((b) => { const a = before.blocks.find((x) => x.k === b.k); return !a || a.x !== b.x || a.y !== b.y; });
    if (before.env.scrollY === 0 && after.env.scrollY === 0 && after.env.scroll.y === 1090) ok('the window did not scroll; the inner main did, by 1090px', `env.scroll ${JSON.stringify(after.env.scroll)}`); else bad('the window did not scroll; the inner main did, by 1090px', JSON.stringify({ before: before.env, after: after.env }));
    if (before.blocks.length >= 40 && moved.length === 0 && after.sig === before.sig) ok('every block reads at the same document coordinates after the scroll', `${before.blocks.length} blocks, none moved, same signature`); else bad('every block reads at the same document coordinates after the scroll', `${moved.length} of ${after.blocks.length} moved: ${moved.slice(0, 3).map((b) => `${b.t}#${b.id ?? ''} ${b.x},${b.y}`).join('; ')}`);
    const read = before.blocks.find((b) => b.id === 'read');
    const fixed = before.blocks.filter((b) => b.f).length;
    if (read && read.c === 1 && read.lh && read.lp === '/pricing.html' && read.p && fixed >= 4) ok('a link is a control block: what it does hashed, its path beside it, its parent named', `a#read [${read.lp}] c=${read.c} p=${read.p} · ${fixed} fixed blocks`); else bad('a link is a control block: what it does hashed, its path beside it, its parent named', JSON.stringify(read));
    if (before.blocks.every((b) => !('href' in b) && !('action' in b))) ok('no block carries an address, only its hash and a masked path'); else bad('no block carries an address, only its hash and a masked path');
    await p.close();
  } finally { await own.close(); }

  // Then the runner: a monitor on the whole page with the default rule, and
  // the four checks it stands for, each shown catching its own kind of change.
  if (!(await open(v, SCROLL))) { bad('the scrolling fixture opens'); await done(); }
  ok('the scrolling fixture opens', SCROLL);
  await wait(500);
  const sp = (await create('check-scroll', ':page', 'Nothing on the page may change')).json?.monitor;
  const ids = sp?.spec?.checks?.map((c) => c.id) ?? [];
  if (sp?.spec?.kind === 'page' && ids.join(',') === 'logic,elements,content,alignment') ok('"nothing may change" is four checks: what it does, its elements, its words, their alignment', ids.join(' ')); else { bad('"nothing may change" is four checks: what it does, its elements, its words, their alignment', JSON.stringify(sp?.spec ?? sp).slice(0, 200)); await done(); }
  if (/^Nothing on the page may change: not what it does, not which elements it has, not its words, not their alignment \(scrolling, moves under 4px/.test(sp.spec.summary)) ok('and says so', sp.spec.summary.slice(0, 70) + '…'); else bad('and says so', sp.spec.summary);
  if (sp.baseline?.env?.scroll?.y === 0 && sp.baseline.env.innerWidth === 1180 && !sp.baseline.blocks) ok('the baseline was read unscrolled at 1180px, and the API carries no blocks', `${sp.baseline.counts?.blocks} blocks`); else bad('the baseline was read unscrolled at 1180px, and the API carries no blocks', JSON.stringify(sp.baseline?.env));
  const mine = (m) => m.t === 'incident.opened' && m.incident.monitorId === sp.id;
  const resolvedOf = (id, from) => v.until((m) => m.t === 'incident.resolved' && m.incident.id === id, 10000, from);

  // (a) a scroll of 1090px inside main: nothing opens, and the reading says how far it went.
  let from = v.at();
  await run(v, 'click button:Scroll down');
  await wait(3500);
  if (await v.none(mine, 1, from)) ok('(a) scrolled 1090px inside main: no incident'); else bad('(a) scrolled 1090px inside main: no incident', 'a scroll was reported as a change');
  let st = await stateOf(sp.id);
  if (st?.state === 'ok' && st.last?.env?.scroll?.y === 1090 && st.last.htmlHash === st.baseline.htmlHash) ok('state ok; the last reading scrolled 1090px, the same shape as the baseline', `env.scroll ${JSON.stringify(st.last.env.scroll)}`); else bad('state ok; the last reading scrolled 1090px, the same shape as the baseline', JSON.stringify({ state: st?.state, scroll: st?.last?.env?.scroll, same: st?.last?.htmlHash === st?.baseline?.htmlHash }));
  await run(v, 'click button:Scroll up');
  await wait(800);

  // (b) a link that points elsewhere is a change to what the page does.
  from = v.at();
  await run(v, 'click button:Change link');
  const logic = (await incidentFor(v, sp.id, from))?.incident;
  if (logic?.violations.map((x) => x.metric).join(',') === 'logic') ok('(b) a link that points elsewhere: a logic incident, and only that', logic.violations[0].actual.slice(0, 80)); else bad('(b) a link that points elsewhere: a logic incident, and only that', JSON.stringify(logic?.violations?.map((x) => x.metric)));
  const lc = logic?.diff?.pageChanges;
  if (lc?.totals?.logic === 1 && lc.logicChanges?.[0]?.id === 'read' && lc.logicChanges[0].before === '/pricing.html' && lc.logicChanges[0].after === '/pricing-2.html' && /now points at \/pricing-2\.html instead of \/pricing\.html/.test(logic.violations[0].actual)) ok('naming the link and both paths', `${lc.logicChanges[0].before} → ${lc.logicChanges[0].after}`); else bad('naming the link and both paths', JSON.stringify(lc?.logicChanges));
  if (logic?.verdict?.severity === 'high' && /What the page does changed/.test(logic.verdict.explanation)) ok('a functional change is high severity, in a sentence', logic.verdict.explanation.slice(0, 80) + '…'); else bad('a functional change is high severity, in a sentence', JSON.stringify(logic?.verdict).slice(0, 200));
  if (logic && !JSON.stringify(logic).includes('"href"')) ok('and no address rides on the incident, only the masked paths'); else bad('and no address rides on the incident, only the masked paths');
  from = v.at();
  await run(v, 'click button:Reset all');
  if (await resolvedOf(logic?.id, from)) ok('the link put back resolves it'); else bad('the link put back resolves it');

  // (c) a control that went is an elements change (and words gone, for a words rule).
  from = v.at();
  await run(v, 'click button:Remove button');
  const gone = (await incidentFor(v, sp.id, from))?.incident;
  const gm = gone?.violations.map((x) => x.metric) ?? [];
  if (gm[0] === 'elements' && !gm.includes('logic') && !gm.includes('alignment')) ok('(c) a button removed: an elements incident', gone.violations[0].actual.slice(0, 80)); else bad('(c) a button removed: an elements incident', JSON.stringify(gm));
  const ec = gone?.diff?.pageChanges;
  if (ec?.totals?.elementsRemoved === 1 && ec.elementChanges?.[0]?.how === 'removed' && ec.elementChanges[0].id === 'save' && /Save for later/.test(ec.elementChanges[0].text ?? '')) ok('naming the button', `${ec.elementChanges[0].t}#${ec.elementChanges[0].id} “${ec.elementChanges[0].text}”`); else bad('naming the button', JSON.stringify(ec?.elementChanges));
  from = v.at();
  await run(v, 'click button:Reset all');
  if (await resolvedOf(gone?.id, from)) ok('the button put back resolves it'); else bad('the button put back resolves it');

  // (d) reworded copy is a content change, and nothing else.
  from = v.at();
  await run(v, 'click button:Reword copy');
  const worded = (await incidentFor(v, sp.id, from))?.incident;
  if (worded?.violations.map((x) => x.metric).join(',') === 'content' && worded.diff?.pageChanges?.changed?.some((b) => b.id === 'copy' && /copy changed/.test(b.after))) ok('(d) reworded copy: a content incident, and only that', worded.violations[0].actual.slice(0, 80)); else bad('(d) reworded copy: a content incident, and only that', JSON.stringify(worded?.violations?.map((x) => x.metric)));
  from = v.at();
  await run(v, 'click button:Reset all');
  if (await resolvedOf(worded?.id, from)) ok('the copy put back resolves it'); else bad('the copy put back resolves it');

  // (e) a section pulled up into its neighbour is an alignment change — every
  // block below it moved too, which is not one.
  from = v.at();
  await run(v, 'click button:Overlap');
  const over = (await incidentFor(v, sp.id, from))?.incident;
  if (over?.violations.map((x) => x.metric).join(',') === 'alignment' && /section#story-[ab] now overlaps section#story-[ab]/.test(over.violations[0].actual)) ok('(e) two sections overlapping: an alignment incident, and only that', over.violations[0].actual.slice(0, 80)); else bad('(e) two sections overlapping: an alignment incident, and only that', JSON.stringify(over?.violations?.map((x) => [x.metric, x.actual])).slice(0, 300));
  if ((over?.diff?.pageChanges?.totals?.moved ?? 0) >= 10) ok('the blocks below moved up, which the whole-page watch does not report', `${over.diff.pageChanges.totals.moved} moved`); else bad('the blocks below moved up, which the whole-page watch does not report', JSON.stringify(over?.diff?.pageChanges?.totals));
  from = v.at();
  await run(v, 'click button:Reset all');
  if (await resolvedOf(over?.id, from)) ok('the section put back resolves it'); else bad('the section put back resolves it');

  // (f) the content slid 500px by a transform, the way a smooth-scroll library
  // scrolls: a uniform shift of every free block is forgiven, and said.
  from = v.at();
  await run(v, 'click button:Shift content');
  const slid = await v.until((m) => m.t === 'monitor.tick' && m.monitorId === sp.id && m.metrics?.scrolled?.dy === -500, 8000, from);
  if (slid && slid.ok === true) ok('(f) the content slid 500px by a transform: forgiven as a scroll', `scrolled ${JSON.stringify(slid.metrics.scrolled)}`); else bad('(f) the content slid 500px by a transform: forgiven as a scroll', JSON.stringify(slid?.metrics ?? 'no tick said scrolled'));
  await wait(2500);
  if (await v.none(mine, 1, from)) ok('and no incident opened'); else bad('and no incident opened');
  st = await stateOf(sp.id);
  if (st?.state === 'ok' && st.metrics?.scrolled?.dy === -500) ok('the card says a scroll was ignored', JSON.stringify(st.metrics.scrolled)); else bad('the card says a scroll was ignored', JSON.stringify({ state: st?.state, metrics: st?.metrics }));
  await run(v, 'click button:Reset all');
  await wait(800);

  // (g) an iPad's width: the sidebar is not shown and everything re-flows,
  // which a responsive layout does on purpose — no incident, a note, and the
  // settled reading kept as that width's own baseline; a button removed at
  // that width is judged against it. Only where the runner can change device;
  // check:monitoring-judge drives the same engine path without a browser.
  from = v.at();
  v.send({ t: 'device', id: 'ipad' });
  const dev = await v.until((m) => m.t === 'device' && m.width === 768, 4000, from);
  if (!dev) ok('(g) (no device command on this runner — the responsive case is covered by check:monitoring-judge)');
  else {
    const noted = await v.until((m) => m.t === 'monitor.tick' && m.monitorId === sp.id && m.metrics?.viewport?.width === 768, 8000, from);
    if (noted && noted.ok === true && noted.metrics.viewport.baseline === 1180) ok('(g) at 768px: the tick says so, and nothing fails', JSON.stringify(noted.metrics.viewport)); else bad('(g) at 768px: the tick says so, and nothing fails', JSON.stringify(noted?.metrics ?? 'no tick at 768'));
    const kept = await v.until((m) => m.t === 'log' && /check-scroll: measured at 768px; the baseline is 1180px: \d+ blocks are not shown at this width.*kept as the 768px baseline/.test(m.msg), 10000, from);
    if (kept) ok('the settled reading is kept as the 768px baseline, said in the log', kept.msg.slice(0, 90) + '…'); else bad('the settled reading is kept as the 768px baseline, said in the log');
    if (await v.none(mine, 1, from)) ok('and no incident opened'); else bad('and no incident opened', 'the sidebar hidden at this width was reported');
    st = await stateOf(sp.id);
    const b768 = st?.baselines?.['768'];
    if (st?.state === 'ok' && b768 && !b768.blocks && b768.env?.innerWidth === 768 && b768.counts?.blocks < st.baseline.counts.blocks && st.baseline.env.innerWidth === 1180) ok('baselines[768] on the API, compacted like the baseline; the 1180px one untouched', `${b768.counts.blocks} blocks at 768, ${st.baseline.counts.blocks} at 1180`); else bad('baselines[768] on the API, compacted like the baseline; the 1180px one untouched', JSON.stringify({ state: st?.state, keys: Object.keys(st?.baselines ?? {}), raw: !!b768?.blocks }));
    if (st?.metrics?.viewport?.adopted === true) ok('the card compares against this width’s own baseline now', JSON.stringify(st.metrics.viewport)); else bad('the card compares against this width’s own baseline now', JSON.stringify(st?.metrics?.viewport));
    from = v.at();
    await run(v, 'click button:Remove button');
    const narrow = (await incidentFor(v, sp.id, from))?.incident;
    if (narrow?.violations[0]?.metric === 'elements' && narrow.before?.snapshot?.env?.innerWidth === 768 && narrow.diff?.pageChanges?.viewport === null) ok('a button removed at 768px: an elements incident against the 768px baseline', narrow.violations[0].actual.slice(0, 60)); else bad('a button removed at 768px: an elements incident against the 768px baseline', JSON.stringify({ v: narrow?.violations?.map((x) => x.metric), width: narrow?.before?.snapshot?.env?.innerWidth, viewport: narrow?.diff?.pageChanges?.viewport }));
    from = v.at();
    await run(v, 'click button:Reset all');
    if (await resolvedOf(narrow?.id, from)) ok('the button put back resolves it'); else bad('the button put back resolves it');
    from = v.at();
    v.send({ t: 'device', id: 'desktop' });
    await v.until((m) => m.t === 'device' && m.width === 1180, 4000, from);
    await wait(3000);
    if (await v.none(mine, 1, from) && (await stateOf(sp.id))?.state === 'ok') ok('back at 1180px: the creation baseline serves, nothing opened'); else bad('back at 1180px: the creation baseline serves, nothing opened');
  }
  await api('DELETE', `/api/monitors/${sp.id}`);
  // Back to the first fixture for what follows.
  await open(v, FIXTURE);
  await wait(1500);
}

// ---------------------------------------------------------------------------
section('7 · pause, resume, delete');
{
  const p = await api('POST', `/api/monitors/${hero.id}/pause`);
  if (p.json?.monitor?.state === 'paused') ok('paused'); else bad('paused', JSON.stringify(p.json));
  let from = v.at();
  await run(v, 'click button:Grow text');
  await wait(3000);
  if (await v.none((m) => m.t === 'incident.opened' && m.incident.monitorId === hero.id, 1, from)) ok('a paused monitor opens nothing'); else bad('a paused monitor opens nothing');
  from = v.at();
  const r = await api('POST', `/api/monitors/${hero.id}/resume`);
  if (r.json?.monitor?.state && r.json.monitor.state !== 'paused') ok('resumed', r.json.monitor.state); else bad('resumed', JSON.stringify(r.json));
  const inc = (await incidentFor(v, hero.id, from))?.incident;
  if (inc) ok('resuming on a broken element opens the incident', inc.id); else bad('resuming on a broken element opens the incident');
  from = v.at();
  await run(v, 'click button:Reset all');
  await v.until((m) => m.t === 'incident.resolved' && m.incident.id === inc?.id, 10000, from);
  const shot = hero.baselineShot;
  from = v.at();
  const d = await api('DELETE', `/api/monitors/${hero.id}`);
  if (d.status === 200 && (await v.until((m) => m.t === 'monitor.gone' && m.id === hero.id, 5000, from))) ok('deleted, and monitor.gone said so'); else bad('deleted, and monitor.gone said so', String(d.status));
  if (!(await stateOf(hero.id))) ok('gone from the list'); else bad('gone from the list');
  const kept = (await api('GET', '/api/incidents')).json?.incidents.filter((i) => i.monitorId === hero.id) ?? [];
  if (!kept.length) ok('its incidents went with it'); else bad('its incidents went with it', `${kept.length} kept`);
  if (EXTERNAL) ok('(baseline shot file — skipped against an external runner)');
  else if (shot && !existsSync(join(STATE, 'monitor-shots', shot))) ok('its baseline shot went with it'); else bad('its baseline shot went with it', shot);
  const again = await api('DELETE', `/api/monitors/${hero.id}`);
  if (again.status === 404) ok('deleting it again is a 404'); else bad('deleting it again is a 404', String(again.status));
  const pz = await api('POST', '/api/monitors/m_00000000/pause');
  if (pz.status === 404) ok('pausing an unknown id is a 404'); else bad('pausing an unknown id is a 404', String(pz.status));
}

// ---------------------------------------------------------------------------
section('8 · reloads and other pages');
{
  let from = v.at();
  await open(v, FIXTURE);
  if (await v.until((m) => m.t === 'monitor.tick' && m.monitorId === rows.id, 10000, from)) ok('after a reload the table monitor ticks again', 're-armed by the handshake'); else bad('after a reload the table monitor ticks again');
  from = v.at();
  await open(v, OTHER);
  const there = await stateOf(rows.id);
  if (there && there.onPage === false && there.state === 'ok') ok('on another page it is "not on this page", not missing', there.state); else bad('on another page it is "not on this page", not missing', JSON.stringify({ onPage: there?.onPage, state: there?.state }));
  await wait(3000);
  if (await v.none((m) => m.t === 'incident.opened', 1, from)) ok('and nothing opened meanwhile'); else bad('and nothing opened meanwhile');
  await open(v, FIXTURE);
  await wait(1500);
  const back = await stateOf(rows.id);
  if (back?.onPage === true) ok('back on its page it is on it again'); else bad('back on its page it is on it again', JSON.stringify(back?.onPage));
}

// ---------------------------------------------------------------------------
section('8b · every visit runs the check');
{
  const before = (await stateOf(rows.id))?.stats?.visits ?? 0;
  let from = v.at();
  await open(v, FIXTURE);
  const changed = await v.until((m) => m.t === 'monitor.changed' && m.monitor.id === rows.id && (m.monitor.stats?.visits ?? 0) > before, 10000, from);
  if (changed) ok('opening the page again counts a visit', `${before} → ${changed.monitor.stats.visits}`); else bad('opening the page again counts a visit', `still ${(await stateOf(rows.id))?.stats?.visits}`);
  if (changed && changed.monitor.lastVisitAt >= STARTED) ok('and says when', new Date(changed.monitor.lastVisitAt).toISOString().slice(11, 19)); else bad('and says when');
  if (await v.until((m) => m.t === 'log' && /opened: checking/.test(m.msg), 5000, from)) ok('and the log says the check ran'); else bad('and the log says the check ran');

  // The estimate arrives 1.2s after load. Armed at DOMContentLoaded, the
  // monitor sees nothing there — and must wait, not report it missing.
  await wait(2000);
  const late = (await create('check-late', '[data-testid="late-copy"]', 'text must not change')).json?.monitor;
  if (late?.state === 'ok') ok('a monitor on the late paragraph', late.id); else { bad('a monitor on the late paragraph', JSON.stringify(late)); }
  from = v.at();
  await open(v, FIXTURE);
  await wait(4000);
  if (await v.none((m) => m.t === 'incident.opened' && m.incident.monitorId === late?.id, 1, from)) ok('a reload does not call it missing', 'late is not gone'); else bad('a reload does not call it missing', 'a missing incident opened for a paragraph that was on its way');
  const settled = await stateOf(late?.id);
  if (settled?.state === 'ok' && settled.metrics?.exists) ok('and it is ok once it has arrived', metricsOf(settled)); else bad('and it is ok once it has arrived', JSON.stringify({ state: settled?.state, metrics: settled?.metrics }));

  // Gone for real, on a page that has been open a while, is still an incident within seconds.
  await wait(2500);
  from = v.at();
  await run(v, 'click button:Remove estimate');
  const gone = (await incidentFor(v, late.id, from))?.incident;
  if (gone?.type === 'missing') ok('removed for real is a missing incident', gone.id); else bad('removed for real is a missing incident', JSON.stringify(gone?.type));
  from = v.at();
  await run(v, 'click button:Reset all');
  if (await v.until((m) => m.t === 'incident.resolved' && m.incident.id === gone?.id, 10000, from)) ok('and back is resolved'); else bad('and back is resolved');
}

// ---------------------------------------------------------------------------
section('9 · picking from the canvas');
{
  const text = (await create('check-text', HERO, 'text must not change')).json?.monitor;
  if (text) ok('a text monitor on the hero, to catch a click that gets through'); else bad('a text monitor on the hero, to catch a click that gets through');
  // Where the paragraph is, at the runner's viewport, from a browser of our own.
  probe = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--disable-dev-shm-usage'] });
  const page = await probe.newPage({ viewport: { width: 1180, height: 760 } });
  await page.goto(FIXTURE);
  const box = await page.locator(HERO).boundingBox();
  const embed = await page.locator('#embed').boundingBox();
  await page.close();
  const at = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  const inFrame = { x: Math.round(embed.x + embed.width / 2), y: Math.round(embed.y + embed.height / 2) };

  let from = v.at();
  v.send({ t: 'monitor.pick.start' });
  if (await v.until((m) => m.t === 'monitor.pick' && m.on === true, 5000, from)) ok('monitor.pick.start → picking'); else bad('monitor.pick.start → picking');
  const g = await api('GET', '/api/monitoring');
  if (g.json?.picking === true) ok('/api/monitoring says so'); else bad('/api/monitoring says so', String(g.json?.picking));
  v.send({ t: 'human.move', ...at });
  await wait(400);
  // What the pointer is over is said in words, not only outlined in the video.
  const hov = await v.until((m) => m.t === 'monitor.hover', 3000, from);
  if (hov?.tag === 'p' && /^p\.hero-copy/.test(hov.describe) && /Every order/.test(hov.text) && hov.w > 100 && hov.fontSize === '16px') ok('hovering names the element to the panel', `${hov.describe} ${hov.w}×${hov.h} · ${hov.fontSize}`);
  else bad('hovering names the element to the panel', JSON.stringify(hov));
  v.send({ t: 'human.click' });
  const sel = await v.until((m) => m.t === 'monitor.selected', 5000, from);
  if (sel?.selector === HERO && sel.snapshot?.metrics?.fontSizePx === 16 && /Every order/.test(sel.snapshot?.text ?? '')) ok('the click chose the paragraph', sel.selector); else bad('the click chose the paragraph', JSON.stringify(sel && { selector: sel.selector }));
  if (sel?.label && sel.fingerprint?.tag === 'p') ok('with a label and a fingerprint', sel.label); else bad('with a label and a fingerprint');
  if (Array.isArray(sel?.path) && sel.path.at(-1) === 'div.hero') ok('and where it sits', sel.path.join(' > ')); else bad('and where it sits', JSON.stringify(sel?.path));
  if (sel && sel.readError === null) ok('and nothing it could not read'); else bad('and nothing it could not read', JSON.stringify(sel?.readError));
  if (await v.until((m) => m.t === 'monitor.pick' && m.on === false, 5000, from)) ok('and picking ended'); else bad('and picking ended');
  const shot = await v.until((m) => m.t === 'monitor.shot' && m.selector === HERO, 8000, from);
  if (shot && /^data:image\/png;base64,/.test(shot.shot) && isPng(Buffer.from(shot.shot.slice('data:image/png;base64,'.length), 'base64'))) ok('a clip of the picked element follows', `${shot.shot.length} chars`); else bad('a clip of the picked element follows', shot ? shot.shot.slice(0, 30) : 'no monitor.shot');
  await wait(2500);
  if (await v.none((m) => m.t === 'incident.opened' && m.incident.monitorId === text?.id, 1, from)) ok('the pick-click never reached the page'); else bad('the pick-click never reached the page', 'the text changed');

  // A click inside an embedded frame reaches nothing the picker can see: the
  // person is told so, and picking stays on for the next click.
  from = v.at();
  v.send({ t: 'monitor.pick.start' });
  await v.until((m) => m.t === 'monitor.pick' && m.on === true, 5000, from);
  v.send({ t: 'human.move', ...inFrame });
  await wait(300);
  v.send({ t: 'human.click' });
  const miss = await v.until((m) => m.t === 'monitor.pick.miss', 4000, from);
  if (miss && /embedded frame/.test(miss.msg)) ok('a click inside an iframe is a miss, said out loud', miss.msg.slice(0, 40) + '…'); else bad('a click inside an iframe is a miss, said out loud', JSON.stringify(miss));
  if (await v.none((m) => m.t === 'monitor.selected', 1, from) && (await api('GET', '/api/monitoring')).json?.picking === true) ok('and picking is still on'); else bad('and picking is still on');
  v.send({ t: 'monitor.pick.stop' });
  await v.until((m) => m.t === 'monitor.pick' && m.on === false, 5000, from);

  from = v.at();
  v.send({ t: 'human.move', ...at });
  await wait(200);
  v.send({ t: 'human.click' });
  if (await incidentFor(v, text.id, from, 8000)) ok('the control: a plain click does reach it', 'the text monitor fired'); else bad('the control: a plain click does reach it');

  from = v.at();
  v.send({ t: 'monitor.pick.start' });
  await v.until((m) => m.t === 'monitor.pick' && m.on === true, 5000, from);
  v.send({ t: 'monitor.pick.stop' });
  if (await v.until((m) => m.t === 'monitor.pick' && m.on === false, 5000, from)) ok('monitor.pick.stop ends it'); else bad('monitor.pick.stop ends it');

  from = v.at();
  v.send({ t: 'monitor.pick.start' });
  await v.until((m) => m.t === 'monitor.pick' && m.on === true, 5000, from);
  v.send({ t: 'human.key', key: 'Escape' });
  if (await v.until((m) => m.t === 'monitor.pick' && m.on === false, 5000, from)) ok('Escape in the page ends it'); else bad('Escape in the page ends it');

  from = v.at();
  v.send({ t: 'command', text: 'wait 3000 ms', pace: 0 });
  await v.until((m) => m.t === 'run.start', 5000, from);
  v.send({ t: 'monitor.pick.start' });
  const busy = await v.until((m) => m.t === 'refused' && m.of === 'monitor.pick.start', 5000, from);
  if (busy) ok('refused during a run', busy.error); else bad('refused during a run');
  await v.until((m) => m.t === 'run.end', 10000, from);

  from = v.at();
  v.send({ t: 'record.start' });
  await v.until((m) => m.t === 'record.state' && m.on === true, 5000, from);
  v.send({ t: 'monitor.pick.start' });
  const rec = await v.until((m) => m.t === 'refused' && m.of === 'monitor.pick.start', 5000, from);
  if (rec) ok('refused while recording', rec.error); else bad('refused while recording');
  v.send({ t: 'record.stop' });
  await v.until((m) => m.t === 'record.state' && m.on === false, 5000, from);
}

// ---------------------------------------------------------------------------
section('10 · secrets never reach a snapshot');
{
  const r = await create('check-secret', '#debug', 'text must not change');
  const m = r.json?.monitor;
  const txt = m?.baseline?.text ?? '';
  if (m && /\$QA_PASS/.test(txt) && !/hunter2/.test(txt)) ok('the vault value is its name in the baseline', txt); else bad('the vault value is its name in the baseline', txt);
  const ex = m?.baselineExcerpt?.html ?? '';
  if (/\$QA_PASS/.test(ex) && !/hunter2/.test(ex)) ok('and in the markup excerpt', ex.slice(0, 70)); else bad('and in the markup excerpt', ex.slice(0, 120));
  if (EXTERNAL) ok('(monitors.json — skipped against an external runner)');
  else {
    await wait(1200);   // the store is debounced half a second
    const file = join(STATE, 'monitors.json');
    const disk = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (disk && !disk.includes('hunter2-but-from-a-vault')) ok('and never on disk', file); else bad('and never on disk', disk ? 'THE SECRET IS ON DISK' : 'no monitors.json');
  }
}

// ---------------------------------------------------------------------------
section('11 · cleanup');
await sweep();
const left = (await api('GET', '/api/monitors')).json?.monitors.filter((m) => String(m.label).startsWith('check-')) ?? [];
if (!left.length) ok('the check’s monitors are gone'); else bad('the check’s monitors are gone', `${left.length} left`);
const stray = (await api('GET', '/api/incidents')).json?.incidents.filter((i) => String(i.monitorLabel).startsWith('check-') && i.openedAt >= STARTED) ?? [];
if (!stray.length) ok('and none of their incidents stayed behind'); else bad('and none of their incidents stayed behind', `${stray.length} left`);
v.ws.close();
await done();
