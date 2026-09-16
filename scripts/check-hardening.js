/**
 * check-hardening — the runner's switches, request limits, security headers
 * and request ids (docs/HARDENING.md).
 *
 *   npm run check:hardening
 *
 * Three halves. The rules, against the modules directly and instantly. The
 * refusals, by starting server.js with a bad value and reading how it dies.
 * And two real runners on their own ports — one open with limits named, one
 * gated with a throwaway public key — asked the questions a client would ask.
 * Nothing here touches a runner you already have on :3000.
 */
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import WebSocket from 'ws';
import { parseOff, switchesFor, SWITCHES } from '../switches.js';
import { Limiter, clientIp, parseRate } from '../limits.js';
import { requestIds } from '../trace.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(56)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(56)} ${d}`); };
const expect = (label, pass, detail = '') => (pass ? ok(label, pass === true ? '' : detail) : bad(label, detail));
const throws = (fn) => { try { fn(); return null; } catch (err) { return err; } };

// ---------------------------------------------------------------------------
console.log('\n— the rules ————————————————————————————————————————————————');

// Six: recording, runs, onboarding, origins, driving, and heal (the fixes layer).
expect('a service name is every switch of that service', parseOff('runner').size === 6, [...parseOff('runner')].join(','));
expect('* is every switch there is', parseOff('*').size === Object.keys(SWITCHES).length);
const typo = throws(() => parseOff('runner.recordin'));
expect('a switch nobody knows is refused, not ignored', typo && /runner\.recordin/.test(typo.message), typo?.message);
const token = switchesFor({ off: ['runner.runs'] });
expect('a token turns a switch off, and only that one', !token.on('runner.runs') && token.on('runner.recording'));
expect('no claims is the environment alone', switchesFor(null).on('runner.runs'));

expect('rates read the way the control plane writes them', JSON.stringify(parseRate('20/5m')) === JSON.stringify({ limit: 20, ms: 300000 }));
expect('an unreadable rate is refused', !!throws(() => parseRate('lots')));
const limiter = new Limiter('2/m', 'test', { shared: false });
const t0 = 1_000_000;
limiter.hit('a', t0);
limiter.hit('a', t0);
const third = limiter.hit('a', t0 + 1);
expect('the hit past the limit is refused, and marked first once', third.over && third.first && !limiter.hit('a', t0 + 2).first);
expect('another address has its own window', !limiter.hit('b', t0 + 3).over);
expect('and a window ends', !limiter.hit('a', t0 + 60_001).over);
const budget = new Limiter('2/m', 'test', { shared: false, budget: true });
budget.hit('a', t0);
const spent = budget.hit('a', t0);
expect('a budget is shut the moment its last try is spent', spent.first && budget.blocked('a', t0 + 1) > 0);

const peer = { socket: { remoteAddress: '10.0.0.9' } };
expect('X-Forwarded-For is not believed with no proxy trusted', clientIp({ ...peer, headers: { 'x-forwarded-for': '1.2.3.4' } }, 0) === '10.0.0.9');
expect('and behind one, only the entry that proxy wrote', clientIp({ ...peer, headers: { 'x-forwarded-for': '6.6.6.6, 1.2.3.4' } }, 1) === '1.2.3.4');
expect('and an entry that is not an address says nothing', clientIp({ ...peer, headers: { 'x-forwarded-for': 'evil' } }, 1) === '10.0.0.9');

const sampled = requestIds({ 'x-request-id': 'abc-12345678', traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' });
expect('a sane request id is kept; a sampled traceparent is read', sampled.rid === 'abc-12345678' && sampled.trace === '0af7651916cd43dd8448eb211c80319c' && sampled.sampled);
const junk = requestIds({ 'x-request-id': 'no spaces allowed', traceparent: '00-00000000000000000000000000000000-b7ad6b7169203331-01' });
expect('a bad id is replaced, and an all-zero trace ignored', /^[0-9a-f-]{36}$/.test(junk.rid) && !junk.sampled && junk.trace.length === 32);

// ---------------------------------------------------------------------------
console.log('\n— refusing to start ————————————————————————————————————————');

/** A runner that should die at once: it names the variable, and never launches a browser. */
const doomed = (env) => spawnSync(process.execPath, [join(ROOT, 'server.js')], {
  cwd: ROOT, timeout: 20000, encoding: 'utf8', env: { ...process.env, PORT: '8329', HOME_URL: '', ...env },
});
for (const [name, value] of [['GC_SWITCHES_OFF', 'runner.recordin'], ['GC_API_RATE', 'lots'], ['GC_REQUEST_LOG', 'verbose'], ['GC_TRUSTED_PROXY_COUNT', 'one']]) {
  const r = doomed({ [name]: value });
  expect(`${name}=${value} stops the runner, by name`, r.status === 1 && `${r.stderr}${r.stdout}`.includes(name), `exit ${r.status}`);
}

// ---------------------------------------------------------------------------
async function start(port, env) {
  const child = spawn(process.execPath, [join(ROOT, 'server.js')], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(port), HOME_URL: '', ...env },
  });
  const run = { child, out: '' };
  child.stdout.on('data', (d) => { run.out += d; });
  child.stderr.on('data', (d) => { run.out += d; });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return run; } catch { /* not up yet */ }
    await wait(500);
  }
  throw new Error(`the runner on ${port} never became healthy:\n${run.out.slice(-800)}`);
}

const open = (url) => new Promise((resolve) => {
  const ws = new WebSocket(url);
  const seen = [];
  ws.on('message', (d, binary) => { if (!binary) { try { seen.push(JSON.parse(d)); } catch { /* not ours */ } } });
  ws.on('open', () => resolve({ ws, seen, status: 101 }));
  ws.on('unexpected-response', (_req, res) => resolve({ ws: null, seen, status: res.statusCode }));
  ws.on('error', () => resolve({ ws: null, seen, status: 0 }));
});

const PORT = Number(process.env.GC_HARDENING_PORT) || 8321;
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];

try {
  console.log('\n— an open runner, limits named ———————————————————————————————');
  const runner = await start(PORT, {
    GC_SWITCHES_OFF: 'runner.recording',
    GC_API_RATE: '60/m', GC_WS_CONNECT_RATE: '6/m', GC_WS_MESSAGE_RATE: '40/10s',
    GC_REQUEST_LOG: 'sampled', GC_LOG_FORMAT: 'json',
  });
  children.push(runner.child);

  const health = await fetch(`${BASE}/healthz`);
  const state = await fetch(`${BASE}/api/state`, { headers: { 'x-request-id': 'hardening-check-0001' } });
  const headers = [
    ['X-Request-Id on every response', /^[0-9a-f-]{36}$/.test(health.headers.get('x-request-id') ?? '')],
    ['the caller\'s own request id echoed', state.headers.get('x-request-id') === 'hardening-check-0001'],
    ['Cross-Origin-Opener-Policy same-origin', health.headers.get('cross-origin-opener-policy') === 'same-origin'],
    ['Cross-Origin-Resource-Policy same-site', health.headers.get('cross-origin-resource-policy') === 'same-site'],
    ['Origin-Agent-Cluster', health.headers.get('origin-agent-cluster') === '?1'],
    ['no X-Powered-By', !health.headers.has('x-powered-by')],
    ['the API is never cached', state.headers.get('cache-control') === 'no-store'],
  ];
  for (const [label, pass] of headers) expect(label, pass);

  const preflight = await fetch(`${BASE}/api/state`, { method: 'OPTIONS', headers: { origin: 'http://elsewhere.test', 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-request-id,traceparent' } });
  const allowed = preflight.headers.get('access-control-allow-headers') ?? '';
  expect('a preflight may send the request id and the trace', /x-request-id/.test(allowed) && /traceparent/.test(allowed), allowed);
  expect('and may read the request id and Retry-After back', /X-Request-Id/.test(preflight.headers.get('access-control-expose-headers') ?? '') && /Retry-After/.test(preflight.headers.get('access-control-expose-headers') ?? ''));

  const body = await state.json();
  expect('/api/state says which switches are off', body.switches?.['runner.recording'] === false && body.switches?.['runner.runs'] === true, JSON.stringify(body.switches));
  const rec = await fetch(`${BASE}/api/recording`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"flow":""}' });
  const recBody = await rec.json().catch(() => ({}));
  expect('a switched-off route is refused, naming the switch', rec.status === 403 && recBody.error === 'switched_off' && recBody.switch === 'runner.recording', `${rec.status} ${JSON.stringify(recBody)}`);

  const huge = await fetch(`${BASE}/api/suites`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x'.repeat(600_000) }) });
  expect('a body past the limit is a 413 in the API\'s shape', huge.status === 413 && (await huge.json().catch(() => ({}))).ok === false, String(huge.status));
  const broken = await fetch(`${BASE}/api/suites`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
  expect('and a body that is not JSON is a 400 in it', broken.status === 400 && /not valid JSON/.test((await broken.json().catch(() => ({}))).error ?? ''), String(broken.status));

  const traced = 'hardening-traced-0001';
  const untraced = 'hardening-untraced-0001';
  await fetch(`${BASE}/api/version?ticket=shh-secret`, { headers: { 'x-request-id': traced, traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' } });
  await fetch(`${BASE}/api/version`, { headers: { 'x-request-id': untraced, traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00' } });
  await wait(300);
  const line = runner.out.split('\n').find((l) => l.includes(traced)) ?? '';
  expect('a sampled request is logged, as JSON, under its id', /"msg":"request"/.test(line) && /"path":"\/api\/version"/.test(line), line.slice(0, 120));
  expect('without its query string', line !== '' && !line.includes('shh-secret'));
  expect('and an unsampled one is not', !runner.out.includes(untraced));

  // The socket: the greeting, a switched-off message, and the message budget.
  const sock = await open(`ws://127.0.0.1:${PORT}/ws`);
  await wait(800);
  const ready = sock.seen.find((m) => m.t === 'ready');
  expect('the greeting carries the switches', ready?.switches?.['runner.recording'] === false, JSON.stringify(ready?.switches));
  sock.ws?.send(JSON.stringify({ t: 'record.start' }));
  await wait(300);
  expect('a switched-off message is refused, naming the switch', sock.seen.some((m) => m.t === 'refused' && m.error === 'switched_off' && m.switch === 'runner.recording'));
  for (let i = 0; i < 60; i++) sock.ws?.send(JSON.stringify({ t: 'human.move', x: i, y: i }));
  await wait(400);
  expect('a socket past its message budget is told so, once', sock.seen.filter((m) => m.t === 'refused' && m.error === 'rate_limited').length === 1);
  sock.ws?.close();

  let refusedAt = 0;
  for (let i = 1; i <= 8 && !refusedAt; i++) {
    const s = await open(`ws://127.0.0.1:${PORT}/ws`);
    if (s.status === 429) refusedAt = i;
    s.ws?.close();
  }
  expect('socket upgrades past the rate are a 429', refusedAt > 0 && refusedAt <= 6, `refused at upgrade ${refusedAt || 'never'} (the first socket above counts)`);

  let limited = null;
  for (let i = 0; i < 80 && !limited; i++) {
    const r = await fetch(`${BASE}/api/version`);
    if (r.status === 429) limited = r;
  }
  const limitedBody = await limited?.json().catch(() => ({}));
  expect('an address past its API rate is a 429 with Retry-After', limited && Number(limited.headers.get('retry-after')) >= 1 && limitedBody?.error === 'rate_limited', limited ? `retry after ${limited.headers.get('retry-after')}s` : 'never limited');

  console.log('\n— a gated runner, a guessing loop ————————————————————————————');
  const { publicKey } = generateKeyPairSync('ed25519');
  const GPORT = PORT + 1;
  const gated = await start(GPORT, {
    GC_AUTH_PUBLIC_KEYS: JSON.stringify({ hardening: publicKey.export({ type: 'spki', format: 'pem' }) }),
    GC_WEB_ORIGIN: `http://127.0.0.1:${GPORT}`,
    GC_AUTH_FAIL_RATE: '5/m',
  });
  children.push(gated.child);
  const statuses = [];
  for (let i = 0; i < 7; i++) {
    statuses.push((await fetch(`http://127.0.0.1:${GPORT}/api/state`, { headers: { authorization: 'Bearer not.a.token' } })).status);
  }
  expect('five bad tokens are 401s, and the sixth address-wide a 429', statuses.slice(0, 5).every((s) => s === 401) && statuses[5] === 429, statuses.join(' '));
  const shut = await fetch(`http://127.0.0.1:${GPORT}/api/state`);
  expect('the address is shut out of everything until its window ends', shut.status === 429 && Number(shut.headers.get('retry-after')) >= 1, `${shut.status}`);
  expect('and the moment it tripped is logged, once', gated.out.split('\n').filter((l) => /failed authentication past the limit/.test(l)).length === 1);
} catch (err) {
  bad('the check ran to the end', err.message.split('\n')[0]);
} finally {
  for (const c of children) c.kill();
}

console.log(failures
  ? `\n  ${failures} failed\n`
  : '\n  OK — switches refuse by name on both the API and the socket, limits answer\n'
    + '       429 with a Retry-After, bad tokens shut an address out, every response\n'
    + '       carries a request id and the headers, and a sampled request is logged\n'
    + '       without its query string.\n');
process.exit(failures ? 1 : 0);
