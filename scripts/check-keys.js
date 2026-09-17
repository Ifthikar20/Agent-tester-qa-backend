/**
 * The key, read once, reaching every layer — and never the browser.
 *
 *   node scripts/check-keys.js        (starts runners of its own)
 *
 * Three layers of the runner may call a model: the fixes (GC_HEAL=ai, where
 * this copy has them), agentic monitoring and the chat. They used to read
 * ANTHROPIC_API_KEY one after another, and the first read took it out of the
 * environment — so the deployed runner, which has the environment and no
 * .env.local, ran monitoring on the mock compiler whatever key was set. The
 * key is read once now, and this check keeps it that way.
 *
 *   1  a key in the environment     every layer says "environment", and runs on Claude
 *   2  the browser does not have it   no Chromium process under the runner carries it (Linux: /proc)
 *   3  never said                     not in the banner, a body or a frame
 *   4  no key                         the layers say so, and run on the mock (skipped when .env.local has one)
 *
 * Nothing leaves the machine: the model's address is a closed port, the
 * budgets are zero, and no run, monitor or turn is made.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.GC_KEYS_PORT) || 3415;
const BASE = `http://localhost:${PORT}`;
const FAKE_KEY = 'sk-ant-check-keys-not-a-real-key-0123456789';

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(52)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(52)} ${d}`); };
const skip = (l, d = '') => console.log(`  –  ${l.padEnd(52)} ${d}`);
const section = (t) => console.log(`\n— ${t} ${'—'.repeat(Math.max(2, 52 - t.length))}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const said = [];
async function api(path) {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  said.push(text);
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json };
}
const line = (out, re) => out.split('\n').find((l) => re.test(l))?.trim() ?? '(no line)';

function start(extra) {
  const env = {
    ...process.env, PORT: String(PORT), HOME_URL: 'about:blank', GC_PACE_MS: '0',
    // A closed port and empty budgets: even a layer that wanted to ask could not.
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', GC_MONITOR_AI_MAX_PER_DAY: '0', GC_CHAT_AI_MAX_PER_DAY: '0',
    ...extra,
  };
  const child = spawn(process.execPath, [join(ROOT, 'server.js')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env });
  const run = { child, out: '', exited: null };
  child.stdout.on('data', (d) => { run.out += d; });
  child.stderr.on('data', (d) => { run.out += d; });
  child.on('exit', (code) => { run.exited = code ?? -1; });
  return run;
}
async function up(run) {
  for (let i = 0; i < 120 && run.exited === null; i++) {
    const ready = await fetch(`${BASE}/healthz`).then((r) => r.json()).then((j) => !!j.browser).catch(() => false);
    if (ready) return true;
    await wait(500);
  }
  return false;
}
async function stop(run) {
  if (run.exited !== null) return;
  run.child.kill('SIGTERM');
  for (let i = 0; i < 20 && run.exited === null; i++) await wait(150);
  if (run.exited === null) run.child.kill('SIGKILL');
  await wait(300);
}
const done = async () => {
  console.log(failures ? `\n  ${failures} failure${failures === 1 ? '' : 's'}\n` : '\n  all green\n');
  process.exit(failures ? 1 : 0);
};

/** Every process under `rootPid`, by walking /proc — Linux only. */
function descendants(rootPid) {
  const parent = new Map();
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const m = readFileSync(`/proc/${d}/status`, 'utf8').match(/^PPid:\s+(\d+)/m);
      if (m) parent.set(Number(d), Number(m[1]));
    } catch { /* gone, or not ours */ }
  }
  const under = (pid) => { let p = pid; for (let i = 0; i < 64 && p > 1; i++) { if (p === rootPid) return true; p = parent.get(p) ?? 0; } return false; };
  return [...parent.keys()].filter((pid) => pid !== rootPid && under(pid));
}
const readProc = (pid, file) => { try { return readFileSync(`/proc/${pid}/${file}`, 'latin1').split('\0'); } catch { return null; } };

// ---------------------------------------------------------------------------
section('1 · a key in the environment');
const withKey = start({ ANTHROPIC_API_KEY: FAKE_KEY, GC_HEAL: 'ai', GC_MONITOR_LLM: 'claude', GC_CHAT: 'claude' });
if (!(await up(withKey))) { bad('a runner is up', withKey.out.trim().split('\n').slice(-8).join('\n')); await stop(withKey); await done(); }
{
  const fixes = line(withKey.out, /ai fixes +->/);
  if (fixes === '(no line)') skip('the fixes see the key', 'this runner has no fixes layer');
  else if (/key found \(environment\)/.test(fixes)) ok('the fixes see the key', fixes); else bad('the fixes see the key', fixes);
  const mon = line(withKey.out, /monitoring +->/);
  if (/Claude \(.+\) .*key from environment/.test(mon)) ok('monitoring sees the key', mon.slice(0, 90)); else bad('monitoring sees the key', mon);
  const chat = line(withKey.out, /chat +->/);
  if (/Claude \(.+\) .*key from environment/.test(chat)) ok('the chat sees the key', chat.slice(0, 90)); else bad('the chat sees the key', chat);

  const m = await api('/api/monitoring');
  if (m.json?.llm?.mode === 'claude' && m.json.llm.key?.have === true && m.json.llm.key.from === 'environment') ok('GET /api/monitoring: Claude, key from the environment', m.json.llm.model); else bad('GET /api/monitoring: Claude, key from the environment', JSON.stringify(m.json?.llm));
  const c = await api('/api/chat');
  if (c.json?.llm?.mode === 'claude' && c.json.llm.key?.from === 'environment') ok('GET /api/chat: Claude, key from the environment', c.json.llm.model); else bad('GET /api/chat: Claude, key from the environment', JSON.stringify(c.json?.llm));
  const s = await api('/api/state');
  if (!('heal' in (s.json ?? {}))) skip('/api/state: ai fixes available', 'this runner has no fixes layer');
  else if (s.json.heal.mode === 'ai' && s.json.heal.ai?.available === true) ok('/api/state: ai fixes available', `reason: ${s.json.heal.ai.reason}`); else bad('/api/state: ai fixes available', JSON.stringify(s.json.heal));
}

// ---------------------------------------------------------------------------
section('2 · the browser does not have it');
if (process.platform !== 'linux') skip('no Chromium process under the runner carries the key', 'needs /proc');
else {
  const kids = descendants(withKey.child.pid);
  const browsers = kids.filter((pid) => (readProc(pid, 'cmdline') ?? []).some((a) => /chrom/i.test(a)));
  if (!browsers.length) bad('a Chromium process runs under the runner', `${kids.length} processes under it, none named chrom*`);
  else {
    const carrying = browsers.filter((pid) => (readProc(pid, 'environ') ?? []).some((kv) => kv.includes(FAKE_KEY)));
    if (!carrying.length) ok('no Chromium process under the runner carries the key', `${browsers.length} checked`); else bad('no Chromium process under the runner carries the key', `pids ${carrying.join(', ')}`);
    const runnerEnv = readProc(withKey.child.pid, 'environ') ?? [];
    if (runnerEnv.some((kv) => kv === `ANTHROPIC_API_KEY=${FAKE_KEY}`)) ok('while the runner itself was started with it', '/proc shows the environment it was given'); else skip('while the runner itself was started with it', 'could not read the runner’s environ');
  }
}

// ---------------------------------------------------------------------------
section('3 · never said');
{
  const leaked = [withKey.out, ...said].some((t) => t.includes(FAKE_KEY));
  if (!leaked) ok('the key is in no banner line, body or frame'); else bad('the key is in no banner line, body or frame');
}
await stop(withKey);

// ---------------------------------------------------------------------------
section('4 · no key');
{
  let local = '';
  try { local = readFileSync(join(ROOT, '.env.local'), 'utf8'); } catch { /* none */ }
  if (existsSync(join(ROOT, '.env.local')) && /^\s*ANTHROPIC_API_KEY\s*=/m.test(local)) skip('without a key the layers say so', '.env.local here has one');
  else {
    const noKey = start({ ANTHROPIC_API_KEY: undefined, GC_MONITOR_LLM: 'claude', GC_CHAT: 'claude' });
    if (!(await up(noKey))) bad('a keyless runner is up', noKey.out.trim().split('\n').slice(-8).join('\n'));
    else {
      const mon = line(noKey.out, /monitoring +->/);
      if (/the mock compiler and judge — set ANTHROPIC_API_KEY for Claude/.test(mon)) ok('monitoring says to set the key', mon.slice(0, 80)); else bad('monitoring says to set the key', mon);
      const chat = line(noKey.out, /chat +->/);
      if (/the mock mind.*set ANTHROPIC_API_KEY for Claude/.test(chat)) ok('the chat says to set the key', chat.slice(0, 80)); else bad('the chat says to set the key', chat);
      const m = await api('/api/monitoring');
      if (m.json?.llm?.mode === 'mock' && m.json.llm.key?.have === false) ok('GET /api/monitoring: the mock, no key'); else bad('GET /api/monitoring: the mock, no key', JSON.stringify(m.json?.llm));
    }
    await stop(noKey);
  }
}
await done();
