/**
 * End-to-end check. Drives the running server over the same WebSocket the
 * browser uses, so it exercises the real path: parse -> validate -> execute.
 *
 *   npm start &
 *   node scripts/check.js
 */
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';

const URL_ = process.env.WS_URL || 'ws://localhost:3000';
const BASE = process.env.BASE_URL || 'http://localhost:3000';

const SCRIPTS = {
  // Named targets, resolved through the alias table for this origin.
  'meridian (aliases)': `suite "Username length boundary"
goto   "${BASE}/demo.html"
fill   auth.email    with $secrets.QA_USER
fill   auth.password with $secrets.QA_PASS
click  auth.submit
click  nav.settings
expect url contains "/settings"
click  settings.profileTab
fill   profile.username with repeat("a", 20)
click  profile.save
expect text "Profile saved"
expect value profile.username is repeat("a", 20)`,

  // The same test written as mermaid. Different front end, identical IR —
  // the executor never learns which was typed.
  'meridian (mermaid flow)': `%% suite "Username length boundary"
flowchart TD
  home(("${BASE}/demo.html"))
  form("Sign-in form")
  dash["#/dashboard"]
  settings["#/settings"]
  profile("Profile tab")
  saved{{"Profile saved"}}

  home     -->|fill 'Email' : textbox = $QA_USER| form
  form     -->|fill 'Password' : textbox = $QA_PASS| form
  form     -->|click 'Sign in' : button| dash
  dash     -->|click 'Settings' : link| settings
  settings -->|click 'Profile' : button| profile
  profile  -->|fill 'Username' : textbox = 'a' * 20| profile
  profile  -->|click 'Save changes' : button| saved
  saved    -->|check 'Username' : textbox is 20 chars| saved`,

  // A different app with NO registry entries at all — every target is a
  // role:name pair resolved against the live accessibility tree.
  'nimbus shop (no registry)': `suite "Cart total ignores quantity"
goto   "${BASE}/shop.html"
fill   textbox:Search with "Widget"
click  button:Search
expect text "2 results"
click  button:Add Widget
click  button:Add Widget
click  link:Cart
expect text "Widget × 2"
expect text "Total: $40.00"`,
};

const REJECTIONS = [
  ['flowchart TD\n  a(("http://localhost:3000/")) -->|clik \'Go\' : button| b', /Unreadable edge action/i],
  ['flowchart TD\n  a["x"] --> b\n  b --> a', /No entry node/i],
  ['click nope.nothing',                             /Bad target|Unknown target strategy/i],
  ['click css:#usr_nm_2',                            /Unknown target strategy/i],
  ['click button',                                   /Bad target/i],
  ['goto "file:///etc/passwd"',                      /http\(s\)|absolute/i],
  ['goto "http://169.254.169.254/latest/meta-data/"', /allowlist|private/i],
  ['goto "https://evil.example.com/"',               /allowlist|private/i],
  ['evaluate "fetch(1)"',                            /unknown verb/i],
];

const ws = new WebSocket(URL_);
ws.binaryType = 'arraybuffer';

let frames = 0, cursorEvents = 0, presses = 0, savedFrame = false;
let targets = null, diagrams = [];
const errors = [];
let steps = [], waiter = null;

ws.on('message', (data, isBinary) => {
  if (isBinary) {
    frames++;
    if (!savedFrame) { writeFileSync('/tmp/ghostclick-frame.jpg', Buffer.from(data)); savedFrame = true; }
    return;
  }
  const ev = JSON.parse(data);
  if (ev.t === 'cursor') cursorEvents++;
  if (ev.t === 'press') presses++;
  if (ev.t === 'targets') targets = ev;
  if (ev.t === 'diagram') diagrams.push(ev);
  if (ev.t === 'step.start') steps.push({ i: ev.i, desc: `${ev.step.op} ${ev.step.target ?? ev.step.assert ?? ''}` });
  if (ev.t === 'step.pass') Object.assign(steps.find((s) => s.i === ev.i), { ok: true, ms: ev.ms });
  if (ev.t === 'step.fail') Object.assign(steps.find((s) => s.i === ev.i), { ok: false, ms: ev.ms, error: ev.error });
  if (ev.t === 'log' && ev.level === 'error') errors.push(ev.msg);
  if (ev.t === 'run.end' && waiter) { waiter(ev); waiter = null; }
});

const send = (o) => ws.send(JSON.stringify(o));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.log(`\n  FAIL  ${m}\n`); process.exit(1); };

await new Promise((r) => ws.on('open', r));
await wait(600);

// ---------------------------------------------------------------- rejections
console.log('\n— rejections (the security model) ————————————————————————');
for (const [text, want] of REJECTIONS) {
  errors.length = 0;
  send({ t: 'command', text });
  await wait(220);
  const got = errors[0] ?? '(no error — IT RAN)';
  const ok = want.test(got);
  const shown = text.replace(/\s*\n\s*/g, ' ⏎ ');
  console.log(`  ${ok ? 'rejected' : 'LEAKED  '}  ${shown.padEnd(52)} ${got}`);
  if (!ok) fail(`"${text}" was not rejected`);
}

// ---------------------------------------------------------------- discovery
console.log('\n— discovery (what makes an unseen URL scriptable) ————————');
send({ t: 'open', url: `${BASE}/shop.html` });
await wait(1400);
if (!targets?.items?.length) fail('no targets discovered on shop.html');
console.log(`  ${targets.url}`);
console.log(`  ${targets.items.map((t) => t.target).join('  ·  ')}`);
if (!targets.items.some((t) => t.target === 'button:Search')) fail('expected button:Search');

// ---------------------------------------------------------------- runs
const outcomes = {};
for (const [name, text] of Object.entries(SCRIPTS)) {
  steps = []; diagrams = [];
  console.log(`\n— run: ${name} ${'—'.repeat(Math.max(0, 42 - name.length))}`);
  send({ t: 'command', text });
  const end = await new Promise((r) => { waiter = r; });
  for (const s of steps) {
    console.log(`  ${s.ok ? '✓' : '✕'}  ${String(s.i).padStart(2)}  ${s.desc.padEnd(30)} ${s.ms ?? '-'}ms` +
      (s.error ? `\n        ${s.error}` : ''));
  }
  outcomes[name] = { end, last: steps.at(-1), diagrams: [...diagrams] };
  if (!diagrams.some((d) => d.kind === 'plan')) fail(`${name}: no plan diagram emitted`);
  if (!diagrams.some((d) => d.kind === 'report')) fail(`${name}: no report diagram emitted`);
  writeFileSync(`/tmp/gc-${name.split(' ')[0]}.mmd`, diagrams.at(-1).mermaid);
}

// ---------------------------------------------------------------- assertions
console.log('\n— stream ——————————————————————————————————————————————————');
console.log(`  screencast frames ${frames} · cursor events ${cursorEvents} · clicks ${presses}`);

for (const name of ['meridian (aliases)', 'meridian (mermaid flow)']) {
  const m = outcomes[name];
  if (m.end.ok) fail(`${name} passed — the truncation bug was NOT caught`);
  if (!/16 chars/.test(m.last.error ?? '')) fail(`${name}: expected a 16-char truncation failure, got: ${m.last.error}`);
}

const s = outcomes['nimbus shop (no registry)'];
if (s.end.ok) fail('shop run passed — the cart total bug was NOT caught');
if (!/Total: \$40\.00/.test(s.last.desc + (s.last.error ?? ''))) {
  fail(`expected the total assertion to fail, got: ${s.last.desc} / ${s.last.error}`);
}
for (const o of Object.values(outcomes)) {
  for (const d of o.diagrams) {
    if (!d.mermaid.startsWith('block-beta')) fail('diagram is not block-beta');
  }
}
if (!frames) fail('no screencast frames arrived (did you ack?)');
if (!cursorEvents) fail('no cursor events — overlay would never move');

console.log(`
  OK — both runs failed on their planted bug, on two different apps,
       one of which has no registry entries at all.
`);
ws.close();
