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
 *  10  drafted tests                 read, tick, run, revise once, report — and stop (chat-plan.js, public/contact.html)
 *  11  the documentation             a question about the product, answered from its own docs
 *  12  files                         a Playwright file becomes checks to tick and run; a CSV is described and charted; the caps on the wire
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
  // What the tool read rides on the reply, shaped for the page to draw.
  const view = (reply.message.data ?? [])[0];
  if (view?.kind === 'defects' && view.totals?.all === t.all && Array.isArray(view.rows)) ok('and the reply carries the defects as data', `${view.rows.length} row(s), totals ${JSON.stringify(view.totals)}`); else bad('and the reply carries the defects as data', JSON.stringify(view));
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
section('10 · drafted tests: read, tick, run, revise once, report');
{
  // A page of its own with NO saved case (§5's "Contact us" has one, so that
  // sentence runs the case): Harbour's contact form, whose "Our story" link
  // shows late and whose brochure link goes nowhere (public/contact.html).
  const formPage = (await api('POST', `/api/suites/${suiteId}/pages`, { name: 'Contact form', path: '/contact.html', expect: [{ kind: 'url', value: '/contact.html' }, { kind: 'text', value: 'Talk to us' }] })).json?.page ?? null;
  if (formPage) ok('a contact form page, with no case'); else { bad('a contact form page, with no case'); await done(); }
  const defectsBefore = JSON.stringify((await api('GET', '/api/defects')).json);

  const first = await ask({ text: 'draft 4 tests for the contact form page' });
  const cv = first.conversationId;
  if (first.reply?.t === 'chat.done' && /^Drafting tests for "Contact form" opens the page, reads its controls and writes up to 4 checks/.test(first.reply.message.text)) ok('drafting is proposed, not done', short(first.reply.message.text)); else { bad('drafting is proposed, not done', JSON.stringify(first.reply?.message?.text)); await done(); }
  const p1 = first.reply.message.proposal;
  if (p1?.kind === 'plan_page' && first.reply.message.runs.length === 0) ok('a plan_page proposal, and nothing was run', p1.label); else { bad('a plan_page proposal, and nothing was run', JSON.stringify(p1)); await done(); }

  const yes = await ask({ conversationId: cv, text: 'Yes, do it', confirm: p1.id }, 60000);
  const read = await v.until((m) => m.t === 'chat.tool' && m.call?.name === 'plan_page_tests' && m.call.state === 'done', 30000, yes.from);
  if (read && /4 drafted/.test(read.call.summary)) ok('the page was read and four checks drafted', read.call.summary); else { bad('the page was read and four checks drafted', JSON.stringify(read)); await done(); }
  const p2 = yes.reply?.message?.proposal;
  const items = p2?.items ?? [];
  const names = items.map((i) => i.name);
  if (p2?.kind === 'run_drafts' && JSON.stringify(names) === JSON.stringify(['Contact form loads', 'Contact form form is there', 'Contact form → Our story', 'Contact form → Download the brochure'])) ok('a run_drafts proposal carries the four to tick', names.join(' | ')); else { bad('a run_drafts proposal carries the four to tick', JSON.stringify(p2)); await done(); }
  if (items.every((i) => /^dc\d$/.test(i.id) && i.steps > 0 && /^%% suite "Chat check · /.test(i.flow) && /testcase TD/.test(i.flow))) ok('each with an id, a size and its script'); else bad('each with an id, a size and its script', JSON.stringify(items.map((i) => [i.id, i.steps, i.flow.slice(0, 40)])));
  if (/drafted 4 checks by the rules/.test(yes.reply.message.text) && /Tick the ones to run/.test(yes.reply.message.text)) ok('the reply lists them', short(yes.reply.message.text)); else bad('the reply lists them', short(yes.reply.message.text));
  if (yes.reply.message.executed?.kind === 'plan_page' && yes.reply.message.executed.result?.mind === 'rules') ok('drafted by the rules, with no key', JSON.stringify(yes.reply.message.executed.result?.candidates?.length)); else bad('drafted by the rules, with no key', JSON.stringify(yes.reply.message.executed));
  const listed = (await api('GET', `/api/chat/${cv}`)).json?.conversation;
  if (listed?.proposal?.id === p2.id && listed.proposal.items?.length === 4 && listed.proposal.args === undefined) ok('the items survive a re-read, the arguments never leave', 'GET /api/chat/:id'); else bad('the items survive a re-read, the arguments never leave', JSON.stringify(listed?.proposal));
  const scanned = (await api('GET', `/api/suites/${suiteId}`)).json?.suite?.pages.find((x) => x.id === formPage.id);
  if (scanned?.targets?.some((t) => t.target === 'link:Our story')) ok('the read recorded the page\'s targets, the late link among them', `${scanned.targets.length} targets`); else bad('the read recorded the page\'s targets, the late link among them', JSON.stringify(scanned?.targets));

  // Three of the four: the form check, the late link, the brochure.
  const picked = [items[1].id, items[2].id, items[3].id];
  const run = await ask({ conversationId: cv, text: 'Yes, run the ones I ticked', confirm: p2.id, choices: picked }, 150000);
  if (run.reply?.t === 'chat.done') ok('chat.done', short(run.reply.message.text)); else { bad('chat.done', JSON.stringify(run.reply)); await done(); }
  const starts = v.msgs.slice(run.from).filter((m) => m.t === 'run.start');
  const second = starts.find((m) => m.attempt === 2);
  if (starts.length === 4 && second && /\(attempt 2\)$/.test(second.caseName) && starts.filter((m) => !m.attempt).length === 3) ok('three drafts ran, one of them twice, the second attempt saying so', second.caseName); else bad('three drafts ran, one of them twice, the second attempt saying so', JSON.stringify(starts.map((m) => [m.caseName, m.attempt ?? 1])));
  const cards = run.reply.message.runs ?? [];
  const by = Object.fromEntries(cards.map((c) => [c.candidate, c]));
  if (cards.length === 3 && cards.every((c) => c.draft === true && c.oneOff === true && c.caseId === null)) ok('one card per draft, each a draft, none a saved case'); else bad('one card per draft, each a draft, none a saved case', JSON.stringify(cards.map((c) => [c.candidate, c.draft, c.caseId])));
  if (by[items[1].id]?.verdict === 'passed' && by[items[1].id].ok === true) ok('the form check passed', `${by[items[1].id].passed}/${by[items[1].id].total}`); else bad('the form check passed', JSON.stringify(by[items[1].id]));
  const late = by[items[2].id];
  if (late?.verdict === 'test_script' && late.ok === true && late.attempts === 2 && late.revised === true && /wait \d+ms/.test(late.flow ?? '')) ok('the late link: the test was wrong, given a wait, and passed the second time', late.flow.split('\n').find((l) => /wait/.test(l))?.trim()); else bad('the late link: the test was wrong, given a wait, and passed the second time', JSON.stringify(late));
  const broken = by[items[3].id];
  if (broken?.verdict === 'app_bug' && broken.ok === false && broken.attempts === 1 && broken.revised === false && /got 404/.test(broken.error ?? '')) ok('the brochure: the application is broken, and no revision was tried', short(broken.error, 60)); else bad('the brochure: the application is broken, and no revision was tried', JSON.stringify(broken));
  const said = run.reply.message.text;
  if (/^2 of 3 drafted checks passed\./.test(said) && /"Contact form → Our story" was wrong: .* — it passed on the second attempt/.test(said) && /"Contact form → Download the brochure" found the application broken/.test(said)) ok('the reply says so, verdict by verdict', short(said, 90)); else bad('the reply says so, verdict by verdict', said);
  if (JSON.stringify((await api('GET', '/api/defects')).json) === defectsBefore) ok('no draft filed a defect', 'GET /api/defects byte for byte'); else bad('no draft filed a defect');
  const state = await api('GET', '/api/chat');
  if (state.json?.busy === null && state.json.stopping === null) ok('nothing in flight afterwards'); else bad('nothing in flight afterwards', JSON.stringify(state.json?.busy));

  // Stop: the second draft in flight is the last to run.
  const again = await ask({ conversationId: cv, text: 'draft tests for the contact form page' });
  const p3 = again.reply?.message?.proposal;
  const drafted = await ask({ conversationId: cv, text: 'yes', confirm: p3?.id }, 60000);
  const p4 = drafted.reply?.message?.proposal;
  if (p4?.kind === 'run_drafts' && p4.items?.length === 3) ok('drafted again: three by default', p4.items.map((i) => i.name).join(' | ')); else { bad('drafted again: three by default', JSON.stringify(p4)); await done(); }
  const from = v.at();
  const go = await api('POST', '/api/chat/turns', { conversationId: cv, text: 'Yes, do it', confirm: p4.id });
  const stop = await api('POST', '/api/chat/stop');
  if (go.status === 202 && stop.status === 200 && stop.json?.stopping === go.json.turnId) ok('POST /api/chat/stop names the turn it stops', stop.json.stopping); else bad('POST /api/chat/stop names the turn it stops', `${go.status} ${stop.status} ${JSON.stringify(stop.json)}`);
  const stopped = await v.until((m) => (m.t === 'chat.done' || m.t === 'chat.error') && m.turn === go.json.turnId, 90000, from);
  const outs = stopped?.message?.executed?.result?.outcomes ?? [];
  if (stopped?.t === 'chat.done' && outs.length === 3 && outs[0].verdict === 'passed' && outs.slice(1).every((o) => o.verdict === 'stopped') && stopped.message.executed.result.stopped === true) ok('it ended after the draft in flight', outs.map((o) => o.verdict).join(', ')); else bad('it ended after the draft in flight', JSON.stringify(outs.map((o) => o.verdict)));
  if (/^1 of 3 drafted checks passed before it was stopped\./.test(stopped?.message?.text ?? '')) ok('and the reply says so', short(stopped.message.text, 70)); else bad('and the reply says so', short(stopped?.message?.text ?? ''));
  const idle = await api('POST', '/api/chat/stop');
  if (idle.status === 200 && idle.json?.stopping === null) ok('a stop with nothing in flight stops nothing'); else bad('a stop with nothing in flight stops nothing', JSON.stringify(idle.json));
  const gone = await api('DELETE', `/api/chat/${cv}`);
  if (gone.status === 200) ok('the conversation is deleted'); else bad('the conversation is deleted', `${gone.status}`);
}

// ---------------------------------------------------------------------------
section('11 · a question about the product, from its own documentation');
{
  // A conversation of its own: the transcript section above deleted the shared one.
  const { r, reply } = await ask({ text: 'How do I record a test?' });
  const m = reply?.message ?? {};
  if (r.status === 202 && reply?.t === 'chat.done') ok('a question about the product is taken', short(m.text)); else bad('a question about the product is taken', `${r.status} ${JSON.stringify(reply)}`);
  const used = (m.tools ?? []).map((c) => c.name);
  if (used.includes('docs')) ok('and answered from the docs tool', used.join(', ')); else bad('and answered from the docs tool', used.join(', '));
  if (/^From README\.md · .+:\n\n/.test(m.text ?? '')) ok('the rules quote the section and name it', short(m.text, 80)); else bad('the rules quote the section and name it', short(m.text));
  if (Array.isArray(m.sources) && m.sources.length && m.sources[0].file === 'README.md') ok('the reply keeps where it was read', m.sources.map((s) => `${s.file} · ${s.heading}`).join('; ')); else bad('the reply keeps where it was read', JSON.stringify(m.sources));
  const kept = await api('GET', `/api/chat/${r.json?.conversationId}`);
  const last = kept.json?.conversation?.messages?.at(-1);
  if (last?.sources?.length) ok('and the transcript keeps them too'); else bad('and the transcript keeps them too', JSON.stringify(last?.sources));
  if (r.json?.conversationId) await api('DELETE', `/api/chat/${r.json.conversationId}`);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
section('12 · files: code becomes checks to tick, a table becomes a chart');
{
  // A Playwright test against the runner's own demo page (public/demo.html):
  // one check that can pass, one against a page that is not there.
  const PW = `import { test, expect } from '@playwright/test';
test('the account page', async ({ page }) => {
  await page.goto('${BASE}/demo.html');
  await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();
  await page.getByLabel('Email').fill('qa@example.com');
  await page.getByRole('checkbox', { name: 'Remember me' }).check();
});
test('a page that is not there', async ({ page }) => {
  await page.goto('${BASE}/nowhere.html');
  await expect(page.getByText('Nothing here')).toBeVisible();
});`;
  const first = await ask({ text: 'Turn this into checks', attachments: [{ name: 'account.spec.ts', encoding: 'text', data: PW }] });
  const cv = first.conversationId;
  const m = first.reply?.message ?? {};
  if (first.reply?.t === 'chat.done' && /^Translated 2 checks from Playwright: the account page \(3 steps\), a page that is not there \(2 steps\)\./.test(m.text)) ok('a Playwright file becomes two checks', short(m.text, 90)); else { bad('a Playwright file becomes two checks', `${first.r.status} ${short(m.text ?? JSON.stringify(first.reply))}`); await done(); }
  if (/Could not carry: .*ticking a checkbox is not in the language yet/.test(m.text)) ok('and says what it could not carry', 'the checkbox'); else bad('and says what it could not carry', short(m.text));
  const p = m.proposal;
  const items = p?.items ?? [];
  if (p?.kind === 'run_import' && items.length === 2 && items.every((i) => /^dc\d$/.test(i.id) && /testcase TD/.test(i.flow)) && m.runs.length === 0) ok('a run_import proposal with two items, and nothing ran', p.label); else { bad('a run_import proposal with two items, and nothing ran', JSON.stringify(p)); await done(); }
  if ((m.tools ?? []).some((c) => c.name === 'translate_code')) ok('the translator was the agent asked'); else bad('the translator was the agent asked', (m.tools ?? []).map((c) => c.name).join(', '));
  const kept = (await api('GET', `/api/chat/${cv}`)).json?.conversation;
  const mine = kept?.messages?.[0];
  if (mine?.attachments?.[0]?.name === 'account.spec.ts' && mine.attachments[0].kind === 'code' && mine.attachments[0].framework === 'playwright' && mine.attachments[0].lines > 5) ok('the transcript keeps the file\'s name and shape', JSON.stringify(mine.attachments[0])); else bad('the transcript keeps the file\'s name and shape', JSON.stringify(mine?.attachments));
  // The reply may quote the one line it could not carry (bounded, credentials masked); the file itself stays in memory and out of the transcript.
  const dump = JSON.stringify(kept);
  if (!dump.includes("import { test, expect }") && !dump.includes('async ({ page })') && !('data' in (mine?.attachments?.[0] ?? {})) && !('text' in (mine?.attachments?.[0] ?? {}))) ok('and never the file itself'); else bad('and never the file itself', short(dump.match(/.{0,40}(import \{ test|async \(\{ page).{0,40}/)?.[0] ?? 'data on the message'));

  const run = await ask({ conversationId: cv, text: 'Yes, run them all', confirm: p.id, choices: items.map((i) => i.id) }, 120000);
  const cards = run.reply?.message?.runs ?? [];
  if (run.reply?.t === 'chat.done' && /^1 of 2 translated checks passed\./.test(run.reply.message.text)) ok('both ran; one passed', short(run.reply.message.text, 100)); else { bad('both ran; one passed', JSON.stringify(run.reply?.message?.text ?? run.reply)); await done(); }
  const by = Object.fromEntries(cards.map((c) => [c.candidate, c]));
  if (cards.length === 2 && cards.every((c) => c.imported === true && c.draft === true && c.from === 'playwright' && c.caseId === null && c.suiteId === suiteId)) ok('one card per check, each translated, none saved, each in the suite its origin matches'); else bad('one card per check, each translated, none saved, each in the suite its origin matches', JSON.stringify(cards.map((c) => [c.candidate, c.imported, c.draft, c.from, c.caseId, c.suiteId])));
  if (by.dc1?.ok === true && by.dc1.passed === 3 && /fill 'Email' : label/.test(by.dc1.flow ?? '')) ok('the account page passed', `${by.dc1.passed}/${by.dc1.total}`); else bad('the account page passed', JSON.stringify(by.dc1));
  if (by.dc2?.ok === false && by.dc2.error) ok('the page that is not there failed, and says why', short(by.dc2.error, 80)); else bad('the page that is not there failed, and says why', JSON.stringify(by.dc2));
  if (run.reply.message.executed?.kind === 'run_import' && run.reply.message.executed.result?.passed === 1) ok('the executed proposal is on the reply', run.reply.message.executed.label); else bad('the executed proposal is on the reply', JSON.stringify(run.reply.message.executed));
  // Keeping the passing one is the person's press: the same route the card's button calls.
  const saved = await api('POST', `/api/suites/${suiteId}/cases`, { name: by.dc1.caseName, pageId: null, flow: by.dc1.flow, source: 'generated' });
  if (saved.json?.ok && saved.json.case.steps === 3) ok('the passing check keeps as a case', `${saved.json.case.name} (${saved.json.case.steps} steps)`); else bad('the passing check keeps as a case', JSON.stringify(saved.json));
  const runsBefore = (await api('GET', '/api/runs')).json?.totals?.runs;

  // A table: described, then charted from the offer, then the records charted.
  const csv = 'day,runs,failed\n2026-09-01,4,1\n2026-09-02,6,0\n2026-09-03,3,2\n';
  const t = await ask({ conversationId: cv, text: 'What is in this file?', attachments: [{ name: 'runs.csv', encoding: 'text', data: csv }] });
  const tm = t.reply?.message ?? {};
  if (t.reply?.t === 'chat.done' && /^runs\.csv: 3 rows × 3 columns — day \(date\), runs \(number\), failed \(number\)\./.test(tm.text)) ok('a CSV is described', short(tm.text, 90)); else { bad('a CSV is described', short(tm.text ?? JSON.stringify(t.reply))); await done(); }
  if (tm.data?.[0]?.kind === 'table' && tm.data[0].rows.length === 3) ok('and drawn as a table', `${tm.data[0].rows.length} rows`); else bad('and drawn as a table', JSON.stringify(tm.data));
  if (tm.offers?.[0]?.text === 'chart runs.csv') ok('with a chart offered', tm.offers[0].label); else { bad('with a chart offered', JSON.stringify(tm.offers)); await done(); }
  const c = await ask({ conversationId: cv, text: tm.offers[0].text });
  const cm = c.reply?.message ?? {};
  const chart = (cm.data ?? []).find((v) => v.kind === 'chart');
  if (chart && chart.type === 'line' && chart.x === 'date' && JSON.stringify(chart.series.map((s) => s.name)) === '["runs","failed"]' && chart.labels.length === 3) ok('the offer charts it: a line, by day', short(cm.text, 90)); else bad('the offer charts it: a line, by day', JSON.stringify(chart ?? cm.text));
  const r = await ask({ conversationId: cv, text: 'chart the runs per day' });
  const rc = (r.reply?.message?.data ?? []).find((v) => v.kind === 'chart');
  if (rc && rc.stacked === true && rc.labels.length === 14 && rc.series[0].role === 'pass' && rc.series[1].role === 'fail') ok('the records chart too: runs per day, stacked', short(r.reply.message.text, 90)); else bad('the records chart too: runs per day, stacked', JSON.stringify(rc ?? r.reply?.message?.text));
  if ((await api('GET', '/api/runs')).json?.totals?.runs === runsBefore) ok('reading and charting ran nothing'); else bad('reading and charting ran nothing');

  // The caps and the kinds, on the wire: refused before anything is read, naming the file.
  const big = await api('POST', '/api/chat/turns', { conversationId: cv, text: 'x', attachments: [{ name: 'big.csv', encoding: 'text', data: 'a,b\n' + '1,2\n'.repeat(70_000) }] });
  if (big.status === 400 && /big\.csv: .*files up to 256 kB/.test(big.json?.error ?? '')) ok('a file too big is a 400 naming it', big.json.error); else bad('a file too big is a 400 naming it', `${big.status} ${JSON.stringify(big.json)}`);
  const png = await api('POST', '/api/chat/turns', { conversationId: cv, text: 'x', attachments: [{ name: 'shot.png', encoding: 'base64', data: Buffer.from('\x89PNG\r\n').toString('base64') }] });
  if (png.status === 400 && /shot\.png: .*does not read/.test(png.json?.error ?? '')) ok('a kind the chat does not read is a 400 naming it', png.json.error); else bad('a kind the chat does not read is a 400 naming it', `${png.status} ${JSON.stringify(png.json)}`);
  const state = await api('GET', '/api/chat');
  if (state.json?.busy === null) ok('nothing in flight afterwards'); else bad('nothing in flight afterwards', JSON.stringify(state.json?.busy));
  await api('DELETE', `/api/chat/${cv}`);
}

section('13 · cleanup');
{
  const r = await api('DELETE', `/api/suites/${suiteId}`);
  if (r.status === 200) ok('the suite is gone'); else bad('the suite is gone', `${r.status}`);
}
v.ws.close();
await done();
