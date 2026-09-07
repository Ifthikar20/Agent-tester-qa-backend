/**
 * How much of a run is performance, and whether skipping it changes anything.
 *
 *   npm start &
 *   node scripts/check-pace.js
 *
 * A replay glides the pointer into the target, pauses, holds the button down
 * and types a character at a time. None of that is waiting for the page — it
 * exists so that a feed running at roughly ten frames a second shows something
 * a person can follow, and it costs about two thirds of a second on every click
 * step plus 42ms per character typed. Worth it when you are watching, pure cost
 * when you are not, so it is now a number a run can carry.
 *
 * Three things, and the second is the one that matters:
 *
 *   the table    at the default, every delay is the literal it replaced. This
 *                is what makes the change a refactor rather than a retiming of
 *                the other seventeen checks.
 *   the outcome  the same case run at both paces reaches the same verdict on
 *                every step. Speed must not change what a run concludes — a
 *                fast mode that quietly passes something a slow one fails is
 *                worse than no fast mode.
 *   the saving   and it is actually faster, or none of this was worth doing.
 */
import WebSocket from 'ws';
import { VirtualCursor } from '../cursor.js';
import { PACE, paceOf, performanceAt } from '../ops.js';
import { toFlow } from '../flow.js';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const WS_URL = process.env.WS_URL || BASE.replace(/^http/, 'ws');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(48)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(48)} ${d}`); };

// ---------------------------------------------------------------------------
console.log('\n— the default is the code it replaced ————————————————');

/**
 * The literals that were in ops.js before any of this existed. Every one is an
 * exact fraction of the 420ms glide they were tuned against, which is the only
 * reason expressing them as fractions is safe: at the default they must come
 * back byte-identical, or seventeen other checks have quietly been retimed.
 */
const WAS = { approach: 294, aim: 140, correct: 120, linger: 140, press: 70, keystroke: 42, dwell: 300 };
const now = performanceAt(420);
const drifted = Object.keys(WAS).filter((k) => now[k] !== WAS[k]);
if (!drifted.length) ok('every delay is unchanged at 420', Object.values(WAS).join('/') + 'ms');
else bad('every delay is unchanged at 420', drifted.map((k) => `${k}: ${WAS[k]} -> ${now[k]}`).join(', '));

const zero = performanceAt(0);
if (Object.values(zero).every((v) => v === 0)) ok('and all of it is gone at 0', 'nothing is performed');
else bad('and all of it is gone at 0', JSON.stringify(zero));

// 0 is a real setting, and `Number(x) || fallback` reads it as absent — the one
// mistake that would make the whole feature silently do nothing.
const parses = [[undefined, PACE], ['', PACE], ['0', 0], ['250', 250], ['junk', PACE], ['-5', PACE]];
const wrong = parses.filter(([raw, want]) => paceOf(raw, PACE) !== want);
if (!wrong.length) ok('0 survives being parsed', 'not read as "unset"');
else bad('0 survives being parsed', JSON.stringify(wrong));

// ---------------------------------------------------------------------------
console.log('\n— a glide takes as long as it says ———————————————————');

/**
 * It used to await a CDP round trip and THEN sleep 16ms, every frame, so a
 * 420ms glide really took 26 x (16 + rtt) — around 500ms. That was tolerable
 * while the number was a constant nobody read; it is not tolerable now that
 * someone can set it.
 */
const sent = [];
const stub = { send: async (_m, p) => { sent.push(p); await wait(4); } };   // 4ms "round trip"
const cursor = new VirtualCursor(stub, () => {});
const t0 = Date.now();
await cursor.glideTo(300, 300, 300);
const took = Date.now() - t0;
if (took >= 280 && took <= 350) ok('300ms of glide takes about 300ms', `${took}ms with a 4ms round trip`);
else bad('300ms of glide takes about 300ms', `${took}ms — ${took > 380 ? 'the sleep is still on top of the work' : 'it finished early'}`);
if (cursor.x === 300 && cursor.y === 300) ok('and lands exactly on the point', `${cursor.x},${cursor.y}`);
else bad('and lands exactly on the point', `${cursor.x},${cursor.y}`);

sent.length = 0;
await cursor.glideTo(10, 10, 0);
if (sent.length === 1) ok('a pace of 0 is one move, not an animation', '1 event');
else bad('a pace of 0 is one move, not an animation', `${sent.length} events`);

// ---------------------------------------------------------------------------
console.log('\n— the same case, at both paces ———————————————————————');

/**
 * Two fills and a click: the three costs in one case. Email is 16 characters,
 * so at the default the typing alone is 672ms.
 */
const FLOW = toFlow({
  suite: 'Pace',
  steps: [
    { op: 'goto', url: `${BASE}/demo.html` },
    { op: 'fill', target: 'label:Email', value: 'qa@example.com' },
    { op: 'fill', target: 'label:Password', value: 'hunter2' },
    { op: 'click', target: 'button:Sign in' },
    { op: 'expect', assert: 'urlContains', value: '/demo.html#/dashboard' },
  ],
});

const ws = new WebSocket(WS_URL);
await new Promise((r) => { ws.on('open', r); ws.on('error', r); });

/** Run the flow at a pace and report how it went, step by step. */
function runAt(pace) {
  return new Promise((resolve) => {
    const steps = [];
    const started = Date.now();
    const onMessage = (d, isBinary) => {
      if (isBinary) return;
      const ev = JSON.parse(d);
      if (ev.t === 'step.pass') steps.push(`${ev.i}:pass`);
      if (ev.t === 'step.fail') steps.push(`${ev.i}:fail`);
      if (ev.t === 'run.end') {
        ws.off('message', onMessage);
        resolve({ ms: Date.now() - started, steps, ok: ev.ok });
      }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ t: 'command', text: FLOW, pace }));
  });
}

await wait(400);
const watched = await runAt(420);
await wait(900);
const fast = await runAt(0);
ws.close();

if (watched.steps.length && watched.steps.join() === fast.steps.join()) {
  ok('every step reaches the same verdict', watched.steps.join(' '));
} else {
  bad('every step reaches the same verdict', `watch=[${watched.steps}] fast=[${fast.steps}]`);
}
if (watched.ok === fast.ok) ok('and the run as a whole agrees', String(watched.ok));
else bad('and the run as a whole agrees', `watch=${watched.ok} fast=${fast.ok}`);

const saved = Math.round((1 - fast.ms / watched.ms) * 100);
if (saved >= 40) ok('and dropping the performance is worth it', `${watched.ms}ms -> ${fast.ms}ms, ${saved}% off`);
else bad('and dropping the performance is worth it', `${watched.ms}ms -> ${fast.ms}ms, only ${saved}% off`);

console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — the default is the timing it replaced, a glide takes as long as it\n'
    + '       says, and the same case reaches the same verdict either way while\n'
    + '       a fast run skips the part that only a watcher needs.\n');
process.exit(failures ? 1 : 0);
