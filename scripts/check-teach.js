/**
 * Teach mode, end to end: demonstrate by driving the feed the way a human
 * would, then replay the mermaid it wrote.
 *
 *   npm start &
 *   node scripts/check-teach.js
 */
import WebSocket from 'ws';
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const WS_URL = process.env.WS_URL || 'ws://localhost:3000';
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const VIEW = { width: 1180, height: 760 };
const TYPED_PASSWORD = 'sup3rsecret-should-never-appear';

// Where things are, in the same viewport the server streams.
const probe = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const pp = await probe.newPage({ viewport: VIEW });
await pp.goto(`${BASE}/demo.html`);
const at = async (locator) => {
  const b = await locator.boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
const POINTS = {
  email:    await at(pp.getByLabel('Email')),
  password: await at(pp.getByLabel('Password')),
  signin:   await at(pp.getByRole('button', { name: 'Sign in' })),
  settings: await at(pp.getByRole('link', { name: 'Settings' })),
};
await probe.close();

const ws = new WebSocket(WS_URL);
const errors = [];
let flow = '', count = 0, steps = [], waiter = null;

ws.on('message', (data, isBinary) => {
  if (isBinary) return;
  const ev = JSON.parse(data);
  if (ev.t === 'recorded') { flow = ev.flow; count = ev.count; }
  if (ev.t === 'log' && ev.level === 'error') errors.push(ev.msg);
  if (ev.t === 'step.start') steps.push({ i: ev.i, desc: `${ev.step.op} ${ev.step.target ?? ev.step.assert ?? ''}` });
  if (ev.t === 'step.pass') Object.assign(steps.find((s) => s.i === ev.i), { ok: true });
  if (ev.t === 'step.fail') Object.assign(steps.find((s) => s.i === ev.i), { ok: false, error: ev.error });
  if (ev.t === 'run.end' && waiter) { waiter(ev); waiter = null; }
});

const send = (o) => ws.send(JSON.stringify(o));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.log(`\n  FAIL  ${m}\n`); process.exit(1); };

/** Exactly what the browser sends when someone clicks the canvas. */
const clickAt = async (p) => { send({ t: 'human.move', ...p }); await wait(120); send({ t: 'human.click' }); await wait(320); };
const type = async (text) => { for (const ch of text) { send({ t: 'human.key', text: ch }); await wait(28); } await wait(160); };

await new Promise((r) => ws.on('open', r));
await wait(500);

console.log('\n— demonstrating (as a human would, on the canvas) ————————');
send({ t: 'open', url: `${BASE}/demo.html` });
await wait(1200);
send({ t: 'record.start' });
await wait(400);

await clickAt(POINTS.email);    await type('qa@example.com');
await clickAt(POINTS.password); await type(TYPED_PASSWORD);
await clickAt(POINTS.signin);
await clickAt(POINTS.settings);
await wait(600);

send({ t: 'record.stop' });
await wait(600);

console.log(`  recorded ${count} steps\n`);
console.log(flow.split('\n').map((l) => '  ' + l).join('\n'));
writeFileSync('/tmp/gc-taught.mmd', flow);
if (errors.length) console.log(`\n  recorder notes: ${errors.join(' | ')}`);

// ------------------------------------------------------------------ assertions
if (!flow.includes('flowchart')) fail('no flow emitted');
if (count < 5) fail(`expected at least 5 recorded steps, got ${count}`);
if (flow.includes(TYPED_PASSWORD)) fail('THE TYPED PASSWORD IS IN THE SCRIPT');
if (!/\$TODO/.test(flow)) fail('password should have been recorded as a vault reference');
for (const want of ['Email', 'Sign in', 'Settings']) {
  if (!flow.includes(want)) fail(`recording is missing "${want}"`);
}

console.log('\n— replaying what it wrote —————————————————————————————');
// The recorder cannot know which vault key a password belongs to, so it
// writes $TODO. Map it, exactly as a human would before committing.
const runnable = flow.replace(/\$TODO/g, '$QA_PASS');
steps = [];
send({ t: 'command', text: runnable });
const end = await new Promise((r) => { waiter = r; });
for (const s of steps) {
  console.log(`  ${s.ok ? '✓' : '✕'}  ${String(s.i).padStart(2)}  ${s.desc}` + (s.error ? `\n        ${s.error}` : ''));
}
if (!end.ok) fail('the taught script did not replay cleanly');

// ------------------------------------------------- recorded mid-session
console.log('\n— a recording that starts part-way through ————————————————');
// The most common way a recording fails: you hit record while already deep in
// the app, and its URL does not get anyone back there. In an SPA the path is
// often decorative, so the entry URL hands you the login screen instead.
steps = [];
send({ t: 'command', text: `%% suite "Mid-session"
flowchart TD
  n0(("${BASE}/demo.html#/settings"))

  n0 -->|fill 'Time zone' : label = 'x'| n0

%% entry ["link:Settings","button:General","button:Profile","textbox:Time zone"]` });
const midEnd = await new Promise((r) => { waiter = r; });
const first = steps[0];
if (midEnd.ok) fail('a mid-session recording replayed clean, which it should not');
if (first?.ok !== false) fail('it failed somewhere other than the goto — the entry check did not run');
if (!/part-way through a session/.test(first.error ?? '')) {
  fail(`the failure did not explain itself:\n        ${first.error}`);
}
console.log(`  ✕ step 0 — ${first.error.split('\n')[0]}`);
console.log('  fails at the goto, not eight seconds later on an unrelated element');

console.log(`
  OK — demonstrated by hand, written as mermaid, replayed against the app.
       The typed password never entered the script, and a recording that
       begins mid-session says so instead of timing out downstream.
`);
ws.close();
