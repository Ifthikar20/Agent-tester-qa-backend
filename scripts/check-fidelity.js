/**
 * "When you rerun the script, it has to run exactly what I did."
 *
 * Two questions, both answered by running them rather than by argument.
 *
 *   1. Does replaying a recording reproduce the demonstration?
 *   2. Would replaying the raw coordinates have done the same job?
 *
 *   npm start &
 *   node scripts/check-fidelity.js
 */
import WebSocket from 'ws';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const VIEW = { width: 1180, height: 760 };
const fail = (m) => { console.log(`\n  FAIL  ${m}\n`); process.exit(1); };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

// Element centres in the same viewport the runner streams.
const probe = await browser.newPage({ viewport: VIEW });
await probe.goto(`${BASE}/demo.html`);
const at = async (l) => { const b = await l.boundingBox(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; };
const P = { email: await at(probe.getByLabel('Email')), password: await at(probe.getByLabel('Password')),
            signin: await at(probe.getByRole('button', { name: 'Sign in' })),
            settings: await at(probe.getByRole('link', { name: 'Settings' })) };
await probe.getByLabel('Email').fill('a@b.c');
await probe.getByLabel('Password').fill('x');
await probe.getByRole('button', { name: 'Sign in' }).click();
await probe.getByRole('link', { name: 'Settings' }).click();
P.profile = await at(probe.getByRole('button', { name: 'Profile' }));
await probe.getByRole('button', { name: 'Profile' }).click();
P.username = await at(probe.getByLabel('Username'));
P.save = await at(probe.getByRole('button', { name: 'Save changes' }));
await probe.close();

// ---------------------------------------------------- 1. demonstrate, replay
const ws = new WebSocket(`ws://${new URL(BASE).host}`);
let flow = '', snap = null, runWaiter = null;
const notes = [];
ws.on('message', (d, bin) => {
  if (bin) return;
  const ev = JSON.parse(d);
  if (ev.t === 'recorded') flow = ev.flow;
  if (ev.t === 'targets') snap = ev;
  if (ev.t === 'log' && ev.level === 'warn') notes.push(ev.msg);
  if (ev.t === 'run.end' && runWaiter) { runWaiter(ev); runWaiter = null; }
});
const send = (o) => ws.send(JSON.stringify(o));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const click = async (p) => { send({ t: 'human.move', ...p }); await wait(110); send({ t: 'human.click' }); await wait(340); };
const type = async (t) => { for (const c of t) { send({ t: 'human.key', text: c }); await wait(26); } await wait(150); };
const state = async () => { snap = null; send({ t: 'inspect' }); await wait(700);
  return { url: snap.url, targets: snap.items.map((i) => i.target).sort().join(' · ') }; };

await new Promise((r) => ws.on('open', r));
await wait(500);

console.log('\n— 1 · demonstrate by hand, then replay what it wrote ————————');
send({ t: 'open', url: `${BASE}/demo.html` }); await wait(1400);
send({ t: 'record.start' }); await wait(400);
await click(P.email);    await type('qa@example.com');
await click(P.password); await type('hunter2-but-from-a-vault');
await click(P.signin);
await click(P.settings);
await click(P.profile);
await click(P.username); await type('aaaaaaaaaaaaaaaaaaaa');
await click(P.save);
await wait(700);
send({ t: 'record.stop' }); await wait(700);
const demonstrated = await state();
console.log(`  demonstrated  ${demonstrated.url}`);

send({ t: 'open', url: `${BASE}/demo.html` }); await wait(1500);
notes.length = 0;
send({ t: 'command', text: flow.replace(/\$TODO/g, '$QA_PASS') });
const end = await new Promise((r) => { runWaiter = r; });
await wait(700);
const replayed = await state();
console.log(`  replayed      ${replayed.url}`);

if (!end.ok) fail('the replay did not run clean');
if (demonstrated.url !== replayed.url) fail(`different url: ${demonstrated.url} vs ${replayed.url}`);
if (demonstrated.targets !== replayed.targets) {
  fail(`different page:\n    hand:   ${demonstrated.targets}\n    replay: ${replayed.targets}`);
}
console.log(`  same page after both  ✓`);
console.log(`  ${notes.length ? notes.length + ' drift note(s): ' + notes[0] : 'no drift — every element resolved where it was clicked'}`);

// -------------------------------------------- 2. would coordinates have done?
console.log('\n— 2 · would replaying the coordinates have worked? ——————————');
const marks = [...flow.matchAll(/^%% at (\d+) (-?\d+),(-?\d+) /gm)].length;
if (!marks) fail('the recording carries no coordinates');
console.log(`  the recording carries ${marks} landing points, e.g. Sign in at ${P.signin.x},${P.signin.y}`);

const shifted = await browser.newPage({ viewport: { width: 880, height: 760 } });
await shifted.goto(`${BASE}/demo.html`);
const hit = await shifted.evaluate(({ x, y }) => {
  const el = document.elementFromPoint(x, y);
  if (!el) return { desc: 'nothing at all', id: null };
  return {
    desc: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}`,
    id: el.id || null,
    // Identify the element, not its text: a wrapper's innerText contains the
    // button's words, so matching on text says "hit" when it plainly missed.
    isTheButton: el.id === 'signin',
  };
}, P.signin);
const stillWorks = await shifted.getByRole('button', { name: 'Sign in' }).count();
await shifted.close();
await browser.close();

console.log(`  same page, window 880 wide instead of 1180:`);
console.log(`    coordinate ${P.signin.x},${P.signin.y} now lands on   ${hit.desc}  (the Sign in button? ${hit.isTheButton ? 'yes' : 'NO'})`);
console.log(`    button:Sign in still resolves                        ${stillWorks === 1 ? 'yes, exactly one' : stillWorks + ' matches'}`);

if (stillWorks !== 1) fail('the semantic target broke, which would undermine the whole argument');
const coordinateMissed = !hit.isTheButton;
console.log(`\n  ${coordinateMissed
  ? 'Coordinate replay MISSES the button after a resize. The name still finds it.'
  : 'Coordinates survived this resize — try a bigger layout change before trusting them.'}`);
if (!coordinateMissed) {
  console.log('  (This demo app may be too forgiving; the point stands for any responsive layout.)');
}
console.log(`
  So: the replay reproduces the demonstration, and the coordinates are kept
  as evidence — they are what tells you an element moved — rather than as the
  way the element is found.
`);
ws.close();
