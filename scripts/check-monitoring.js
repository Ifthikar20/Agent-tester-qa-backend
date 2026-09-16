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
 *   2  a monitor needs a page  409 before a page; then a rule, its checks, its baseline shot
 *   3  a change opens an incident   the numbers, the after shot, the mock verdict
 *   4  and recovery closes it       resolved by `auto`
 *   5  churn stays quiet            a ticker and a clock are not incidents
 *   6  rows, visibility, accepting  exactly N rows; always visible; manual resolve → acknowledged
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.GC_MONITOR_PORT) || 3405;
const EXTERNAL = process.env.BASE_URL || null;
const BASE = EXTERNAL || `http://localhost:${PORT}`;
const WS_URL = `${BASE.replace(/^http/, 'ws')}/ws`;
const FIXTURE = `${BASE}/monitor.html`;
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
  if (incident.verdict?.source === 'mock' && /36px/.test(incident.verdict.explanation)) ok('a mock verdict, at once', incident.verdict.severity); else bad('a mock verdict, at once', JSON.stringify(incident.verdict));
  if (incident.after?.screenshot) {
    const s = await bytes(`/api/monitors/shots/${encodeURIComponent(incident.after.screenshot)}`);
    if (s.status === 200 && isPng(s.buf)) ok('the after shot is a PNG', incident.after.screenshotKind); else bad('the after shot is a PNG', String(s.status));
  } else bad('the after shot is a PNG', 'none taken');
  if (await v.until((m) => m.t === 'monitor.changed' && m.monitor.id === hero.id && m.monitor.state === 'violated', 5000, from)) ok('the monitor is violated'); else bad('the monitor is violated');
  if (await v.until((m) => m.t === 'monitor.tick' && m.monitorId === hero.id && m.ok === false, 5000, from)) ok('a tick said ok:false'); else bad('a tick said ok:false');
  if (await v.until((m) => m.t === 'log' && /incident: check-hero/.test(m.msg), 5000, from)) ok('and the log said so'); else bad('and the log said so');
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
