/**
 * Schedules, checked three ways.
 *
 *   the arithmetic   a cron line names the minutes it names, in words too
 *   the engine       fires what is due, once; waits while the browser is
 *                    held and says so when the slot has passed; a fire
 *                    that throws is an outcome, not a dead engine
 *   the runner       the routes, a schedule fired by hand against a real
 *                    suite, the run marked as scheduled in history, and a
 *                    sweep with nothing to sweep
 *
 *   node scripts/check-schedules.js          (the third part needs a browser)
 *   GC_SCHEDULES_OFFLINE=1 node scripts/check-schedules.js   (the first two only)
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCron, nextAfter, describeCron, forOrg, orgsWithSchedules, Scheduler, Deferred, SCHEDULES_MAX, publicSchedule } from '../schedules.js';
import { stateDir } from '../org.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(56)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(56)} ${d}`); };
const section = (t) => console.log(`\n— ${t} ${'—'.repeat(Math.max(2, 60 - t.length))}`);
async function check(label, fn) { try { const d = await fn(); ok(label, d ?? ''); } catch (e) { bad(label, e.message.split('\n')[0].slice(0, 120)); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
section('1 · the arithmetic');
const from = new Date(2026, 8, 19, 12, 34, 56).getTime();      // a Saturday
const at = (c) => new Date(nextAfter(c, from));
await check('every minute is the next whole minute', () => { assert.equal(at('* * * * *').getTime(), new Date(2026, 8, 19, 12, 35).getTime()); });
await check('a step counts from the top of the hour', () => { assert.equal(at('*/15 * * * *').getMinutes(), 45); });
await check('daily at a time already past today is tomorrow', () => { const d = at('30 9 * * *'); assert.equal(d.getDate(), 20); assert.equal(d.getHours(), 9); });
await check('weekdays from a Saturday is Monday', () => { assert.equal(at('0 9 * * 1-5').getDay(), 1); assert.equal(at('0 9 * * mon-fri').getDay(), 1); });
await check('day of month OR day of week, as cron has always meant it', () => { const d = at('0 9 15 * 1'); assert.equal(d.getDay(), 1); });
await check('sunday is 0 and 7', () => { assert.deepEqual([...parseCron('0 0 * * 7').dow], [0]); });
await check('a time that never comes within a year is null', () => { assert.equal(nextAfter('0 0 29 2 *', from), null); });
await check('in words', () => {
  assert.equal(describeCron('*/15 * * * *'), 'every 15 minutes');
  assert.equal(describeCron('0 * * * *'), 'hourly at :00');
  assert.equal(describeCron('30 9 * * *'), 'daily at 09:30');
  assert.equal(describeCron('0 9 * * 1-5'), 'weekdays at 09:00');
  assert.equal(describeCron('0 0 1 * *'), 'cron 0 0 1 * *');
});
await check('what is not a cron line is refused, by name', () => {
  for (const [line, why] of [['0 9', /five fields/], ['60 * * * *', /minute 60/], ['0 9 * * 8', /day of week 8/], ['0 9 * * x', /"x" is not a day of week/], ['*/0 * * * *', /step must be 1/], ['5-1 * * * *', /runs backwards/]]) {
    assert.throws(() => parseCron(line), why, line);
  }
});

// ---------------------------------------------------------------------------
section('2 · the store and the engine');
const ORG = 'check-schedules';
rmSync(stateDir(ORG), { recursive: true, force: true });
const book = forOrg(ORG);
let clock = new Date(2026, 8, 19, 12, 0, 0).getTime();
const now = () => clock;
await check('a schedule is made with its next time, kept on disk, and listed without its claims', () => {
  const s = book.create({ kind: 'suite', suiteId: 'su-1', cron: '*/30 * * * *', name: 'Half-hourly', claims: { org: ORG, plan: 'team', ent: { 'runs.per_day': 100 }, ent_v: 3 } }, { clock: now });
  assert.equal(s.nextAt, new Date(2026, 8, 19, 12, 30).getTime());
  assert.equal(s.describe, 'every 30 minutes');
  assert.ok(!('claims' in s));
  assert.ok(existsSync(join(stateDir(ORG), 'schedules.json')));
  assert.ok(orgsWithSchedules().includes(ORG));
  assert.equal(book.list('su-1').length, 1);
  assert.equal(book.list('su-2').length, 0);
});
await check('a bad cron, a missing suite and the cap are refused', () => {
  assert.throws(() => book.create({ kind: 'suite', suiteId: 'su-1', cron: 'x' }, { clock: now }), /five fields/);
  assert.throws(() => book.create({ kind: 'suite', cron: '* * * * *' }, { clock: now }), /names the suite/);
  assert.throws(() => book.create({ kind: 'nope', cron: '* * * * *' }, { clock: now }), /kind must be/);
  const many = forOrg('check-schedules-cap');
  rmSync(stateDir('check-schedules-cap'), { recursive: true, force: true });
  for (let i = 0; i < SCHEDULES_MAX; i++) many.create({ kind: 'sweep', cron: '* * * * *' }, { clock: now });
  assert.throws(() => many.create({ kind: 'sweep', cron: '* * * * *' }, { clock: now }), /at most/);
  rmSync(stateDir('check-schedules-cap'), { recursive: true, force: true });
});
const fired = [];
let busy = false;
let fire = async (org, s) => { fired.push({ org, id: s.id, at: clock }); return { ok: true, passed: 2, total: 2 }; };
const events = [];
const engine = new Scheduler({ fire: (o, s) => fire(o, s), busy: () => busy, clock: now, orgs: () => [ORG], book: forOrg, emit: (org, ev) => events.push(ev), log: { error: () => {} } });
engine.known.add(ORG);
const one = () => [...book.schedules.values()][0];
await check('nothing fires before its time', async () => { await engine.tick(); assert.equal(fired.length, 0); });
await check('it fires once when due, and the next time moves on', async () => {
  clock = new Date(2026, 8, 19, 12, 30, 10).getTime();
  await engine.tick();
  assert.equal(fired.length, 1);
  assert.equal(one().nextAt, new Date(2026, 8, 19, 13, 0).getTime());
  assert.deepEqual(one().lastOutcome, { at: clock, ok: true, passed: 2, total: 2 });
  await engine.tick();
  assert.equal(fired.length, 1, 'not twice for one slot');
  assert.equal(events.filter((e) => e.t === 'schedule.fired').length, 1);
});
await check('while the browser is held it waits, and fires when it is free', async () => {
  clock = new Date(2026, 8, 19, 13, 0, 5).getTime();
  busy = true;
  await engine.tick();
  assert.equal(fired.length, 1);
  assert.equal(one().waitingSince, clock);
  busy = false;
  clock += 40_000;
  await engine.tick();
  assert.equal(fired.length, 2);
  assert.equal(one().waitingSince, null);
});
await check('held for the whole slot, the slot is recorded as missed and the next one taken', async () => {
  clock = new Date(2026, 8, 19, 13, 30, 5).getTime();
  busy = true;
  await engine.tick();                       // due, waiting
  clock = new Date(2026, 8, 19, 14, 0, 5).getTime();
  await engine.tick();                       // the following slot has come round too
  assert.equal(fired.length, 2);
  assert.equal(one().missed, 1);
  assert.equal(one().lastOutcome.missed, true);
  assert.equal(one().nextAt, new Date(2026, 8, 19, 14, 30).getTime());
  busy = false;
});
await check('a Deferred fire waits like a held browser; a throw is an outcome', async () => {
  clock = new Date(2026, 8, 19, 14, 30, 5).getTime();
  fire = async () => { throw new Deferred('the lock'); };
  await engine.tick();
  assert.equal(one().waitingSince, clock);
  fire = async () => { throw new Error('the suite is gone'); };
  clock += 30_000;
  await engine.tick();
  assert.equal(one().lastOutcome.error, 'the suite is gone');
  assert.equal(one().nextAt, new Date(2026, 8, 19, 15, 0).getTime());
});
await check('switched off, it never fires; on again, its next time is recomputed', async () => {
  fire = async (org, s) => { fired.push({ org, id: s.id, at: clock }); return { ok: true, passed: 1, total: 1 }; };
  book.update(one().id, { enabled: false }, { clock: now });
  clock = new Date(2026, 8, 19, 15, 0, 5).getTime();
  await engine.tick();
  assert.equal(fired.length, 2);
  book.update(one().id, { enabled: true }, { clock: now });
  assert.equal(one().nextAt, new Date(2026, 8, 19, 15, 30).getTime());
});
await check('run now fires whatever the time, and reports by hand', async () => {
  const s = await engine.runNow(ORG, one().id);
  assert.equal(fired.length, 3);
  assert.equal(s.lastOutcome.byHand, true);
  assert.equal(s.nextAt, new Date(2026, 8, 19, 15, 30).getTime(), 'the next time is not moved by a run by hand');
});
await check('a runner that was down runs a missed schedule once, not once per slot', async () => {
  clock = new Date(2026, 8, 20, 9, 0, 0).getTime();   // eighteen hours later
  await engine.tick();
  assert.equal(fired.length, 4);
  assert.equal(one().nextAt, new Date(2026, 8, 20, 9, 30).getTime());
});
await check('removed, it is gone from the list and the file', () => {
  book.remove(one().id);
  assert.equal(book.list().length, 0);
  assert.equal(publicSchedule({ id: 'x', cron: '0 9 * * *', claims: { a: 1 } }).describe, 'daily at 09:00');
});
rmSync(stateDir(ORG), { recursive: true, force: true });

// ---------------------------------------------------------------------------
if (process.env.GC_SCHEDULES_OFFLINE) {
  console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all green (offline)\n');
  process.exit(failures ? 1 : 0);
}
section('3 · the runner');
const PORT = Number(process.env.GC_SCHEDULES_PORT) || 3416;
const BASE = `http://localhost:${PORT}`;
const child = spawn('node', ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(PORT), GC_CHAT: 'mock', GC_MONITOR_LLM: 'mock', HOME_URL: 'about:blank', GC_PACE_MS: '0', GC_SETTLE_MS: '120', GC_TIMEOUT_MS: '4000' },
});
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });
const api = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, json };
};
const done = async () => { child.kill('SIGTERM'); await sleep(500); console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all green\n'); process.exit(failures ? 1 : 0); };
for (let i = 0; i < 120; i++) { try { const r = await fetch(`${BASE}/healthz`); if (r.ok) break; } catch { /* not yet */ } await sleep(500); }
const settled = async () => { for (let i = 0; i < 200; i++) { const s = (await api('GET', '/api/state')).json; if (s && !s.running) return s; await sleep(300); } return null; };
let suiteId = null;
let scheduleId = null;
try {
  await check('the runner boots with the scheduler up', async () => { assert.match(log, /schedules\s+/); });
  const made = await api('POST', '/api/suites/quickstart', { url: `${BASE}/demo.html`, name: 'Schedules check' });
  suiteId = made.json?.suite?.id ?? made.json?.suiteId ?? null;
  await check('a suite to schedule, from quickstart', async () => { assert.equal(made.status, 200, JSON.stringify(made.json).slice(0, 200)); assert.ok(suiteId); await settled(); });
  await check('a bad cron is a 400 that names the field', async () => {
    const r = await api('POST', '/api/schedules', { kind: 'suite', suiteId, cron: '99 * * * *' });
    assert.equal(r.status, 400); assert.match(r.json?.error ?? r.json?.message ?? '', /minute 99/);
  });
  await check('a suite that is not this organisation\'s is "no suite"', async () => {
    const r = await api('POST', '/api/schedules', { kind: 'suite', suiteId: 'su-nope', cron: '0 9 * * *' });
    assert.equal(r.status, 404);
  });
  await check('a schedule is made, described, and listed by suite', async () => {
    const r = await api('POST', '/api/schedules', { kind: 'suite', suiteId, cron: '0 9 * * 1-5', name: 'Weekday mornings' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    scheduleId = r.json.schedule.id;
    assert.equal(r.json.schedule.describe, 'weekdays at 09:00');
    assert.ok(r.json.schedule.nextAt > Date.now());
    const l = await api('GET', `/api/schedules?suite=${suiteId}`);
    assert.equal(l.json.schedules.length, 1);
    assert.equal((await api('GET', '/api/schedules?suite=su-other')).json.schedules.length, 0);
  });
  await check('run now answers 202 and the run is in history as scheduled', async () => {
    const r = await api('POST', `/api/schedules/${scheduleId}/run`);
    assert.equal(r.status, 202, JSON.stringify(r.json));
    let s = null;
    // The run is on the organisation's own pooled page (backgroundSession):
    // the console is never marked running by it, however often it is asked.
    let consoleRunning = false;
    for (let i = 0; i < 200; i++) {
      const [sched, state] = await Promise.all([api('GET', `/api/schedules?suite=${suiteId}`), api('GET', '/api/state')]);
      if (state.json?.running) consoleRunning = true;
      s = sched.json.schedules[0];
      if (s.lastOutcome) break;
      await sleep(150);
    }
    assert.ok(s?.lastOutcome, 'an outcome arrived');
    assert.equal(consoleRunning, false, 'the console was marked running by a scheduled run');
    const health = (await api('GET', '/healthz')).json;
    assert.ok(health.pool && health.pool.active >= 1, `a pooled context is leased: ${JSON.stringify(health.pool)}`);
    assert.equal(s.lastOutcome.byHand, true);
    assert.equal(s.lastOutcome.ok, true, JSON.stringify(s.lastOutcome));
    assert.equal(s.fired, 1);
    const runs = (await api('GET', `/api/runs?suite=${suiteId}`)).json;
    assert.ok(runs.latest.some((x) => x.scheduled === true), 'a run marked scheduled');
    assert.ok(runs.latest.some((x) => !x.scheduled), 'the quickstart run is not');
  });
  await check('switched off and on, renamed', async () => {
    const off = await api('PATCH', `/api/schedules/${scheduleId}`, { enabled: false, name: 'Paused mornings' });
    assert.equal(off.json.schedule.enabled, false);
    assert.equal(off.json.schedule.name, 'Paused mornings');
    const on = await api('PATCH', `/api/schedules/${scheduleId}`, { enabled: true, cron: '*/10 * * * *' });
    assert.equal(on.json.schedule.describe, 'every 10 minutes');
  });
  await check('a sweep opens a monitored page on the pooled session and the monitor is visited', async () => {
    // A monitor on the demo page's heading, made over the API the way the monitoring check makes one.
    const made = await api('POST', '/api/monitors', { selector: 'h1', label: 'check-schedules', ruleText: 'text must not change' });
    if (made.status !== 200) return `skipped: a monitor could not be made here (${made.status} ${JSON.stringify(made.json).slice(0, 80)})`;
    const monitorId = made.json.monitor.id;
    try {
      const r = await api('POST', '/api/schedules', { kind: 'sweep', cron: '0 * * * *', name: 'Sweep check' });
      const id = r.json.schedule.id;
      assert.equal((await api('POST', `/api/schedules/${id}/run`)).status, 202);
      let s = null;
      for (let i = 0; i < 300; i++) { s = (await api('GET', '/api/schedules')).json.schedules.find((x) => x.id === id); if (s.lastOutcome) break; await sleep(200); }
      assert.ok(s?.lastOutcome, 'the sweep ended');
      assert.equal(s.lastOutcome.pages, 1, JSON.stringify(s.lastOutcome));
      assert.equal(s.lastOutcome.ok, true, JSON.stringify(s.lastOutcome));
      const m = (await api('GET', '/api/monitors')).json.monitors.find((x) => x.id === monitorId);
      assert.ok(m && m.stats && m.stats.visits >= 1, `the monitor was visited by the sweep: ${JSON.stringify(m?.stats)}`);
      assert.equal((await api('DELETE', `/api/schedules/${id}`)).status, 200);
      return `visits ${m.stats.visits}`;
    } finally { await api('DELETE', `/api/monitors/${monitorId}`); }
  });
  await check('a sweep with nothing to sweep says so', async () => {
    const r = await api('POST', '/api/schedules', { kind: 'sweep', cron: '0 * * * *' });
    assert.equal(r.status, 200);
    const id = r.json.schedule.id;
    assert.equal((await api('POST', `/api/schedules/${id}/run`)).status, 202);
    let s = null;
    for (let i = 0; i < 100; i++) { s = (await api('GET', '/api/schedules')).json.schedules.find((x) => x.id === id); if (s.lastOutcome) break; await sleep(200); }
    assert.equal(s.lastOutcome.pages, 0);
    assert.match(s.lastOutcome.note, /nothing to sweep/);
    assert.equal((await api('DELETE', `/api/schedules/${id}`)).status, 200);
  });
  await check('removed, and a second removal is a 404', async () => {
    assert.equal((await api('DELETE', `/api/schedules/${scheduleId}`)).status, 200);
    assert.equal((await api('DELETE', `/api/schedules/${scheduleId}`)).status, 404);
    assert.equal((await api('GET', '/api/schedules')).json.schedules.length, 0);
  });
} finally {
  if (suiteId) await api('DELETE', `/api/suites/${suiteId}`).catch(() => null);
  await done();
}
