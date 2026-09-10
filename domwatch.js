/**
 * "On this page", kept true when the page changes without navigating.
 *
 * Discovery reads the accessibility tree on navigation and on Re-scan. So a
 * click that opened an accordion, a menu or a dialog left the target panel
 * describing the page as it was before the click: the new controls were right
 * there on the canvas and nowhere in the list. They cannot be listed early
 * either — collapsed content is not in the tree at all, which is exactly what
 * collapsed means to a screen reader — so the only fix is to read it again.
 *
 * Two halves. PAGE_SCRIPT runs in the driven page and reports that it changed
 * shape: an element added or removed, one of the attributes a disclosure widget
 * flips, or a click, key or change that may have toggled a class the observer
 * deliberately does not watch. targetRefresher() is the server's half: it reads
 * again once the page settles, at most every REFRESH_MS, never while a run
 * holds the page, and says nothing when the list did not change — a marketing
 * page mutates constantly, and almost none of it is new controls.
 */

/**
 * What opens, closes, shows or hides something. Not `class` or `style`: those
 * change on every frame of an animation, and a counter ticking up would have
 * the tree re-read for as long as the page is open.
 */
const WATCHED = ['open', 'hidden', 'inert', 'disabled', 'aria-expanded', 'aria-hidden', 'aria-selected'];

/** At most one read of the accessibility tree per this many milliseconds. */
export const REFRESH_MS = 1500;

export const PAGE_SCRIPT = `(() => {
  if (window.__gcDomWatch) return;
  window.__gcDomWatch = true;

  let timer = 0;
  const changed = (delay) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try { window.__gcDomChanged(); } catch (e) { /* binding not attached yet */ }
    }, delay);
  };

  const start = () => new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') return changed(300);
      // Elements only: a number counting up replaces a text node many times a
      // second, and that is not a new control.
      for (const n of r.addedNodes) if (n.nodeType === 1) return changed(300);
      for (const n of r.removedNodes) if (n.nodeType === 1) return changed(300);
    }
  }).observe(document.documentElement, {
    subtree: true, childList: true, attributes: true, attributeFilter: ${JSON.stringify(WATCHED)},
  });
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });

  // A panel shown by toggling a class changes nothing the observer watches.
  for (const type of ['click', 'change', 'keyup']) {
    document.addEventListener(type, () => changed(600), true);
  }
})();`;

/**
 * The server's half: a function to call whenever the page says it changed.
 *
 *   read()      -> { url, items }   discovery, the way publishTargets does it
 *   publish(r)                      send it to the console
 *   busy()      -> boolean          true while a run holds the page; a run
 *                                   publishes its own targets when it ends
 *
 * A burst of calls is one read. A read already in flight is followed by exactly
 * one more, so the last change is never the one that goes unread.
 */
export function targetRefresher({ read, publish, busy, every = REFRESH_MS }) {
  let timer = null;
  let reading = false;
  let again = false;
  let last = 0;
  let shown = '';

  const refresh = async () => {
    if (busy()) return;
    if (reading) { again = true; return; }
    reading = true;
    try {
      const got = await read();
      const key = `${got.url}\n${got.items.map((t) => t.target).join('\n')}`;
      if (key !== shown) {
        shown = key;
        publish(got);
      }
    } catch {
      // Mid-navigation, usually. framenavigated publishes the page that won.
    } finally {
      last = Date.now();
      reading = false;
      if (again) { again = false; soon(); }
    }
  };

  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, Math.max(250, last + every - Date.now()));
  };
  return soon;
}

/**
 * Install both halves on a page. The binding goes on first, so the page's first
 * report has somewhere to land; the init script covers every later document,
 * and the evaluate covers the one already open.
 */
export async function watchDom(page, onChange) {
  await page.exposeBinding('__gcDomChanged', () => onChange());
  await page.addInitScript({ content: PAGE_SCRIPT });
  await page.evaluate(PAGE_SCRIPT).catch(() => { /* navigating; the init script has the next document */ });
}
