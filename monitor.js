/**
 * Agentic monitoring — the engine, one per organisation, and its store.
 *
 * A monitor is an element on a page and a rule about it — or the whole page
 * (`:page`) and a rule about its layout or its words, judged by the diff of
 * two page snapshots rather than by one element's numbers. The page agent
 * (monitor-page.js) reports a snapshot whenever the element's change
 * signature changes; this funnels those reports through a debounce, evaluates
 * them deterministically (monitor-evaluate.js), insists a new state is
 * CONFIRMED — by a second report that agrees or by a fresh measurement half a
 * second later, which is what stops an animation frame opening an incident —
 * and then opens, updates and resolves incidents with before/after clips and
 * a verdict. The mock verdict is written at once; Claude's, when there is a
 * key, replaces it later (monitor-resolver.js), rate-limited to one question
 * per monitor per minute and to a daily budget for the process.
 *
 * One engine PER ORGANISATION, in `.ghostclick/<org>/monitors.json` and
 * `.ghostclick/<org>/monitor-shots/` (docs/AUTH.md §10), the same shape as
 * runs.js: read once, kept in memory, written whole. Every event goes to that
 * organisation's sockets with `emitTo`, never to whoever happens to be driving
 * — monitors are the organisation's data and outlive the browser changing
 * hands. The engine is `attach`ed to the page agent while that organisation's
 * page is on the browser and `detach`ed when it is not; monitors re-arm
 * through the agent's boot handshake the next time their document is open.
 *
 * Text that came from a page — a snapshot's text, a label, a fingerprint —
 * is redacted against the organisation's vault before it is kept, sent or
 * shown to a model, the way the page's console lines are.
 *
 * Ported from the monitoring proof of concept's server/engine.js and
 * server/store.js.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import crypto from 'node:crypto';
import { stateDir } from './org.js';
import * as secrets from './secrets.js';
import { redactWith } from './redact.js';
import { evaluate, diff, summarize, changedKeys, isPageSnapshot } from './monitor-evaluate.js';
import { compileMock, judgeMock, compactSnapshot, sameDoc, violationKey, RULE_MAX, LABEL_MAX, SELECTOR_MAX, PAGE_SELECTOR } from './monitor-rules.js';

export { RULE_MAX, LABEL_MAX, SELECTOR_MAX, PAGE_SELECTOR };
export const MONITORS_MAX = 50;
export const INCIDENTS_MAX = 200;
const FINGERPRINT_MAX = 4096;
const SPEC_ERROR_MAX = 300;
/** How much of an excerpt's markup is kept, per monitor and per incident; the model is shown up to the page's own cap. */
const EXCERPT_KEEP = 4000;
const JUDGE_MIN_INTERVAL_MS = 60000;
const HEARTBEAT_MS = 2500;
/**
 * How long a freshly (re)armed monitor waits before "missing" is believed.
 * The page arms its monitors at DOMContentLoaded, and a hero that a framework
 * renders a second later is not missing, it is late — so right after a visit
 * the element gets this long to turn up before an incident opens, where a
 * change on a page that was already open is confirmed in half a second.
 */
export const ARM_GRACE_MS = 6000;
/**
 * How long a new monitor on the whole page watches the page nobody touched
 * before its baseline is settled: the blocks that changed meanwhile — a
 * ticker, a clock, a carousel — are the page's own churn, learned into the
 * spec's `ignore` and never reported. Three readings, half a second apart.
 */
export const PAGE_LEARN_MS = 500;
export const PAGE_LEARN_READS = 3;
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
/** A shot's name, as the gated route accepts it — and nothing with a slash or a dot in it. */
export const SHOT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,120}\.png$/;

// ---- the process's one configuration -------------------------------------------
let cfg = {
  emitTo: () => {},
  log: console,
  llm: { mode: 'mock', model: null, key: { have: false, from: null } },
  resolver: null,
  budget: null,
  isIdle: () => true,
  /** One question per monitor per this long; a check sets it to zero. */
  judgeIntervalMs: JUDGE_MIN_INTERVAL_MS,
  /** Somewhere to tell (notify.js send): an incident opening or resolving goes there too. Null tells nobody. */
  notify: null,
  /**
   * The defect registry (defects.js incident): an incident is filed as a
   * defect when it opens and closed when it resolves. (org, event, { incident,
   * monitor, by }) → the defect's id, or null. Null files nothing.
   */
  defects: null,
};
/**
 * Given once by server.js: how to reach an organisation's sockets, which mind
 * compiles and judges (`llm` is mutable — a rejected key turns the process to
 * mock), the resolver and its budget, and whether the page is idle (a run or a
 * recording holds it otherwise, and a screenshot must not scroll under them).
 */
export function configure(options) { cfg = { ...cfg, ...options }; }
export const llmState = () => cfg.llm;
export const budgetState = () => ({ used: cfg.budget ? cfg.budget.used() : 0, max: cfg.budget ? cfg.budget.max : 0 });

export class NoSuchMonitor extends Error {
  constructor(id) { super(`No monitor ${id}`); this.name = 'NoSuchMonitor'; }
}
export class NoSuchIncident extends Error {
  constructor(id) { super(`No incident ${id}`); this.name = 'NoSuchIncident'; }
}
const refuse = (msg, status) => { const e = new Error(msg); e.status = status; return e; };
const newId = (prefix) => prefix + '_' + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
const now = () => Date.now();
const newRuntime = () => ({ debounce: null, pending: null, candidate: null, confirm: null, confirming: false, lastJudgeAt: 0, judgeTimer: null, judgeInFlight: false, tickTimer: null, tickPending: null, armedAt: 0 });
const clearRuntime = (rt) => { if (!rt) return; clearTimeout(rt.debounce); clearTimeout(rt.confirm); clearTimeout(rt.judgeTimer); clearTimeout(rt.tickTimer); rt.debounce = rt.confirm = rt.judgeTimer = rt.tickTimer = null; rt.candidate = null; rt.pending = null; rt.tickPending = null; };
const str = (v, max) => String(v ?? '').trim().slice(0, max);
/** Whether a failing check is a judgment clause's proxy (monitor-rules.js normalizeSpec): it says the element changed, not that the rule broke. */
const isJudgmentCheck = (spec, id) => !!(spec && Array.isArray(spec.checks) && spec.checks.find((c) => c.id === id && c.judgment));
/** An excerpt as it is kept: the markup cut at a tag boundary to EXCERPT_KEEP. */
function keepExcerpt(x) {
  if (!x) return null;
  let html = String(x.html ?? '');
  if (html.length > EXCERPT_KEEP) {
    const cut = html.lastIndexOf('>', EXCERPT_KEEP);
    html = (cut > EXCERPT_KEEP / 2 ? html.slice(0, cut + 1) : html.slice(0, EXCERPT_KEEP)) + '…';
  }
  return { ...x, html };
}

class MonitorEngine {
  constructor(org) {
    this.org = org;
    this.dir = stateDir(org);
    this.file = join(this.dir, 'monitors.json');
    this.shotsDir = join(this.dir, 'monitor-shots');
    this.monitors = new Map();
    this.incidents = new Map();
    this.rt = new Map();
    this.agent = null;
    this.heartbeat = null;
    this.beating = false;
    this.saveTimer = null;
    this.load();
  }

  // ---- the store ---------------------------------------------------------------------
  load() {
    if (!existsSync(this.file)) return;
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const m of Array.isArray(s.monitors) ? s.monitors : []) {
        if (!m || !m.id) continue;
        if (!m.stats) m.stats = { ticks: 0, reports: 0, incidents: 0, judgeCalls: 0, visits: 0 };
        // Written before visits were counted: they start now.
        if (typeof m.stats.visits !== 'number') m.stats.visits = 0;
        if (!('lastVisitAt' in m)) m.lastVisitAt = null;
        this.monitors.set(m.id, m);
        this.rt.set(m.id, newRuntime());
      }
      for (const i of Array.isArray(s.incidents) ? s.incidents : []) if (i && i.id) this.incidents.set(i.id, i);
    } catch (err) {
      // A file that does not parse is moved aside rather than overwritten:
      // whatever is in it may still be worth reading by hand.
      const bad = `${this.file}.corrupt-${now()}`;
      try { renameSync(this.file, bad); } catch { /* nothing to move */ }
      cfg.log.error(`  monitoring: ${this.org}'s monitors.json did not parse (${err.message}); moved to ${bad}`);
    }
  }
  writeNow() {
    try {
      mkdirSync(this.dir, { recursive: true });
      const incidents = [...this.incidents.values()].sort((a, b) => b.openedAt - a.openedAt);
      const body = JSON.stringify({ version: 1, savedAt: now(), monitors: [...this.monitors.values()], incidents }, null, 2);
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, body);
      renameSync(tmp, this.file);
    } catch (err) {
      cfg.log.error(`  monitoring: could not write ${this.file}: ${err.message}`);
    }
  }
  /** Debounced half a second: a burst of ticks is one write. */
  persist() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.writeNow(); }, 500);
    this.saveTimer.unref?.();
  }
  flush() {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.writeNow();
  }
  saveShot(name, png) {
    if (!png) return null;
    const safe = `${String(name).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 116)}.png`;
    try {
      mkdirSync(this.shotsDir, { recursive: true });
      writeFileSync(join(this.shotsDir, safe), png);
      return safe;
    } catch (err) {
      cfg.log.error(`  monitoring: could not write ${safe}: ${err.message}`);
      return null;
    }
  }
  /** The absolute path of a shot this organisation owns, or null — the route's one question. */
  shotPath(name) {
    if (!name || !SHOT_NAME.test(name)) return null;
    const root = resolve(this.shotsDir);
    const p = resolve(root, name);
    if (!p.startsWith(root + sep) || !existsSync(p)) return null;
    return p;
  }
  deleteShot(name) {
    const p = this.shotPath(name);
    if (p) { try { unlinkSync(p); } catch { /* already gone */ } }
  }
  readShot(name) {
    const p = this.shotPath(name);
    if (!p) return null;
    try { return readFileSync(p); } catch { return null; }
  }

  // ---- redaction --------------------------------------------------------------------
  redact(text) { return redactWith(secrets.forOrg(this.org), text); }
  /** A snapshot's text, redacted in place — it is a fresh object from the page. */
  cleanSnapshot(s) {
    if (s && typeof s.text === 'string') s.text = this.redact(s.text);
    if (s && typeof s.title === 'string') s.title = this.redact(s.title);
    // A page's blocks carry the page's words, block by block.
    if (s && Array.isArray(s.blocks)) for (const b of s.blocks) if (b && typeof b.text === 'string') b.text = this.redact(b.text);
    return s;
  }
  /** An excerpt (core.js excerptOf), redacted string by string — markup and one-liners are page content too. */
  cleanExcerpt(x) {
    if (!x || typeof x !== 'object') return null;
    const line = (v) => this.redact(String(v ?? '')).slice(0, 200);
    return {
      html: this.redact(String(x.html ?? '')),
      path: Array.isArray(x.path) ? x.path.slice(0, 12).map(line) : [],
      siblings: Array.isArray(x.siblings) ? x.siblings.slice(0, 8).map(line) : [],
      children: Array.isArray(x.children) ? x.children.slice(0, 8).map(line) : [],
      childCount: Number.isFinite(x.childCount) ? x.childCount : null,
    };
  }

  // ---- lifecycle ----------------------------------------------------------------------
  /** This organisation's page is on the browser: measure, arm and watch through `agent`. */
  attach(agent) {
    this.agent = agent;
    this.startHeartbeat();
  }
  /** Its page is gone (a handover, a shutdown): every timer off, nothing in flight touches a page. */
  detach() {
    this.stopHeartbeat();
    for (const rt of this.rt.values()) clearRuntime(rt);
    this.agent = null;
    this.flush();
  }
  emit(ev) { cfg.emitTo(this.org, ev); }
  say(level, msg) { this.emit({ t: 'log', level, msg }); }
  live() { return this.agent && this.agent.alive() ? this.agent : null; }
  /**
   * The incident, into the defect registry (cfg.defects) — filed as it opens,
   * rewritten as it changes, closed as it resolves, and every open one of a
   * monitor closed when the monitor goes. The id comes back onto the incident
   * so a card and a notification can name the number. Failing at it must not
   * cost the incident: said in the log, and the incident stands.
   */
  fileDefect(event, inc, m, by = null) {
    if (!cfg.defects) return inc?.defect ?? null;
    try {
      const id = cfg.defects(this.org, event, { incident: inc, monitor: m, by }) ?? null;
      if (inc && id) inc.defect = id;
      return id;
    } catch (err) {
      cfg.log.error(`  monitoring: could not file the defect: ${err.message}`);
      return inc?.defect ?? null;
    }
  }

  // ---- listings ------------------------------------------------------------------------
  status() {
    return {
      counts: { monitors: this.monitors.size, open: [...this.incidents.values()].filter((i) => i.status !== 'resolved').length },
    };
  }
  onPage(m) {
    const url = this.live()?.url();
    return !!url && sameDoc(m.url, url);
  }
  publicMonitor(m) {
    return { ...m, baseline: compactSnapshot(m.baseline), last: compactSnapshot(m.last), onPage: this.onPage(m), metrics: summarize(m.last || m.baseline) };
  }
  /**
   * Whether a monitor is a project's: the suite it was made from, or — made
   * with no project chosen — the suite whose origin its page is on. The
   * project is { id, origin }; no project means every monitor.
   */
  belongs(m, project) {
    if (!project) return true;
    if (m.suiteId) return m.suiteId === project.id;
    let origin = null;
    try { origin = new URL(m.url).origin; } catch { /* not a URL */ }
    return !!project.origin && origin === project.origin;
  }
  list(project = null) {
    return [...this.monitors.values()].filter((m) => this.belongs(m, project))
      .sort((a, b) => b.createdAt - a.createdAt).map((m) => this.publicMonitor(m));
  }
  get(id) {
    const m = this.monitors.get(id);
    if (!m) throw new NoSuchMonitor(id);
    return m;
  }
  listIncidents(status, project = null) {
    const mine = project ? new Set([...this.monitors.values()].filter((m) => this.belongs(m, project)).map((m) => m.id)) : null;
    return [...this.incidents.values()]
      // `open` is everything unresolved: an incident still being judged is open in every sense a page counts.
      .filter((i) => (!status || (status === 'open' ? i.status !== 'resolved' : i.status === status)) && (!mine || mine.has(i.monitorId)))
      .sort((a, b) => b.openedAt - a.openedAt);
  }
  incident(id) {
    const inc = this.incidents.get(id);
    if (!inc) throw new NoSuchIncident(id);
    return inc;
  }
  /** What a document arms: the monitors of that page, minus the paused ones, in the shape the agent takes. */
  monitorsForPage(href) {
    return [...this.monitors.values()]
      .filter((m) => m.state !== 'paused' && sameDoc(m.url, href))
      .map((m) => ({ id: m.id, selector: m.selector, fingerprint: m.fingerprint || null, label: m.label }));
  }
  /**
   * A new document of `href` just armed these monitors: the page was hit
   * again — by a run's `goto`, by Open, by a reload — and each of them is
   * about to be measured against its rule. Counted, so a card can say how
   * many times its check has run and when it last did; the verdict follows
   * as the tick the arming report produces.
   */
  visited(href, ids) {
    const at = now();
    const seen = [];
    for (const id of ids || []) {
      const m = this.monitors.get(id);
      if (!m) continue;
      if (!m.stats) m.stats = { ticks: 0, reports: 0, incidents: 0, judgeCalls: 0, visits: 0 };
      m.stats.visits = (m.stats.visits || 0) + 1;
      m.lastVisitAt = at;
      seen.push(m);
    }
    if (!seen.length) return;
    this.persist();
    for (const m of seen) this.emit({ t: 'monitor.changed', monitor: this.publicMonitor(m) });
    let where = href;
    try { where = new URL(href).pathname || href; } catch { /* not a URL */ }
    this.say('info', `${where} opened: checking ${seen.length === 1 ? seen[0].label : `${seen.length} monitors`}`);
  }

  // ---- monitors ------------------------------------------------------------------------
  async create({ selector, fingerprint, label, ruleText, tag, suiteId } = {}) {
    selector = str(selector, SELECTOR_MAX);
    ruleText = str(ruleText, RULE_MAX);
    if (!selector || !ruleText) throw refuse('selector and ruleText are required', 400);
    // The project this monitor was made from, when it was made from one. The
    // server has checked the suite is this organisation's; here it is a name.
    suiteId = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(String(suiteId ?? '')) ? String(suiteId) : null;
    if (fingerprint != null && (typeof fingerprint !== 'object' || JSON.stringify(fingerprint).length > FINGERPRINT_MAX)) fingerprint = null;
    if (this.monitors.size >= MONITORS_MAX) throw refuse(`This organisation already has ${MONITORS_MAX} monitors — delete one first`, 409);
    const agent = this.live();
    const url = agent?.url();
    if (!agent || !url) throw refuse('Nothing is open yet — open a URL first', 409);
    // The whole page: no fingerprint (there is nothing to find again), and
    // the baseline is settled only after the page has been watched a moment
    // — what changed while nobody touched it is what the page does on its own.
    const isPage = selector === PAGE_SELECTOR;
    if (isPage) fingerprint = null;
    const base = await agent.measure({ selector, fingerprint });
    if (!base || !base.exists) throw refuse(isPage ? 'The page could not be measured' : `No element matches "${selector}" on the current page`, 422);
    const volatile = new Set();
    if (isPage && isPageSnapshot(base)) {
      for (let i = 0; i < PAGE_LEARN_READS; i++) {
        await sleep(PAGE_LEARN_MS);
        const again = await agent.measure({ selector, fingerprint: null }).catch(() => null);
        if (isPageSnapshot(again)) for (const k of changedKeys(base, again)) volatile.add(k);
      }
    }
    this.cleanSnapshot(base);
    if (fingerprint && typeof fingerprint.text === 'string') fingerprint = { ...fingerprint, text: this.redact(fingerprint.text) };
    // The element's markup, for the compilers: what is really there, with the
    // code taken out before it left the page (core.js excerptOf).
    const excerpt = this.cleanExcerpt(await agent.excerpt({ selector, fingerprint }).catch(() => null));
    const m = {
      id: newId('m'), label: this.redact(str(label, LABEL_MAX) || (isPage ? 'Whole page' : selector)).slice(0, LABEL_MAX), url, suiteId,
      selector, fingerprint: fingerprint || null, tag: str(tag, 40) || base.tag || null, ruleText,
      spec: null, specSource: null, specError: null, baseline: base, baselineShot: null, baselineExcerpt: keepExcerpt(excerpt), last: base,
      state: 'ok', openIncidentId: null, createdAt: now(), lastTickAt: null, lastVisitAt: null,
      stats: { ticks: 0, reports: 0, incidents: 0, judgeCalls: 0, visits: 0 },
    };
    const element = { tag: m.tag, selector, label: m.label, textPreview: (base.text || '').slice(0, 120), excerpt };
    m.spec = compileMock({ ruleText: m.ruleText, element, baseline: base });
    // A page rule is the diff's to answer, not a model's to compile: the mock's spec is final.
    if (m.spec.kind === 'page') { m.spec.ignore = [...volatile]; m.specSource = 'mock'; }
    else m.specSource = cfg.llm.mode === 'claude' && cfg.resolver ? 'provisional' : 'mock';
    this.monitors.set(m.id, m);
    this.rt.set(m.id, newRuntime());
    const shot = await agent.screenshotElement(m, { mayScroll: cfg.isIdle() }).catch(() => null);
    if (shot) m.baselineShot = this.saveShot(`${m.id}-baseline`, shot.png);
    this.persist();
    this.emit({ t: 'monitor.changed', monitor: this.publicMonitor(m) });
    const learned = m.spec.kind === 'page' ? ` (${base.counts?.blocks ?? 0} blocks${volatile.size ? `, ${volatile.size} that change on their own ignored` : ''})` : '';
    this.say('info', `watching ${m.label}: ${m.spec.checks.map((c) => `${c.metric} ${c.op}${c.value == null ? '' : ` ${c.value}`}`).join(', ')}${learned}`);
    await agent.arm(m).catch(() => null);
    if (m.specSource === 'provisional') this.compileAsync(m, element);
    return m;
  }

  /** Claude's spec, when it lands, replacing the mock's — or the mock's, kept, with why. */
  async compileAsync(m, element) {
    let spec = null;
    let why = null;
    if (!cfg.resolver || cfg.llm.mode !== 'claude') why = 'no model';
    else if (cfg.budget && !cfg.budget.take()) why = 'daily AI budget spent';
    else {
      spec = await cfg.resolver.compile({ ruleText: m.ruleText, element, baseline: m.baseline });
      if (!spec) why = String(cfg.resolver.unavailable || 'unavailable');
    }
    if (!this.monitors.has(m.id)) return;
    if (spec) {
      m.spec = spec; m.specSource = 'claude'; m.specError = null;
      const judged = spec.clauses.filter((c) => c.outcome === 'judgment').map((c) => `"${c.text}"`);
      const lost = spec.clauses.filter((c) => c.outcome === 'not_understood').map((c) => `"${c.text}"`);
      this.say('info', `rule compiled by Claude for ${m.label}: ${spec.checks.map((c) => `${c.metric} ${c.op}${c.value == null ? '' : ` ${c.value}`}`).join(', ')}${judged.length ? `; judged on change: ${judged.join(', ')}` : ''}${lost.length ? `; not understood: ${lost.join(', ')}` : ''}`);
      // Said on its own, before the card mutates: the checks a person approved
      // in the preview were the mock's, and these are not the same checks.
      this.emit({ t: 'monitor.compiled', monitorId: m.id, source: 'claude', clauses: spec.clauses, checks: spec.checks, summary: spec.summary });
    } else {
      m.specSource = 'mock';
      m.specError = why.slice(0, SPEC_ERROR_MAX);
      if (why === 'AuthenticationError') this.switchToMock('Claude rejected the runner’s credentials; rules are compiled and incidents judged by the mock from here on');
      else this.say('warn', `rule compilation fell back to the mock compiler for ${m.label}: ${m.specError}`);
    }
    this.persist();
    this.emit({ t: 'monitor.changed', monitor: this.publicMonitor(m) });
    if (m.last) this.tick(m, m.last, 'recompiled');
  }
  switchToMock(reason) {
    if (cfg.llm.mode === 'mock') return;
    cfg.llm.mode = 'mock';
    cfg.llm.model = null;
    cfg.log.error(`  monitoring: ${reason}`);
    this.say('warn', reason);
  }

  async remove(id) {
    const m = this.get(id);
    clearRuntime(this.rt.get(id));
    // Its open defects close with it, saying why (defects.js): a rule nobody watches any more is not a standing failure.
    this.fileDefect('removed', null, m);
    // Its incidents go with it, clips included. They were evidence about a
    // rule nobody watches any more, and a page that reports on what is set
    // should not fill up with the history of what is not.
    for (const inc of [...this.incidents.values()]) {
      if (inc.monitorId !== id) continue;
      this.incidents.delete(inc.id);
      this.deleteShot(inc.after?.screenshot);
    }
    this.monitors.delete(id);
    this.rt.delete(id);
    this.deleteShot(m.baselineShot);
    await this.live()?.disarm(id);
    this.persist();
    this.emit({ t: 'monitor.gone', id });
    return true;
  }
  async pause(id) {
    const m = this.get(id);
    if (m.state === 'paused') return m;
    const rt = this.rt.get(id);
    if (rt) { clearTimeout(rt.debounce); clearTimeout(rt.confirm); rt.debounce = rt.confirm = null; rt.candidate = null; rt.pending = null; }
    m.pausedFrom = m.state;
    m.state = 'paused';
    await this.live()?.disarm(id);
    this.persist();
    this.emit({ t: 'monitor.changed', monitor: this.publicMonitor(m) });
    return m;
  }
  async resume(id) {
    const m = this.get(id);
    if (m.state !== 'paused') return m;
    m.state = m.openIncidentId ? (m.pausedFrom || 'violated') : 'ok';
    delete m.pausedFrom;
    if (this.onPage(m)) await this.live()?.arm(m);
    this.persist();
    this.emit({ t: 'monitor.changed', monitor: this.publicMonitor(m) });
    return m;
  }

  // ---- the funnel ----------------------------------------------------------------------
  /** A report from the page: { monitorId, snapshot, reason, selectorNew, … }. */
  ingest(r) {
    if (!r || !r.monitorId || !r.snapshot) return;
    const m = this.monitors.get(r.monitorId);
    if (!m || m.state === 'paused') return;
    let rt = this.rt.get(m.id);
    if (!rt) { rt = newRuntime(); this.rt.set(m.id, rt); }
    m.stats.reports++;
    this.cleanSnapshot(r.snapshot);
    // The page (re)armed this monitor: a new document, a route change, a
    // resume. What is missing right now may only be late (ARM_GRACE_MS).
    if (r.reason === 'rearmed') rt.armedAt = now();
    if (r.selectorNew && r.selectorNew !== m.selector && String(r.selectorNew).length <= SELECTOR_MAX) {
      // The selector stopped matching and the fingerprint found the element
      // again: the monitor heals its selector rather than reporting it missing.
      this.say('info', `${m.label}: selector healed, ${m.selector} → ${r.selectorNew}`);
      m.selector = r.selectorNew;
      this.persist();
      this.emit({ t: 'monitor.changed', monitor: this.publicMonitor(m) });
    }
    rt.pending = { snapshot: r.snapshot, reason: r.reason || 'report' };
    clearTimeout(rt.debounce);
    rt.debounce = setTimeout(() => {
      rt.debounce = null;
      const p = rt.pending; rt.pending = null;
      if (p && this.monitors.has(m.id) && m.state !== 'paused') this.tick(m, p.snapshot, p.reason);
    }, 300);
  }
  tick(m, snap, reason) {
    const rt = this.rt.get(m.id);
    if (!rt) return;
    const res = evaluate(m.spec, m.baseline, snap);
    m.last = snap; m.lastTickAt = now(); m.stats.ticks++;
    this.emitTick(m, res);
    const desired = res.missing ? 'missing' : res.ok ? 'ok' : 'violated';
    if (desired === m.state) { rt.candidate = null; clearTimeout(rt.confirm); rt.confirm = null; return; }
    // Acknowledged (manually resolved) monitors stay quiet while the same checks keep failing.
    if (m.state === 'acknowledged' && desired !== 'ok' && violationKey(res) === m.ackKey) { rt.candidate = null; clearTimeout(rt.confirm); rt.confirm = null; return; }
    // Missing just after arming is "not yet" (any change, on a whole page), and neither a second report
    // that agrees nor the half-second re-measure gets to decide it; only the
    // measurement at the end of the grace does. Anything else — a violation,
    // or missing on a page that has been open a while — is confirmed as fast
    // as it always was.
    // A whole page just armed is still arriving too: a block a framework
    // renders a second later is late, not gone, so every verdict waits.
    const late = rt.armedAt && now() - rt.armedAt < ARM_GRACE_MS && (desired === 'missing' || m.spec?.kind === 'page');
    if (rt.candidate && rt.candidate.desired === desired && reason !== 'recompiled') {
      if (!late) { this.confirm(m, desired, res, snap); return; }
      if (rt.confirm) return;
    }
    rt.candidate = { desired, at: now() };
    clearTimeout(rt.confirm);
    rt.confirm = setTimeout(async () => {
      rt.confirm = null;
      if (!this.monitors.has(m.id) || m.state === 'paused' || !rt.candidate || rt.candidate.desired !== desired) return;
      let s2 = null;
      try { s2 = await this.live()?.measure(m); } catch { s2 = null; }
      if (!s2) s2 = snap; else this.cleanSnapshot(s2);
      const r2 = evaluate(m.spec, m.baseline, s2);
      const d2 = r2.missing ? 'missing' : r2.ok ? 'ok' : 'violated';
      if (d2 === desired) this.confirm(m, desired, r2, s2);
      else rt.candidate = null;
    }, late ? Math.max(500, rt.armedAt + ARM_GRACE_MS - now()) : 500);
  }
  /** At most one tick event per monitor per 400 ms: a card's numbers, not a firehose. */
  emitTick(m, res) {
    const rt = this.rt.get(m.id);
    rt.tickPending = { t: 'monitor.tick', monitorId: m.id, state: m.state, ok: res.ok, missing: res.missing, metrics: summarize(m.last), violations: res.violations, at: now() };
    if (rt.tickTimer) return;
    rt.tickTimer = setTimeout(() => { rt.tickTimer = null; if (rt.tickPending) this.emit(rt.tickPending); rt.tickPending = null; }, 400);
  }
  async confirm(m, desired, res, snap) {
    const rt = this.rt.get(m.id);
    if (!rt || rt.confirming) return;
    rt.confirming = true;
    rt.candidate = null; clearTimeout(rt.confirm); rt.confirm = null;
    try {
      m.state = desired; m.last = snap;
      delete m.ackKey;
      if (desired === 'ok') {
        if (m.openIncidentId) await this.resolve(m.openIncidentId, 'auto');
        this.say('info', `recovered: ${m.label} is back within its rule`);
      } else {
        // The markup as it is now, for the incident and the judge: a removed
        // node or a swapped class is evidence a clip alone may not show.
        const agent = this.live();
        const excerpt = agent ? this.cleanExcerpt(await agent.excerpt(m).catch(() => null)) : null;
        const open = m.openIncidentId ? this.incidents.get(m.openIncidentId) : null;
        if (open && open.status !== 'resolved') await this.updateIncident(m, open, res, snap, desired, excerpt);
        else await this.openIncident(m, res, snap, desired, excerpt);
      }
      this.persist();
      this.emit({ t: 'monitor.changed', monitor: this.publicMonitor(m) });
    } finally { rt.confirming = false; }
  }

  // ---- incidents -----------------------------------------------------------------------
  async openIncident(m, res, snap, desired, excerpt = null) {
    // Only a judgment clause's proxies failed: the element changed, and whether
    // the rule broke is Claude's to say (JUDGE_DIRECT_SYSTEM). The incident
    // opens as `judging` and the verdict makes it stand or resolves it; with
    // no model it opens as any other, with a verdict that says what is missing.
    const judgmentOnly = desired !== 'missing' && res.violations.length > 0 && res.violations.every((v) => isJudgmentCheck(m.spec, v.checkId));
    const willJudge = judgmentOnly && cfg.llm.mode === 'claude' && !!cfg.resolver;
    const inc = {
      id: newId('i'), monitorId: m.id, monitorLabel: m.label, suiteId: m.suiteId ?? null, selector: m.selector, ruleText: m.ruleText,
      type: desired === 'missing' ? 'missing' : 'violation', status: willJudge ? 'judging' : 'open', judgment: judgmentOnly,
      openedAt: now(), resolvedAt: null, resolvedBy: null,
      violations: res.violations,
      before: { snapshot: compactSnapshot(m.baseline), screenshot: m.baselineShot, excerpt: m.baselineExcerpt ?? null },
      after: { snapshot: compactSnapshot(snap), screenshot: null, excerpt: keepExcerpt(excerpt) },
      diff: diff(m.baseline, snap, m.spec), verdict: null,
    };
    let afterPng = null;
    const agent = this.live();
    if (agent) {
      const shot = await agent.screenshotElement(m, { mayScroll: cfg.isIdle() }).catch(() => null);
      if (shot) { afterPng = shot.png; inc.after.screenshot = this.saveShot(`${inc.id}-after`, shot.png); inc.after.screenshotKind = shot.kind; }
    }
    inc.verdict = judgeMock({ label: m.label, selector: m.selector, ruleText: m.ruleText, violations: inc.violations, diff: inc.diff, judgment: judgmentOnly });
    this.incidents.set(inc.id, inc);
    m.openIncidentId = inc.id;
    m.stats.incidents++;
    // A defect, under the same numbers as a failed run's (defects.js), before
    // anyone is told — so the event and the notification carry its number.
    inc.defect = null;
    this.fileDefect('opened', inc, m);
    this.prune();
    this.persist();
    this.emit({ t: 'incident.opened', incident: inc });
    const headline = (inc.violations[0] && inc.violations[0].message) || (m.spec?.kind === 'page' ? 'The page changed' : 'The element changed');
    try { cfg.notify?.(this.org, 'incident', { id: inc.id, label: m.label, ruleText: m.ruleText, headline, severity: inc.verdict?.severity ?? null, page: m.url ?? null, url: m.url ?? null, defect: inc.defect ?? null }); }
    catch (err) { cfg.log.error(`  monitoring: could not notify: ${err.message}`); }
    // A rule the element failed from the start — "must not exceed 10px" on a
    // 16px paragraph — is a rule to rewrite, not a change to chase; the
    // baseline itself says which this is.
    const brokenFromTheStart = !evaluate(m.spec, m.baseline, m.baseline).ok;
    if (willJudge) this.say('warn', `judging: ${m.label} changed — asking Claude whether "${m.spec.judgmentHint ?? m.ruleText}" still holds`);
    else this.say('error', `${brokenFromTheStart ? 'already broken at creation' : 'incident'}: ${m.label} — ${headline}`);
    agent?.flash(m).catch(() => null);
    this.scheduleJudge(m, inc, afterPng, excerpt);
  }
  async updateIncident(m, inc, res, snap, desired, excerpt = null) {
    const prevIds = inc.violations.map((v) => v.checkId).sort().join(',');
    const nextIds = res.violations.map((v) => v.checkId).sort().join(',');
    inc.violations = res.violations;
    inc.after.snapshot = compactSnapshot(snap);
    if (excerpt) inc.after.excerpt = keepExcerpt(excerpt);
    inc.diff = diff(m.baseline, snap, m.spec);
    inc.type = desired === 'missing' ? 'missing' : 'violation';
    inc.updatedAt = now();
    const agent = this.live();
    let afterPng = null;
    if (prevIds !== nextIds && agent) {
      const shot = await agent.screenshotElement(m, { mayScroll: cfg.isIdle() }).catch(() => null);
      if (shot) { afterPng = shot.png; this.deleteShot(inc.after.screenshot); inc.after.screenshot = this.saveShot(`${inc.id}-after-${inc.updatedAt}`, shot.png); inc.after.screenshotKind = shot.kind; }
    }
    if (!inc.verdict || inc.verdict.source === 'mock') inc.verdict = judgeMock({ label: m.label, selector: m.selector, ruleText: m.ruleText, violations: inc.violations, diff: inc.diff, judgment: !!inc.judgment });
    if (prevIds !== nextIds) this.fileDefect('updated', inc, m);
    this.emit({ t: 'incident.updated', incident: inc });
    // A different failure inside the same incident is a new question.
    if (prevIds !== nextIds) this.scheduleJudge(m, inc, afterPng, excerpt);
  }
  /**
   * Close an incident. `auto` is recovery; `manual` is "accept the current
   * state" (`who` says by whom), and `judge` is Claude saying the change was fine: for both, the
   * element as it is now becomes the baseline — relative rules and judgment
   * proxies take it as their new normal — and absolute rules that still fail
   * put the monitor into `acknowledged`, which stays quiet until the element
   * changes again.
   */
  async resolve(incId, by, who = null) {
    const inc = this.incident(incId);
    const m = this.monitors.get(inc.monitorId);
    if (inc.status !== 'resolved') {
      inc.status = 'resolved'; inc.resolvedAt = now(); inc.resolvedBy = by;
      if (m && m.openIncidentId === inc.id) m.openIncidentId = null;
      // Its defect closes with it; `who` is the person behind a manual resolve, for the activity.
      this.fileDefect('resolved', inc, m ?? null, who ? { ...who, how: by } : { how: by });
      if ((by === 'manual' || by === 'judge') && m) {
        const rt = this.rt.get(m.id);
        if (rt) { rt.candidate = null; clearTimeout(rt.confirm); rt.confirm = null; clearTimeout(rt.debounce); rt.debounce = null; rt.pending = null; }
        if (m.last && m.last.exists) {
          m.baseline = m.last;
          const agent = this.live();
          if (agent) {
            const shot = await agent.screenshotElement(m, { mayScroll: cfg.isIdle() }).catch(() => null);
            if (shot) { this.deleteShot(m.baselineShot); m.baselineShot = this.saveShot(`${m.id}-baseline-${now()}`, shot.png); }
            m.baselineExcerpt = keepExcerpt(this.cleanExcerpt(await agent.excerpt(m).catch(() => null))) ?? m.baselineExcerpt ?? null;
          }
        }
        if (m.state !== 'paused') {
          const res = evaluate(m.spec, m.baseline, m.last);
          if (res.ok) { m.state = 'ok'; delete m.ackKey; }
          else { m.state = 'acknowledged'; m.ackKey = violationKey(res); }
        }
        this.emit({ t: 'monitor.changed', monitor: this.publicMonitor(m) });
      }
      this.persist();
      this.emit({ t: 'incident.resolved', incident: inc });
      try { cfg.notify?.(this.org, 'incident', { id: inc.id, status: 'resolved', label: inc.monitorLabel, ruleText: inc.ruleText, by: by ?? null, page: m?.url ?? null, url: m?.url ?? null, defect: inc.defect ?? null }); }
      catch (err) { cfg.log.error(`  monitoring: could not notify: ${err.message}`); }
    }
    return inc;
  }
  /** The newest INCIDENTS_MAX stay; the oldest resolved ones go first, and their clips with them. */
  prune() {
    if (this.incidents.size <= INCIDENTS_MAX) return;
    const byAge = [...this.incidents.values()].sort((a, b) => a.openedAt - b.openedAt);
    const drop = [...byAge.filter((i) => i.status === 'resolved'), ...byAge.filter((i) => i.status !== 'resolved')];
    for (const inc of drop) {
      if (this.incidents.size <= INCIDENTS_MAX) break;
      this.incidents.delete(inc.id);
      this.deleteShot(inc.after?.screenshot);
    }
  }

  // ---- the judge -----------------------------------------------------------------------------
  scheduleJudge(m, inc, afterPng, afterExcerpt = null) {
    if (cfg.llm.mode !== 'claude' || !cfg.resolver) return;
    const rt = this.rt.get(m.id);
    if (!rt) return;
    const wait = Math.max(0, cfg.judgeIntervalMs - (now() - rt.lastJudgeAt));
    clearTimeout(rt.judgeTimer);
    rt.judgeTimer = setTimeout(() => this.runJudge(m, inc, afterPng, afterExcerpt), wait);
  }
  async runJudge(m, inc, afterPng, afterExcerpt = null) {
    const rt = this.rt.get(m.id);
    if (!rt || rt.judgeInFlight || !this.incidents.has(inc.id) || !cfg.resolver) return;
    if (cfg.budget && !cfg.budget.take()) {
      this.say('warn', `no verdict from Claude for ${m.label}: the daily AI budget is spent`);
      this.unjudged(inc, 'the daily AI budget is spent');
      return;
    }
    rt.judgeInFlight = true;
    rt.lastJudgeAt = now();
    m.stats.judgeCalls++;
    try {
      const beforePng = this.readShot(m.baselineShot);
      const after = afterPng || this.readShot(inc.after.screenshot);
      const v = await cfg.resolver.judge({
        label: m.label, selector: m.selector, ruleText: m.ruleText, specSummary: m.spec && m.spec.summary, judgmentHint: m.spec && m.spec.judgmentHint,
        violations: inc.violations, diff: inc.diff, beforePng, afterPng: after, elapsedMs: inc.openedAt - m.createdAt,
        beforeExcerpt: m.baselineExcerpt ?? null, afterExcerpt: afterExcerpt ?? inc.after?.excerpt ?? null,
        direct: !!inc.judgment,
      });
      if (!this.incidents.has(inc.id)) return;
      const first = (s) => String(s ?? '').split(/(?<=\.)\s/)[0];
      if (v) {
        inc.verdict = v;
        if (inc.status === 'judging' || (m.spec && m.spec.needsLlmJudgment && inc.status !== 'resolved')) {
          if (v.violation) {
            // A judged change that broke the rule: the incident stands, in Claude's words.
            inc.status = 'open';
            this.say('error', `incident: ${m.label} — ${first(v.explanation)}`);
          } else {
            // Judged fine: the element as it is now becomes the baseline, and the
            // same state is not asked about again (resolve, 'judge').
            this.say('info', `judged fine: ${m.label} — ${first(v.explanation)}`);
            await this.resolve(inc.id, 'judge');
          }
        } else {
          this.say('info', `Claude on ${m.label}: ${v.severity} severity, ${v.violation ? 'a real violation' : 'a false alarm'}`);
        }
      } else {
        const why = String(cfg.resolver.unavailable || 'unavailable');
        inc.verdict = { ...(inc.verdict || judgeMock({ label: m.label, selector: m.selector, ruleText: m.ruleText, violations: inc.violations, diff: inc.diff, judgment: !!inc.judgment })), source: 'error', error: why, at: now() };
        this.unjudged(inc, why);
        if (why === 'AuthenticationError') this.switchToMock('Claude rejected the runner’s credentials; rules are compiled and incidents judged by the mock from here on');
        else this.say('warn', `no verdict from Claude for ${m.label}: ${why}`);
      }
    } finally {
      rt.judgeInFlight = false;
      this.persist();
      if (this.incidents.has(inc.id)) this.emit({ t: 'incident.updated', incident: inc });
    }
  }

  /** A judging incident nobody could judge stands as an ordinary one, saying why: never silence. */
  unjudged(inc, why) {
    if (inc.status !== 'judging') return;
    inc.status = 'open';
    inc.verdict = { ...(inc.verdict || {}), unjudged: String(why).slice(0, 200), at: now() };
    this.persist();
    this.emit({ t: 'incident.updated', incident: inc });
  }

  // ---- the heartbeat -----------------------------------------------------------------------
  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }
  stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
  /** A safety net under the observers — and only when there is something armed to measure. */
  async beat() {
    const agent = this.live();
    if (!agent || this.beating || !agent.url() || !agent.armed.size) return;
    this.beating = true;
    try {
      const all = await agent.measureAll();
      for (const r of all?.monitors || []) this.ingest(r);
    } catch { /* navigating or closed */ } finally { this.beating = false; }
  }
}

// ---- one engine per organisation ---------------------------------------------------
const engines = new Map();

/** The engine of one organisation, the same object for every caller. */
export function forOrg(org) {
  let e = engines.get(org);
  if (!e) { e = new MonitorEngine(org); engines.set(org, e); }
  return e;
}

/** Every pending write, now — for the moment before the process exits. */
export function flushAll() {
  for (const e of engines.values()) e.flush();
}
