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

  // ---- landmarks ----------------------------------------------------------
  /**
   * Which region of the page is this element in?
   *
   * Real sites repeat their nav in the footer, so "Pricing" is two links and
   * role+name names neither. The page already says which is which — the header
   * and footer are landmarks — so read that instead of inventing an id.
   *
   * <header> and <footer> are only banner/contentinfo at the top level; nested
   * inside an article or a section they are that thing's header, not the
   * page's, which is exactly what the HTML spec says and what the browser's
   * own accessibility tree does.
   */
  const LANDMARK_SEL = 'header,footer,nav,main,aside,form,[role]';
  const SECTIONING = 'article,section,aside,nav';

  const landmarkRole = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) {
      const r = explicit.trim().split(/\s+/)[0];
      return ['banner','navigation','main','contentinfo','complementary','form','search','region'].includes(r) ? r : null;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'aside') return 'complementary';
    if (tag === 'form') return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'form' : null;
    if (tag === 'header' || tag === 'footer') {
      return el.parentElement && el.parentElement.closest(SECTIONING)
        ? null                                    // a section's header, not the page's
        : (tag === 'header' ? 'banner' : 'contentinfo');
    }
    return null;
  };

  /** The innermost landmark containing this element, as an ARIA role. */
  const landmarkOf = (el) => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      if (!n.matches || !n.matches(LANDMARK_SEL)) continue;
      const r = landmarkRole(n);
      if (r) return { role: r, node: n };
    }
    return null;
  };

  /** Everything a bare `<kind>:<arg>` would match, within root. */
  const matchesFor = (kind, arg, root) => {
    const all = [...(root || document).querySelectorAll(SCOPE)];
    if (kind === 'testid') {
      return all.filter((e) => (e.getAttribute('data-testid') ?? e.getAttribute('data-test-id')) === arg);
    }
    if (kind === 'label') return all.filter((e) => labelText(e) === arg);
    if (kind === 'placeholder') return all.filter((e) => e.getAttribute('placeholder') === arg);
    if (kind === 'text') return null;   // ambiguous by nature; last resort only
    return all.filter((e) => roleOf(e) === kind && nameOf(e) === arg);
  };

  /** How many elements would this proposal match, right now? */
  const countMatching = (cand) => {
    let raw = cand, root = null, nth = 0;
    const slash = raw.indexOf('/');
    if (slash > 0) {
      const head = raw.slice(0, slash);
      const asNth = /^nth(\d+)$/.exec(head);
      if (asNth) { nth = Number(asNth[1]); raw = raw.slice(slash + 1); }
      else {
        // Scoped to a landmark: measure inside the first region of that role,
        // which is the same one locate() will pick.
        const regions = [...document.querySelectorAll(LANDMARK_SEL)].filter((n) => landmarkRole(n) === head);
        if (!regions.length) return 0;
        root = regions[0];
        raw = raw.slice(slash + 1);
      }
    }
    const i = raw.indexOf(':');
    const hits = matchesFor(raw.slice(0, i), raw.slice(i + 1), root);
    if (hits === null) return -1;
    if (nth) return nth <= hits.length ? 1 : 0;   // an ordinal names exactly one
    return hits.length;
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

    // ---- disambiguation -----------------------------------------------------
    // Everything above can be ambiguous, and on a marketing site it usually is:
    // the header nav and the footer carry the same words. Rather than give up,
    // say WHICH one, using the region the page itself declares.
    if (role && name) {
      const lm = landmarkOf(el);
      if (lm) out.push(`${lm.role}/${role}:${name}`);
    }
    if (name) out.push(`text:${name}`);

    // The last resort, and the only fragile proposal here: this element's
    // position among everything role+name matches. It survives a restyle but
    // not a reorder — which is still infinitely better than dropping the step,
    // and it is visible in the script so you know you have one.
    if (role && name) {
      const all = matchesFor(role, name, null);
      const i = all ? all.indexOf(el) : -1;
      if (i >= 0 && all.length > 1) out.push(`nth${i + 1}/${role}:${name}`);
    }

    return [...new Set(out)].map((target) => ({ target, n: countMatching(target) }));
  };

  /** The first proposal that is unambiguous, for showing a human. */
  const best = (cands) => (cands.find((c) => c.n === 1) ?? cands[0])?.target ?? null;

  self.__gcPropose = { SCOPE, propose, best, roleOf, nameOf, labelText, landmarkOf, txt };
})();
