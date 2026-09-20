/**
 * Where a press lands.
 *
 * A replay resolves an element by name and then has to press it somewhere.
 * "The centre of its box" was that somewhere, and it is wrong for one common
 * shape: an inline link that wraps onto two lines. Its box is the union of two
 * line boxes, and the centre of that union is the gap between them — a pixel
 * the paragraph owns, not the link. The press went to the paragraph, the step
 * reported success, and the check after it failed with a sentence about the
 * wrong thing.
 *
 * So a press is aimed at one of the element's OWN boxes (`getClientRects`:
 * one per line for inline content, one for anything else), and the pixel is
 * hit-tested before the press: what is under it has to be the element, inside
 * it, or something the page routes to it. When no box takes the press, the
 * step stops and says what would have been pressed instead — a press that
 * misses is exactly the failure this file exists to prevent.
 *
 * The two in-page functions are serialised into the page by Playwright, so
 * they use nothing from this module. Everything else runs in Node and is pure
 * geometry, which is what makes it identical in every checkout that has it.
 */

/**
 * IN-PAGE. The element's boxes, relative to its bounding rect, clipped to the
 * window, empty ones dropped — in document order, so the first line is first.
 */
export function rectsOf(el) {
  const b = el.getBoundingClientRect();
  const out = [];
  for (const q of el.getClientRects()) {
    if (!(q.width > 0 && q.height > 0)) continue;
    const x1 = Math.max(q.left, 0), y1 = Math.max(q.top, 0);
    const x2 = Math.min(q.right, window.innerWidth), y2 = Math.min(q.bottom, window.innerHeight);
    if (x2 - x1 <= 0 || y2 - y1 <= 0) continue;
    out.push({ x: x1 - b.left, y: y1 - b.top, w: x2 - x1, h: y2 - y1 });
  }
  return out;
}

/**
 * IN-PAGE. Would a press at (rect.left + dx, rect.top + dy) reach `el`?
 *
 * ok when what is under the pixel is the element, something inside it, a
 * <label> whose control it is, or an ancestor the page routes the pointer to
 * (everything from the element up to it has pointer-events: none). Not ok when
 * an ancestor got it for any other reason — a gap the element does not paint
 * (`around`) — when an unrelated element sits over it (`over`), or when the
 * pixel is outside the window (`nothing`). Looks through open shadow roots.
 *
 * `on` is what the press lands on, `what` is the thing in the way, `self` is
 * the word for the element — all plain words, for the sentences below.
 */
export function hitAt(el, { dx, dy }) {
  const CONTROL = 'a[href], button, input, select, textarea, summary, [role], [tabindex]';
  const word = (e) => {
    if (!e || e === document.documentElement || e === document.body) return 'page';
    const tag = e.tagName.toLowerCase();
    const role = e.getAttribute && e.getAttribute('role');
    if (role) return role;
    if (tag === 'a') return e.hasAttribute('href') ? 'link' : 'text';
    if (tag === 'button' || (tag === 'input' && /^(button|submit|reset|image)$/i.test(e.type))) return 'button';
    if (tag === 'input' || tag === 'textarea') return 'field';
    if (tag === 'select') return 'dropdown';
    if (tag === 'option') return 'option';
    if (tag === 'label') return 'label';
    if (tag === 'p') return 'paragraph';
    if (tag === 'li') return 'list item';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'td' || tag === 'th') return 'cell';
    if (tag === 'img') return 'image';
    if (tag === 'svg' || e instanceof SVGElement) return 'icon';
    return tag;
  };
  const label = (e) => {
    const t = ((e.getAttribute && (e.getAttribute('aria-label') || e.getAttribute('alt'))) || e.textContent || '')
      .replace(/\s+/g, ' ').trim();
    return t ? `${word(e)} "${t.length > 40 ? `${t.slice(0, 40)}…` : t}"` : word(e);
  };
  const up = (e) => e.parentElement ?? (e.parentNode instanceof ShadowRoot ? e.parentNode.host : null);
  const inside = (outer, inner) => { for (let e = inner; e; e = up(e)) if (e === outer) return true; return false; };
  const deepAt = (px, py) => {
    let e = document.elementFromPoint(px, py);
    while (e && e.shadowRoot) {
      const inner = e.shadowRoot.elementFromPoint(px, py);
      if (!inner || inner === e) break;
      e = inner;
    }
    return e;
  };
  const control = (el.closest && el.closest(CONTROL)) || el;
  const self = word(control);
  const b = el.getBoundingClientRect();
  const x = b.left + dx, y = b.top + dy;
  const off = x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight;
  const hit = off ? null : deepAt(x, y);
  const ok = (relation) => ({ ok: true, relation, on: label(control), what: 'the element', self });
  if (!hit) return { ok: false, relation: 'nothing', on: 'nothing', what: 'nothing', self };
  if (hit === el) return ok('on');
  if (inside(el, hit)) return ok('inside');
  const lab = hit.closest && hit.closest('label');
  if (lab && lab.control === el) return ok('label');
  if (inside(hit, el)) {
    let through = true;
    for (let e = el; e && e !== hit; e = up(e)) {
      if (getComputedStyle(e).pointerEvents !== 'none') { through = false; break; }
    }
    if (through) return ok('through');
    return { ok: false, relation: 'around', on: label(hit), what: word(hit), self };
  }
  return { ok: false, relation: 'over', on: label(hit), what: label(hit), self };
}

/**
 * The box to press: with several boxes, the one holding the recorded point
 * (scaled to this window), else the largest — the line with the most of the
 * words on it. With one box or none, the bounding box itself, so an element
 * that was never the problem is pressed exactly where it always was.
 */
export function pickRect(rects, box, opts = {}, viewport = null) {
  if (!Array.isArray(rects) || rects.length < 2) return { rect: box, rects: [] };
  const abs = rects.map((r) => ({ x: box.x + r.x, y: box.y + r.y, width: r.w, height: r.h }));
  const at = opts.at;
  if (at && viewport) {
    const sx = viewport.width / (at.vw || viewport.width);
    const sy = viewport.height / (at.vh || viewport.height);
    const px = at.x * sx, py = at.y * sy;
    const holds = abs.find((r) => px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height);
    if (holds) return { rect: holds, rects: abs };
  }
  const largest = abs.reduce((a, r) => (r.width * r.height > a.width * a.height ? r : a), abs[0]);
  return { rect: largest, rects: abs };
}

/** The pixel inside a box: its centre, or near its left edge for a field. */
export function aimIn(rect, opts = {}) {
  const x = rect.x + (opts.leftEdge ? Math.min(14, rect.width / 2) : rect.width / 2);
  return [x, rect.y + rect.height / 2];
}

/**
 * Where to press `node`, whose bounding box is `box` (from boundingBox(), in
 * page coordinates; the rects are read in the element's own frame and mapped
 * through it, so a frame's element is aimed at like any other).
 */
export async function aimAt(node, box, opts = {}, viewport = null) {
  const rel = await node.evaluate(rectsOf).catch(() => []);
  const { rect, rects } = pickRect(rel, box, opts, viewport);
  const [x, y] = aimIn(rect, opts);
  return { box, rects, rect, x, y };
}

/** What a press at page pixel (x, y) would land on, asked of the element's own frame. */
export const landing = (node, box, x, y) => node.evaluate(hitAt, { dx: x - box.x, dy: y - box.y });

/**
 * Did we end up anywhere near where the human clicked?
 *
 * The recorded point is NOT how the element is found — resolving it by name is
 * what survives a layout change. But it is evidence, and it is the only thing
 * that catches a target which resolves cleanly to the wrong element: the name
 * matched, one node came back, and it sits nowhere near where you pointed.
 *
 * Takes an aim ({ box, rects, x, y }) or a bare box. "Inside" means inside any
 * of the element's boxes, and the point reported is the one that will be
 * pressed; an element with one box gives exactly the numbers it always did.
 */
export function drift(at, aim, viewport) {
  if (!at || !viewport || !aim) return null;
  const aimed = 'rect' in aim;
  const box = aimed ? aim.box : aim;
  const rects = aimed && aim.rects.length ? aim.rects : [box];
  const sx = viewport.width / (at.vw || viewport.width);
  const sy = viewport.height / (at.vh || viewport.height);
  const px = at.x * sx, py = at.y * sy;
  const inside = rects.some((r) => px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height);
  if (inside) return null;
  const cx = aimed ? aim.x : box.x + box.width / 2;
  const cy = aimed ? aim.y : box.y + box.height / 2;
  return { px: Math.round(px), py: Math.round(py), cx: Math.round(cx), cy: Math.round(cy),
           dist: Math.round(Math.hypot(cx - px, cy - py)) };
}

/**
 * The sentence when no box of the element takes a press. The first line
 * carries no numbers, so a defect filed on it is the same defect run after
 * run; the pixels tried go on their own line.
 */
export function missMessage(target, hit, tried = []) {
  const self = hit?.self || 'element';
  const where = hit?.relation === 'nothing' ? 'outside the window'
    : hit?.relation === 'around' ? `on the ${hit.what} around the ${self}`
      : `on ${hit?.what ?? 'something else'} over the ${self}`;
  return `"${target}" is on the page, but the press would land ${where}, not on the ${self} — so nothing was pressed.` +
    '\n  A press that misses reports success, and the case fails later, at a check, with the wrong sentence.' +
    (tried.length ? `\n  Tried ${tried.map(([x, y]) => `${Math.round(x)},${Math.round(y)}`).join(' and ')}.` : '');
}

/**
 * The sentence when a URL check gives up: what IS true, told from the press
 * before it. `press` is what the click or key recorded about itself — how it
 * was made, what it landed on, the URL and the navigation count at the time —
 * or null when nothing has been pressed since the page was opened. `nav` is
 * the navigation log's summary, when there is one.
 */
export function arrivalFailure(value, seen, press = null, nav = null, waitedMs = 8000) {
  const head = `expected the URL to contain "${value}"`;
  if (!press) return `${head}, but it is "${seen}"`;
  const navigated = Boolean(nav && Number.isFinite(nav.seq) && nav.seq > press.navSeq);
  if (seen === press.urlBefore && !navigated) {
    return `${head}, but it is still "${seen}" — the page did not change after ${press.how}` +
      (press.on ? `; the press landed on the ${press.on}` : '') +
      `, and nothing navigated in the ${(waitedMs / 1000).toFixed(1)}s this waited.` +
      '\n  A link that opens a new tab, a download, a menu, or a handler that did nothing all look like this from here.';
  }
  const redirects = navigated ? Number(nav.redirects) || 0 : 0;
  const via = redirects ? ` through ${redirects} redirect${redirects === 1 ? '' : 's'}` : '';
  return `${head}, but ${press.how} took the page to "${seen}"${via}, which does not contain it`;
}
