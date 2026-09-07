/**
 * Where the runner points when it starts.
 *
 *   npm start &
 *   node scripts/check-startup.js
 *
 * This exists because the green suite could not see the case that mattered.
 * The rule reads the newest run out of history, and history is gitignored — so
 * on the machine that wrote it there is always a page to open, and on a fresh
 * clone or a CI runner there is never one. Every check ran in the first
 * condition and the second was never executed anywhere.
 *
 * Two halves, and both are needed:
 *
 *   the decision   chooseHome() against fabricated input, instantly, including
 *                  the empty-history branch no machine here can produce
 *   the wiring     the running server actually opened what chooseHome() picks
 *                  from the same history and allowlist
 *
 * The first alone would pass while server.js ignored the function entirely.
 * The second alone can only ever test the state this machine happens to be in.
 */
import { spawn, spawnSync } from 'node:child_process';
import WebSocket from 'ws';
import { fileURLToPath } from 'node:url';
import { chooseHome } from '../home.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const API = process.env.BASE_URL || 'http://localhost:3000';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(46)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(46)} ${d}`); };
const yes = () => true;
const run = (url) => ({ url, at: Date.now() });

// ---------------------------------------------------------------------------
console.log('\n— the decision ————————————————————————————————————');

// 1. An explicit choice beats an inferred one.
const named = chooseHome({
  envUrl: 'https://staging.acme.com/',
  runs: [run('http://localhost:3000/demo.html')],
  isAllowed: yes,
});
if (named === 'https://staging.acme.com/') ok('HOME_URL wins over history', named);
else bad('HOME_URL wins over history', String(named));

// 2. Otherwise the newest run. `list()` is oldest first, and reading it the
//    wrong way round would reliably reopen whatever you ran a fortnight ago.
const newest = chooseHome({
  runs: [run('http://localhost:3000/old.html'), run('http://localhost:3000/new.html')],
  isAllowed: yes,
});
if (newest === 'http://localhost:3000/new.html') ok('otherwise the newest run', newest);
else bad('otherwise the newest run', String(newest));

// 3. The gate still applies. A URL that ran here before normally passes — but
//    an origin you have since removed must not be re-opened because a file
//    remembers it.
const gated = chooseHome({
  runs: [run('http://localhost:3000/kept.html'), run('http://revoked.example/gone.html')],
  isAllowed: (o) => o === 'http://localhost:3000',
});
if (gated === 'http://localhost:3000/kept.html') ok('a revoked origin is skipped', gated);
else bad('a revoked origin is skipped', String(gated));

// 4. The branch every fresh clone takes, and the one no machine here can reach:
//    nothing to open, said plainly rather than as a black rectangle.
const nothing = chooseHome({ runs: [], isAllowed: yes });
if (nothing === null) ok('and empty history opens nothing', 'null, not a default');
else bad('and empty history opens nothing', String(nothing));

// A run recorded before the URL was parseable, or a suite deleted since, must
// not throw at boot — the server would not start at all.
try {
  const junk = chooseHome({ runs: [run('not a url'), run(null)], isAllowed: yes });
  if (junk === null) ok('an unreadable entry is skipped, not thrown on');
  else bad('an unreadable entry is skipped, not thrown on', String(junk));
} catch (e) { bad('an unreadable entry is skipped, not thrown on', e.message); }

// ---------------------------------------------------------------------------
console.log('\n— the wiring ——————————————————————————————————————');

/**
 * The decision being right is worth nothing if server.js does not use it.
 *
 * Start a real server on its own port and read the boot banner, which prints
 * the choice BEFORE navigating — so this needs no browser round-trip and no
 * waiting for a page. Asserting against the RUNNING server instead would only
 * ever say where the page has since wandered: a run moves it on, legitimately,
 * and an SPA route change moves it without navigating at all.
 *
 * This is the half that discriminates. A server reverted to a constant would
 * announce the bundled demo while history says otherwise.
 */
/**
 * Make the newest run something the old behaviour would never have chosen.
 *
 * Without this the assertion is degenerate half the time: the rest of the suite
 * runs against demo.html, so when that IS the newest run a server reverted to
 * the old constant announces the same URL and passes. Driving one case against
 * a different page first — using the product, not fabricating a file — means
 * the two answers can never coincide.
 */
const ws = new WebSocket(API.replace(/^http/, 'ws'));
let ran = false;
ws.on('message', (d, bin) => { if (!bin && JSON.parse(d).t === 'run.end') ran = true; });
await new Promise((r) => { ws.on('open', r); ws.on('error', r); });
await wait(300);
ws.send(JSON.stringify({ t: 'command', text:
  `%% suite "Startup probe"\ntestcase TD\n  a(("${API}/results.html"))\n  b["/results.html"]\n  a --> b` }));
for (let i = 0; i < 40 && !ran; i++) await wait(500);
ws.close();
if (!ran) bad('a probe run was recorded', 'the run never finished');

const child = spawnSync(process.execPath, [ROOT + 'scripts/start.js'], {
  cwd: ROOT, timeout: 20000, encoding: 'utf8',
  env: { ...process.env, PORT: '3400', GC_SKIP_BUILD: '1', HOME_URL: '' },
});
const banner = (child.stdout ?? '').split('\n').find((l) => l.includes('driving')) ?? '';
const announced = banner.split('->')[1]?.trim() ?? '(no banner)';

/**
 * History read over HTTP, not by importing runs.js.
 *
 * The module loads the file once at import, so this process's copy predates the
 * probe run the main server just recorded — it would compare the child's answer
 * against history as it stood a minute ago and report a mismatch that is only
 * staleness. `/api/runs` is the live server's own view.
 */
const seen = await fetch(`${API}/api/runs`).then((r) => r.json()).catch(() => null);
const allowed = new Set((await fetch(`${API}/api/state`).then((r) => r.json()).catch(() => ({}))).origins ?? []);
const expected = chooseHome({
  envUrl: null,
  runs: (seen?.latest ?? []).slice().reverse(),   // latest is newest-first; the rule wants oldest-first
  isAllowed: (o) => allowed.has(o),
});
const want = expected ?? 'nothing yet — open a URL in the console';

if (announced === want) ok('the server opens what the rule picks', announced);
else bad('the server opens what the rule picks', `rule says "${want}", server said "${announced}"`);

// The probe above guarantees the rule's answer is results.html, so a server
// still opening the bundled demo is caught here rather than coincidentally
// agreeing with it.
if (announced.endsWith('/results.html')) ok('and not the bundled demo it used to be');
else bad('and not the bundled demo it used to be', announced);

// ---------------------------------------------------------------------------
console.log('\n— and it can be asked about itself while it starts ——');

/**
 * The port opens the moment express is ready. The browser takes seconds after
 * that, so there is a window where the server accepts requests and its runtime
 * state does not exist yet — and reading a `let` before its declaration is a
 * ReferenceError, not undefined.
 *
 * /api/state reads three of them and it is the first thing the UI asks for. It
 * used to answer with a 500 and an express stack trace for the whole of that
 * window, which reads as a broken server rather than one that is still coming
 * up. Nothing caught it because every check waits for the server to settle
 * before asking it anything.
 *
 * So this one deliberately does not wait: it hammers /api/state from the
 * instant the port accepts a connection until the browser is up, and any 500
 * in there is a failure.
 */
const BOOT_PORT = Number(process.env.GC_BOOT_PORT) || 3407;
const booting = spawn(process.execPath, [ROOT + 'scripts/start.js'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(BOOT_PORT), GC_SKIP_BUILD: '1', HOME_URL: '' },
});
try {
  const codes = new Map();
  let sawOk = false;
  for (let i = 0; i < 200 && !sawOk; i++) {
    const code = await fetch(`http://127.0.0.1:${BOOT_PORT}/api/state`)
      .then((r) => r.status).catch(() => 0);        // 0 = not listening yet
    if (code) codes.set(code, (codes.get(code) ?? 0) + 1);
    // Two 200s in a row means the window is behind us and nothing broke in it.
    if (code === 200 && codes.get(200) >= 2) sawOk = true;
    await wait(50);
  }
  const seen = [...codes.entries()].map(([c, n]) => `${c}x${n}`).join(' ');
  if (!sawOk) bad('/api/state answers while the browser starts', `never got a 200 — saw ${seen || 'nothing'}`);
  else if ([...codes.keys()].some((c) => c >= 500)) {
    bad('/api/state answers while the browser starts', `${seen} — a 5xx during boot`);
  } else ok('/api/state answers while the browser starts', seen);
} finally {
  booting.kill('SIGTERM');
  await wait(300);
  booting.kill('SIGKILL');
}

console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — HOME_URL wins, else the newest run whose origin is still\n'
    + '       allowed, else nothing at all — and the server opens what the\n'
    + '       rule picks rather than a bundled demo.\n');
process.exit(failures ? 1 : 0);
