/**
 * The chat: a conversation with the runner about what it knows, and what it
 * can run.
 *
 * "How many defects do we have", "what were the latest scans", "which cases
 * are saved", "can you test the contact us page" — the answers are all in
 * stores this process already keeps per organisation, and the last one is a
 * thing it can do. So this is not a search over documents. It is a MIND that
 * drives a fixed set of TOOLS (chat-tools.js): each tool reads one store or
 * runs one thing, and everything the reply says comes back from a tool. Two
 * minds drive the same tools — Claude (chat-resolver.js) when a key is here
 * and the day's budget has room, the rules (chat-mock.js) otherwise — so a
 * deployment with no key still has a chat, and the end-to-end check needs no
 * network.
 *
 * Two of the tools only PROPOSE: scanning a page and quickstart drive the
 * browser and change what the organisation keeps. A proposal is kept on the
 * conversation for ten minutes; the next turn that says yes (a button, or the
 * word) executes it here, through the same functions the routes call, and
 * the outcome is handed to the mind as a runner-authored note so the reply
 * can report it. Nothing a model says executes anything by itself.
 *
 * A turn is accepted at once and answered on the organisation's sockets,
 * because an answer that runs a case takes as long as the case does:
 *
 *   chat.turn      { turn, conversationId, state: 'thinking' }   accepted
 *   chat.delta     { text }                                       the model's words, as they come
 *   chat.tool      { call: { id, name, label, state, summary } }  a tool started, landed or failed
 *   chat.proposal  { proposal }                                   something to say yes to
 *   chat.done      { message }                                    the reply, as it was kept
 *   chat.error     { error, message }                             the turn died; the message says so
 *
 * One reply at a time per organisation (ChatBusy, a 409 the UI waits on),
 * because the tools take the one browser and two replies would race for it.
 *
 * The transcript lives in `.ghostclick/<org>/chat.json` — twenty
 * conversations of two hundred messages, redacted before they are kept
 * (redact.js, plus the saved session's values where the deployment passes
 * them). What the model saw — its own turns, tool calls and results — is kept
 * in memory only, for the life of the process; after a restart the
 * conversation is rebuilt from the words, and a tool is simply called again.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { stateDir } from './org.js';
import { normalizeUrl } from './origins.js';
import { originOf } from './suites.js';
import { makeTools, maskUrl, redactorFor, refusalOf, untrusted } from './chat-tools.js';
import { answerMock, unavailableNote } from './chat-mock.js';
import { MAX_ITERATIONS } from './chat-resolver.js';

export const TEXT_MAX = 2000;
export const TITLE_MAX = 60;
export const CONVERSATIONS_MAX = 20;
export const MESSAGES_MAX = 200;
export const TOOLS_KEPT = 16;
export const RUNS_KEPT = 8;
export const PROPOSAL_TTL_MS = 10 * 60 * 1000;
/** How many of the transcript's messages become the model's context after a restart. */
export const CONTEXT_MESSAGES = 20;
/** Past this many API messages the model's context is rebuilt from the words, so a long chat does not grow without bound. */
const CONTEXT_API_MAX = 40;
const DELTA_MS = 60;
const YES = /^(yes|yes,? (do it|please|go ahead)|yep|go ahead|do it|confirm|ok(ay)?)\b/i;
const NO = /^(no|nope|cancel|stop|never mind|don'?t|do not|leave it)\b/i;

let cfg = {
  emitTo: () => {},
  log: console,
  llm: { mode: 'mock', model: null, key: { have: false, from: null } },
  resolver: null,
  budget: null,
  /** (space) => (text) => text — one more pass over site-derived text, for the deployment's own secrets. */
  extraRedact: null,
  /** The runner's actions — the functions its routes call (server.js). */
  actions: null,
};
export function configure(options) { cfg = { ...cfg, ...options }; }
export const llmState = () => cfg.llm;
export const budgetState = () => ({ used: cfg.budget ? cfg.budget.used() : 0, max: cfg.budget ? cfg.budget.max : 0 });

export class ChatBusy extends Error {
  constructor(turn) {
    super('A reply is still being written — wait for it to finish');
    this.name = 'ChatBusy';
    this.turnId = turn.id;
    this.conversationId = turn.conversationId;
  }
}
export class NoSuchConversation extends Error {
  constructor(id) { super(`No conversation ${id}`); this.name = 'NoSuchConversation'; }
}

const refuse = (msg, status) => Object.assign(new Error(msg), { status });
const newId = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const now = () => Date.now();
export const isConversationId = (id) => /^cv_[a-z0-9]{8}$/.test(String(id ?? ''));

// ---- the store ------------------------------------------------------------------------------
/** A proposal as the UI and the transcript see it: what, not the arguments it runs with. */
const publicProposal = (p) => (p ? { id: p.id, kind: p.kind, label: p.label, at: p.at, expiresAt: p.expiresAt } : null);

class ChatStore {
  constructor(org) {
    this.org = org;
    this.dir = stateDir(org);
    this.file = join(this.dir, 'chat.json');
    this.conversations = new Map();
    /** The model's own view of each conversation, in memory only. */
    this.contexts = new Map();
    /** The turn being answered, or null. */
    this.busy = null;
    this.load();
  }

  load() {
    if (!existsSync(this.file)) return;
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const c of Array.isArray(s.conversations) ? s.conversations : []) {
        if (!c || !isConversationId(c.id)) continue;
        this.conversations.set(c.id, {
          id: c.id, title: str(c.title, TITLE_MAX) || 'Untitled',
          createdAt: Number(c.createdAt) || 0, updatedAt: Number(c.updatedAt) || 0,
          proposal: c.proposal && c.proposal.id ? c.proposal : null,
          messages: Array.isArray(c.messages) ? c.messages.filter((m) => m && (m.role === 'user' || m.role === 'assistant')) : [],
        });
      }
    } catch (err) {
      // A file that does not parse is moved aside rather than overwritten:
      // whatever is in it may still be worth reading by hand.
      const bad = `${this.file}.corrupt-${now()}`;
      try { renameSync(this.file, bad); } catch { /* nothing to move */ }
      cfg.log.error(`  chat: ${this.org}'s chat.json did not parse (${err.message}); moved to ${bad}`);
    }
  }
  persist() {
    try {
      mkdirSync(this.dir, { recursive: true });
      const body = JSON.stringify({ version: 1, savedAt: now(), conversations: [...this.conversations.values()] }, null, 2);
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, body);
      renameSync(tmp, this.file);
    } catch (err) {
      cfg.log.error(`  chat: could not write ${this.file}: ${err.message}`);
    }
  }

  find(id) {
    const c = isConversationId(id) ? this.conversations.get(id) : null;
    if (!c) throw new NoSuchConversation(id);
    return c;
  }
  /** Newest first, as a list: who said what last, and whether something waits for a yes. */
  list() {
    return [...this.conversations.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => {
        const last = c.messages[c.messages.length - 1] ?? null;
        return {
          id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, messages: c.messages.length,
          last: last ? { role: last.role, at: last.at, text: str(last.text, 140) } : null,
          proposal: publicProposal(this.proposalOf(c.id)),
        };
      });
  }
  get(id) {
    const c = this.find(id);
    return { id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, proposal: publicProposal(this.proposalOf(c.id)), messages: c.messages.map((m) => ({ ...m })) };
  }
  create(firstText) {
    const at = now();
    const c = { id: newId('cv'), title: str(firstText, TITLE_MAX) || 'Untitled', createdAt: at, updatedAt: at, proposal: null, messages: [] };
    this.conversations.set(c.id, c);
    // Twenty is plenty to scroll; the oldest goes, with what the model kept of it.
    while (this.conversations.size > CONVERSATIONS_MAX) {
      const oldest = [...this.conversations.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
      this.conversations.delete(oldest.id);
      this.contexts.delete(oldest.id);
    }
    this.persist();
    return c;
  }
  remove(id) {
    const c = this.find(id);
    this.conversations.delete(c.id);
    this.contexts.delete(c.id);
    this.persist();
    return { removed: c.id };
  }
  append(id, message) {
    const c = this.find(id);
    c.messages.push(message);
    if (c.messages.length > MESSAGES_MAX) c.messages = c.messages.slice(-MESSAGES_MAX);
    c.updatedAt = message.at;
    this.persist();
    return message;
  }
  /** The proposal waiting on this conversation, if it has not expired. */
  proposalOf(id) {
    const c = this.conversations.get(id);
    if (!c?.proposal) return null;
    if (Number(c.proposal.expiresAt) <= now()) { c.proposal = null; return null; }
    return c.proposal;
  }
  setProposal(id, proposal) {
    const c = this.find(id);
    c.proposal = proposal ?? null;
    this.persist();
  }

  /**
   * What the model sees of a conversation: its own messages from earlier
   * turns this process answered, or — after a restart, or once they have
   * grown long — the last twenty things said, as alternating turns. Tool
   * results are never rebuilt; a tool is called again.
   */
  contextOf(id) {
    const have = this.contexts.get(id);
    if (have && have.length <= CONTEXT_API_MAX) return have;
    const c = this.find(id);
    const out = [];
    for (const m of c.messages.slice(-CONTEXT_MESSAGES)) {
      if (m.error || !m.text) continue;
      const last = out[out.length - 1];
      if (last && last.role === m.role) { last.content += `\n\n${m.text}`; continue; }
      if (!out.length && m.role === 'assistant') continue;
      out.push({ role: m.role, content: String(m.text) });
    }
    // The turn being answered is the last user message; the caller adds it.
    if (out.length && out[out.length - 1].role === 'user') out.pop();
    this.contexts.set(id, out);
    return out;
  }
  setContext(id, messages) { this.contexts.set(id, messages); }
  forgetContext(id) { this.contexts.delete(id); }
}

const stores = new Map();
/** The chat of one organisation, the same object for every caller. */
export function forOrg(org) {
  let s = stores.get(org);
  if (!s) { s = new ChatStore(org); stores.set(org, s); }
  return s;
}

// ---- the engine -----------------------------------------------------------------------------
/** What GET /api/chat answers: which mind, how much budget, whether a reply is being written, the conversations. */
export function describe(space) {
  const store = space.chat;
  return {
    llm: cfg.llm,
    budget: budgetState(),
    busy: store.busy ? { id: store.busy.id, conversationId: store.busy.conversationId } : null,
    conversations: store.list(),
  };
}

/**
 * One turn. Validated and refused synchronously — no words, an unknown
 * conversation, a reply already being written — then accepted: the person's
 * message is kept, the organisation is told, and the answer is worked out
 * after this returns.
 *
 * @param confirm the id of the proposal a button confirmed, when one did
 * @returns {{id: string, conversationId: string, at: number}}
 */
export function turn({ conversationId = null, text, confirm = null, space, ent, switches = null, by = null }) {
  const store = space.chat;
  const asked = str(text, TEXT_MAX);
  if (!asked) throw refuse('Ask something — a question about defects, runs or suites, or a case to run', 400);
  const existing = conversationId != null && conversationId !== '' ? store.find(conversationId) : null;
  if (store.busy) throw new ChatBusy(store.busy);
  const conversation = existing ?? store.create(asked);
  const at = now();
  store.append(conversation.id, { id: newId('m'), role: 'user', at, text: asked, by: by == null ? null : str(by, 200) });
  const t = { id: newId('t'), conversationId: conversation.id, at, text: asked, confirm: confirm == null ? null : str(confirm, 40) };
  store.busy = t;
  cfg.emitTo(space.org, { t: 'chat.turn', turn: t.id, conversationId: t.conversationId, state: 'thinking' });
  work(t, { store, space, ent, switches }).catch((err) => {
    cfg.log.error(`  chat: turn ${t.id} for ${space.org} failed: ${err.stack ?? err.message}`);
    finish(t, store, space, { text: `Something went wrong while answering: ${err.message}`, mind: null, model: null, tools: [], runs: [], offers: null, proposal: null, executed: null, error: String(err.message ?? err) });
  });
  return { id: t.id, conversationId: t.conversationId, at };
}

/** Keep the reply, let go of the lock, tell the organisation. */
function finish(t, store, space, fields) {
  const message = { id: newId('m'), role: 'assistant', at: now(), ...fields };
  try { store.append(t.conversationId, message); } catch { /* the conversation was deleted mid-turn: the reply has nowhere to go */ }
  if (store.busy?.id === t.id) store.busy = null;
  cfg.emitTo(space.org, { t: message.error ? 'chat.error' : 'chat.done', turn: t.id, conversationId: t.conversationId, error: message.error ?? undefined, message });
  return message;
}

/** Text deltas, batched: a socket frame every sixty milliseconds rather than one per token. */
function batcher(send) {
  let buf = '';
  let timer = null;
  const flush = () => { clearTimeout(timer); timer = null; if (buf) { const out = buf; buf = ''; send(out); } };
  return {
    push(chunk) { buf += chunk; if (!timer) timer = setTimeout(flush, DELTA_MS); },
    flush,
  };
}

/** A tool call as the transcript keeps it: what it did, not what it carried. */
const publicCall = (c) => ({
  id: c.id, name: c.name, label: c.label, ok: c.ok, summary: c.summary,
  ...(c.refused ? { refused: c.refused } : {}),
  ...(c.proposal ? { proposal: publicProposal(c.proposal) } : {}),
});

/** Every run a turn made, in the order it made them: the run cards. */
function runsOf(calls, executed) {
  const out = [];
  for (const c of calls) {
    if (c.run) out.push(c.run);
    if (Array.isArray(c.runs)) out.push(...c.runs);
  }
  if (executed?.run) out.push(executed.run);
  return out;
}

/** The executed proposal as the transcript keeps it. */
const publicExecuted = (e) => (e ? { id: e.id, kind: e.kind, label: e.label, ok: e.ok ?? null, refused: e.refused ?? null, result: e.result ?? null } : null);

/**
 * The person's turn as the model reads it: what they typed, under a note
 * from the runner when a proposal was executed first. The note is the
 * runner's — the person did not write it — and the site-derived words in it
 * ride in the untrusted block like every other tool result.
 */
function userTurn(text, executed) {
  if (!executed) return text;
  const e = executed;
  let facts;
  if (e.refused) facts = `the person confirmed "${e.label}" (${e.id}) but the runner refused: ${JSON.stringify(e.refused)}`;
  else if (e.kind === 'scan_page') facts = `the person confirmed "${e.label}" (${e.id}) and it ran: ${e.result.targets} targets and ${e.result.linked} links were recorded`;
  else if (e.kind === 'quickstart') facts = `the person confirmed "${e.label}" (${e.id}) and it ran: a suite (${e.result.suiteId}) was made with ${e.result.targets} targets and its first check ${e.ok ? 'passed' : 'failed'} ${e.result.passed}/${e.result.total}${e.result.defect ? `, filed as ${e.result.defect}` : ''}`;
  else facts = `the person confirmed "${e.label}" (${e.id}); nothing was run`;
  const words = { page: e.result?.page, name: e.result?.name, url: e.result?.url, error: e.result?.error, target: e.result?.target };
  return `[Runner note — from the runner, not the person: ${facts}. Report it, then answer what follows.]\n${untrusted(words)}\n\n${text}`;
}

/**
 * Execute a confirmed proposal through the runner's own actions, with the
 * routes' gates: the switch, the origin, the plan and the locks. The answer
 * is the note the mind reports from; a refusal is part of it, never a throw.
 */
async function execute(p, { space, ent, switches, redact, emit }) {
  const base = { id: p.id, kind: p.kind, label: p.label };
  const started = (name) => emit({ t: 'chat.tool', call: { id: p.id, name, label: p.label, state: 'start' } });
  const landed = (name, summary) => emit({ t: 'chat.tool', call: { id: p.id, name, label: p.label, state: 'done', summary } });
  try {
    if (p.kind === 'scan_page') {
      switches?.demand?.('runner.onboarding');
      const suite = space.suites.get(p.args.suiteId);
      const pg = suite.pages.find((x) => x.id === p.args.pageId);
      if (!pg) throw refuse('That page is gone', 404);
      const origin = originOf(suite);
      if (!space.origins.has(origin)) return { ...base, refused: { refused: 'needs_origin', origin } };
      started('scan_page');
      const r = await cfg.actions.scanPage({ suite, pg, space });
      const result = { page: redact(pg.name), targets: (r.page?.targets ?? []).length, linked: (r.page?.linked ?? []).length, url: maskUrl(r.url) };
      landed('scan_page', `${result.targets} targets, ${result.linked} links`);
      return { ...base, ok: true, result };
    }
    if (p.kind === 'quickstart') {
      switches?.demand?.('runner.onboarding');
      switches?.demand?.('runner.runs');
      const u = normalizeUrl(p.args.url);
      if (!space.origins.has(u.origin)) return { ...base, refused: { refused: 'needs_origin', origin: u.origin } };
      started('quickstart');
      const r = await cfg.actions.quickstart({ u, name: p.args.name, space, ent, switches });
      const o = r.run ?? {};
      const c = r.suite?.cases?.[0] ?? null;
      const run = {
        suiteId: r.suite.id, suite: redact(r.suite.name), caseId: c?.id ?? null, caseName: c ? redact(c.name) : null,
        ok: !!o.ok, passed: o.passed ?? 0, total: o.total ?? 0, step: o.step ?? null,
        error: o.error == null ? null : redact(o.error), target: o.target == null ? null : redact(o.target), defect: o.defect ?? null, at: now(),
      };
      const result = { suiteId: run.suiteId, name: run.suite, url: maskUrl(u.href), targets: r.targets ?? 0, passed: run.passed, total: run.total, error: run.error, target: run.target, defect: run.defect };
      landed('quickstart', `${run.ok ? 'passed' : 'failed'} ${run.passed}/${run.total}`);
      return { ...base, ok: run.ok, run, result };
    }
    return { ...base, refused: { refused: 'error', error: `nothing runs a "${p.kind}" proposal` } };
  } catch (err) {
    const refused = refusalOf(err);
    emit({ t: 'chat.tool', call: { id: p.id, name: p.kind, label: p.label, state: 'error', summary: `refused: ${refused.refused}` } });
    return { ...base, refused };
  }
}

/** The model has stopped answering for good this process: an authentication error is not going to pass on the next turn. */
function switchToMock(reason) {
  if (cfg.llm.mode !== 'claude') return;
  cfg.llm = { ...cfg.llm, mode: 'mock', reason };
  cfg.log.error(`  chat: the model is unavailable (${reason}); the mock mind answers from here on`);
}

/** The turn's work: the proposal, the tools, a mind, the reply. */
async function work(t, { store, space, ent, switches }) {
  const org = space.org;
  const redact = redactorFor(space, cfg.extraRedact ? cfg.extraRedact(space) : undefined);
  const emit = (ev) => cfg.emitTo(org, { ...ev, turn: t.id, conversationId: t.conversationId });

  // ---- 1 · a proposal, confirmed or dropped ----------------------------------------------
  const pending = store.proposalOf(t.conversationId);
  let executed = null;
  if (t.confirm && (!pending || pending.id !== t.confirm)) {
    // A button pressed on a proposal that has expired or was already taken:
    // answered here, in the runner's words, because no mind has anything to add.
    return finish(t, store, space, { text: 'Nothing is waiting to be confirmed — that proposal has expired or was already handled. Ask again if you still want it.', mind: 'runner', model: null, tools: [], runs: [], offers: null, proposal: null, executed: null, error: null });
  }
  if (pending && (t.confirm === pending.id || YES.test(t.text))) {
    store.setProposal(t.conversationId, null);
    executed = await execute(pending, { space, ent, switches, redact, emit });
  } else if (pending && NO.test(t.text)) {
    store.setProposal(t.conversationId, null);
    return finish(t, store, space, { text: `Dropped: ${pending.label}. Nothing was run.`, mind: 'runner', model: null, tools: [], runs: [], offers: null, proposal: null, executed: null, error: null });
  }

  // ---- 2 · the tools ---------------------------------------------------------------------
  let proposal = null;
  const propose = ({ kind, args, label }) => {
    const at = now();
    proposal = { id: newId('pr'), kind, args, label: str(label, 160), at, expiresAt: at + PROPOSAL_TTL_MS };
    store.setProposal(t.conversationId, proposal);
    emit({ t: 'chat.proposal', proposal: publicProposal(proposal) });
    return proposal;
  };
  const onCall = (call) => emit({ t: 'chat.tool', call: { id: call.id, name: call.name, label: call.label, state: call.state, summary: call.summary ?? null } });
  const { tools, byName, calls } = makeTools({ space, ent, switches, org, actions: cfg.actions, redact, propose, onCall });

  // ---- 3 · a mind ------------------------------------------------------------------------
  let text = null;
  let mind = 'mock';
  let model = null;
  let offers = null;
  let note = null;
  const remaining = cfg.budget ? Math.max(0, cfg.budget.max - cfg.budget.used()) : 0;
  if (cfg.llm.mode === 'claude' && cfg.resolver && remaining > 0) {
    const messages = [...store.contextOf(t.conversationId), { role: 'user', content: userTurn(t.text, executed) }];
    const deltas = batcher((chunk) => emit({ t: 'chat.delta', text: chunk }));
    const answer = await cfg.resolver.answer({ messages, tools, onText: deltas.push, maxIterations: Math.min(MAX_ITERATIONS, remaining) });
    deltas.flush();
    if (answer) {
      for (let i = 0; i < answer.iterations; i++) cfg.budget.take();
      store.setContext(t.conversationId, answer.messages);
      mind = 'claude';
      model = answer.model;
      text = answer.refused
        ? 'The model declined to answer that. Ask it another way, or name a defect, a run or a case.'
        : (answer.text || 'The model had nothing to say. Try naming a defect, a run or a case.');
    } else {
      const reason = cfg.resolver.unavailable ?? 'no answer';
      cfg.log.error(`  chat: the model was unavailable (${reason}) for ${org}; answered by rules`);
      if (reason === 'AuthenticationError') switchToMock(reason);
      note = unavailableNote(reason);
    }
  }
  if (text == null) {
    const r = await answerMock({ text: t.text, byName, executed, propose });
    text = note ? `${note} ${r.text}` : r.text;
    offers = Array.isArray(r.offers) && r.offers.length ? r.offers.slice(0, 4).map((o) => ({ label: str(o.label, 80), text: str(o.text, 200) })) : null;
    // The model's view of the conversation is stale now; the next model turn
    // reads the words back instead (contextOf).
    store.forgetContext(t.conversationId);
  }

  // ---- 4 · the reply, kept and told ------------------------------------------------------
  return finish(t, store, space, {
    text: str(redact(text), TEXT_MAX),
    mind,
    model,
    tools: calls.slice(0, TOOLS_KEPT).map(publicCall),
    runs: runsOf(calls, executed).slice(0, RUNS_KEPT),
    offers,
    proposal: publicProposal(proposal),
    executed: publicExecuted(executed),
    error: null,
  });
}
