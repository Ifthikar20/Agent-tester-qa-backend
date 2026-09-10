/**
 * What the runner owes a console, over the socket, with no console in sight.
 *
 *   npm start &
 *   node scripts/check-console.js
 *
 * This file used to drive the Vue app in a real browser: navigate to /app/
 * console, read the canvas back pixel by pixel, count how much of it was not
 * black. Every one of those assertions is about something poc-qa-stack
 * renders, and poc-qa-stack is a different repository now — so that half has
 * gone there, where the components it names actually live and where a rename
 * breaks it on the commit that does the renaming.
 *
 * Deleting the file with them would have thrown away the half that is not the
 * UI's at all. Two of the three regressions it was written for were caused
 * HERE, and are invisible from the app except as a symptom:
 *
 *  1. A BLACK CANVAS. Chrome's screencast is damage-driven — a page sitting
 *     still emits nothing — so a viewer that attaches to a quiet page gets
 *     nothing until something moves. The fix is the runner priming each new
 *     socket with the last frame it held. That is a property of this process,
 *     it showed up as "the app is broken", and no amount of care in the UI can
 *     supply a frame the server never sent.
 *
 *  2. NO WAY TO SCROLL. The canvas forwarded clicks and keys but not the
 *     wheel. The app's half is sending `human.wheel`; the runner's half is
 *     turning it into a scroll of the page under test, and that is what is
 *     asserted here.
 *
 *  3. NOTHING TO READ WHILE WAITING. The app decides the words. It can only
 *     decide them from what the greeting tells it — whether a page is open,
 *     whether a run is going, whether somebody else is driving — so the
 *     greeting's shape is the contract, and it is pinned below.
 *
 * So this is the runner's side of the console, asserted from a bare
 * WebSocket. It needs no UI and does not care which one is being served, which
 * is the point: any console built against these three things works.
 */
import WebSocket from 'ws';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const WS_URL = process.env.WS_URL || BASE.replace(/^http/, 'ws');
const SITE = `${BASE}/site.html`;

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(46)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(46)} ${d}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A viewer: a socket that remembers what it was told.
 *
 * Frames arrive as binary and everything else as JSON on the same connection,
 * so they are kept apart here once rather than at every call site.
 */
function viewer() {
  const ws = new WebSocket(WS_URL);
  const v = { ws, frames: [], msgs: [], greeting: null };
  ws.on('message', (data, isBinary) => {
    if (isBinary) return void v.frames.push({ at: Date.now(), bytes: data.length });
    let m;
    try { m = JSON.parse(data); } catch { return; }
    v.msgs.push(m);
    if (m.t === 'ready' && !v.greeting) v.greeting = m;
  });
  v.open = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  v.send = (m) => ws.send(JSON.stringify(m));
  /** Wait for a JSON message, or give up. */
  v.until = async (pred, ms = 8000) => {
    for (let i = 0; i < ms / 50; i++) {
      const hit = v.msgs.find(pred);
      if (hit) return hit;
      await wait(50);
    }
    return null;
  };
  return v;
}

const first = viewer();
try {
  await first.open;
} catch (err) {
  console.log(`\n  FAIL  no socket at ${WS_URL}: ${err.message}\n        start the runner first — npm start\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
console.log('\n— 1 · the greeting a console is built from ————————');

/**
 * Everything the app can say about "which kind of waiting is this" comes from
 * these fields, and a console cannot invent one that is missing. `url: null`
 * with `driving` naming somebody else is "another organisation has the
 * browser"; `url: null` with nobody driving is "nothing is open yet"; a url
 * with no frame yet is "connecting to the page". Three different sentences,
 * one message.
 */
const hello = await first.until((m) => m.t === 'ready');
if (!hello) {
  bad('the socket says hello', 'no ready message in 8s');
} else {
  const want = ['url', 'running', 'recording', 'origins', 'org', 'driving'];
  const missing = want.filter((k) => !(k in hello));
  if (!missing.length) ok('the greeting carries what a console needs', want.join(', '));
  else bad('the greeting carries what a console needs', `missing ${missing.join(', ')}`);

  // The vault's key names are deliberately NOT in it: they come from
  // GET /api/state under the token [websocket-3] [authz-tenancy-4]. A console
  // that could read them off an unauthenticated greeting would be one that
  // never needed the token.
  if (!('secrets' in hello)) ok('and not the vault’s key names', 'those need the token, from /api/state');
  else bad('and not the vault’s key names', 'a greeting is not a place for them');
}

// ---------------------------------------------------------------------------
console.log('\n— 2 · a page, and the frames it produces ——————————');

/**
 * Put the runner on a known page rather than leaning on whatever it booted
 * onto. Run history is gitignored, so what a fresh clone has open is nothing
 * and what a working machine has open is the last thing it ran — and neither
 * answer has anything to do with the property being tested.
 */
first.send({ t: 'open', url: SITE });
const opened = await first.until((m) => m.t === 'log' && /opened |not allowed/.test(m.msg ?? ''), 20000)
  ?? await first.until((m) => m.t === 'needs.origin', 100);
if (opened?.t === 'needs.origin') {
  console.log(`\n  FAIL  ${opened.origin} is not on this runner’s allowlist.\n`
    + '        Allow it once (the console offers a button), or start the runner\n'
    + `        with HOME_URL=${BASE}.\n`);
  process.exit(1);
}
if (opened && /opened /.test(opened.msg ?? '')) ok('the runner opens a page when asked', SITE);
else bad('the runner opens a page when asked', opened?.msg ?? 'nothing said');

for (let i = 0; i < 40 && !first.frames.length; i++) await wait(250);
if (first.frames.length) ok('and streams frames of it', `${first.frames.length} in ${(first.frames.at(-1).bytes / 1024).toFixed(0)}KB-ish`);
else bad('and streams frames of it', 'no binary frame in 10s');

// ---------------------------------------------------------------------------
console.log('\n— 3 · a viewer that arrives late is primed ————————');

/**
 * The black canvas, at its source.
 *
 * Let the page go quiet first — that is the whole condition. A screencast of a
 * still page emits nothing, so a socket opened now would receive nothing, ever,
 * and a console has nothing to draw. The runner holds the last frame and sends
 * it on attach; without that line the app is black on arrival and there is no
 * fix available on the app's side.
 */
await wait(3000);
const before = first.frames.length;
await wait(2000);
const quiet = first.frames.length === before;
if (quiet) ok('the page has gone quiet', 'no frames while nothing moves — as Chrome intends');
else ok('the page is still emitting', 'the priming assertion below is weaker but still true');

const late = viewer();
await late.open;
const primed = await (async () => {
  for (let i = 0; i < 60 && !late.frames.length; i++) await wait(50);
  return late.frames.length > 0;
})();
if (primed) ok('a socket that attaches is sent a frame', 'without waiting for the page to move');
else bad('a socket that attaches is sent a frame', 'black until something happens — the canvas regression');

// And on demand, for a console that has just mounted its canvas: the greeting
// arrives when the app loads, the canvas exists a route change later, so the
// first frame can legitimately have nowhere to go.
late.frames.length = 0;
late.send({ t: 'frame.request' });
const onDemand = await (async () => {
  for (let i = 0; i < 60 && !late.frames.length; i++) await wait(50);
  return late.frames.length > 0;
})();
if (onDemand) ok('and can ask for another', 'frame.request — for a canvas that mounted late');
else bad('and can ask for another', 'a console that missed the first frame stays black');

// ---------------------------------------------------------------------------
console.log('\n— 4 · the wheel reaches the page ——————————————————');

/**
 * The scroll regression, asserted the only way it can be from outside a
 * browser: frames are damage-driven, so a page that scrolled produces one and
 * a page that ignored the message does not.
 *
 * Which is why it waits for quiet first. Against a page still emitting frames
 * this proves nothing, so that case is reported as unproven rather than passed
 * — a check that says OK when it did not look is worse than one that is absent.
 */
const settle = async () => {
  for (let i = 0; i < 40; i++) {
    const n = first.frames.length;
    await wait(400);
    if (first.frames.length === n) return true;
  }
  return false;
};

if (!await settle()) {
  bad('the wheel scrolls the page under test', 'the page never went quiet, so a new frame proves nothing');
} else {
  const mark = first.frames.length;
  first.send({ t: 'human.wheel', deltaY: 600, deltaX: 0 });
  let moved = false;
  for (let i = 0; i < 40 && !moved; i++) { await wait(100); moved = first.frames.length > mark; }
  if (moved) ok('the wheel scrolls the page under test', 'a still page produced a frame, so it moved');
  else bad('the wheel scrolls the page under test', 'human.wheel changed nothing — the scroll regression');

  // A wheel is a person's, so a nonsense one must be ignored rather than
  // taken down the stack: the deltas are clamped, and a string is not a delta.
  await settle();
  const alive = first.ws.readyState === 1;
  first.send({ t: 'human.wheel', deltaY: 'lots', deltaX: null });
  first.send({ t: 'human.wheel', deltaY: 1e9 });
  await wait(1000);
  if (alive && first.ws.readyState === 1) ok('and a nonsense one is survived', 'clamped, not thrown');
  else bad('and a nonsense one is survived', 'the socket went away');
}

// ---------------------------------------------------------------------------
console.log('\n— 5 · and typing does too ——————————————————————————');

await settle();
const keyMark = first.frames.length;
first.send({ t: 'human.key', text: 'q' });
let typed = false;
for (let i = 0; i < 30 && !typed; i++) { await wait(100); typed = first.frames.length > keyMark; }
// Not a failure: whether a keystroke changes any pixel depends on the page,
// and site.html has no focused field to receive it. What matters is that the
// message is accepted and the socket survives it, which the next line asserts.
if (typed) ok('a keystroke reaches the page', 'the frame changed');
else ok('a keystroke is accepted', 'no visible change on this page, which proves nothing either way');
if (first.ws.readyState === 1) ok('and the socket is still up', 'after everything above');
else bad('and the socket is still up', 'something threw');

// ---------------------------------------------------------------------------
console.log('\n— 6 · the driven page’s console, forwarded ————————');

/**
 * A failing step usually has a reason the page already printed, and until this
 * existed that reason lived inside a browser nobody could open devtools on.
 * public/noisy.html behaves like an app mid-incident: every level, a line
 * repeated the way a render loop repeats it, a credential printed the way a
 * hurried fetch wrapper prints it, and then an uncaught throw.
 *
 * The app decides how to DISPLAY all that — folded away until asked for,
 * repeats collapsed — and those assertions went to poc-qa-stack with the
 * rest of the rendering. What is here is what the runner puts on the wire,
 * and one of those is a security property rather than a convenience.
 */
first.msgs.length = 0;
first.send({ t: 'open', url: `${BASE}/noisy.html` });
await first.until((m) => m.t === 'log' && /opened /.test(m.msg ?? ''), 20000);
await wait(3000);

const lines = first.msgs.filter((m) => m.t === 'console');
if (lines.length) ok('the page’s console arrives over the socket', `${lines.length} lines`);
else bad('the page’s console arrives over the socket', 'nothing forwarded — the reason stays inside the browser');

const printed = lines.map((m) => m.text).join('\n');
if (/GET \/api\/balances -> 500/.test(printed)) ok('an error the page logged is in it');
else bad('an error the page logged is in it', printed.replace(/\s+/g, ' ').slice(0, 70));

// An uncaught throw never reaches console.*, and it is the one you most want.
if (/__kestrel|TypeError|undefined/.test(printed)) ok('and an uncaught throw is too', 'pageerror is captured');
else bad('and an uncaught throw is too', 'only console.* was captured');

/**
 * The one that matters, and the reason this section did not go to the UI with
 * the rest of it. A page logging the token it just sent is not unusual, and a
 * vault value that never leaves the server must not leave it through here
 * either — so it is replaced with its NAME on the way out, in the runner,
 * before anything can render it. The demo credential is the fixture's own
 * literal, so a leak would be visible verbatim.
 */
if (!printed.includes('hunter2-but-from-a-vault') && /\$QA_PASS/.test(printed)) {
  ok('and a vault value is redacted, not printed', 'sent as $QA_PASS');
} else {
  bad('and a vault value is redacted, not printed',
      printed.includes('hunter2-but-from-a-vault') ? 'THE SECRET IS ON SCREEN' : 'it was not named either');
}

// And a page that dumps a 2MB blob into console.log cannot do it down this
// socket. The cap is the runner's; no console can un-send what it was given.
const longest = Math.max(0, ...lines.map((m) => String(m.text).length));
if (longest <= 2000) ok('and a very long line is cut', `longest ${longest} chars`);
else bad('and a very long line is cut', `${longest} chars reached the socket`);

first.ws.close();
late.ws.close();
await wait(200);

console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — the greeting carries what a console decides its waiting state\n'
    + '       from, a viewer that arrives at a still page is primed with a\n'
    + '       frame rather than left black, the wheel and the keyboard reach\n'
    + '       the page being driven, and its own console comes back with the\n'
    + '       vault redacted and long lines cut. What the app DRAWS with all\n'
    + '       of that is checked in poc-qa-stack.\n');
process.exit(failures ? 1 : 0);
