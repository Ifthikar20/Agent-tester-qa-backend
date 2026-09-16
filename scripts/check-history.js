/**
 * Back, as the console offers it: whether there is a page behind this one.
 *
 *   node scripts/check-history.js        (starts a runner of its own)
 *
 * The runner decides from Chrome's history rather than from page.goBack()'s
 * answer, and the blank page a fresh context starts on is never somewhere to
 * go back to. That floor only exists on a runner nobody has driven yet, which
 * is why this check starts its own instead of joining one on :3000.
 *
 *   1  a fresh page          the greeting says there is nothing behind it
 *   2  the first page        still nothing behind it — Back says so, and goes nowhere
 *   3  a second page         Back is offered, returns to the first, and is then withdrawn
 *   4  a hash change         is a page too: Back steps out of it without leaving the document
 */
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.GC_HISTORY_PORT) || 3412;
const BASE = `http://localhost:${PORT}`;
const WS_URL = `${BASE.replace(/^http/, 'ws')}/ws`;

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(50)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(50)} ${d}`); };
const section = (t) => console.log(`\n— ${t} ${'—'.repeat(Math.max(2, 50 - t.length))}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A viewer: a socket that remembers what it was told (check-monitoring.js). */
function viewer() {
  const ws = new WebSocket(WS_URL);
  const v = { ws, msgs: [], greeting: null };
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
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
    v.send({ t: 'origin.add', origin: answer.origin });
    await v.until((m) => m.t === 'origins', 5000, from);
    const again = v.at();
    v.send({ t: 'open', url });
    return !!(await v.until((m) => m.t === 'targets' && m.url && m.url.startsWith(url), 15000, again));
  }
  return !!answer;
}
/** The latest `history` answer from `from` on, once the runner has had a moment to ask Chrome. */
const history = (v, from) => v.until((m) => m.t === 'history', 5000, from);

// ---------------------------------------------------------------- a runner
const child = spawn(process.execPath, [join(ROOT, 'server.js')], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(PORT), GC_MONITOR_LLM: 'mock', HOME_URL: 'about:blank', GC_PACE_MS: '0', GC_SETTLE_MS: '120', GC_TIMEOUT_MS: '4000' },
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });
const done = async () => {
  child.kill();
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

// ---------------------------------------------------------------------------
section('1 · a fresh page');
if (v.greeting && v.greeting.back === false) ok('the greeting says there is nothing behind it', 'back: false');
else bad('the greeting says there is nothing behind it', JSON.stringify(v.greeting?.back));

// ---------------------------------------------------------------------------
section('2 · the first page');
{
  let from = v.at();
  if (await open(v, `${BASE}/demo.html`)) ok('the first page opens', 'demo.html'); else { bad('the first page opens'); await done(); }
  const h = await history(v, from);
  if (h && h.back === false) ok('the runner asked Chrome and there is nothing behind it', 'the blank page is not a destination'); else bad('the runner asked Chrome and there is nothing behind it', JSON.stringify(h));
  from = v.at();
  v.send({ t: 'human.back' });
  const said = await v.until((m) => m.t === 'log' && /Nothing to go back to/.test(m.msg), 3000, from);
  if (said) ok('Back says there is nothing to go back to', said.level); else bad('Back says there is nothing to go back to');
  if (await v.none((m) => m.t === 'url', 1200, from)) ok('and goes nowhere'); else bad('and goes nowhere', 'a url event arrived');
}

// ---------------------------------------------------------------------------
section('3 · a second page');
{
  let from = v.at();
  await open(v, `${BASE}/links.html`);
  const h = await history(v, from);
  if (h && h.back === true) ok('with a page behind it, Back is offered', 'back: true'); else bad('with a page behind it, Back is offered', JSON.stringify(h));
  from = v.at();
  v.send({ t: 'human.back' });
  const u = await v.until((m) => m.t === 'url' && /demo\.html/.test(m.url ?? ''), 8000, from);
  if (u) ok('Back returns to the first page', u.url); else bad('Back returns to the first page', JSON.stringify(v.msgs.slice(from).filter((m) => m.t === 'url').map((m) => m.url)));
  const h2 = await history(v, from);
  if (h2 && h2.back === false) ok('and is then withdrawn: nothing behind the first page'); else bad('and is then withdrawn: nothing behind the first page', JSON.stringify(h2));
  if (await v.until((m) => m.t === 'log' && /went back to/.test(m.msg), 3000, from)) ok('the log says where it went'); else bad('the log says where it went');
}

// ---------------------------------------------------------------------------
section('4 · a hash change');
{
  let from = v.at();
  await open(v, `${BASE}/site.html`);
  await history(v, from);
  from = v.at();
  v.send({ t: 'command', text: 'click link:See how Harbour prices', pace: 0 });
  const end = await v.until((m) => m.t === 'run.end' || (m.t === 'refused' && m.of === 'run'), 20000, from);
  if (end?.t === 'run.end' && end.ok) ok('a link to #pricing was clicked'); else bad('a link to #features was clicked', JSON.stringify(end));
  const hashed = await v.until((m) => m.t === 'url' && /#pricing$/.test(m.url ?? ''), 5000, from);
  if (hashed) ok('the address gained the fragment', hashed.url); else bad('the address gained the fragment');
  const h = await history(v, from);
  if (h && h.back === true) ok('a hash change is a page behind, as far as Back is concerned'); else bad('a hash change is a page behind, as far as Back is concerned', JSON.stringify(h));
  from = v.at();
  v.send({ t: 'human.back' });
  const u = await v.until((m) => m.t === 'url' && /site\.html$/.test(m.url ?? ''), 8000, from);
  if (u) ok('Back steps out of the fragment without leaving the document', u.url); else bad('Back steps out of the fragment without leaving the document');
}

v.ws.close();
await done();
