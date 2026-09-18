/**
 * The prompt catalogue, run: every kind of question the chat answers
 * (scripts/fixtures/chat-prompts.json), every phrasing of it, each on a
 * conversation of its own, against a runner of this check's own with the
 * mock mind — so the catalogue is a thing that is true rather than a list
 * of hopes. For each phrasing: which agents were asked, what the reply
 * says, what data rides on it, whether anything ran, whether it proposed
 * instead; then the follow-ups in the same conversation, a yes carrying
 * the proposal's id and a no not.
 *
 * Seeds a suite of three pages and four cases on the runner's own demo
 * pages, files one defect by running the case that cannot pass, and deletes
 * everything it made at the end — the suite, whatever a confirmed quickstart
 * made, and the conversations.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { toFlow } from '../flow.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.GC_CHAT_PORT) || 3414;
const BASE = `http://localhost:${PORT}`;
const WS_URL = `${BASE.replace(/^http/, 'ws')}/ws`;
const CATALOGUE = JSON.parse(readFileSync(join(ROOT, 'scripts/fixtures/chat-prompts.json'), 'utf8'));

let failures = 0;
let passes = 0;
let skipped = 0;
const ok = (l, d = '') => { passes++; console.log(`  ✓  ${l.padEnd(58)} ${d}`); };
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(58)} ${d}`); };
const skip = (l, d = '') => { skipped++; console.log(`  –  ${l.padEnd(58)} ${d}`); };
const section = (t) => console.log(`\n— ${t} ${'—'.repeat(Math.max(2, 58 - t.length))}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s, n = 90) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);
async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, json };
}

// ---------------------------------------------------------------- a runner
const child = spawn(process.execPath, [join(ROOT, 'server.js')], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(PORT), GC_CHAT: 'mock', GC_MONITOR_LLM: 'mock', HOME_URL: 'about:blank', GC_PACE_MS: '0', GC_SETTLE_MS: '120', GC_TIMEOUT_MS: '4000' },
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });
const made = { suites: new Set(), conversations: new Set() };
async function done() {
  for (const id of made.conversations) await api('DELETE', `/api/chat/${id}`).catch(() => null);
  const have = await api('GET', '/api/suites').catch(() => ({ json: null }));
  for (const s of have.json?.suites ?? []) if (made.suites.has(s.id) || s.name === CATALOGUE.seed.suite) await api('DELETE', `/api/suites/${s.id}`).catch(() => null);
  child.kill();
  console.log(`\n  ${passes} behaved, ${failures} did not, ${skipped} skipped on this runner\n`);
  process.exit(failures ? 1 : 0);
}
let up = false;
for (let i = 0; i < 120 && !up; i++) {
  up = await fetch(`${BASE}/healthz`).then((r) => r.json()).then((j) => !!j.browser).catch(() => false);
  if (!up) await wait(500);
}
if (!up) { bad('a runner is up', `nothing on ${BASE}\n${out.trim().split('\n').slice(-8).join('\n')}`); await done(); }

/** A viewer: a socket that remembers what it was told (check-chat.js). */
const ws = new WebSocket(WS_URL);
const msgs = [];
ws.on('message', (data, isBinary) => { if (isBinary) return; try { msgs.push(JSON.parse(data)); } catch { /* not JSON */ } });
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
const at = () => msgs.length;
const until = async (pred, ms, from = 0) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    for (let i = from; i < msgs.length; i++) if (pred(msgs[i])) return msgs[i];
    await wait(50);
  }
  return null;
};
await until((m) => m.t === 'ready', 5000);

/** One turn: POST it, wait for its reply on the socket. */
async function ask(body, ms = 60000) {
  const from = at();
  const r = await api('POST', '/api/chat/turns', body);
  if (r.status !== 202 || !r.json?.turnId) return { r, from, reply: null };
  made.conversations.add(r.json.conversationId);
  const reply = await until((m) => (m.t === 'chat.done' || m.t === 'chat.error') && m.turn === r.json.turnId, ms, from);
  return { r, from, reply, turnId: r.json.turnId, conversationId: r.json.conversationId };
}

// ---------------------------------------------------------------- the seed
section('the seed');
const seed = CATALOGUE.seed;
let suiteId = null;
const pageByName = new Map();
{
  const o = await api('POST', '/api/origins', { origin: BASE });
  if (o.status === 200 || /already/i.test(o.json?.error ?? '')) ok('the runner’s own origin is allowed', BASE); else bad('the runner’s own origin is allowed', `${o.status} ${JSON.stringify(o.json)}`);
  const have = await api('GET', '/api/suites');
  for (const s of have.json?.suites ?? []) if (s.name === seed.suite) await api('DELETE', `/api/suites/${s.id}`);
  const before = new Set(((await api('GET', '/api/suites')).json?.suites ?? []).map((s) => s.id));
  const madeSuite = await api('POST', '/api/suites', { name: seed.suite, baseUrl: BASE, description: 'made by scripts/check-chat-prompts.js' });
  suiteId = madeSuite.json?.suite?.id ?? null;
  if (suiteId) ok('a suite', suiteId); else { bad('a suite', JSON.stringify(madeSuite.json)); await done(); }
  made.suites.add(suiteId);
  for (const p of seed.pages) {
    const page = (await api('POST', `/api/suites/${suiteId}/pages`, { name: p.name, path: p.path, expect: [{ kind: 'url', value: p.path }] })).json?.page ?? null;
    if (page) pageByName.set(p.name, page); else { bad(`the page ${p.name}`); await done(); }
  }
  ok('its pages', [...pageByName.keys()].join(' · '));
  for (const c of seed.cases) {
    const page = pageByName.get(c.page);
    const flow = c.flow === "the page's own check"
      ? (await api('GET', `/api/suites/${suiteId}/pages/${page.id}/check`)).json?.flow
      : toFlow({ suite: seed.suite, steps: [{ op: 'goto', url: `${BASE}${page.path}` }, { op: 'click', target: 'button:This does not exist' }] });
    const r = await api('POST', `/api/suites/${suiteId}/cases`, { name: c.name, pageId: page.id, flow });
    if (r.json?.ok) ok(`the case ${c.name}`, `${r.json.case.steps} steps`); else { bad(`the case ${c.name}`, JSON.stringify(r.json)); await done(); }
  }
  // The scenarios that follow must not see a suite a stale run left; note the extra ones for cleanup.
  for (const s of (await api('GET', '/api/suites')).json?.suites ?? []) if (!before.has(s.id)) made.suites.add(s.id);
}

// ---------------------------------------------------------------- what this runner can do
section('what this runner offers');
const can = {};
{
  const broken = seed.cases.find((c) => c.flow !== "the page's own check");
  const { reply } = await ask({ text: `Test the ${broken.name} case` }, 90000);
  if (reply?.t === 'chat.done' && /failed \d+\/\d+/.test(reply.message.text)) ok('the case that cannot pass fails', short(reply.message.text)); else bad('the case that cannot pass fails', JSON.stringify(reply?.message?.text));
  const d = await api('GET', '/api/defects');
  const first = (d.json?.defects ?? [])[0];
  can.defect_by_id = typeof first?.id === 'string' && /^DEF-/.test(first.id);
  can.plans = (await api('GET', '/api/settings/heal')).status === 200;
  can.no_plans = !can.plans;
  console.log(`     defects numbered: ${can.defect_by_id ? first.id : 'no (derived from history)'} · drafting offered: ${can.plans ? 'yes' : 'no'}`);
  can.DEFECT = can.defect_by_id ? first.id : null;
}
const fill = (s) => String(s).replaceAll('{{base}}', BASE).replaceAll('{{defect}}', can.DEFECT ?? 'DEF-0000-000');

/** One expectation against one reply; the first thing wrong, or null. */
function judge(expect, m) {
  const tools = (m.tools ?? []).map((c) => c.name);
  for (const t of expect.tools ?? []) if (!tools.includes(t)) return `asked ${tools.join(', ') || 'no agent'}, not ${t}`;
  for (const t of expect.notTools ?? []) if (tools.includes(t)) return `asked ${t}, which it must not`;
  if (expect.reply && !new RegExp(expect.reply, 'm').test(m.text ?? '')) return `said "${short(m.text)}"`;
  if (expect.data && !(m.data ?? []).some((v) => v.kind === expect.data)) return `data ${(m.data ?? []).map((v) => v.kind).join(', ') || 'none'}, not ${expect.data}`;
  if (expect.sources && !(m.sources?.length > 0)) return 'no sources on the reply';
  if (expect.runs != null) { const n = (m.runs ?? []).length; const want = expect.runs === false ? 0 : Number(expect.runs); if (n !== want) return `${n} run(s), not ${want}`; }
  if ('proposal' in expect) { if (expect.proposal === null ? m.proposal != null : m.proposal?.kind !== expect.proposal) return `proposal ${m.proposal?.kind ?? 'none'}, not ${expect.proposal ?? 'none'}`; }
  if ('executed' in expect) { if (expect.executed === null ? m.executed != null : m.executed?.kind !== expect.executed) return `executed ${m.executed?.kind ?? 'nothing'}, not ${expect.executed ?? 'nothing'}`; }
  if (expect.offers) { const labels = (m.offers ?? []).map((o) => o.label); if (!labels.length || !labels.some((l) => new RegExp(expect.offers).test(l))) return `offers ${labels.join(' | ') || 'none'}`; }
  if (expect.items != null && !((m.proposal?.items?.length ?? 0) >= expect.items)) return `${m.proposal?.items?.length ?? 0} item(s) on the proposal`;
  return null;
}
const gist = (m) => {
  const bits = [];
  const tools = (m.tools ?? []).map((c) => c.name);
  if (tools.length) bits.push(tools.join('+'));
  if (m.runs?.length) bits.push(`${m.runs.length} run`);
  if (m.proposal) bits.push(`proposes ${m.proposal.kind}`);
  if (m.executed) bits.push(`executed ${m.executed.kind}`);
  if (m.data?.length) bits.push(`data ${m.data.map((v) => v.kind).join(',')}`);
  return bits.join(' · ');
};

// ---------------------------------------------------------------- the catalogue
for (const s of CATALOGUE.scenarios) {
  section(`${s.id} · ${s.group}`);
  if (s.requires && !can[s.requires]) { skip(`${s.prompt}`, `needs ${s.requires}`); continue; }
  for (const phrasing of [s.prompt, ...(s.also ?? [])]) {
    const text = fill(phrasing);
    const { r, reply, conversationId } = await ask({ text });
    if (reply?.t !== 'chat.done') { bad(`"${text}"`, `${r.status} ${JSON.stringify(reply ?? r.json)}`); continue; }
    let m = reply.message;
    const wrong = judge(s.expect, m);
    if (wrong) { bad(`"${text}"`, wrong); continue; }
    ok(`"${text}"`, gist(m) || short(m.text, 60));
    for (const step of s.then ?? []) {
      const prompt = step.prompt.startsWith('@offer:') ? m.offers?.[Number(step.prompt.slice(7))]?.text : fill(step.prompt);
      if (!prompt) { bad(`  ↳ ${step.prompt}`, 'no such offer'); break; }
      const body = { conversationId, text: prompt };
      if (step.confirm === true) { if (!m.proposal?.id) { bad(`  ↳ "${prompt}"`, 'nothing to confirm'); break; } body.confirm = m.proposal.id; }
      const next = await ask(body, 120000);
      if (next.reply?.t !== 'chat.done') { bad(`  ↳ "${prompt}"`, JSON.stringify(next.reply ?? next.r.json)); break; }
      m = next.reply.message;
      const w = judge(step.expect, m);
      if (w) { bad(`  ↳ "${prompt}"`, w); break; }
      ok(`  ↳ "${prompt}"`, gist(m) || short(m.text, 60));
    }
    // Whatever a confirmed quickstart made is this check's to delete.
    for (const x of (await api('GET', '/api/suites')).json?.suites ?? []) if (x.id !== suiteId && x.name !== seed.suite && !made.suites.has(x.id) && String(x.origin ?? '').includes(`localhost:${PORT}`)) made.suites.add(x.id);
  }
}

await done();
