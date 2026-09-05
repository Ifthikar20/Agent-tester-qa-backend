/**
 * End-to-end check. Drives the running server over the same WebSocket the
 * browser uses, so it exercises the real path: parse -> validate -> execute.
 *
 *   node server.js &        # or npm start
 *   node scripts/check.js
 */
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';

const URL_ = process.env.WS_URL || 'ws://localhost:3000';
const SCRIPT = `suite "Username length boundary"
goto   "http://localhost:3000/demo.html"
fill   auth.email    with $secrets.QA_USER
fill   auth.password with $secrets.QA_PASS
click  auth.submit
click  nav.settings
expect url contains "/settings"
click  settings.profileTab
fill   profile.username with repeat("a", 20)
click  profile.save
expect text "Profile saved"
expect value profile.username is repeat("a", 20)`;

const REJECTIONS = [
  ['click profile.nonexistent',  /unknown target/i],
  ['goto "file:///etc/passwd"',  /http\(s\)|absolute/i],
  ['goto "http://169.254.169.254/latest/meta-data/"', /allowlist/i],
  ['evaluate "fetch(1)"',        /unknown verb/i],
];

const ws = new WebSocket(URL_);
ws.binaryType = 'arraybuffer';

let frames = 0, cursorEvents = 0, presses = 0, savedFrame = false;
const steps = [];
let waiter = null;
const nextRunEnd = () => new Promise((r) => { waiter = r; });

ws.on('message', (data, isBinary) => {
  if (isBinary) {
    frames++;
    if (!savedFrame) { writeFileSync('/tmp/ghostclick-frame.jpg', Buffer.from(data)); savedFrame = true; }
    return;
  }
  const ev = JSON.parse(data);
  if (ev.t === 'cursor') cursorEvents++;
  if (ev.t === 'press') presses++;
  if (ev.t === 'step.start') steps.push({ i: ev.i, desc: ev.step.op + ' ' + (ev.step.target ?? ev.step.assert ?? '') });
  if (ev.t === 'step.pass') Object.assign(steps.find((s) => s.i === ev.i), { ok: true, ms: ev.ms });
  if (ev.t === 'step.fail') Object.assign(steps.find((s) => s.i === ev.i), { ok: false, ms: ev.ms, error: ev.error });
  if (ev.t === 'log' && ev.level === 'error') errors.push(ev.msg);
  if (ev.t === 'run.end' && waiter) { waiter(ev); waiter = null; }
});

const errors = [];
const send = (text) => ws.send(JSON.stringify({ t: 'command', text }));
const fail = (m) => { console.log(`\n  FAIL  ${m}\n`); process.exit(1); };

await new Promise((r) => ws.on('open', r));
await new Promise((r) => setTimeout(r, 400));

console.log('\n— rejections (the security model) ——————————————————');
for (const [text, want] of REJECTIONS) {
  errors.length = 0;
  send(text);
  await new Promise((r) => setTimeout(r, 250));
  const got = errors[0] ?? '(no error — IT RAN)';
  const ok = want.test(got);
  console.log(`  ${ok ? 'rejected' : 'LEAKED  '}  ${text.padEnd(48)} ${got}`);
  if (!ok) fail(`"${text}" was not rejected`);
}

console.log('\n— run ——————————————————————————————————————————————');
send(SCRIPT);
const end = await nextRunEnd();

for (const s of steps) {
  console.log(`  ${s.ok ? '✓' : '✕'}  ${String(s.i).padStart(2)}  ${s.desc.padEnd(28)} ${s.ms ?? '-'}ms` +
    (s.error ? `\n        ${s.error}` : ''));
}

console.log('\n— stream ———————————————————————————————————————————');
console.log(`  screencast frames   ${frames}`);
console.log(`  cursor events       ${cursorEvents}`);
console.log(`  clicks              ${presses}`);
console.log(`  first frame saved   /tmp/ghostclick-frame.jpg`);

if (!frames) fail('no screencast frames arrived (did you ack?)');
if (!cursorEvents) fail('no cursor events — overlay would never move');

const last = steps.at(-1);
if (end.ok) fail('run passed — the truncation bug was NOT caught');
if (!/16 chars/.test(last.error ?? '')) fail(`expected a 16-char truncation failure, got: ${last.error}`);
console.log(`\n  OK — run failed on the planted bug, as designed.\n`);
ws.close();
