/**
 * Teach mode.
 *
 * You drive the app by hand on the canvas; this watches and writes the script.
 * Because canvas clicks go through VirtualCursor -> CDP -> real DOM events, an
 * injected capture-phase listener sees them exactly as it would see a human on
 * a real browser. Nothing here is reachable from a generated plan: the script
 * below is fixed, shipped code, not something the DSL can produce.
 *
 * Two things make it trustworthy rather than merely clever:
 *
 *  - The page never decides on a target, it PROPOSES several. Each proposal is
 *    resolved with the same locator the executor will use and kept only if it
 *    matches exactly one element, and that element is the one interacted with.
 *
 *  - A click usually destroys the thing that was clicked — submit a form and
 *    the form is gone before any async check can run. So the page also counts
 *    matches synchronously, at event time, while the DOM still looks the way
 *    it did. Playwright's verdict wins when the element survives; the in-page
 *    count is what stands in when it doesn't.
 *
 * Everything reaches the recorder through one ordered channel from the page,
 * URL changes included. Watching navigation separately raced the bindings and
 * filed clicks after the page transitions they caused.
 */
import { parseTarget, locate } from './targets.js';

/** Runs in the page. Proposes and counts; never decides. */
function inPageRecorder() {
  if (window.__gcRecorderInstalled) return;
  window.__gcRecorderInstalled = true;

  let n = 0;
  const SCOPE = 'a,button,input,select,textarea,[role],[data-testid],[onclick],[tabindex]';
  const txt = (s) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);

  const ROLE_BY_TAG = { a: 'link', button: 'button', select: 'combobox', textarea: 'textbox' };
  const ROLE_BY_INPUT = {
    button: 'button', submit: 'button', reset: 'button', image: 'button',
    checkbox: 'checkbox', radio: 'radio', search: 'searchbox', range: 'slider',
    number: 'spinbutton',
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit.trim().split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') return ROLE_BY_INPUT[el.type] ?? 'textbox';
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return ROLE_BY_TAG[tag] ?? null;
  };

  const labelText = (el) => {
    if (el.labels && el.labels.length) return txt(el.labels[0].textContent);
    const wrap = el.closest && el.closest('label');
    if (wrap) return txt(wrap.textContent);
    const by = el.getAttribute && el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
      if (txt(t)) return txt(t);
    }
    return '';
  };

  const ownText = (el) => {
    if (el.tagName === 'INPUT') return el.type === 'submit' ? el.value : '';
    // innerText is layout-aware, so it skips <style>/<script> and hidden nodes.
    // textContent would happily scrape a stylesheet into an element's "name".
    return el.innerText ?? el.textContent ?? '';
  };

  const nameOf = (el) =>
    txt(el.getAttribute && el.getAttribute('aria-label')) ||
    labelText(el) ||
    txt(ownText(el)) ||
    txt(el.getAttribute && el.getAttribute('title'));

  /** How many elements would this proposal match, right now? */
  const countMatching = (cand) => {
    const i = cand.indexOf(':');
    const kind = cand.slice(0, i);
    const arg = cand.slice(i + 1);
    const all = [...document.querySelectorAll(SCOPE)];
    if (kind === 'testid') {
      return all.filter((e) => (e.getAttribute('data-testid') ?? e.getAttribute('data-test-id')) === arg).length;
    }
    if (kind === 'label') return all.filter((e) => labelText(e) === arg).length;
    if (kind === 'placeholder') return all.filter((e) => e.getAttribute('placeholder') === arg).length;
    if (kind === 'text') return -1;   // ambiguous by nature; last resort only
    return all.filter((e) => roleOf(e) === kind && nameOf(e) === arg).length;
  };

  // Most stable first. The server keeps the first that holds up.
  const candidates = (el) => {
    const out = [];
    const testid = el.getAttribute && (el.getAttribute('data-testid') || el.getAttribute('data-test-id'));
    if (testid) out.push(`testid:${testid}`);

    const role = roleOf(el);
    const name = nameOf(el);
    const label = labelText(el);
    if (label) out.push(`label:${label}`);
    if (role && name) out.push(`${role}:${name}`);

    const ph = el.getAttribute && el.getAttribute('placeholder');
    if (ph) out.push(`placeholder:${txt(ph)}`);
    if (name) out.push(`text:${name}`);

    return [...new Set(out)].map((target) => ({ target, n: countMatching(target) }));
  };

  const report = (kind, el, extra = {}) => {
    if (!el || !el.getAttribute) return;
    const id = 'gc' + ++n;
    el.setAttribute('data-gc-el', id);
    try {
      // href rides along so URL changes stay ordered with the actions.
      window.__gcRecord({ kind, id, href: location.href, candidates: candidates(el), ...extra });
    } catch { /* binding not attached yet */ }
  };

  const FIELD = /^(input|textarea|select)$/;

  document.addEventListener('click', (e) => {
    // A click on nothing in particular is not an action. Recording it anyway
    // means naming a <div> by whatever text happens to be inside it, which is
    // exactly the unstable target a recorder exists to avoid.
    const el = e.target.closest(SCOPE);
    if (!el) return;
    const tag = el.tagName.toLowerCase();
    // Clicking a text field is just focus; the `change` that follows carries
    // the real intent. Checkboxes and radios are the exception — there the
    // click IS the action.
    if (FIELD.test(tag) && !['checkbox', 'radio', 'submit', 'button'].includes(el.type)) return;
    report('click', el);
  }, true);

  document.addEventListener('change', (e) => {
    const el = e.target;
    const tag = el.tagName && el.tagName.toLowerCase();
    if (!FIELD.test(tag)) return;
    if (['checkbox', 'radio'].includes(el.type)) return;   // recorded as a click
    report('fill', el, {
      // A typed password never leaves the page. The script gets a vault
      // reference that fails loudly until someone maps it.
      secret: el.type === 'password',
      value: el.type === 'password' ? null : String(el.value ?? '').slice(0, 500),
    });
  }, true);

  for (const ev of ['popstate', 'hashchange']) {
    window.addEventListener(ev, () => {
      try { window.__gcRecord({ kind: 'url', href: location.href }); } catch {}
    });
  }
}

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
    await this.page.addInitScript(inPageRecorder);
    // The page is already open, so install into it too rather than waiting for
    // the next navigation.
    await this.page.evaluate(inPageRecorder).catch(() => {});
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
   * usual case for a submit — fall back to what the page counted at the moment
   * of the click.
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

    if (p.kind === 'click') return this.#push({ op: 'click', target });
    if (p.kind === 'fill') {
      return this.#push(p.secret
        ? { op: 'fill', target, valueRef: 'secrets.TODO' }
        : { op: 'fill', target, value: p.value ?? '' });
    }
  }
}

function pathOf(u) {
  try { const x = new URL(u); return `${x.pathname}${x.hash}`; } catch { return null; }
}
