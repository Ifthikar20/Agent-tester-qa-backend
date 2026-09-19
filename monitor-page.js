/**
 * The monitoring agent inside the driven page, and the runner's handle on it.
 *
 * Four files under monitor/page/ — the sanitiser, the runtime, the picker,
 * the watcher — are read off disk and wrapped in one function body, exactly as recorder.js
 * does with the extension's propose.js: one copy of the code, installed the
 * same way. `attach()` installs it the way Recorder.attach does, in the order
 * that matters: the bindings first (the page calls them), then the init script
 * (every document from now on), then an evaluate into the document that is
 * already open. Evaluate rather than addScriptTag, because a strict CSP can
 * refuse a script tag and cannot refuse an evaluate.
 *
 * One agent per driven session, re-made by newSession() with the rest of the
 * session's listeners; its `owner` is the organisation whose page this is, so
 * a report arriving late from an outgoing page can never land in the incoming
 * organisation's engine.
 *
 * Every call into the page answers `null` (or `false`) rather than throwing
 * when the page is gone or navigating: monitoring is a passenger on a browser
 * somebody else is driving, and a passenger does not stop the car.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PAGE_SELECTOR } from './monitor-rules.js';

const part = (name) => readFileSync(fileURLToPath(new URL(`./monitor/page/${name}`, import.meta.url)), 'utf8');

/** The in-page agent: one IIFE, top frame only, shared lexical scope for the four files. */
export const BUNDLE = "(function () {\n'use strict';\nif (window !== window.top) return;\n"
  + ['sanitize.js', 'core.js', 'picker.js', 'watcher.js'].map(part).join('\n')
  + '\n})();\n';

/**
 * The page's sanitiser, as a function the runner can call: the one file,
 * evaluated on its own. It is pure — a string in, a string out — which is
 * what lets check:monitoring-request prove what an excerpt can never carry
 * without opening a browser.
 */
export function pageSanitizer() {
  return new Function(`${part('sanitize.js')}\nreturn sanitizeHtml;`)();
}

export class MonitorAgent {
  /**
   * @param page the driven Playwright page
   * @param owner the organisation whose page it is (driver.org when the session was made)
   * @param onReport a change the watcher measured: { monitorId, snapshot, reason, selectorNew, … }
   * @param onSelected the picker's answer: { selector, fingerprint, snapshot, label, url, readError } or { cancelled: true }
   * @param onHover what the picker is over right now: { describe, tag, text, w, h, fontSize }
   * @param listFor (href) => the monitors to arm in that document, [{ id, selector, fingerprint, label }]
   * @param onVisit (href, list) => a new document just asked for its monitors — a visit to their page
   * @param onError a sentence for the log
   */
  constructor(page, { owner = null, onReport, onSelected, onHover, listFor, onVisit, onError } = {}) {
    this.page = page;
    this.owner = owner;
    this.picking = false;
    /** The ids the current document was handed — what the heartbeat has to measure. */
    this.armed = new Set();
    this.onReport = onReport ?? (() => {});
    this.onSelected = onSelected ?? (() => {});
    this.onHover = onHover ?? (() => {});
    this.listFor = listFor ?? (() => []);
    this.onVisit = onVisit ?? (() => {});
    this.onError = onError ?? (() => {});
  }

  alive() { return !!this.page && !this.page.isClosed(); }

  /** Where the page is, or null for nothing open. */
  url() {
    if (!this.alive()) return null;
    let u = null;
    try { u = this.page.url(); } catch { return null; }
    return !u || u === 'about:blank' ? null : u;
  }

  async attach() {
    await this.page.exposeBinding('__gcMonitorReport', (_src, payload) => {
      try { this.onReport(payload); } catch (err) { this.onError(err.message); }
    });
    // A selection is the answer to a question somebody is waiting on, so a
    // handler that throws — or a promise that rejects, the handler takes a
    // screenshot — is reported rather than lost.
    await this.page.exposeBinding('__gcMonitorSelected', (_src, info) => {
      this.picking = false;
      let r;
      try { r = this.onSelected(info); } catch (err) { this.onError(err.message); return; }
      if (r && typeof r.then === 'function') r.catch((err) => this.onError(err?.message ?? String(err)));
    });
    await this.page.exposeBinding('__gcMonitorHover', (_src, info) => {
      if (!this.picking) return;
      try { this.onHover(info); } catch (err) { this.onError(err.message); }
    });
    // The boot handshake: a new document asks which monitors are its own. The
    // answer is what the page arms, so it is also what the runner remembers —
    // and, for each of them, a visit to its page: the moment "does it still
    // hold?" gets asked again.
    await this.page.exposeBinding('__gcMonitorList', async (_src, href) => {
      let list = [];
      try { list = (await this.listFor(href)) || []; } catch (err) { this.onError(err.message); }
      this.armed = new Set(list.map((m) => m.id));
      try { this.onVisit(href, list); } catch (err) { this.onError(err.message); }
      return list;
    });
    await this.page.addInitScript({ content: BUNDLE });
    await this.page.evaluate(BUNDLE).catch(() => { /* navigating; the init script has the next document */ });
  }

  /**
   * page.evaluate, answered null when the page is gone, and tried once more
   * after a navigation destroyed the context it was talking to.
   */
  async #call(fn, arg) {
    if (!this.alive()) return null;
    try {
      return await this.page.evaluate(fn, arg);
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (/Execution context was destroyed|navigation|Target closed|has been closed/i.test(msg) && this.alive()) {
        await this.page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        if (!this.alive()) return null;
        try { return await this.page.evaluate(fn, arg); } catch { return null; }
      }
      return null;
    }
  }

  async startPicker() {
    const ok = await this.#call(() => (window.__gcMonitor ? window.__gcMonitor.startPicker() : false));
    this.picking = !!ok;
    return this.picking;
  }
  async stopPicker() {
    this.picking = false;
    return this.#call(() => (window.__gcMonitor ? window.__gcMonitor.stopPicker() : false));
  }
  async clearSelection() {
    return this.#call(() => (window.__gcMonitor ? window.__gcMonitor.clearSelection() : false));
  }

  async arm(m) {
    const r = await this.#call((mm) => (window.__gcMonitor ? window.__gcMonitor.arm(mm) : null),
      { id: m.id, selector: m.selector, fingerprint: m.fingerprint || null, label: m.label || '' });
    if (r !== null) this.armed.add(m.id);
    return r;
  }
  async disarm(id) {
    this.armed.delete(id);
    return this.#call((i) => (window.__gcMonitor ? window.__gcMonitor.disarm(i) : false), id);
  }
  /** The list for this document, applied in place — a same-document route change. */
  async sync(list) {
    const l = (list || []).map((m) => ({ id: m.id, selector: m.selector, fingerprint: m.fingerprint || null, label: m.label || '' }));
    const r = await this.#call((ll) => (window.__gcMonitor ? window.__gcMonitor.sync(ll) : false), l);
    if (r) this.armed = new Set(l.map((m) => m.id));
    return r;
  }

  async measure(target) {
    return this.#call((t) => (window.__gcMonitor ? window.__gcMonitor.measureFor(t) : null),
      { selector: target.selector, fingerprint: target.fingerprint || null });
  }
  /** The element's markup excerpt (core.js excerptOf), or null when it is gone. */
  async excerpt(target) {
    return this.#call((t) => (window.__gcMonitor ? window.__gcMonitor.excerptFor(t) : null),
      { selector: target.selector, fingerprint: target.fingerprint || null });
  }
  async measureAll() {
    return this.#call(() => (typeof window.__gcMonitorMeasureAll === 'function' ? window.__gcMonitorMeasureAll() : null));
  }
  async flash(target) {
    return this.#call((t) => (window.__gcMonitor ? window.__gcMonitor.flash(t) : false),
      { selector: target.selector, fingerprint: target.fingerprint || null });
  }
  async setHostHidden(hidden) {
    return this.#call((h) => (window.__gcMonitor ? window.__gcMonitor.setHostHidden(h) : false), !!hidden);
  }

  /**
   * A clip of the element, padded, within the viewport; the whole viewport
   * when the element is gone or has no size — or when the monitor is on the
   * whole page.
   *
   * `mayScroll` brings the element into view first. Never while a run or a
   * recording holds the page: scrolling under the executor moves what it is
   * about to click. The overlay is hidden only while picking — the one time it
   * has something on screen — because a style change on the host is a mutation
   * the page's other observers can see. `caret: 'initial'` for the same
   * reason: Playwright's default hides the caret by injecting a style element.
   */
  async screenshotElement(target, { padding = 8, mayScroll = true } = {}) {
    if (!this.alive()) return null;
    const page = this.page;
    const ts = Date.now();
    const t = { selector: target.selector, fingerprint: target.fingerprint || null };
    const shot = (opts) => page.screenshot({ type: 'png', timeout: 5000, caret: 'initial', ...opts });
    const viewportShot = async () => ({ png: await shot({}), kind: 'viewport', clip: null, ts });
    // The whole page's clip is the viewport: what a person would see.
    if (t.selector === PAGE_SELECTOR) { try { return await viewportShot(); } catch { return null; } }
    const box = (scroll) => this.#call(([tt, s]) => {
      const r = window.__gcMonitor ? window.__gcMonitor.resolveTarget(tt) : { el: null };
      if (!r.el) return null;
      if (s) { try { r.el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) {} }
      const b = r.el.getBoundingClientRect();
      return { x: b.left, y: b.top, w: b.width, h: b.height, vw: innerWidth, vh: innerHeight };
    }, [t, scroll]);
    const hide = this.picking;
    try {
      if (hide) await this.setHostHidden(true);
      const first = await box(mayScroll);
      if (!first || first.w <= 0 || first.h <= 0) return await viewportShot();
      if (mayScroll) await page.waitForTimeout(60);
      const b = (mayScroll ? await box(false) : null) || first;
      const x0 = Math.max(0, b.x - padding), y0 = Math.max(0, b.y - padding);
      const x1 = Math.min(b.vw, b.x + b.w + padding), y1 = Math.min(b.vh, b.y + b.h + padding);
      if (x1 - x0 < 2 || y1 - y0 < 2) return await viewportShot();
      const clip = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
      return { png: await shot({ clip }), kind: 'element', clip, ts };
    } catch {
      try { return await viewportShot(); } catch { return null; }
    } finally {
      if (hide) await this.setHostHidden(false);
    }
  }
}
