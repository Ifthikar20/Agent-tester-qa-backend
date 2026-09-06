/**
 * How an element gets named.
 *
 * Loaded in two places and deliberately written once:
 *   - the extension's content script, as a plain content_scripts entry
 *   - the server's teach mode, read off disk and injected into the page
 *
 * Both must agree, because the extension proposes a target on your machine and
 * the runner has to resolve the same one on ours. A second copy would drift and
 * you would find out on a Tuesday, in CI.
 *
 * It proposes, ordered most stable first, and counts how many elements each
 * proposal would match RIGHT NOW — synchronously, while the DOM still looks the
 * way it did when you clicked. Nothing here decides anything.
 */
(function () {
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

  const propose = (el) => {
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

  /** The first proposal that is unambiguous, for showing a human. */
  const best = (cands) => (cands.find((c) => c.n === 1) ?? cands[0])?.target ?? null;

  self.__gcPropose = { SCOPE, propose, best, roleOf, nameOf, labelText, txt };
})();
