/**
 * Teach mode, server side.
 *
 * You drive the app by hand on the canvas; this watches and writes the script.
 * Because canvas clicks go through VirtualCursor -> CDP -> real DOM events, an
 * injected capture-phase listener sees them exactly as it would see a human on
 * a real browser.
 *
 * How an element gets NAMED lives in extension/lib/propose.js, which is read
 * off disk and injected here and loaded as a content script by the extension.
 * One copy, because the extension proposes a target on the user's machine and
 * this runner has to resolve the same one on ours.
 *
 * Two things make a recording trustworthy rather than merely clever:
 *
 *  - The page never decides on a target, it PROPOSES several. Each proposal is
 *    resolved with the same locator the executor will use and kept only if it
 *    matches exactly one element, and that element is the one interacted with.
 *
 *  - A click usually destroys the thing that was clicked — submit a form and
 *    the form is gone before any async check can run. So the page also counts
 *    matches synchronously, at event time, while the DOM still looks the way it
 *    did. Playwright's verdict wins when the element survives; the click-time
 *    count is what stands in when it doesn't.
 *
 * Everything reaches the recorder through one ordered channel from the page,
 * URL changes included. Watching navigation separately raced the bindings and
 * filed clicks after the page transitions they caused.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseTarget, locate } from './targets.js';

const PROPOSE_SRC = readFileSync(
  fileURLToPath(new URL('./extension/lib/propose.js', import.meta.url)), 'utf8');

/** The listeners. Naming is delegated to __gcPropose, above. */
const LISTENERS = `
(function () {
  if (window.__gcRecorderInstalled) return;
  window.__gcRecorderInstalled = true;

  var SCOPE = self.__gcPropose.SCOPE;
  var propose = self.__gcPropose.propose;
  var n = 0;

  /**
   * Hand an interaction to the recorder — after deciding any click that is
   * still waiting to learn whether it changed the page, so steps arrive in the
   * order they happened.
   */
  function send(msg) {
    settle(false);
    post(msg);
  }

  function post(msg) {
    try { window.__gcRecord(msg); } catch (e) { /* binding not attached yet */ }
  }

  /** An interaction, measured now — while the element is still the way it was. */
  function describe(kind, el, extra, ev) {
    if (!el || !el.getAttribute) return null;
    var id = 'gc' + ++n;
    el.setAttribute('data-gc-el', id);
    var r = el.getBoundingClientRect();
    try {
      // href rides along so URL changes stay ordered with the actions.
      var msg = { kind: kind, id: id, href: location.href, candidates: propose(el),
        // Where the pointer actually was, and the box it landed in. Not how the
        // replay finds the element — a cross-check that says when the thing it
        // resolved is nowhere near where you clicked.
        at: {
          x: ev && ev.clientX != null ? Math.round(ev.clientX) : Math.round(r.left + r.width / 2),
          y: ev && ev.clientY != null ? Math.round(ev.clientY) : Math.round(r.top + r.height / 2),
          w: Math.round(r.width), h: Math.round(r.height),
          vw: window.innerWidth, vh: window.innerHeight,
        } };
      for (var k in (extra || {})) msg[k] = extra[k];
      return msg;
    } catch (e) { return null; /* the element went away mid-measure */ }
  }

  function report(kind, el, extra, ev) {
    var msg = describe(kind, el, extra, ev);
    if (msg) send(msg);
  }

  // ---- clicks on things that are not controls ------------------------------
  // An accordion header, a tab, a card: often a <div> with a click handler,
  // and nothing in the markup says it is a control. Those clicks used to be
  // ignored on purpose — naming a div by the text inside it is usually a target
  // that breaks next week — so a recording replayed into a closed accordion,
  // one step short.
  //
  // The page answers what the markup does not. If something near the element
  // changes within CHANGE_MS of the click, the click did something, and it is a
  // step. Not anything that was already changing just before the click: a
  // ticking counter or an animation mutates all the time, and a click on the
  // text beside it did nothing. A click that changes nothing is still not an
  // action. <summary> needs none of this; it is a control and says so.
  var CLICKABLE = SCOPE + ',summary';
  var CHANGE_MS = 500;
  var QUIET_MS = 800;
  var WATCHED = ['class', 'style', 'open', 'hidden', 'aria-expanded', 'aria-hidden', 'aria-selected', 'aria-pressed', 'data-state'];
  var lastChanged = new WeakMap();    // element -> when it last changed
  var pending = null;                 // { el, msg, at, timer }: a click waiting for its answer

  /** The waiting click, decided: kept because the page changed, or let go. */
  function settle(keep) {
    if (!pending) return;
    var p = pending;
    pending = null;
    clearTimeout(p.timer);
    if (keep) post(p.msg);
    else p.el.removeAttribute('data-gc-el');
  }

  /** Within three levels around the element, or inside what it says it controls. */
  function near(node, el) {
    var box = el;
    for (var i = 0; i < 3 && box.parentElement && box.parentElement !== document.body; i++) box = box.parentElement;
    if (box.contains(node)) return true;
    // Doubled backslash: this whole script is a template string on the way in,
    // and a single one would reach the page as a plain "s".
    var ids = (el.getAttribute('aria-controls') || '').split(/\\s+/);
    for (var j = 0; j < ids.length; j++) {
      var c = ids[j] && document.getElementById(ids[j]);
      if (c && c.contains(node)) return true;
    }
    return false;
  }

  new MutationObserver(function (records) {
    var now = Date.now();
    for (var i = 0; i < records.length; i++) {
      var rec = records[i];
      var node = null;
      var surfaced = false;             // a new top-level layer: a dialog, a menu, a popover
      if (rec.type === 'attributes') {
        node = rec.target;
      } else {
        for (var a = 0; a < rec.addedNodes.length && !node; a++) {
          if (rec.addedNodes[a].nodeType === 1) { node = rec.target; surfaced = rec.target === document.body; }
        }
        for (var d = 0; d < rec.removedNodes.length && !node; d++) {
          if (rec.removedNodes[d].nodeType === 1) node = rec.target;
        }
      }
      // Text alone is not the page changing shape; it is a number ticking over.
      if (!node || node.nodeType !== 1) continue;
      var before = lastChanged.get(node);
      lastChanged.set(node, now);
      // A control that was pressed, and the page answered the press rather
      // than waiting for the click — see "a press that did the clicking".
      if (press && !press.answered && now - press.at <= CHANGE_MS
          && !(before !== undefined && before >= press.at - QUIET_MS)
          && (surfaced || near(node, press.el))) press.answered = true;
      if (!pending || now - pending.at > CHANGE_MS) continue;
      if (before !== undefined && before >= pending.at - QUIET_MS) continue;   // was already changing
      if (surfaced || near(node, pending.el)) settle(true);
    }
    // The document itself, not documentElement: this runs as an init script,
    // before the parser has made an <html> to hang an observer on.
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: WATCHED });

  /** A click on something that is not a control: measure it now, keep it if the page answers. */
  function watchClick(e) {
    var el = e.target;
    if (!el || !el.getAttribute || el === document.body || el === document.documentElement) return;
    // The element that was made clickable, not the span inside it: climb while
    // the page's own styling still says "pointer".
    if (getComputedStyle(el).cursor === 'pointer') {
      for (var i = 0; i < 5 && el.parentElement && el.parentElement !== document.body
           && getComputedStyle(el.parentElement).cursor === 'pointer'; i++) el = el.parentElement;
    }
    settle(false);
    var msg = describe('click', el, null, e);
    if (!msg) return;
    clickAt = Date.now();
    pending = { el: el, msg: msg, at: clickAt, timer: setTimeout(function () { settle(false); }, CHANGE_MS) };
  }

  var FIELD = /^(input|textarea|select)$/;

  // ---- what the pointer revealed -------------------------------------------
  // A dropdown's items are not in the page until the pointer is on the thing
  // that opens them. Recording only the click gives you a script that waits
  // eight seconds for a menu nobody opened. So: keep a short trail of what the
  // pointer has been over, and a periodic sample of what is actually visible.
  // If a click lands on something that was NOT visible a moment ago, the
  // pointer put it there, and the last thing it was over that WAS already
  // visible is what opened it.
  var trail = [];
  var baseline = new WeakSet();
  var onScope = false;

  function isVisible(el) {
    return !!(el.offsetParent !== null || el.getClientRects().length);
  }

  /**
   * What is on the page when the pointer is NOT provoking anything.
   *
   * Sampling on a plain timer was wrong: pause on a menu for longer than the
   * interval and the open menu becomes the baseline, so the click that follows
   * looks like it was always available and the hover goes unrecorded. The
   * baseline is only refreshed while nothing interactive is hovered.
   */
  function sample() {
    if (onScope) return;
    baseline = new WeakSet();
    var all = document.querySelectorAll(SCOPE);
    for (var i = 0; i < all.length && i < 400; i++) {
      if (isVisible(all[i])) baseline.add(all[i]);
    }
  }
  sample();
  setInterval(sample, 600);

  document.addEventListener('mouseover', function (e) {
    var el = e.target.closest && e.target.closest(SCOPE);
    if (!el) return;
    onScope = true;
    if (trail[trail.length - 1] !== el) trail.push(el);
    if (trail.length > 8) trail.shift();
  }, true);

  document.addEventListener('mouseout', function (e) {
    var to = e.relatedTarget;
    if (to && to.closest && to.closest(SCOPE)) return;   // still on something
    onScope = false;
    sample();                                            // pointer is idle: re-baseline
  }, true);

  /** The most recent thing the pointer was over that was already on the page. */
  function openerOf(el) {
    for (var i = trail.length - 1; i >= 0; i--) {
      if (trail[i] !== el && baseline.has(trail[i])) return trail[i];
    }
    return null;
  }

  // ---- scrolling -----------------------------------------------------------
  // Scrolling is an interaction, and on a long page it is often the only way to
  // reach the thing you want to click. Recording it as a pixel offset would be
  // useless — a different viewport scrolls to a different place — so a gesture
  // is converted here, while the page is in front of us, into something that
  // means the same at any size: the top, the bottom, or the first interactive
  // element you came to rest on.
  var scrollTimer = null;
  var lastY = window.scrollY;
  var clickAt = 0;                      // when the last click happened

  /**
   * Is this element pinned to the viewport rather than to the page?
   *
   * A sticky header never leaves the top of the screen, so it is ALWAYS the
   * topmost interactive thing in view. Anchoring a scroll to it produced
   * "scroll to Features" three times in a row, and replaying those moved
   * nothing at all — the element was already exactly where it always is.
   */
  function pinned(el) {
    for (var n = el; n && n !== document.body; n = n.parentElement) {
      var pos = getComputedStyle(n).position;
      if (pos === 'fixed' || pos === 'sticky') return true;
    }
    return false;
  }

  /**
   * The topmost thing in view that actually moved with the page.
   *
   * Skipping the first band of the viewport as well: even without sticky
   * positioning, whatever is grazing the top edge is a poor description of
   * where you came to rest.
   */
  function anchor() {
    var all = document.querySelectorAll(SCOPE);
    var best = null, bestTop = Infinity;
    var floor = Math.min(120, window.innerHeight * 0.2);
    for (var i = 0; i < all.length && i < 400; i++) {
      var r = all[i].getBoundingClientRect();
      if (!r.height || r.top < floor || r.top > window.innerHeight - 40) continue;
      if (pinned(all[i])) continue;
      if (r.top < bestTop) { bestTop = r.top; best = all[i]; }
    }
    return best;
  }

  window.addEventListener('scroll', function () {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(function () {
      var y = window.scrollY;
      if (Math.abs(y - lastY) < 120) return;        // settling, not a gesture
      lastY = y;
      // A click that moves the page is the click's business, not a separate
      // scroll step — recording both would replay the movement twice.
      if (Date.now() - clickAt < 700) return;
      var max = document.documentElement.scrollHeight - window.innerHeight;
      if (y <= 8) return send({ kind: 'scroll', to: 'top', href: location.href });
      if (y >= max - 8) return send({ kind: 'scroll', to: 'bottom', href: location.href });
      var a = anchor();
      if (a) report('scroll', a, null, null);
    }, 260);
  }, true);

  // ---- a press that did the clicking ---------------------------------------
  // Some controls act on the PRESS. A select or a menu built on Bits UI or
  // Radix opens on pointerdown and takes pointer events away from the rest of
  // the page, so the release lands on the open list or on nothing, and the
  // click that follows is dispatched to <html>. Listening for clicks kept the
  // option you picked and lost the click that opened the list — and replay
  // waited for an option in a list nobody had opened.
  //
  // So a control is measured when it is pressed, while it still looks the way
  // it did. If the page answers the press and the click then lands somewhere
  // that is not the control, the press was the click. Released where it was
  // pressed, too: a press that travelled is a drag, and a drag is not a click
  // on anything.
  var press = null;                   // { el, msg, at, x, y, answered }
  var lastClicked = null;             // the control the latest click step was on
  var SLOP = 8;

  function stayed(p, ev) {
    return Math.abs(ev.clientX - p.x) <= SLOP && Math.abs(ev.clientY - p.y) <= SLOP;
  }

  /**
   * Was this control on the page before the pointer went looking for it? If
   * not, the hover that revealed it is a step — unless what revealed it is the
   * control that was just clicked. That click already did the revealing, and
   * by now the control may be named by the value it was used to change.
   * Only controls are sampled into the baseline, so only a control can ask.
   */
  function revealedBy(el) {
    if (!el.matches(SCOPE) || baseline.has(el)) return;
    var opener = openerOf(el);
    if (opener && opener !== lastClicked) report('hover', opener, null, null);
  }

  function keepPress(p) {
    revealedBy(p.el);
    clickAt = Date.now();
    lastClicked = p.el;
    send(p.msg);
  }

  document.addEventListener('pointerdown', function (e) {
    press = null;
    if (e.button !== 0) return;
    var el = e.target.closest && e.target.closest(CLICKABLE);
    if (!el || (FIELD.test(el.tagName.toLowerCase()) && ['checkbox','radio','submit','button'].indexOf(el.type) === -1)) return;
    var msg = describe('click', el, null, e);
    if (msg) press = { el: el, msg: msg, at: Date.now(), x: e.clientX, y: e.clientY, answered: false };
  }, true);

  // The click is dispatched in the same task as the release, so by the time
  // this runs it has either claimed the press or is never coming.
  document.addEventListener('pointerup', function (e) {
    var p = press;
    if (p) setTimeout(function () {
      if (press !== p) return;
      press = null;
      if (p.answered && stayed(p, e)) keepPress(p);
    }, 0);
  }, true);

  document.addEventListener('pointercancel', function () { press = null; }, true);

  document.addEventListener('click', function (e) {
    var p = press;
    press = null;
    // The press did the clicking, and this click went somewhere else — <html>,
    // or whatever opened under the pointer. The press is the step.
    if (p && p.answered && !p.el.contains(e.target) && stayed(p, e)) return keepPress(p);

    var el = e.target.closest && e.target.closest(CLICKABLE);
    // Not a control. It may still be the step — an accordion header, a tab —
    // and the page will say so: watchClick keeps it only if something near it
    // changes. A click that changes nothing is still not an action.
    if (!el) return watchClick(e);
    var tag = el.tagName.toLowerCase();
    // Clicking a text field is just focus; the change that follows carries the
    // real intent. Checkboxes and radios are the exception — the click IS it.
    if (FIELD.test(tag) && ['checkbox','radio','submit','button'].indexOf(el.type) === -1) return;

    revealedBy(el);
    var before = window.scrollY;
    clickAt = Date.now();
    lastClicked = el;
    report('click', el, null, e);

    // "Back to top", a router that resets scroll, an anchor that jumps: a click
    // that moves the page is a behaviour, and behaviours are what tests are
    // for. Recording it means a regression that quietly stops scrolling to the
    // top turns a run red instead of going unnoticed.
    if (before > 200) {
      setTimeout(function () {
        if (window.scrollY <= 8) {
          lastY = 0;
          send({ kind: 'jumped-to-top', href: location.href });
        }
      }, 240);
    }
  }, true);

  document.addEventListener('change', function (e) {
    var el = e.target;
    var tag = el.tagName && el.tagName.toLowerCase();
    if (!FIELD.test(tag)) return;
    if (['checkbox','radio'].indexOf(el.type) !== -1) return;   // recorded as a click
    report('fill', el, {
      // A typed password never leaves the page. The script gets a vault
      // reference that fails loudly until someone maps it.
      secret: el.type === 'password',
      value: el.type === 'password' ? null : String(el.value == null ? '' : el.value).slice(0, 500),
    }, null);
  }, true);

  ['popstate', 'hashchange'].forEach(function (ev) {
    window.addEventListener(ev, function () {
      // A route change right after a click is that click's answer — and the
      // click happened first, so it is sent first.
      settle(true);
      post({ kind: 'url', href: location.href });
    });
  });
})();
`;

const INJECT = `${PROPOSE_SRC}\n${LISTENERS}`;

export class Recorder {
  /** step -> what was seen beside it that its line cannot say (the frame it happened in). */
  #evidence = new WeakMap();

  /**
   * @param nav a NavigationLog, when there is one. A click that navigates gets
   *   the chain it went through recorded alongside it — the hops and their
   *   statuses — because "it went to the right URL" is not the same as "it went
   *   there directly", and neither is visible afterwards.
   */
  constructor(page, { onStep, onError, onNote, nav } = {}) {
    this.page = page;
    this.nav = nav ?? null;
    this.onStep = onStep ?? (() => {});
    this.onError = onError ?? (() => {});
    this.onNote = onNote ?? (() => {});    // something worth a line in the log, not an error
    this.recording = false;
    this.steps = [];
    this.lastUrl = null;
    this.queue = Promise.resolve();   // one at a time, in arrival order
  }

  async attach() {
    await this.page.exposeBinding('__gcRecord', (src, payload) => {
      // The listeners run in every frame a page loads, and a frame's address is
      // not the page's. A sign-in button another site draws in a frame
      // (accounts.google.com/gsi/button) reported its own URL, and the
      // recording checked that the PAGE had gone there: a step that could never
      // pass. So a frame's route changes and scrolls are not the page's, and
      // anything else it reports is filed at the page's address, with the frame
      // kept beside the step as evidence (understand.js says what it means).
      const frame = src?.frame && src.frame !== this.page.mainFrame() ? src.frame : null;
      let inFrame;
      if (frame) {
        if (!payload || ['url', 'scroll', 'jumped-to-top'].includes(payload.kind)) return;
        payload = { ...payload, href: this.page.url() };
        inFrame = { inFrame: true, frame: originOf(frame.url()) };
      }
      this.queue = this.queue
        .then(() => this.#ingest(payload, inFrame))
        .catch((e) => this.onError(e.message));
    });
    await this.page.addInitScript({ content: INJECT });
    // The page is already open, so install into it too rather than waiting for
    // the next navigation. (A strict CSP can refuse this; the init script on
    // the next navigation is not CSP-bound and will still land.)
    await this.page.addScriptTag({ content: INJECT }).catch(() => {});
  }

  /** Adopt a recording made elsewhere — the browser extension, typically. */
  adopt(steps) {
    this.steps = Array.isArray(steps) ? steps.slice() : [];
    this.lastUrl = null;
    this.onStep(this.steps.at(-1), this.steps);
    return this.steps;
  }

  /**
   * @param entry what the page offered when recording began. Loading a URL is
   *   not the same as being where you were: in an SPA the path can be decorative
   *   and give you the login screen instead. Keeping a fingerprint lets replay
   *   say THAT, instead of timing out on an element three steps later.
   */
  start(url, entry) {
    this.recording = true;
    this.steps = url ? [{ op: 'goto', url, entry }] : [];
    this.lastUrl = url ?? null;
    return this.steps;
  }

  stop(url) {
    // pushState fires neither popstate nor hashchange, so a final route change
    // has nothing to announce it. Take the URL as we close the recording.
    if (url) this.#noteUrl(url);
    this.recording = false;
    return this.steps;
  }

  /** What was seen beside a step that its line cannot say — `{ inFrame, frame }` — or null for most steps. */
  evidenceOf(step) {
    return this.#evidence.get(step) ?? null;
  }

  /**
   * Take one step out: a person's decision, from a flagged step's fix
   * (understand.js, server.js record.fix). Never the first — a recording
   * starts where it was opened. Returns the step taken out, or null.
   */
  remove(index) {
    if (!Number.isInteger(index) || index < 1 || index >= this.steps.length) return null;
    return this.steps.splice(index, 1)[0];
  }

  #push(step) {
    // Scrolling to where you already are is not a step. Two identical scrolls
    // in a row can only mean the second one had nothing to do, and a script
    // full of them is a script nobody trusts.
    const last = this.steps.at(-1);
    if (step.op === 'scroll' && last?.op === 'scroll'
        && last.to === step.to && last.target === step.target) return;

    this.steps.push(step);
    this.onStep(step, this.steps);
  }

  /**
   * Attach the last navigation's chain to the click that caused it.
   *
   * The click and the navigation arrive on different paths — one through the
   * page's ordered channel, one from Playwright's response events — so this
   * settles briefly rather than racing. A chain that has not changed since the
   * previous step is one this click did not cause.
   */
  async #noteNavigation() {
    if (!this.nav) return;
    const before = this.lastChain;
    for (let i = 0; i < 12; i++) {
      const n = this.nav.summary();
      const key = n.hops.map((h) => `${h.status}${h.url}`).join('|');
      if (key && key !== before) {
        this.lastChain = key;
        const step = this.steps.at(-1);
        if (step?.op === 'click') step.via = n.hops;
        if (n.leftOrigin) this.onNote(`the redirect chain left ${hostOf(n.hops[0].url) ?? 'the site'} for ${hostOf(n.url) ?? 'another site'}`);
        this.onStep(step, this.steps);
        return;
      }
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  /** A route change is an assertion — it is what makes a recording self-checking. */
  #noteUrl(href) {
    if (!href || href === this.lastUrl) return;
    const prev = this.lastUrl;
    this.lastUrl = href;
    if (!prev) return;
    const value = arrivalOf(href, prev);
    if (!value) return;
    const from = hostOf(prev), to = hostOf(href);
    if (from && to && from !== to) {
      this.onNote(`${this.steps.at(-1)?.op === 'click' ? 'this click leaves' : 'the page left'} ${from} for ${to} — the arrival check names the host`);
    }
    this.#push({ op: 'expect', assert: 'urlContains', value });
  }

  /**
   * Keep the first proposal that resolves to exactly one element AND to the
   * element that was interacted with. When that element is already gone — the
   * usual case for a submit — fall back to what the page counted at click time.
   */
  async #verify(candidates, id, { enclosing = false } = {}) {
    const tagged = this.page.locator(`[data-gc-el="${id}"]`);
    const tried = [];
    // A name the click itself changed — kept only if nothing resolves outright.
    let renamed = null;

    // Ask about the promising ones first.
    //
    // Each candidate costs two round trips to the browser, and a click on a
    // busy page can carry six. That is the lag you see between doing something
    // and the step appearing. The page already counted every proposal
    // synchronously at click time, so trust it for ORDER: candidates it says
    // match exactly one element go first, and the usual case resolves on the
    // first try instead of the fifth. Nothing is skipped — a wrong guess just
    // costs its place in the queue, not its chance.
    const ordered = [...candidates].sort((a, b) => rank(a.n) - rank(b.n));

    for (const cand of ordered) {
      const { target, n } = cand;
      let parsed;
      try { parsed = parseTarget(target); } catch { continue; }   // not in the grammar

      // A proposal that names the box the interaction happened INSIDE is only
      // as good as the interaction. Hovering a card's wrapper hovers the card;
      // clicking a wrapper clicks whatever happens to sit at its centre, which
      // is not the same promise at all.
      if (cand.enclosing && !enclosing) {
        tried.push(`${target} (names the surrounding box, not the element)`);
        continue;
      }

      let loc, found;
      try {
        loc = locate(this.page, parsed);
        found = await loc.count();
      } catch (e) {
        tried.push(`${target} (${e.message.split('\n')[0]})`);
        continue;
      }

      if (found === 1) {
        if (await loc.and(tagged).count() === 1) return { target, via: 'live' };
        // Naming an element that CONTAINS what was interacted with — only ever
        // reached when the proposer had nothing for the element itself, and
        // only for kinds where that is the same gesture.
        if (cand.enclosing && await loc.locator('*').and(tagged).count() === 1) {
          return { target, via: 'enclosing' };
        }
        // Or a unique element INSIDE the one you interacted with.
        //
        // A card link wraps a heading; naming the heading is both more readable
        // and more stable than naming the whole card, and clicking it clicks
        // the link. Requiring the exact same node rejected the better target.
        if (await tagged.locator('*').and(loc).count() === 1) return { target, via: 'inside' };

        /**
         * Or the element is not here any more, and this is a different page.
         *
         * Clicking a nav link navigates, and the page it lands on carries the
         * same nav — so "Docs" still matches exactly one element, and it is a
         * perfectly good link that we never touched. The old code read that as
         * "our name is wrong" and threw the step away; the two clicks a person
         * most wants recorded, the ones that move between pages, were the two
         * most likely to be lost.
         *
         * The discriminator is whether the tagged element exists AT ALL. The
         * attribute was set on the document we were on; nothing carries it to
         * the next one. When it is gone, what the page counted at click time is
         * the only honest evidence there is — the same reasoning the found === 0
         * branch below already relies on.
         */
        if (n === 1 && await tagged.count() === 0) return { target, via: 'click-time' };

        tried.push(`${target} (names a different element)`);
        continue;
      }
      if (found === 0) {
        // Nothing matched. Two very different reasons for that:
        //
        //  - The interaction destroyed the element. A submit hides its own
        //    form; a button behind display:none leaves the DOM but not the
        //    accessibility tree. The page's click-time count is the honest
        //    evidence, and this is what it is for.
        //
        //  - Our name is simply wrong. If the element is still sitting there,
        //    that is the case — and accepting it anyway used to hand back a
        //    target that could not possibly resolve, which then failed at
        //    replay, minutes into a run, having looked fine in the script.
        // Is it still REACHABLE, or merely still in the document?
        //
        // Visibility, not DOM presence. A submit hides its own form: the button
        // stays in the tree and leaves the accessibility tree, which is exactly
        // why a role query finds nothing and exactly when the click-time count
        // is the honest evidence. Testing for DOM presence rejected that whole
        // legitimate case and dropped the click that submits a login.
        const reachable = await tagged.and(this.page.locator('*:visible')).count();
        if (!reachable && n === 1) return { target, via: 'click-time' };
        /**
         * Or the click RENAMED it. A hamburger says "Open navigation" until it
         * is pressed and "Close navigation" after; an accordion's "Show all 7
         * questions" becomes "Hide all 7 questions". The element is right
         * there, still the role the proposal named, and the name it had at
         * click time — the one the page counted exactly one of — is the name a
         * fresh page shows at replay. Reading this as "our name is wrong"
         * dropped precisely the click that opens a menu, and the replay then
         * looked for the menu's items in a menu nobody had opened.
         *
         * Two things must hold, or this stays a drop: the proposal was unique
         * at click time, and the element's accessible name is now something
         * ELSE under the same role. A proposal that never described the
         * element has the same name now as then, and still falls through.
         * Kept as a fallback rather than returned: a later candidate that
         * resolves outright — a test id, say — is the better name.
         */
        if (reachable && n === 1 && !renamed && await this.#renamedByClick(parsed, tagged)) {
          renamed = { target, via: 'renamed' };
          tried.push(`${target} (renamed by the click — kept as the name it had)`);
          continue;
        }
        tried.push(`${target} (${reachable
          ? 'the element is still visible, so this name does not describe it'
          : n < 0 ? 'ambiguous by nature' : `${n} at click time`})`);
        continue;
      }
      /**
       * Ambiguous — so ask the browser which one it was.
       *
       * The proposer offers an ordinal, but it counts with querySelectorAll and
       * this resolves with getByRole, and the two sets are not always equal.
       * `.nth()` here indexes the exact query that will run at replay, so the
       * answer cannot disagree with itself. It costs one round trip per
       * candidate and only on the path that was previously a dead end.
       */
      if (!parsed.scope && found <= ORDINAL_MAX) {
        let at = -1;
        for (let i = 0; i < found && at < 0; i++) {
          const one = loc.nth(i);
          if (await one.and(tagged).count() === 1
            // The two relationships a unique match is already allowed, which
            // this branch forgot: the match sits INSIDE what was interacted
            // with — `text:` finds a stat's span, never the card a scroll
            // landed on — or, for a candidate naming the surrounding box, it
            // is that box. Without them a name that matched twice dropped the
            // step even when one match was plainly the element:
            // "Dropped a scroll … Tried: text:100.0% (2 matches)".
            || await one.and(tagged.locator('*')).count() === 1
            || (cand.enclosing && await one.locator('*').and(tagged).count() === 1)) at = i;
        }
        if (at >= 0) return { target: `nth${at + 1}/${target}`, via: 'ordinal' };
      }
      tried.push(`${target} (${found} matches)`);
    }
    if (renamed) return renamed;
    return { target: null, tried };
  }

  /**
   * Is the tagged element still the role a proposal named, under a different
   * accessible name than the proposal's? The name comes from the element's own
   * aria snapshot — the same model getByRole queries at replay — so "different"
   * means the query that found exactly one at click time finds none now because
   * the click changed the words, not because they were never the element's.
   * Only for role proposals: a test id or a placeholder does not change when
   * pressed, and a bare text proposal has no role to hold it to.
   */
  async #renamedByClick(parsed, tagged) {
    if (parsed.kind !== 'role') return false;
    const snap = await tagged.first().ariaSnapshot().catch(() => '');
    let line = snap.split('\n')[0].replace(/^\s*-\s+/, '');
    if (line.startsWith("'")) line = line.slice(1, line.lastIndexOf("'")).replace(/''/g, "'");
    const m = line.match(/^([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?/);
    if (!m || m[1] !== parsed.role) return false;
    const now = (m[2] ?? '').replace(/\\(.)/g, '$1');
    const fold = (t) => String(t).trim().replace(/\s+/g, ' ').toLowerCase();
    return fold(now) !== fold(parsed.name);
  }

  async #ingest(p, inFrame = undefined) {
    if (!this.recording) return;

    if (p.kind === 'url') return this.#noteUrl(p.href);
    this.#noteUrl(p.href);   // the action happened at this URL, so order it first

    // Positions with no element to name: the two that mean the same thing at
    // any viewport, and the behaviour of being sent back to the top.
    if (p.kind === 'scroll' && p.to) return this.#push({ op: 'scroll', to: p.to });
    if (p.kind === 'jumped-to-top') return this.#push({ op: 'expect', assert: 'atTop' });

    // Landing on the surrounding box is the same gesture for a hover or a
    // scroll, and a different one for a click: Playwright clicks the centre of
    // what it resolved, which for a wrapper is whatever happens to be there.
    const enclosing = p.kind === 'hover' || p.kind === 'scroll';
    const { target, tried } = await this.#verify(p.candidates ?? [], p.id, { enclosing });
    if (!target) {
      // This should now be rare: the proposer offers a positional target as a
      // last resort precisely so a step is never silently lost. If it still
      // happens, say WHICH step went missing — "could not name that element"
      // with no subject sends you looking through the whole recording.
      return this.onError(
        `Dropped a ${p.kind} — could not name that element. Tried: ` +
        `${(tried ?? []).join(', ') || '(nothing usable)'}`
      );
    }

    const at = p.at;
    // The frame is kept beside the step BEFORE anyone is told of the step:
    // the notes read it the moment the step arrives.
    const seen = (step) => { if (inFrame) this.#evidence.set(step, inFrame); return step; };
    if (p.kind === 'scroll') return this.#push(seen({ op: 'scroll', target, at }));
    if (p.kind === 'hover') return this.#push(seen({ op: 'hover', target, at }));
    if (p.kind === 'click') {
      this.#push(seen({ op: 'click', target, at }));
      // A click that navigated: keep what it went through. This is evidence,
      // not instruction — the assertions it suggests are a person's decision,
      // and #noteUrl has already filed the URL change that goes with it.
      return this.#noteNavigation();
    }
    if (p.kind === 'fill') {
      return this.#push(seen(p.secret
        ? { op: 'fill', target, valueRef: 'secrets.TODO', at }
        : { op: 'fill', target, value: p.value ?? '', at }));
    }
  }
}

/** 1 match first, then unknown, then everything the page already doubts. */
/**
 * How many matches are worth walking to find the one that was clicked.
 *
 * A nav name matches two or three things. A `text:` proposal on a content page
 * can match forty, and forty round trips to name one step is the lag you feel
 * rather than a feature.
 */
const ORDINAL_MAX = 12;

function rank(n) {
  if (n === 1) return 0;
  if (n === -1) return 1;      // `text:` — the page cannot count it
  if (n === 0) return 2;       // gone already; only the click-time count can save it
  return 3;                    // ambiguous
}

/** An address as its origin — what a frame is known by — or null for about:blank and the like. */
function originOf(u) {
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.origin : null; } catch { return null; }
}

function pathOf(u) {
  try { const x = new URL(u); return `${x.pathname}${x.hash}`; } catch { return null; }
}

/** An address as its host (with a port that is not the default), or null. */
function hostOf(u) {
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.host : null; } catch { return null; }
}

/**
 * What the arrival assertion says: the path, as ever — or host + path when
 * the step left the site, because "/turbo-ai-notetaking-app-2025-11" on the
 * page you were on and on businessinsider.com are two different arrivals, and
 * the check is a substring of the whole URL either way.
 */
function arrivalOf(href, prev) {
  const path = pathOf(href);
  if (!path) return null;
  const from = hostOf(prev), to = hostOf(href);
  if (from && to && from !== to) return `${to}${path}`;
  return path !== pathOf(prev) ? path : null;
}
