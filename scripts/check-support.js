/**
 * Help & support, end to end: a request lands, turns support access on, is
 * told to every socket of the organisation, and is turned off again.
 *
 *   node scripts/check-support.js
 *   BASE_URL=http://localhost:3000 node scripts/check-support.js   # a running runner
 *
 * A runner of this check's own unless BASE_URL names one; the requests it
 * makes are removed at the end when the runner is its own.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.GC_SUPPORT_PORT) || 3409;
const EXTERNAL = process.env.BASE_URL || null;
const BASE = EXTERNAL || `http://localhost:${PORT}`;
const WS_URL = `${BASE.replace(/^http/, 'ws')}/ws`;
const FILE = join(ROOT, '.ghostclick', 'local', 'support.json');

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(50)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(50)} ${d}`); };
const section = (t) => console.log(`\n— ${t} ${'—'.repeat(Math.max(2, 50 - t.length))}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, json };
}

let child = null;
let out = '';
if (!EXTERNAL) {
  child = spawn(process.execPath, [join(ROOT, 'server.js')], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), GC_MONITOR_LLM: 'mock', HOME_URL: 'about:blank' },
  });
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
}
const done = async () => {
  if (child) { await wait(300); child.kill(); }
  console.log(failures ? `\n  ${failures} failure${failures === 1 ? '' : 's'}\n` : '\n  all green\n');
  process.exit(failures ? 1 : 0);
};
let up = false;
for (let i = 0; i < 120 && !up; i++) {
  up = await fetch(`${BASE}/healthz`).then((r) => r.ok).catch(() => false);
  if (!up) await wait(500);
}
if (!up) { bad('a runner is up', `nothing on ${BASE}\n${out.trim().split('\n').slice(-6).join('\n')}`); await done(); }

// A viewer, to see what the organisation's sockets are told.
const ws = new WebSocket(WS_URL);
const msgs = [];
ws.on('message', (d, bin) => { if (bin) return; try { msgs.push(JSON.parse(d)); } catch { /* frame */ } });
await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
const until = async (pred, ms = 5000, from = 0) => { const t = Date.now() + ms; while (Date.now() < t) { for (let i = from; i < msgs.length; i++) if (pred(msgs[i])) return msgs[i]; await wait(50); } return null; };
await until((m) => m.t === 'ready');

// Start from off, whatever an earlier run left.
await api('DELETE', '/api/support/access');

section('1 · nothing asked yet');
{
  const r = await api('GET', '/api/support');
  if (r.status === 200 && r.json?.enabled === false) ok('support access is off', `requests so far: ${r.json.requests}`); else bad('support access is off', JSON.stringify(r.json));
}

section('2 · a request needs words');
{
  const r = await api('POST', '/api/support/request', { topic: 'bug' });
  if (r.status === 400 && /Say what/.test(r.json?.error ?? '')) ok('an empty message is a 400', r.json.error); else bad('an empty message is a 400', `${r.status} ${JSON.stringify(r.json)}`);
  const after = await api('GET', '/api/support');
  if (after.json?.enabled === false) ok('and turns nothing on'); else bad('and turns nothing on');
}

section('3 · a request lands and turns access on');
let reqId = null;
{
  const from = msgs.length;
  const r = await api('POST', '/api/support/request', { topic: 'bug', message: 'check-support: the run stops at step 3 since this morning', page: '/console' });
  reqId = r.json?.request?.id ?? null;
  if (r.status === 200 && r.json?.enabled === true && reqId) ok('200, enabled, with a reference', reqId); else bad('200, enabled, with a reference', `${r.status} ${JSON.stringify(r.json)}`);
  if (r.json?.request?.topic === 'bug' && r.json.request.page === '/console' && r.json.request.by) ok('topic, page and who', `${r.json.request.topic} · ${r.json.request.page} · ${r.json.request.by}`); else bad('topic, page and who', JSON.stringify(r.json?.request));
  const ev = await until((m) => m.t === 'support' && m.enabled === true, 5000, from);
  if (ev && ev.since) ok('the organisation’s sockets were told', `since ${new Date(ev.since).toISOString()}`); else bad('the organisation’s sockets were told');
  if (await until((m) => m.t === 'log' && /support requested \(bug\)/.test(m.msg), 5000, from)) ok('and the log says so'); else bad('and the log says so');
  const g = await api('GET', '/api/support');
  if (g.json?.enabled === true && g.json.requests >= 1 && g.json.latest?.id === reqId) ok('GET /api/support agrees', `${g.json.requests} request(s)`); else bad('GET /api/support agrees', JSON.stringify(g.json));
}

section('4 · what is kept, and how much');
{
  const r = await api('POST', '/api/support/request', { topic: 'something-nobody-listed', message: 'x'.repeat(5000), page: 'p'.repeat(1000) });
  if (r.json?.request?.topic === 'other') ok('an unknown topic is "other"'); else bad('an unknown topic is "other"', JSON.stringify(r.json?.request?.topic));
  if (r.json?.request?.message.length === 2000 && r.json.request.page.length === 300) ok('message and page are capped', '2000 / 300'); else bad('message and page are capped', `${r.json?.request?.message?.length} / ${r.json?.request?.page?.length}`);
  if (EXTERNAL) ok('(support.json — skipped against an external runner)');
  else {
    const disk = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : null;
    if (disk?.access?.enabled === true && disk.requests?.some((x) => x.id === reqId)) ok('persisted for the organisation', FILE); else bad('persisted for the organisation', disk ? JSON.stringify(disk.access) : 'no file');
  }
}

section('5 · and turned off again');
{
  const from = msgs.length;
  const r = await api('DELETE', '/api/support/access');
  if (r.status === 200 && r.json?.enabled === false) ok('DELETE /api/support/access → off'); else bad('DELETE /api/support/access → off', JSON.stringify(r.json));
  if (await until((m) => m.t === 'support' && m.enabled === false, 5000, from)) ok('the sockets were told'); else bad('the sockets were told');
  const g = await api('GET', '/api/support');
  if (g.json?.enabled === false && g.json.requests >= 2) ok('off, and the requests are kept as history', `${g.json.requests} request(s)`); else bad('off, and the requests are kept as history', JSON.stringify(g.json));
}

section('6 · cleanup');
ws.close();
if (!EXTERNAL) { try { rmSync(FILE, { force: true }); ok('this check’s requests are gone'); } catch (e) { bad('this check’s requests are gone', e.message); } }
else ok('(left as history on the external runner)');
await done();
