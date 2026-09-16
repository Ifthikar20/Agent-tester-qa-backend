/**
 * The chat, end to end, on the mock mind: questions answered from the stores,
 * a saved case run from a sentence, a proposal confirmed, the transcript kept.
 *
 *   node scripts/check-chat.js        (starts a runner of its own, GC_CHAT=mock)
 *
 * No key and no network: the rules (chat-mock.js) drive the same tools the
 * model would, so what is asserted here — the count, the run, the proposal,
 * the events — is the engine's, whichever mind is on.
 *
 *   1  what the runner offers        GET /api/chat: on, the mock mind, no reply in flight
 *   2  a suite to ask about          "Contact us" with a saved case, "Pricing" with none
 *   3  a turn needs words            an empty turn is a 400
 *   4  how many defects              the same number /api/defects gives
 *   5  test the contact us page      one reply at a time; the case runs; the reply cites it
 *   6  the latest scans and runs     the run just made, first
 *   7  a page with no case           what the runner offers instead, and the offer runs
 *   8  a scan, proposed then confirmed   nothing runs on the model's say-so
 *   9  the transcript                kept, listed, deleted
 */
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.GC_CHAT_PORT) || 3413;
const BASE = `http://localhost:${PORT}`;
const WS_URL = `${BASE.replace(/^http/, 'ws')}/ws`;

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(50)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(50)} ${d}`); };
const section = (t) => console.log(`\n— ${t} ${'—'.repeat(Math.max(2, 50 - t.length))}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s, n = 110) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);
async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, json };
}

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
  v.at = () => v.msgs.length;
  v.until = async (pred, ms = 8000, from = 0) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      for (let i = from; i < v.msgs.length; i++) if (pred(v.msgs[i])) return v.msgs[i];
      await wait(50);
    }
    return null;
  };
  return v;
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
if (/chat\s+->\s+the mock mind/.test(out)) ok('the banner names the mock mind', 'GC_CHAT=mock'); else bad('the banner names the mock mind', short(out.split('\n').find((l) => /chat\s+->/.test(l)) ?? out.slice(-200)));

const v = viewer();
await v.open;
await v.until((m) => m.t === 'ready', 5000);

/** One turn: POST it, wait for its reply on the socket. */
async function ask(body, ms = 30000) {
  const from = v.at();
  const r = await api('POST', '/api/chat/turns', body);
  if (r.status !== 202 || !r.json?.turnId) return { r, from, reply: null };
  const reply = await v.until((m) => (m.t === 'chat.done' || m.t === 'chat.error') && m.turn === r.json.turnId, ms, from);
  return { r, from, reply, turnId: r.json.turnId, conversationId: r.json.conversationId };
}

// ---------------------------------------------------------------------------
section('1 · what the runner offers');
let before = 0;
{
  const r = await api('GET', '/api/chat');
  if (r.status === 200 && r.json?.ok && r.json.on === true) ok('GET /api/chat: on', `switch runner.chat is ${r.json.on ? 'on' : 'off'}`); else bad('GET /api/chat: on', `${r.status} ${JSON.stringify(r.json)}`);
  if (r.json?.llm?.mode === 'mock' && r.json.llm.model === null) ok('the mock mind, no model', JSON.stringify(r.json.llm)); else bad('the mock mind, no model', JSON.stringify(r.json?.llm));
  if (r.json?.busy === null && Array.isArray(r.json.conversations)) ok('nothing in flight, the conversations listed', `${r.json.conversations.length} so far`); else bad('nothing in flight, the conversations listed', JSON.stringify(r.json));
  if (typeof r.json?.budget?.max === 'number' && r.json.budget.used === 0) ok('a budget, unspent', `${r.json.budget.used}/${r.json.budget.max}`); else bad('a budget, unspent', JSON.stringify(r.json?.budget));
  before = r.json?.conversations?.length ?? 0;
}

// ---------------------------------------------------------------------------
section('2 · a suite to ask about');
let suiteId = null;
let contactPage = null;
let pricingPage = null;
{
  const o = await api('POST', '/api/origins', { origin: BASE });
  if (o.status === 200 || /already/i.test(o.json?.error ?? '')) ok('the runner’s own origin is allowed', BASE); else bad('the runner’s own origin is allowed', `${o.status} ${JSON.stringify(o.json)}`);
  // Whatever an earlier run of this check left behind.
  const have = await api('GET', '/api/suites');
  for (const s of have.json?.suites ?? []) if (s.name === 'Chat check') await api('DELETE', `/api/suites/${s.id}`);
  const made = await api('POST', '/api/suites', { name: 'Chat check', baseUrl: BASE, description: 'made by scripts/check-chat.js' });
  suiteId = made.json?.suite?.id ?? null;
  if (suiteId) ok('a suite', suiteId); else { bad('a suite', JSON.stringify(made.json)); await done(); }
  contactPage = (await api('POST', `/api/suites/${suiteId}/pages`, { name: 'Contact us', path: '/demo.html', expect: [{ kind: 'url', value: '/demo.html' }] })).json?.page ?? null;
  pricingPage = (await api('POST', `/api/suites/${suiteId}/pages`, { name: 'Pricing', path: '/site.html', expect: [{ kind: 'url', value: '/site.html' }] })).json?.page ?? null;
  if (contactPage && pricingPage) ok('two pages', `${contactPage.name} · ${pricingPage.name}`); else { bad('two pages'); await done(); }
  const flow = (await api('GET', `/api/suites/${suiteId}/pages/${contactPage.id}/check`)).json?.flow;
  const c = await api('POST', `/api/suites/${suiteId}/cases`, { name: 'Contact us loads', pageId: contactPage.id, flow });
  if (c.json?.ok) ok('one saved case', `${c.json.case.name} (${c.json.case.steps} steps)`); else { bad('one saved case', JSON.stringify(c.json)); await done(); }
}

// ---------------------------------------------------------------------------
section('3 · a turn needs words');
{
  const r = await api('POST', '/api/chat/turns', {});
  if (r.status === 400 && /Ask something/.test(r.json?.error ?? '')) ok('an empty turn is a 400', r.json.error); else bad('an empty turn is a 400', `${r.status} ${JSON.stringify(r.json)}`);
  const s = await api('POST', '/api/chat/turns', { text: 'hello', conversationId: 'cv_00000000' });
  if (s.status === 404) ok('an unknown conversation is a 404', s.json?.error); else bad('an unknown conversation is a 404', `${s.status} ${JSON.stringify(s.json)}`);
}

// ---------------------------------------------------------------------------
section('4 · how many defects');
let conversationId = null;
{
  const { r, from, reply, turnId } = await ask({ text: 'How many defects do we have?' });
  if (r.status === 202 && r.json?.conversationId && turnId) ok('a turn is accepted with a 202', `${r.json.conversationId} · ${turnId}`); else { bad('a turn is accepted with a 202', `${r.status} ${JSON.stringify(r.json)}`); await done(); }
  conversationId = r.json.conversationId;
  const accepted = await v.until((m) => m.t === 'chat.turn' && m.turn === turnId, 3000, from);
  if (accepted?.state === 'thinking') ok('chat.turn says it is thinking'); else bad('chat.turn says it is thinking', JSON.stringify(accepted));
  if (reply?.t === 'chat.done' && reply.message?.role === 'assistant') ok('chat.done carries the reply', short(reply.message.text)); else { bad('chat.done carries the reply', JSON.stringify(reply)); await done(); }
  if (reply.message.mind === 'mock' && reply.message.model === null) ok('answered by the rules'); else bad('answered by the rules', `${reply.message.mind} ${reply.message.model}`);
  const d = await api('GET', '/api/defects');
  const t = d.json?.totals ?? {};
  const said = reply.message.text;
  const agrees = t.all === 0 ? /No defects have been filed/.test(said) : said.includes(`You have ${t.open} open defect`) && said.includes(`${t.all} in all`);
  if (agrees) ok('the number is /api/defects’s', `open ${t.open}, all ${t.all}`); else bad('the number is /api/defects’s', `${JSON.stringify(t)} vs "${short(said)}"`);
  const used = reply.message.tools.map((c) => c.name);
  if (used.includes('defects')) ok('and came from the defects tool', used.join(', ')); else bad('and came from the defects tool', used.join(', '));
}

// ---------------------------------------------------------------------------
section('5 · test the contact us page');
{
  const from = v.at();
  const r = await api('POST', '/api/chat/turns', { conversationId, text: 'Can you test the contact us page?' });
  if (r.status === 202) ok('accepted'); else { bad('accepted', `${r.status} ${JSON.stringify(r.json)}`); await done(); }
  const again = await api('POST', '/api/chat/turns', { conversationId, text: 'and again' });
  if (again.status === 409 && again.json?.error === 'chat_busy' && again.json.turnId === r.json.turnId) ok('a second turn meanwhile is a 409 chat_busy', again.json.turnId); else bad('a second turn meanwhile is a 409 chat_busy', `${again.status} ${JSON.stringify(again.json)}`);
  const started = await v.until((m) => m.t === 'chat.tool' && m.call?.name === 'run_case' && m.call.state === 'start', 15000, from);
  if (started) ok('chat.tool: run_case started', started.call.label); else bad('chat.tool: run_case started');
  if (await v.until((m) => m.t === 'run.start' && m.caseName === 'Contact us loads', 15000, from)) ok('run.start on the socket, as any run'); else bad('run.start on the socket, as any run');
  const reply = await v.until((m) => (m.t === 'chat.done' || m.t === 'chat.error') && m.turn === r.json.turnId, 40000, from);
  if (reply?.t === 'chat.done') ok('chat.done', short(reply.message.text)); else { bad('chat.done', JSON.stringify(reply)); await done(); }
  const run = reply.message.runs?.[0];
  if (run && run.ok === true && run.caseName === 'Contact us loads' && run.suiteId === suiteId) ok('the reply carries the run card', `passed ${run.passed}/${run.total}`); else bad('the reply carries the run card', JSON.stringify(reply.message.runs));
  if (/I ran "Contact us loads" from Chat check: passed \d+\/\d+ steps/.test(reply.message.text)) ok('and says so in words'); else bad('and says so in words', short(reply.message.text));
  const landed = reply.message.tools.find((c) => c.name === 'run_case');
  if (landed?.ok && /passed/.test(landed.summary)) ok('the tool line summarises it', landed.summary); else bad('the tool line summarises it', JSON.stringify(landed));
  const state = await api('GET', '/api/chat');
  if (state.json?.busy === null) ok('nothing in flight afterwards'); else bad('nothing in flight afterwards', JSON.stringify(state.json?.busy));
}

// ---------------------------------------------------------------------------
section('6 · the latest scans and runs');
{
  const { reply } = await ask({ conversationId, text: 'What were the latest scans?' });
  if (reply?.t === 'chat.done') ok('chat.done', short(reply.message.text)); else { bad('chat.done', JSON.stringify(reply)); await done(); }
  if (/The latest run was Chat check · Contact us loads, (just now|\d+ min ago): passed/.test(reply.message.text)) ok('the run just made comes first'); else bad('the run just made comes first', short(reply.message.text));
  // This runner's other suites may have scanned pages of their own: either sentence is the store's.
  if (/No page has been scanned yet|Pages scanned most recently: .+ \(.+\) /.test(reply.message.text)) ok('and which page was scanned last, if any', short(reply.message.text.split('\n').pop(), 80)); else bad('and which page was scanned last, if any', short(reply.message.text));
}

// ---------------------------------------------------------------------------
section('7 · a page with no case');
{
  const { reply } = await ask({ conversationId, text: 'test the pricing page' });
  if (reply?.t === 'chat.done' && /could not find a saved case for "pricing"/.test(reply.message.text)) ok('says no case matches', short(reply.message.text)); else { bad('says no case matches', JSON.stringify(reply?.message?.text)); await done(); }
  const offers = reply.message.offers ?? [];
  if (offers.length >= 1 && /page check/i.test(offers[0].text)) ok('and offers the page’s check', offers.map((o) => o.label).join(' | ')); else { bad('and offers the page’s check', JSON.stringify(offers)); await done(); }
  if (reply.message.runs.length === 0) ok('nothing was run'); else bad('nothing was run', JSON.stringify(reply.message.runs));
  const took = await ask({ conversationId, text: offers[0].text });
  if (took.reply?.t === 'chat.done' && /one-off check/.test(took.reply.message.text)) ok('the offer runs the page check', short(took.reply.message.text)); else { bad('the offer runs the page check', JSON.stringify(took.reply?.message?.text)); }
  const run = took.reply?.message?.runs?.[0];
  if (run && run.oneOff === true && run.caseId === null && run.ok === true) ok('as a one-off, not a saved case', `passed ${run.passed}/${run.total}`); else bad('as a one-off, not a saved case', JSON.stringify(run));
}

// ---------------------------------------------------------------------------
section('8 · a scan, proposed then confirmed');
{
  const from = v.at();
  const { reply } = await ask({ conversationId, text: 'scan the contact us page' });
  if (reply?.t === 'chat.done' && /Say yes to go ahead/.test(reply.message.text)) ok('a scan is proposed, not done', short(reply.message.text)); else { bad('a scan is proposed, not done', JSON.stringify(reply?.message?.text)); await done(); }
  const proposed = await v.until((m) => m.t === 'chat.proposal', 2000, from);
  const p = reply.message.proposal;
  if (proposed?.proposal?.id && p?.id === proposed.proposal.id && p.kind === 'scan_page') ok('chat.proposal, and the reply carries it', `${p.id} · ${p.label}`); else { bad('chat.proposal, and the reply carries it', JSON.stringify([proposed, p])); await done(); }
  const pageBefore = (await api('GET', `/api/suites/${suiteId}`)).json?.suite?.pages.find((x) => x.id === contactPage.id);
  if (!pageBefore?.scannedAt) ok('the page is not scanned yet'); else bad('the page is not scanned yet', pageBefore.scannedAt);
  const listed = (await api('GET', `/api/chat/${conversationId}`)).json?.conversation;
  if (listed?.proposal?.id === p.id) ok('the conversation holds the proposal', 'GET /api/chat/:id'); else bad('the conversation holds the proposal', JSON.stringify(listed?.proposal));

  const yes = await ask({ conversationId, text: 'Yes, do it', confirm: p.id });
  const ran = await v.until((m) => m.t === 'chat.tool' && m.call?.name === 'scan_page' && m.call.state === 'done', 20000, yes.from);
  if (ran) ok('the confirmed scan ran', ran.call.summary); else bad('the confirmed scan ran');
  if (yes.reply?.t === 'chat.done' && /^Scanned "Contact us": \d+ targets and \d+ links\./.test(yes.reply.message.text)) ok('and the reply reports it', short(yes.reply.message.text)); else bad('and the reply reports it', JSON.stringify(yes.reply?.message?.text));
  if (yes.reply?.message?.executed?.kind === 'scan_page' && yes.reply.message.executed.ok === true) ok('the reply names what was executed', yes.reply.message.executed.label); else bad('the reply names what was executed', JSON.stringify(yes.reply?.message?.executed));
  const pageAfter = (await api('GET', `/api/suites/${suiteId}`)).json?.suite?.pages.find((x) => x.id === contactPage.id);
  if (pageAfter?.scannedAt && (pageAfter.targets ?? []).length > 0) ok('the page is scanned now', `${pageAfter.targets.length} targets at ${pageAfter.scannedAt}`); else bad('the page is scanned now', JSON.stringify(pageAfter?.scannedAt));

  const stale = await ask({ conversationId, text: 'Yes, do it', confirm: p.id });
  if (stale.reply?.t === 'chat.done' && /Nothing is waiting to be confirmed/.test(stale.reply.message.text)) ok('a second yes finds nothing waiting', short(stale.reply.message.text)); else bad('a second yes finds nothing waiting', JSON.stringify(stale.reply?.message?.text));
  const idle = await ask({ conversationId, text: 'yes' });
  if (idle.reply?.t === 'chat.done' && /Nothing is waiting for a yes/.test(idle.reply.message.text)) ok('a bare yes with no proposal is told so', short(idle.reply.message.text)); else bad('a bare yes with no proposal is told so', JSON.stringify(idle.reply?.message?.text));
}

// ---------------------------------------------------------------------------
section('9 · the transcript');
{
  const one = await api('GET', `/api/chat/${conversationId}`);
  const c = one.json?.conversation;
  const users = (c?.messages ?? []).filter((m) => m.role === 'user').length;
  const answers = (c?.messages ?? []).filter((m) => m.role === 'assistant').length;
  if (one.status === 200 && users === 9 && answers === 9) ok('every turn and every reply is kept', `${users} asked, ${answers} answered`); else bad('every turn and every reply is kept', `${one.status} ${users}/${answers}`);
  if (c?.title === 'How many defects do we have?') ok('titled by the first question', c.title); else bad('titled by the first question', c?.title);
  const list = await api('GET', '/api/chat');
  const row = list.json?.conversations?.find((x) => x.id === conversationId);
  if (row && row.last?.role === 'assistant' && row.messages === 18 && list.json.conversations.length === before + 1) ok('listed, newest first, with its last word', short(row.last.text, 60)); else bad('listed, newest first, with its last word', JSON.stringify(row));
  const fresh = await ask({ text: 'Which test cases are saved?' });
  if (fresh.reply?.t === 'chat.done' && fresh.conversationId !== conversationId && /Contact us loads/.test(fresh.reply.message.text)) ok('a turn with no id starts a new conversation', `${fresh.conversationId}: ${short(fresh.reply.message.text, 70)}`); else bad('a turn with no id starts a new conversation', JSON.stringify(fresh.reply?.message?.text));
  const gone = await api('DELETE', `/api/chat/${fresh.conversationId}`);
  const gone2 = await api('DELETE', `/api/chat/${conversationId}`);
  if (gone.status === 200 && gone2.status === 200 && gone2.json?.removed === conversationId) ok('DELETE /api/chat/:id'); else bad('DELETE /api/chat/:id', `${gone.status} ${gone2.status}`);
  const after = await api('GET', `/api/chat/${conversationId}`);
  if (after.status === 404) ok('and it is gone', after.json?.error); else bad('and it is gone', `${after.status}`);
  const count = (await api('GET', '/api/chat')).json?.conversations?.length;
  if (count === before) ok('the list is as it was', `${count}`); else bad('the list is as it was', `${count} vs ${before}`);
}

// ---------------------------------------------------------------------------
section('10 · cleanup');
{
  const r = await api('DELETE', `/api/suites/${suiteId}`);
  if (r.status === 200) ok('the suite is gone'); else bad('the suite is gone', `${r.status}`);
}
v.ws.close();
await done();
