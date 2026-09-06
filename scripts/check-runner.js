/**
 * "Run script does nothing."
 *
 *   npm start &
 *   node scripts/check-runner.js
 *
 * Three separate faults produced that one symptom, and none of them printed
 * anything anywhere:
 *
 *  1. A DROPPED MESSAGE. The connection handler awaited publishTargets()
 *     before attaching its message listener, and `ws` discards messages that
 *     arrive with no listener on. The window is as long as it takes to read
 *     the accessibility tree of whatever page is open — on a real site, long
 *     enough to click a button in.
 *
 *  2. A WEDGED LOCK. run() cleared `running` on the happy path only, so a
 *     throw while recording history or drawing the report left the executor
 *     locked for the life of the process. Every later run was refused.
 *
 *  3. A DEAD PROCESS. run(plan) is called un-awaited so the socket stays
 *     responsive — but an un-awaited rejection terminates Node, so one
 *     unexpected throw took the whole runner with it.
 */
import { WebSocket } from 'ws';

const WS = process.env.WS_URL || 'ws://localhost:3000';
const BASE = process.env.BASE_URL || 'http://localhost:3000';

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(46)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(46)} ${d}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param when 'immediately' sends in the same tick as `open` — the race.
 *             'after-settling' waits for the greeting first.
 */
async function command(text, { when = 'after-settling', wait = 6000 } = {}) {
  const ws = new WebSocket(WS);
  const seen = [];
  const logs = [];
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  ws.on('message', (d, isBinary) => {
    if (isBinary) return;
    const ev = JSON.parse(d);
    seen.push(ev.t);
    if (ev.t === 'log') logs.push(`${ev.level}: ${ev.msg}`);
  });
  if (when === 'after-settling') await sleep(600);
  ws.send(JSON.stringify({ t: 'command', text }));
  await sleep(wait);
  ws.close();
  return { started: seen.includes('run.start'), ended: seen.includes('run.end'), seen, logs };
}

const GOOD = `goto "${BASE}/site.html"\nclick navigation/link:Pricing`;
const BAD  = `goto "${BASE}/site.html"\nclick button:This does not exist`;

// ---------------------------------------------------------------------------
console.log('\n— 1 · a command sent the moment the socket opens ——');

const race = await command(GOOD, { when: 'immediately' });
if (race.started) ok('is not dropped', 'the listener is attached before the greeting');
else bad('is not dropped', `only saw: ${[...new Set(race.seen)].join(', ') || '(nothing)'}`);

// ---------------------------------------------------------------------------
console.log('\n— 2 · the lock is always released ————————————————');

const first = await command(GOOD);
if (first.started && first.ended) ok('a run starts and finishes');
else bad('a run starts and finishes', JSON.stringify(first.seen.slice(0, 6)));

const second = await command(GOOD);
if (second.started) ok('and the next one is not refused');
else bad('and the next one is not refused', first.ended ? 'lock still held' : 'no run.end was sent');

// A step that fails must not take the lock with it.
const failing = await command(BAD, { wait: 12000 });
if (failing.ended) ok('a failing step still releases it', 'run.end was sent');
else bad('a failing step still releases it', 'no run.end');

const after = await command(GOOD);
if (after.started) ok('so a run after a failure works');
else bad('so a run after a failure works', 'refused');

// ---------------------------------------------------------------------------
console.log('\n— 3 · the runner is still alive ——————————————————');

const state = await fetch(`${BASE}/api/state`).then((r) => r.json()).catch(() => null);
if (state) ok('the process survived all of that', `on ${state.url}`);
else bad('the process survived all of that', 'the server is gone');

if (state && state.running === false) ok('and reports itself idle', 'so a reconnect re-enables Run');
else bad('and reports itself idle', `running=${state?.running}`);

// A fresh socket is told the truth, which is what re-enables a Run button that
// was disabled when a previous socket dropped mid-run.
const ws = new WebSocket(WS);
const ready = await new Promise((r, j) => {
  ws.on('error', j);
  ws.on('message', (d, isBinary) => { if (!isBinary) { const e = JSON.parse(d); if (e.t === 'ready') r(e); } });
});
ws.close();
if ('running' in ready && 'recording' in ready) ok('the greeting carries the run state', `running=${ready.running}`);
else bad('the greeting carries the run state', JSON.stringify(Object.keys(ready)));

console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — a command is never dropped on connect, the lock is released on\n' +
    '       every path including failure, and a throw cannot take the runner down.\n');
process.exit(failures ? 1 : 0);
