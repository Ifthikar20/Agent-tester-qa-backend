/**
 * Notifications — an incident, a failed run or a defect, sent somewhere a
 * person will see it.
 *
 * The runner has been telling its own sockets everything, which is to say
 * telling nobody once the tab is closed. A channel is a place to tell
 * instead: a webhook (JSON, signed when the channel has a secret), a Slack
 * incoming webhook, or an email through the operator's relay (GC_SMTP_URL,
 * GC_SMTP_FROM; smtp.js). Each channel names the events it wants:
 *
 *   incident     a monitor's incident opens, or resolves
 *   run_failed   a run fails — a person's or a schedule's
 *   defect       a defect is filed, or reopened
 *
 * Channels are the organisation's (`.ghostclick/<org>/notify.json`), set by
 * its managers. Every word that leaves is redacted against the vault first,
 * like a console line. A send that fails is retried three times with
 * growing pauses and then recorded on the channel with the reason, and a
 * day's sends per organisation are capped, so a flapping monitor cannot
 * turn a channel into a firehose. Nothing here waits: `send` queues, and a
 * run or an incident is never slower for having been told.
 *
 * Pure where it can be: the store, the shaping of a message, the retry are
 * exercised by check-notify.js against receivers it starts itself.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { assertOrg, stateDir } from './org.js';
import { isAddress, sendMail } from './smtp.js';

export const CHANNELS_MAX = 10;
export const NAME_MAX = 60;
export const SENDS_PER_DAY = 300;
export const KINDS = ['webhook', 'slack', 'email'];
export const EVENTS = Object.freeze({
  incident: 'an incident opens or resolves',
  run_failed: 'a run fails',
  defect: 'a defect is filed or reopened',
});
/** The pauses between tries: at once, five seconds, half a minute, two minutes. */
export const RETRY_MS = [0, 5000, 30_000, 120_000];
export const SEND_TIMEOUT_MS = 10_000;

export class NoSuchChannel extends Error {
  constructor(id) { super(`no channel ${id}`); this.name = 'NoSuchChannel'; this.status = 404; }
}
export class BadChannel extends Error {
  constructor(msg) { super(msg); this.name = 'BadChannel'; this.status = 400; }
}

let cfg = {
  log: console,
  /** The operator's relay, or null: email channels then say what is missing. */
  smtp: { url: process.env.GC_SMTP_URL || null, from: process.env.GC_SMTP_FROM || null },
  /** Whether a channel may point at this address (reach.js on a gated runner); null allows all. */
  mayReach: null,
  /** The organisation's redaction, for every word that leaves. */
  redactFor: () => (s) => s,
  /** Delivery, replaceable by a check. */
  fetch: (...a) => globalThis.fetch(...a),
  sendMail,
  retryMs: RETRY_MS,
  clock: Date.now,
};
export function configure(options) { cfg = { ...cfg, ...options }; }
export const smtpConfigured = () => Boolean(cfg.smtp?.url && cfg.smtp?.from);

// ---------------------------------------------------------------- shaping

const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * One event → the words every channel carries: a title, a line, the details.
 * `d` is the caller's data, already redacted.
 */
export function shape(event, d = {}) {
  const lines = [];
  switch (event) {
    case 'incident': {
      const resolved = d.status === 'resolved';
      lines.push(`Rule: ${cut(d.ruleText, 160)}`);
      if (d.severity) lines.push(`Severity: ${d.severity}`);
      if (d.page) lines.push(`Page: ${d.page}`);
      if (d.id) lines.push(`Incident ${d.id}`);
      return {
        title: `${resolved ? 'Resolved' : 'Incident'}: ${cut(d.label ?? 'a monitored element', 80)}`,
        text: resolved ? `The element is back within its rule${d.by ? ` (${d.by})` : ''}.` : cut(d.headline ?? 'changed against its rule', 300),
        lines, url: d.url ?? null,
      };
    }
    case 'run_failed': {
      if (d.step != null) lines.push(`Stopped at step ${Number(d.step) + 1}${d.doing ? ` — ${cut(d.doing, 80)}` : ''}`);
      if (d.defect) lines.push(`Defect ${d.defect}`);
      if (d.scheduled) lines.push('A scheduled run');
      if (d.page) lines.push(`Page: ${d.page}`);
      return {
        title: `Run failed: ${cut(d.suite ?? 'a run', 60)}${d.caseName ? ` · ${cut(d.caseName, 60)}` : ''}`,
        text: `${d.passed ?? 0}/${d.total ?? 0} steps passed${d.error ? ` — ${cut(d.error, 240)}` : ''}`,
        lines, url: d.url ?? null,
      };
    }
    case 'defect': {
      if (d.suite) lines.push(`Suite: ${cut(d.suite, 60)}`);
      if (d.severity) lines.push(`Severity: ${d.severity}`);
      return { title: `Defect ${d.kind === 'reopened' ? 'reopened' : 'filed'}: ${d.id ?? ''}`.trim(), text: cut(d.title ?? '', 240), lines, url: d.url ?? null };
    }
    default: return { title: cut(event, 60), text: cut(d.text ?? '', 240), lines, url: d.url ?? null };
  }
}

/** The words as one plain-text body, for email and for the log. */
export const asText = (m) => [m.text, ...m.lines, m.url ? `Open: ${m.url}` : null].filter(Boolean).join('\n');

// ------------------------------------------------------------------ store

const now = () => cfg.clock();
const newId = () => `ch-${crypto.randomBytes(5).toString('hex')}`;
const str = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

/** A channel as a caller sees it: its secret never, its address as a host, its counts. */
export function publicChannel(c) {
  const { secret, ...rest } = c;
  let where = c.to ?? '';
  if (c.url) { try { where = new URL(c.url).host; } catch { where = 'an address'; } }
  return { ...rest, url: undefined, where, signed: Boolean(secret) };
}

function checkTarget(kind, { url, to }) {
  if (kind === 'email') {
    const list = String(to ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!list.length) throw new BadChannel('an email channel needs an address');
    for (const a of list) if (!isAddress(a)) throw new BadChannel(`${a} is not an email address`);
    if (list.length > 5) throw new BadChannel('at most five addresses on one channel');
    return { to: list.join(', ') };
  }
  let u;
  try { u = new URL(String(url ?? '')); } catch { throw new BadChannel(`a ${kind} channel needs an https:// address`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new BadChannel('the address must be http:// or https://');
  if (kind === 'slack' && !/hooks\.slack\.com$/.test(u.hostname) && !/\/services\//.test(u.pathname)) throw new BadChannel('a Slack channel takes an incoming webhook address (hooks.slack.com/services/…)');
  return { url: u.href };
}

class ChannelBook {
  constructor(org) {
    this.org = org;
    this.dir = stateDir(org);
    this.file = join(this.dir, 'notify.json');
    this.channels = new Map();
    this.day = { on: dayOf(now()), sent: 0 };
    this.load();
  }
  load() {
    if (!existsSync(this.file)) return;
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const c of Array.isArray(s.channels) ? s.channels : []) if (c && c.id && KINDS.includes(c.kind)) this.channels.set(c.id, c);
      if (s.day && s.day.on === dayOf(now())) this.day = s.day;
    } catch (err) {
      const bad = `${this.file}.corrupt-${now()}`;
      try { renameSync(this.file, bad); } catch { /* nothing to move */ }
      cfg.log.error(`  notify: ${this.org}'s notify.json did not parse (${err.message}); moved to ${bad}`);
    }
  }
  writeNow() {
    try {
      mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: now(), day: this.day, channels: [...this.channels.values()] }, null, 2));
      renameSync(tmp, this.file);
    } catch (err) { cfg.log.error(`  notify: could not write ${this.file}: ${err.message}`); }
  }
  list() { return [...this.channels.values()].sort((a, b) => a.createdAt - b.createdAt).map(publicChannel); }
  get(id) { const c = this.channels.get(String(id)); if (!c) throw new NoSuchChannel(id); return c; }
  create({ kind, name = '', url, to, secret = '', events } = {}) {
    if (!KINDS.includes(kind)) throw new BadChannel(`kind must be one of ${KINDS.join(', ')}`);
    if (this.channels.size >= CHANNELS_MAX) throw new BadChannel(`at most ${CHANNELS_MAX} channels`);
    const wanted = Array.isArray(events) ? events.filter((e) => e in EVENTS) : Object.keys(EVENTS);
    if (!wanted.length) throw new BadChannel('a channel wants at least one event');
    const target = checkTarget(kind, { url, to });
    const c = {
      id: newId(), kind, name: str(name, NAME_MAX) || { webhook: 'Webhook', slack: 'Slack', email: 'Email' }[kind],
      ...target, ...(kind === 'webhook' && secret ? { secret: str(secret, 200) } : {}),
      events: wanted, enabled: true, createdAt: now(), sent: 0, failed: 0, lastSentAt: null, lastError: null,
    };
    this.channels.set(c.id, c);
    this.writeNow();
    return publicChannel(c);
  }
  update(id, { name, events, enabled, url, to, secret } = {}) {
    const c = this.get(id);
    if (name !== undefined) c.name = str(name, NAME_MAX) || c.name;
    if (events !== undefined) { const w = Array.isArray(events) ? events.filter((e) => e in EVENTS) : []; if (!w.length) throw new BadChannel('a channel wants at least one event'); c.events = w; }
    if (enabled !== undefined) c.enabled = enabled === true;
    if (url !== undefined || to !== undefined) Object.assign(c, checkTarget(c.kind, { url: url ?? c.url, to: to ?? c.to }));
    if (secret !== undefined && c.kind === 'webhook') { if (secret) c.secret = str(secret, 200); else delete c.secret; }
    this.writeNow();
    return publicChannel(c);
  }
  remove(id) { const c = this.get(id); this.channels.delete(c.id); this.writeNow(); return publicChannel(c); }
  /** The channels an event goes to. */
  wanting(event) { return [...this.channels.values()].filter((c) => c.enabled && c.events.includes(event)); }
  /** One more send today, or false when the day's cap is reached. */
  countSend() {
    const today = dayOf(now());
    if (this.day.on !== today) this.day = { on: today, sent: 0 };
    if (this.day.sent >= SENDS_PER_DAY) return false;
    this.day.sent++;
    return true;
  }
  noteResult(c, ok, error = null) {
    if (ok) { c.sent++; c.lastSentAt = now(); c.lastError = null; } else { c.failed++; c.lastError = str(error, 200); }
    this.writeNow();
  }
}

const books = new Map();
export function forOrg(org) {
  assertOrg(org);
  let b = books.get(org);
  if (!b) { b = new ChannelBook(org); books.set(org, b); }
  return b;
}

// --------------------------------------------------------------- delivery

const sign = (secret, body) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

/** One attempt at one channel; throws with the reason. */
export async function deliver(channel, event, message, { org, at = now(), data = {} } = {}) {
  if (cfg.mayReach && channel.url) {
    const why = await cfg.mayReach(channel.url);
    if (why) throw new Error(`the address is out of reach: ${why}`);
  }
  if (channel.kind === 'email') {
    if (!smtpConfigured()) throw new Error('no mail relay is configured on this runner (GC_SMTP_URL and GC_SMTP_FROM)');
    await cfg.sendMail({ url: cfg.smtp.url, from: cfg.smtp.from, to: channel.to, subject: `[ghostclick] ${message.title}`, text: asText(message) });
    return;
  }
  const body = channel.kind === 'slack'
    ? JSON.stringify({ text: `*${message.title}*\n${asText(message)}` })
    : JSON.stringify({ event, at, org, title: message.title, text: message.text, lines: message.lines, url: message.url, data });
  const headers = { 'content-type': 'application/json', 'user-agent': 'ghostclick-notify', 'x-ghostclick-event': event };
  if (channel.kind === 'webhook' && channel.secret) headers['x-ghostclick-signature'] = sign(channel.secret, body);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS);
  try {
    const r = await cfg.fetch(channel.url, { method: 'POST', headers, body, signal: ctl.signal, redirect: 'manual' });
    if (!r.ok) throw new Error(`${r.status} from ${new URL(channel.url).host}`);
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`no answer from ${new URL(channel.url).host} within ${SEND_TIMEOUT_MS / 1000} s`);
    throw err;
  } finally { clearTimeout(timer); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inFlight = new Set();

/** Tries, with the pauses between them; the last reason is the channel's when all fail. */
async function attempt(book, channel, event, message, extra) {
  let last = null;
  for (let i = 0; i < cfg.retryMs.length; i++) {
    if (cfg.retryMs[i]) await sleep(cfg.retryMs[i]);
    try {
      await deliver(channel, event, message, extra);
      book.noteResult(channel, true);
      return { ok: true, tries: i + 1 };
    } catch (err) { last = err; }
  }
  book.noteResult(channel, false, last?.message ?? 'failed');
  cfg.log.error(`  notify: ${book.org} → ${channel.name}: ${last?.message ?? 'failed'}`);
  return { ok: false, tries: cfg.retryMs.length, error: last?.message ?? 'failed' };
}

/**
 * Tell the organisation's channels about an event. Queues and returns at
 * once; the promise it hands back is for a check to await. Words are
 * redacted here, once, before any channel sees them.
 */
export function send(org, event, data = {}) {
  const book = forOrg(org);
  const channels = book.wanting(event);
  if (!channels.length) return Promise.resolve([]);
  const redact = cfg.redactFor(org);
  const clean = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === 'string' ? redact(v) : v]));
  const message = shape(event, clean);
  const at = now();
  const jobs = channels.map(async (c) => {
    if (!book.countSend()) return { channel: c.id, ok: false, error: `the day's ${SENDS_PER_DAY} sends are spent` };
    const p = attempt(book, c, event, message, { org, at, data: clean });
    inFlight.add(p);
    try { return { channel: c.id, ...(await p) }; } finally { inFlight.delete(p); }
  });
  const all = Promise.all(jobs);
  all.catch(() => {});
  return all;
}

/** A test message to one channel, awaited: the settings page's Test button. */
export async function test(org, id) {
  const book = forOrg(org);
  const c = book.get(id);
  const message = shape('test', { text: `A test from ghostclick for "${c.name}". If you can read this, the channel works.` });
  message.title = 'ghostclick: a test';
  const saved = cfg.retryMs;
  cfg.retryMs = [0];
  try { return await attempt(book, c, 'test', message, { org, at: now(), data: {} }); }
  finally { cfg.retryMs = saved; }
}

/** Every send still in flight, for the moment before the process exits. */
export const drain = () => Promise.allSettled([...inFlight]);
