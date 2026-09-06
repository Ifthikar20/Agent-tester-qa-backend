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
      window.__gcRecord(msg);
    } catch (e) { /* binding not attached yet */ }
  }

  var FIELD = /^(input|textarea|select)$/;

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
    report('click', el, null, e);
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

  start(url) {
    this.recording = true;
    this.steps = url ? [{ op: 'goto', url }] : [];
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

    for (const { target, n } of candidates) {
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
        tried.push(`${target} (names a different element)`);
        continue;
      }
      if (found === 0) {
        // The interaction changed the page out from under us: a submit hides
        // its own form, and a button behind display:none leaves the DOM tree
        // but not the accessibility tree, so the role query finds nothing.
        // What the page counted at click time is the honest evidence here.
        if (n === 1) return { target, via: 'click-time' };
        tried.push(`${target} (${n < 0 ? 'ambiguous by nature' : n + ' at click time'})`);
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

    const { target, tried } = await this.#verify(p.candidates ?? [], p.id);
    if (!target) {
      // Say so rather than emitting something unproven — a recorder you cannot
      // trust is worse than no recorder.
      return this.onError(
        `Could not name that element uniquely. Tried: ${(tried ?? []).join(', ') || '(nothing usable)'}`
      );
    }

    const at = p.at;
    if (p.kind === 'click') return this.#push({ op: 'click', target, at });
    if (p.kind === 'fill') {
      return this.#push(p.secret
        ? { op: 'fill', target, valueRef: 'secrets.TODO', at }
        : { op: 'fill', target, value: p.value ?? '', at });
    }
  }
}

function pathOf(u) {
  try { const x = new URL(u); return `${x.pathname}${x.hash}`; } catch { return null; }
}
