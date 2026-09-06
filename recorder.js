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

  function send(msg) {
    try { window.__gcRecord(msg); } catch (e) { /* binding not attached yet */ }
  }

  function report(kind, el, extra, ev) {
    if (!el || !el.getAttribute) return;
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
      send(msg);
    } catch (e) { /* the element went away mid-measure */ }
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

  document.addEventListener('click', function (e) {
    // A click on nothing in particular is not an action. Recording it anyway
    // means naming a <div> by whatever text happens to be inside it, which is
    // exactly the unstable target a recorder exists to avoid.
    var el = e.target.closest(SCOPE);
    if (!el) return;
    var tag = el.tagName.toLowerCase();
    // Clicking a text field is just focus; the change that follows carries the
    // real intent. Checkboxes and radios are the exception — the click IS it.
    if (FIELD.test(tag) && ['checkbox','radio','submit','button'].indexOf(el.type) === -1) return;

    // Was this even on the page before the pointer went looking for it?
    if (!baseline.has(el)) {
      var opener = openerOf(el);
      if (opener) report('hover', opener, null, null);
    }
    var before = window.scrollY;
    clickAt = Date.now();
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
      try { window.__gcRecord({ kind: 'url', href: location.href }); } catch (e) {}
    });
  });
})();
`;

const INJECT = `${PROPOSE_SRC}\n${LISTENERS}`;

export class Recorder {
  constructor(page, { onStep, onError } = {}) {
    this.page = page;
    this.onStep = onStep ?? (() => {});
    this.onError = onError ?? (() => {});
    this.recording = false;
    this.steps = [];
    this.lastUrl = null;
    this.queue = Promise.resolve();   // one at a time, in arrival order
  }

  async attach() {
    await this.page.exposeBinding('__gcRecord', (_src, payload) => {
      this.queue = this.queue
        .then(() => this.#ingest(payload))
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

  /** A route change is an assertion — it is what makes a recording self-checking. */
  #noteUrl(href) {
    if (!href || href === this.lastUrl) return;
    const prev = this.lastUrl;
    this.lastUrl = href;
    if (!prev) return;
    const path = pathOf(href);
    if (path && path !== pathOf(prev)) {
      this.#push({ op: 'expect', assert: 'urlContains', value: path });
    }
  }

  /**
   * Keep the first proposal that resolves to exactly one element AND to the
   * element that was interacted with. When that element is already gone — the
   * usual case for a submit — fall back to what the page counted at click time.
   */
  async #verify(candidates, id) {
    const tagged = this.page.locator(`[data-gc-el="${id}"]`);
    const tried = [];

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

    for (const { target, n } of ordered) {
      try { parseTarget(target); } catch { continue; }   // not in the grammar

      let loc, found;
      try {
        loc = locate(this.page, parseTarget(target));
        found = await loc.count();
      } catch (e) {
        tried.push(`${target} (${e.message.split('\n')[0]})`);
        continue;
      }

      if (found === 1) {
        if (await loc.and(tagged).count() === 1) return { target, via: 'live' };
        // Or a unique element INSIDE the one you interacted with.
        //
        // A card link wraps a heading; naming the heading is both more readable
        // and more stable than naming the whole card, and clicking it clicks
        // the link. Requiring the exact same node rejected the better target.
        if (await tagged.locator('*').and(loc).count() === 1) return { target, via: 'inside' };
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
        const survived = await tagged.count();
        if (!survived && n === 1) return { target, via: 'click-time' };
        tried.push(`${target} (${survived
          ? 'the element is still on the page, so this name does not describe it'
          : n < 0 ? 'ambiguous by nature' : `${n} at click time`})`);
        continue;
      }
      tried.push(`${target} (${found} matches)`);
    }
    return { target: null, tried };
  }

  async #ingest(p) {
    if (!this.recording) return;

    if (p.kind === 'url') return this.#noteUrl(p.href);
    this.#noteUrl(p.href);   // the action happened at this URL, so order it first

    // Positions with no element to name: the two that mean the same thing at
    // any viewport, and the behaviour of being sent back to the top.
    if (p.kind === 'scroll' && p.to) return this.#push({ op: 'scroll', to: p.to });
    if (p.kind === 'jumped-to-top') return this.#push({ op: 'expect', assert: 'atTop' });

    const { target, tried } = await this.#verify(p.candidates ?? [], p.id);
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
    if (p.kind === 'scroll') return this.#push({ op: 'scroll', target, at });
    if (p.kind === 'hover') return this.#push({ op: 'hover', target, at });
    if (p.kind === 'click') return this.#push({ op: 'click', target, at });
    if (p.kind === 'fill') {
      return this.#push(p.secret
        ? { op: 'fill', target, valueRef: 'secrets.TODO', at }
        : { op: 'fill', target, value: p.value ?? '', at });
    }
  }
}

/** 1 match first, then unknown, then everything the page already doubts. */
function rank(n) {
  if (n === 1) return 0;
  if (n === -1) return 1;      // `text:` — the page cannot count it
  if (n === 0) return 2;       // gone already; only the click-time count can save it
  return 3;                    // ambiguous
}

function pathOf(u) {
  try { const x = new URL(u); return `${x.pathname}${x.hash}`; } catch { return null; }
}
