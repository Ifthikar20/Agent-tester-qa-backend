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

  /**
   * NAME_MAX is a readability limit, not a matching one.
   *
   * A card link wraps a kicker, a heading and a summary, so its accessible name
   * is all of that text at once — 178 characters is ordinary. Truncating that
   * to keep a script readable used to produce `link:COUPLES & MONEY Joint vs.
   * Separate Bank Acc…`, which the runner then looked up with exact:true. It
   * could never match. A target that cannot possibly resolve is worse than no
   * target: it fails at replay, minutes into a run, having looked fine.
   *
   * So a name is never truncated for matching. Anything longer than this simply
   * is not offered as an exact name — `shortName` below finds something a
   * person would actually call it instead.
   */
  const NAME_MAX = 80;
  const squash = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
  const txt = (s) => squash(s);

  /**
   * Is this element in the accessibility tree at all?
   *
   * THE bug this file had. Everything below counted candidates with
   * querySelectorAll, and the runner resolves them with getByRole — which reads
   * the accessibility tree. A responsive site keeps a mobile menu in the DOM and
   * hides it with visibility:hidden, so the page counted three "Pricing" links
   * and the browser could see two. Every count was off by one and every ordinal
   * pointed one element to the left, which is how `nth1/link:Pricing` came back
   * "names a different element" and the whole step was thrown away.
   *
   * A count built on a different set than the one that will resolve it is not a
   * count, it is a guess wearing a number.
   *
   * display:none has no boxes; visibility:hidden keeps its boxes and leaves the
   * tree, which is why the box test alone was not enough and why this needs the
   * computed style. aria-hidden removes a whole subtree.
   */
  let seen = new WeakMap();
  const exposed = (el) => {
    if (seen.has(el)) return seen.get(el);
    let out = true;
    if (!el || !el.isConnected) out = false;
    else if (el.hasAttribute('hidden')) out = false;
    else if (el.tagName === 'INPUT' && el.type === 'hidden') out = false;
    else if (el.closest('[aria-hidden="true"]')) out = false;
    else if (!el.getClientRects().length && !el.offsetParent) out = false;   // display:none
    else {
      const view = el.ownerDocument.defaultView;
      const vis = view && view.getComputedStyle(el).visibility;
      if (vis === 'hidden' || vis === 'collapse') out = false;
    }
    seen.set(el, out);
    return out;
  };

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

  /**
   * The text an accessible name is computed from — which is NOT what you see.
   *
   * innerText is rendered text: `text-transform: uppercase` makes it SHOUT, and
   * `getByRole` matches the accessible name, which does not. So a kicker styled
   * uppercase produced `link:COUPLES & MONEY Joint vs…` while the browser's own
   * name was `Couples & money Joint vs…`, and the target matched nothing at all.
   *
   * textContent has the right casing but happily scrapes a stylesheet into an
   * element's name. So: walk the text nodes, skip script/style, skip anything
   * hidden. Right casing, no stylesheets.
   */
  const domText = (el) => {
    if (!el || !el.ownerDocument) return '';
    const parts = [];
    const visit = (node) => {
      if (node.nodeType === 3) { parts.push(node.nodeValue); return; }      // text
      if (node.nodeType !== 1) return;
      const tag = node.tagName.toUpperCase();
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE') return;
      if (node.hidden || node.getAttribute('aria-hidden') === 'true') return;
      if (!node.offsetParent && !node.getClientRects().length) return;      // display:none

      // An aria-label on a descendant REPLACES what is under it. That is what
      // the accessibility tree does, so it is what getByRole matched.
      const label = node.getAttribute('aria-label');
      if (label && label.trim()) { parts.push(label); return; }

      // An image contributes its alt text, and this is the line that was
      // missing. Walking text nodes alone gives an icon link — a logo, a search
      // button, a close X — the name "", so the proposer offered NOTHING for
      // it while the browser could see two links called "Support". A whole
      // class of controls simply could not be recorded.
      if (tag === 'IMG' || tag === 'AREA' || (tag === 'INPUT' && node.type === 'image')) {
        const alt = node.getAttribute('alt');
        if (alt) parts.push(alt);
        return;
      }
      // An inline <svg> names itself with a <title>, which is how most icon
      // buttons that are not <img> are built.
      if (tag === 'SVG') {
        const title = node.querySelector('title');
        if (title && title.textContent.trim()) parts.push(title.textContent);
        return;
      }
      for (const child of node.childNodes) visit(child);
    };
    for (const child of el.childNodes) visit(child);
    return parts.join(' ');
  };

  const ownText = (el) => {
    if (el.tagName === 'INPUT') return el.type === 'submit' ? el.value : '';
    return domText(el);
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

  /** Every landmark containing this element, innermost first. */
  const landmarksOf = (el) => {
    const out = [];
    for (let n = el.parentElement; n; n = n.parentElement) {
      if (!n.matches || !n.matches(LANDMARK_SEL)) continue;
      const r = landmarkRole(n);
      if (r) out.push({ role: r, node: n });
    }
    return out;
  };

  /**
   * Only the scopes that can actually name this element.
   *
   * The runner resolves `contentinfo/` as getByRole('contentinfo').first(), so a
   * scope is only truthful when the element's own region IS the first one of
   * that role. The innermost landmark used to be taken unconditionally, which
   * on any ordinary page proposed `navigation/link:Pricing` for a link in the
   * FOOTER's nav — and the header's nav is the first navigation, so it named
   * the header's Pricing every time.
   *
   * Walking outwards fixes it rather than papering over it: the footer link is
   * not in the first navigation, but it IS in the only contentinfo.
   */
  const usableLandmarks = (el) => landmarksOf(el).filter(({ role, node }) => {
    const regions = [...document.querySelectorAll(LANDMARK_SEL)]
      .filter((n) => landmarkRole(n) === role && exposed(n));
    return regions[0] === node;
  });

  /**
   * Same rule the runner uses: a whole name, ignoring case and spacing.
   *
   * These counts only order the candidates, but an ordering built on a stricter
   * comparison than the one that will actually resolve them is a lie — it says
   * "exactly one" about a name the runner will find twice.
   */
  const sameName = (a, b) =>
    squash(a || '').toLowerCase() === squash(b || '').toLowerCase();

  /** Everything a bare `<kind>:<arg>` would match, within root. */
  const matchesFor = (kind, arg, root) => {
    const all = [...(root || document).querySelectorAll(SCOPE)].filter(exposed);
    if (kind === 'testid') {
      return all.filter((e) => (e.getAttribute('data-testid') ?? e.getAttribute('data-test-id')) === arg);
    }
    if (kind === 'label') return all.filter((e) => sameName(labelText(e), arg));
    if (kind === 'placeholder') return all.filter((e) => sameName(e.getAttribute('placeholder'), arg));
    // `text:` matches on a substring, so count the elements whose text contains
    // it. Playwright picks the SMALLEST such element and this counts every one
    // in SCOPE, so the numbers can differ — but a count is still far better
    // than "unknown", which parked every text proposal behind the long exact
    // names it exists to replace.
    if (kind === 'text') {
      const needle = squash(arg).toLowerCase();
      return all.filter((e) => squash(ownText(e)).toLowerCase().includes(needle));
    }
    return all.filter((e) => roleOf(e) === kind && sameName(nameOf(e), arg));
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
        // `.first()` on the runner's side means the first landmark THE BROWSER
        // can see. A hidden mobile <nav> comes first in the DOM and is not one
        // of them, so measuring inside it scoped every proposal to a region the
        // replay would never pick.
        const regions = [...document.querySelectorAll(LANDMARK_SEL)]
          .filter((n) => landmarkRole(n) === head && exposed(n));
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

  /**
   * What a person would call this thing.
   *
   * For a link that wraps a whole card, the heading inside it is the name a
   * human would use, and it is short enough to read in a script. It is offered
   * as a `text:` target because that strategy matches on a substring — the
   * heading really is inside the accessible name, so the match is honest
   * rather than a guess dressed up as an exact one.
   */
  const shortName = (el) => {
    const heading = el.querySelector && el.querySelector('h1,h2,h3,h4,h5,h6');
    if (heading) {
      const h = squash(domText(heading));
      if (h && h.length <= NAME_MAX) return h;
    }
    // Otherwise a readable prefix, ending on a whole word — not on a sentence
    // boundary, because "vs." and "e.g." are not the ends of sentences and
    // cutting there produces a handle that reads as a bug.
    const whole = squash(nameOf(el));
    if (!whole) return null;
    const first = whole.length <= NAME_MAX ? whole : whole.slice(0, NAME_MAX).replace(/\s+\S*$/, '');
    return first.length > 11 ? first : null;
  };

  /** Every name this exact element could go by. May legitimately be empty. */
  const proposeFor = (el) => {
    const out = [];
    const testid = el.getAttribute && (el.getAttribute('data-testid') || el.getAttribute('data-test-id'));
    if (testid) out.push(`testid:${testid}`);

    const role = roleOf(el);
    const name = nameOf(el);
    const label = labelText(el);
    if (label && label.length <= NAME_MAX) out.push(`label:${label}`);

    // A long name is not a lost cause — it needs a handle rather than the whole
    // thing, and the handle goes FIRST because a script is read by people. This
    // is the search-result case, and on a content site it is everywhere.
    if (name && name.length > NAME_MAX) {
      const short = shortName(el);
      if (short) {
        out.push(`text:${short}`);
        for (const lm of usableLandmarks(el)) out.push(`${lm.role}/text:${short}`);
      }
    }

    // Exact strategies only get a name short enough to have survived intact.
    if (role && name && name.length <= NAME_MAX) out.push(`${role}:${name}`);

    const ph = el.getAttribute && el.getAttribute('placeholder');
    if (ph) out.push(`placeholder:${txt(ph)}`);

    // ---- disambiguation -----------------------------------------------------
    // Everything above can be ambiguous, and on a marketing site it usually is:
    // the header nav and the footer carry the same words. Rather than give up,
    // say WHICH one, using the region the page itself declares.
    //
    // A long name gets its landmark variant too, but AFTER the short handle
    // above — both resolve, and one of them fits on a line.
    if (role && name && name.length <= NAME_MAX) {
      for (const lm of usableLandmarks(el)) out.push(`${lm.role}/${role}:${name}`);
    }
    if (name && name.length <= NAME_MAX) out.push(`text:${name}`);

    // The last resort, and the only fragile proposal here: this element's
    // position among everything role+name matches. It survives a restyle but
    // not a reorder — which is still infinitely better than dropping the step,
    // and it is visible in the script so you know you have one.
    // Last resort for a long name: the whole thing, scoped. Unreadable, but it
    // resolves, and a step you can read beats no step at all only when the
    // readable one actually works.
    if (role && name && name.length > NAME_MAX) {
      const lms = usableLandmarks(el);
      if (lms.length) for (const lm of lms) out.push(`${lm.role}/${role}:${name}`);
      else out.push(`${role}:${name}`);
    }

    // The positional backstop still uses the FULL name — it has to, because
    // that is what the runner will look up.
    // matchesFor is now filtered to what the accessibility tree exposes, so this
    // index is the one `.nth()` will use rather than a DOM position that counts
    // elements the browser cannot see.
    if (role && name && name.length <= NAME_MAX) {
      const all = matchesFor(role, name, null);
      const i = all ? all.indexOf(el) : -1;
      if (i >= 0 && all.length > 1) out.push(`nth${i + 1}/${role}:${name}`);
    }

    return [...new Set(out)];
  };

  /**
   * How far up to look when an element has no name of its own.
   *
   * A bare <div> that reveals a menu on hover has no role, no label and no text,
   * and until now that produced "(nothing usable)" and the step was thrown away.
   * Its wrapper usually does have something — a heading, a link — and hovering
   * the wrapper hovers the child.
   *
   * Four levels, and never past a landmark. `main/` names half the page: a
   * target that resolves and does the wrong thing is worse than one that
   * obviously did not resolve, and the verifier only accepts these for the
   * interactions where landing on the enclosing box is genuinely equivalent.
   */
  const CLIMB_MAX = 4;

  const propose = (el) => {
    // A fresh cache per proposal. Visibility changes between one interaction
    // and the next — a menu opens, a modal closes — so an answer from the last
    // click is not an answer about this one. (Replaced rather than cleared: a
    // WeakMap has no clear(), and calling one that is not there silently keeps
    // every stale entry.)
    seen = new WeakMap();

    const mine = proposeFor(el);
    if (mine.length) return mine.map((target) => ({ target, n: countMatching(target) }));

    for (let n = el.parentElement, d = 0; n && d < CLIMB_MAX; n = n.parentElement, d++) {
      if (landmarkRole(n)) break;
      const up = proposeFor(n);
      // `enclosing` is the honest label: this names a box the interaction
      // happened inside, not the thing itself. The verifier decides whether
      // that is good enough for the kind of interaction it was.
      if (up.length) return up.map((target) => ({ target, n: countMatching(target), enclosing: true }));
    }
    return [];
  };

  /** The first proposal that is unambiguous, for showing a human. */
  const best = (cands) => (cands.find((c) => c.n === 1) ?? cands[0])?.target ?? null;

  self.__gcPropose = { SCOPE, propose, proposeFor, best, roleOf, nameOf, labelText, landmarkOf, landmarksOf, usableLandmarks, shortName, txt, NAME_MAX };
})();
