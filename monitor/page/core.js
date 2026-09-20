// ---------------------------------------------------------------------------
// core.js — the shared runtime of the monitoring agent inside the driven page.
//
// monitor-page.js reads this file, picker.js and watcher.js off disk and wraps
// the three in ONE function body, so everything here is in scope for the other
// two. Installed by page.addInitScript (every document) and page.evaluate (the
// one already open), which is how recorder.js installs its own listeners.
//
// Nothing touches the DOM at install time: the init script runs before <body>,
// and a page nobody is monitoring must be left exactly as it was — the overlay
// host is created the first time it is needed (a pick, a flash).
//
// A monitor's target is an element — or the reserved selector `:page`, which
// is the document itself measured as blocks (measurePage).
//
// Everything the page hands the runner goes through bindings the runner
// exposed (`__gcMonitorReport`, `__gcMonitorSelected`, `__gcMonitorList`); with
// none of them present this logs to the console and does nothing else.
//
// Ported from the monitoring proof of concept's injected/core.js.
// ---------------------------------------------------------------------------
if (window.__gcMonitor && window.__gcMonitor.v === 1) return;

const GM = {
  v: 1,
  picking: false,
  host: null,
  shadow: null,
  ui: {},
  monitors: new Map(),      // id -> watcher entry (see watcher.js)
  selected: null,           // { el, selector, fingerprint, snapshot, label }
  flashEl: null,
};
window.__gcMonitor = GM;

// ---- messaging (page -> runner). Falls back to the console when opened without the runner.
function send(name, payload) {
  const fn = window[name];
  if (typeof fn === 'function') {
    try { return fn(payload); } catch (err) { console.debug('[gc-monitor] ' + name + ' failed', err); return undefined; }
  }
  console.debug('[gc-monitor] ' + name, payload);
  return undefined;
}
function hasBackend() { return typeof window.__gcMonitorReport === 'function'; }

// ---- small utils
const r1 = (n) => Math.round(n * 10) / 10;
const ri = (n) => Math.round(n);
function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
function collapse(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
function cssEscape(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/([^\w-])/g, '\\$1'); }
function tagOf(el) { return el && el.tagName ? el.tagName.toLowerCase() : ''; }

// ---- overlay host: a shadow root, so host-page CSS cannot touch us and, just
// as important, so nothing we draw is a mutation the page's own observers
// (the runner's settle() and recorder watch document) can see.
const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; }
#hl { position: fixed; pointer-events: none; background: rgba(59,130,246,.18); outline: 1.5px solid #3b82f6; display: none; z-index: 3; }
#hl-label { position: fixed; pointer-events: none; display: none; background: #1e293b; color: #f8fafc; font: 11px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; padding: 3px 6px; border-radius: 4px; white-space: nowrap; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; box-shadow: 0 2px 8px rgba(0,0,0,.3); z-index: 4; }
#hl-label b { color: #93c5fd; font-weight: 600; }
#hl-label i { color: #fde68a; font-style: normal; margin-left: 6px; }
#sel { position: fixed; pointer-events: none; outline: 2px solid #2563eb; outline-offset: 1px; display: none; z-index: 2; }
#flash { position: fixed; pointer-events: none; outline: 3px solid #ef4444; background: rgba(239,68,68,.15); display: none; z-index: 2; }
`;

function ensureHost() {
  if (GM.host && GM.host.isConnected) return GM.shadow;
  if (GM.host) { try { GM.host.remove(); } catch (_) {} }
  const host = document.createElement('gc-monitor-root');
  host.setAttribute('data-gc-monitor', '');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;margin:0;padding:0;border:0;display:block;';
  const shadow = host.attachShadow({ mode: 'open' });
  let styled = false;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(STYLE);
    shadow.adoptedStyleSheets = [sheet];
    styled = true;
  } catch (_) { /* older engines */ }
  if (!styled) { const st = document.createElement('style'); st.textContent = STYLE; shadow.appendChild(st); }
  const mk = (id) => { const e = document.createElement('div'); e.id = id; shadow.appendChild(e); return e; };
  GM.ui.hl = mk('hl');
  GM.ui.hlLabel = mk('hl-label');
  GM.ui.sel = mk('sel');
  GM.ui.flash = mk('flash');
  (document.documentElement || document.body).appendChild(host);
  GM.host = host;
  GM.shadow = shadow;
  return shadow;
}
function isOurs(node) {
  if (!node) return false;
  if (node === GM.host) return true;
  if (!GM.shadow) return false;
  const root = typeof node.getRootNode === 'function' ? node.getRootNode() : null;
  return root === GM.shadow;
}

// ---- measurement -------------------------------------------------------------
const STYLE_KEYS = ['fontSize', 'lineHeight', 'fontFamily', 'fontWeight', 'color', 'backgroundColor', 'display',
  'visibility', 'opacity', 'position', 'overflow', 'width', 'height', 'padding', 'margin', 'border', 'zIndex'];

function positioningOf(el) {
  let cur = el, hops = 0;
  while (cur && cur.nodeType === 1 && hops < 12) {
    const p = getComputedStyle(cur).position;
    if (p === 'fixed') return 'fixed';
    if (p === 'sticky') return 'sticky';
    cur = cur.parentElement; hops++;
  }
  return 'static';
}
function rowCountOf(el) {
  const tag = tagOf(el);
  if (tag === 'tbody' || tag === 'thead' || tag === 'tfoot') return el.rows.length;
  let table = null;
  if (tag === 'table') table = el;
  else { const t = el.getElementsByTagName('table'); if (t.length === 1) table = t[0]; }
  if (!table) return null;
  let n = 0;
  for (const b of table.tBodies) n += b.rows.length;
  return n;
}
function missingSnapshot() { return { exists: false, ts: Date.now(), url: location.href, sig: 'missing' }; }

// ---- the whole page ----------------------------------------------------------
// A monitor on `:page` watches everything at once. Not one element's numbers:
// the page's BLOCKS — every piece of text a person can read (headings,
// paragraphs, list items, links, buttons, cells, labels, a field's placeholder,
// an image's alt) and the boxes that arrange them (nav, main, sections, forms,
// tables) — each with where it sits and what it says. Two of these snapshots
// diffed (monitor-evaluate.js diffPage) say what was added, what went, what
// moved and what was reworded: "any UI change", once it has to be a list.
// Capped, so a long page costs a bounded report; a block's address is its
// place in the tree, so a row added at the bottom is one added block and not
// a page that changed entirely.
const PAGE_SELECTOR = ':page';
const PAGE_BLOCKS_MAX = 400;
const PAGE_CANDIDATES_MAX = 4000;
const PAGE_TEXT_MAX = 80;
const PAGE_GRID = 4;      // the signature's quantum: a move smaller than this is not a report
const TEXT_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'a', 'button', 'label', 'summary', 'blockquote', 'pre', 'figcaption', 'dt', 'dd', 'th', 'td', 'legend', 'caption', 'input', 'select', 'textarea', 'img'];
const BOX_TAGS = ['nav', 'main', 'header', 'footer', 'aside', 'section', 'article', 'form', 'table', 'dialog'];
// Words that live in a bare div or span (a card's title, a counter, a badge)
// count when the element carries text of its own and no text block above it.
const LOOSE_TAGS = ['div', 'span', 'b', 'strong', 'em', 'i', 'small', 'code', 'time', 'mark'];
const TEXT_SELECTOR = TEXT_TAGS.join(',');
const BLOCK_SELECTOR = TEXT_SELECTOR + ',' + BOX_TAGS.join(',') + ',' + LOOSE_TAGS.join(',');
const BOX_SET = new Set(BOX_TAGS);
const LOOSE_SET = new Set(LOOSE_TAGS);
const FIELD_SET = new Set(['input', 'select', 'textarea']);
// What a test presses, fills or reads a state from: a link with somewhere to
// go, a button, a field, a disclosure, or anything a role says is one.
const CONTROL_TAGS = new Set(['button', 'input', 'select', 'textarea', 'summary']);
const CONTROL_ROLES = new Set(['button', 'link', 'menuitem', 'tab', 'option', 'checkbox', 'radio', 'switch', 'combobox']);

/** What a block says — never a field's value, which is somebody's data. */
function blockText(el, tag) {
  if (FIELD_SET.has(tag)) return collapse(el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('type') || '');
  if (tag === 'img') return collapse(el.getAttribute('alt') || '');
  var t = collapse(el.textContent);
  if (!t && (tag === 'button' || tag === 'a')) t = collapse(el.getAttribute('aria-label') || el.getAttribute('title') || '');
  return t;
}
function ownText(el) {
  for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && /\S/.test(n.nodeValue)) return true;
  return false;
}
function isControl(el, tag) {
  if (CONTROL_TAGS.has(tag)) return true;
  if (tag === 'a') return el.hasAttribute('href');
  var role = el.getAttribute('role');
  return !!role && CONTROL_ROLES.has(role.trim().toLowerCase());
}
/** An address as the logic hash reads it — host, path and query, never the fragment — resolved against the document. */
function addressOf(raw) {
  if (!raw) return '';
  try { var u = new URL(raw, location.href); return u.host + u.pathname + u.search; } catch (_) { return String(raw).slice(0, 200); }
}
/**
 * The same address as a sentence may show it: the path, the host only when it
 * is another host, an opaque segment (a token, a long id) and the whole query
 * masked — the way heal.js maskPath treats a URL. A reset link keeps its shape
 * and loses its secret.
 */
function shownAddress(raw) {
  if (!raw) return '';
  var u;
  try { u = new URL(raw, location.href); } catch (_) { return ''; }
  if (!/^https?:$/.test(u.protocol)) return u.protocol + '…';
  var opaque = function (seg) { return (seg.length >= 16 && /\d/.test(seg) && /[a-z]/i.test(seg)) || (seg.length >= 12 && /^[0-9a-f]{12,}$/i.test(seg.replace(/-/g, ''))); };
  var path = u.pathname.split('/').map(function (seg) { return opaque(seg) ? '…' : seg; }).join('/');
  return (u.host !== location.host ? u.host : '') + path + (u.search ? '?…' : '');
}
/**
 * What an element DOES, as one string to hash (`key`) and a few words a
 * sentence may show (`words`): where a link or a form goes, what kind of
 * control a button or a field is and whether it can be used, what state a
 * role carries. The hash goes into the block as `lh`, so a link that now
 * points elsewhere is a change the signature sees; the words go in as `lp`
 * — never the address itself, which can carry a token.
 */
function logicOf(el, tag) {
  var key = [], words = [];
  if (tag === 'a') {
    var href = el.getAttribute('href');
    key.push('a=' + addressOf(href));
    words.push(href ? shownAddress(href) : 'no href');
  } else if (tag === 'form') {
    var action = el.getAttribute('action'), method = (el.getAttribute('method') || 'get').toLowerCase();
    key.push('form=' + addressOf(action) + '|' + method);
    words.push(method + ' ' + (action ? shownAddress(action) : 'this page'));
  } else if (tag === 'button' || tag === 'input') {
    var type = (el.getAttribute('type') || (tag === 'button' ? 'submit' : 'text')).toLowerCase();
    var name = el.getAttribute('name') || '', off = !!el.disabled, ariaOff = el.getAttribute('aria-disabled') || '';
    key.push(tag + '=' + type + '|' + name + '|' + (off ? 1 : 0) + '|' + ariaOff);
    words.push('type=' + type + (name ? ' name=' + name : '') + (off || ariaOff === 'true' ? ' disabled' : ''));
  } else if (tag === 'select' || tag === 'textarea') {
    var fname = el.getAttribute('name') || '', foff = !!el.disabled;
    key.push(tag + '=' + fname + '|' + (foff ? 1 : 0));
    words.push((fname ? 'name=' + fname : tag) + (foff ? ' disabled' : ''));
  }
  var role = el.getAttribute('role');
  if (role) {
    var state = ['aria-expanded', 'aria-pressed', 'aria-checked'].map(function (a) { var v = el.getAttribute(a); return v == null ? '' : v; });
    key.push('role=' + role + '|' + state.join('|'));
    words.push('role=' + role + (state[0] ? ' expanded=' + state[0] : '') + (state[1] ? ' pressed=' + state[1] : '') + (state[2] ? ' checked=' + state[2] : ''));
  }
  return key.length ? { key: key.join(';'), words: words.join(' ') } : null;
}
/**
 * The page as blocks. `k` is a block's address (its path in the tree, hashed),
 * `t` its tag, `x y w h` its box in document coordinates — through every
 * scroller on the way up, so a page that scrolls an inner `main` rather than
 * the window reads the same before and after the scroll; viewport ones for a
 * fixed or sticky block (`f`), whose place depends on the scroll — `text` its
 * first words and `th` a hash of all of them, `lh` a hash of what it does and
 * `lp` the words for that, `c` on a control and `p` the address of the block
 * it sits in. `sig` changes when any block appears, goes, moves by the grid,
 * says something else or does something else, and not otherwise, so a page
 * that repaints or scrolls but does not differ costs nothing.
 */
function measurePage() {
  var ts = Date.now(), url = location.href;
  var body = document.body;
  if (!body) return missingSnapshot();
  var win = { x: window.scrollX, y: window.scrollY };
  var quirks = document.compatMode !== 'CSS1Compat';
  var paths = new Map(), stuckOf = new Map(), scrollOf = new Map();
  // The main scroller's offset: the largest one seen on the way up, the window included.
  var scroll = { x: win.x, y: win.y };
  function pathOfEl(el) {
    if (!el || el === document.documentElement) return '';
    var have = paths.get(el);
    if (have != null) return have;
    var seg = el === body ? 'body' : tagOf(el) + ':' + nthOfType(el);
    var up = el.parentElement ? pathOfEl(el.parentElement) : '';
    var out = up ? up + '>' + seg : seg;
    paths.set(el, out);
    return out;
  }
  function stuck(el) {
    if (!el || el === document.documentElement) return false;
    var have = stuckOf.get(el);
    if (have != null) return have;
    var pos = getComputedStyle(el).position;
    var out = pos === 'fixed' || pos === 'sticky' || stuck(el.parentElement);
    stuckOf.set(el, out);
    return out;
  }
  // How far the ancestors of `el` are scrolled, summed up to the window: what
  // to add to a viewport rect to get a document one. An element's own scroll
  // moves its children, not itself, so only ancestors count; the root's is the
  // window's, and in quirks mode the body's is too.
  function scrolledBy(el) {
    if (!el || el === document.documentElement) return win;
    var have = scrollOf.get(el);
    if (have) return have;
    var p = el.parentElement;
    var out = scrolledBy(p);
    if (p && p !== document.documentElement && !(quirks && p === body)) {
      var sl = p.scrollLeft || 0, st = p.scrollTop || 0;
      if (sl || st) {
        out = { x: out.x + sl, y: out.y + st };
        if (st > scroll.y || (st === scroll.y && sl > scroll.x)) scroll = { x: sl, y: st };
      }
    }
    scrollOf.set(el, out);
    return out;
  }
  var candidates = body.querySelectorAll(BLOCK_SELECTOR);
  var n = candidates.length;
  var truncated = n > PAGE_CANDIDATES_MAX;
  if (truncated) n = PAGE_CANDIDATES_MAX;
  var byEl = new Map();
  var order = [];
  for (var i = 0; i < n; i++) {
    var el = candidates[i];
    if (isOurs(el)) continue;
    var tag = tagOf(el);
    var isBox = BOX_SET.has(tag);
    if (LOOSE_SET.has(tag)) {
      // Its own words, and no text block above it that already carries them.
      if (!ownText(el)) continue;
      var above = el.parentElement, carried = false;
      while (above && above !== body) { if (byEl.has(above) && byEl.get(above).text != null) { carried = true; break; } above = above.parentElement; }
      if (carried || (el.parentElement && el.parentElement.closest(TEXT_SELECTOR))) continue;
    }
    var r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    var text = isBox ? '' : blockText(el, tag);
    if (!isBox && !text && tag !== 'img' && !FIELD_SET.has(tag)) continue;
    var f = stuck(el);
    var off = f ? null : scrolledBy(el);
    var blk = { k: '', t: tag, x: ri(f ? r.left : r.left + off.x), y: ri(f ? r.top : r.top + off.y), w: ri(r.width), h: ri(r.height) };
    if (f) blk.f = 1;
    if (el.id) blk.id = String(el.id).slice(0, 40);
    if (!isBox) { blk.text = text.slice(0, PAGE_TEXT_MAX); blk.th = fnv1a(text); }
    var logic = logicOf(el, tag);
    if (logic) { blk.lh = fnv1a(logic.key); blk.lp = logic.words.slice(0, PAGE_TEXT_MAX); }
    if (isControl(el, tag)) blk.c = 1;
    byEl.set(el, blk);
    order.push(el);
  }
  // A wrapper — a cell or a list item whose only words are its one link's —
  // is one block, the outer one, not two.
  var kept = [];
  var keyOf = new Map();
  for (var j = 0; j < order.length; j++) {
    var e = order[j], b = byEl.get(e);
    if (b.text != null) {
      var cur = e.parentElement, dup = false;
      while (cur && cur !== body) {
        var outer = byEl.get(cur);
        if (outer && outer.text != null) { dup = outer.th === b.th; break; }
        cur = cur.parentElement;
      }
      if (dup) continue;
    }
    b.k = fnv1a(pathOfEl(e));
    keyOf.set(e, b.k);
    // The block this one sits in: the nearest ancestor that is a block itself.
    var anc = e.parentElement;
    while (anc && anc !== body && !keyOf.has(anc)) anc = anc.parentElement;
    if (anc && keyOf.has(anc)) b.p = keyOf.get(anc);
    kept.push(b);
    if (kept.length >= PAGE_BLOCKS_MAX) { truncated = truncated || j + 1 < order.length; break; }
  }
  var parts = [];
  for (var q = 0; q < kept.length; q++) {
    var kb = kept[q];
    parts.push(kb.k + ':' + (kb.f ? 'f' : Math.round(kb.x / PAGE_GRID) + ',' + Math.round(kb.y / PAGE_GRID)) + ',' + Math.round(kb.w / PAGE_GRID) + 'x' + Math.round(kb.h / PAGE_GRID) + (kb.th ? ':' + kb.th : '') + (kb.lh ? ':' + kb.lh : ''));
  }
  var shape = fnv1a(parts.join('|'));
  var de = document.documentElement;
  var docW = Math.max(de.scrollWidth, body.scrollWidth, window.innerWidth), docH = Math.max(de.scrollHeight, body.scrollHeight, window.innerHeight);
  var text = collapse(body.innerText != null ? body.innerText : body.textContent);
  return {
    ts: ts, url: url, exists: true, visible: true, inViewport: true, kind: 'page',
    tag: 'page', id: '', classes: [], positioning: 'static',
    rect: { x: 0, y: 0, w: docW, h: docH }, docRect: { x: 0, y: 0, w: docW, h: docH }, styles: {}, metrics: { fontSizePx: null, lineHeightPx: null, opacity: 1 },
    title: collapse(document.title).slice(0, 200), text: text.slice(0, 2000), textLength: text.length,
    counts: { children: body.childElementCount, descendants: body.getElementsByTagName('*').length, rows: null, openDetails: body.querySelectorAll('details[open]').length, blocks: kept.length },
    htmlHash: shape, blocks: kept, truncated: truncated,
    env: { innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio || 1, scrollX: r1(win.x), scrollY: r1(win.y), scroll: { x: ri(scroll.x), y: ri(scroll.y) } },
    sig: 'page|' + kept.length + '|' + shape,
  };
}
/** One line per block — the page's outline, which is what a page's "markup excerpt" is. A link's line says where it goes. */
function outlineOf(snap, max) {
  var out = [];
  var list = (snap && snap.blocks) || [];
  for (var i = 0; i < list.length && out.length < max; i++) {
    var b = list[i];
    out.push(b.t + (b.id ? '#' + b.id : '') + (b.text ? ' "' + b.text + '"' : '') + ' @' + b.x + ',' + b.y + ' ' + b.w + 'x' + b.h + (b.f ? ' fixed' : '') + (b.lp ? ' [' + b.lp + ']' : ''));
  }
  return out;
}

/**
 * Everything the evaluator can ask about an element, in one read, plus `sig`:
 * the change signature. A report goes out only when the signature changes, so
 * scrolling (document coordinates, not viewport ones, go into it) and a
 * repaint that changed nothing measurable stay silent.
 *
 * A field's typed value is never shipped — a password field's would be a
 * secret, any field's is somebody's data — but its hash is part of the
 * signature, so a form that was edited still counts as a change.
 */
function measure(el) {
  const ts = Date.now(), url = location.href;
  if (!el || !el.isConnected) return missingSnapshot();
  if (el === document.documentElement) return measurePage();
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const rect = { x: r1(r.left), y: r1(r.top), w: r1(r.width), h: r1(r.height) };
  const docRect = { x: r1(r.left + window.scrollX), y: r1(r.top + window.scrollY), w: rect.w, h: rect.h };
  const positioning = positioningOf(el);
  const styles = {};
  for (const k of STYLE_KEYS) styles[k] = cs[k];
  const fontSizePx = num(cs.fontSize);
  const lineHeightPx = cs.lineHeight === 'normal' ? (fontSizePx == null ? null : r1(fontSizePx * 1.2)) : num(cs.lineHeight);
  const opacity = num(cs.opacity);
  const metrics = { fontSizePx, lineHeightPx, opacity };
  const text = collapse(el.innerText != null ? el.innerText : el.textContent).slice(0, 2000);
  const counts = {
    children: el.childElementCount,
    descendants: el.getElementsByTagName('*').length,
    rows: rowCountOf(el),
    openDetails: el.querySelectorAll('details[open]').length + (el.matches('details[open]') ? 1 : 0),
  };
  const visible = cs.display !== 'none' && cs.visibility !== 'hidden' && (opacity == null || opacity > 0) && rect.w > 0 && rect.h > 0;
  const inViewport = visible && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
  const htmlHash = fnv1a(el.outerHTML.slice(0, 50000));
  let valueHash = '';
  if ('value' in el && typeof el.value === 'string' && tagOf(el) !== 'option') valueHash = fnv1a(el.value.slice(0, 500));
  const posForSig = positioning === 'sticky' ? 'sticky' : positioning === 'fixed' ? 'f' + ri(rect.x) + ',' + ri(rect.y) : ri(docRect.x) + ',' + ri(docRect.y);
  const sig = [tagOf(el), ri(rect.w) + 'x' + ri(rect.h), posForSig, cs.fontSize, cs.fontWeight, cs.color, cs.backgroundColor,
    cs.display, cs.visibility, cs.opacity, htmlHash, text.length, counts.children, counts.rows, visible ? 1 : 0, valueHash].join('|');
  return {
    ts, url, exists: true, visible, inViewport,
    tag: tagOf(el), id: el.id || '', classes: Array.from(el.classList), positioning,
    rect, docRect, styles, metrics, text, textLength: text.length, counts, htmlHash,
    env: { innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio || 1, scrollX: r1(window.scrollX), scrollY: r1(window.scrollY) },
    sig,
  };
}

// ---- selectors ---------------------------------------------------------------
const STATE_CLASS = /^(active|open|opened|closed|selected|hover|hovered|focus|focused|checked|disabled|visible|hidden|show|shown|collapsed|expanded|is-|has-|js-)/;
// CSS-module / utility hashes: "btn_a3f9x", "Stack___kkChc", "Text___XeGJJ", "css-1q2w3e".
function isHashedClass(c) {
  const seg = c.split(/[_-]/).pop() || '';
  if (seg.length < 5) return /^css-/.test(c);
  const digitsAndLetters = /\d/.test(seg) && /[a-z]/i.test(seg);
  const mixedCaseInside = /[a-z]/.test(seg) && /[A-Z]/.test(seg.slice(1));
  return digitsAndLetters || mixedCaseInside || /^css-/.test(c);
}
function unique(sel, el) {
  try { const list = document.querySelectorAll(sel); return list.length === 1 && list[0] === el; } catch (_) { return false; }
}
function nthOfType(el) {
  let i = 1, s = el;
  while ((s = s.previousElementSibling)) if (s.tagName === el.tagName) i++;
  return i;
}
function candidatesFor(el) {
  const tag = tagOf(el);
  const out = [];
  for (const attr of ['data-testid', 'data-test', 'data-cy', 'data-qa']) {
    const v = el.getAttribute(attr);
    if (v) out.push('[' + attr + '="' + cssEscape(v) + '"]');
  }
  if (el.id && !/\d{3,}|[:.]/.test(el.id) && el.id.length <= 40) out.push('#' + cssEscape(el.id));
  for (const attr of ['name', 'aria-label', 'role']) {
    const v = el.getAttribute(attr);
    if (v && v.length <= 60) out.push(tag + '[' + attr + '="' + cssEscape(v) + '"]');
  }
  const classes = Array.from(el.classList).filter((c) => !STATE_CLASS.test(c) && !isHashedClass(c)).slice(0, 6);
  for (const c of classes) out.push(tag + '.' + cssEscape(c));
  for (let i = 0; i < classes.length; i++) for (let j = i + 1; j < classes.length; j++) out.push(tag + '.' + cssEscape(classes[i]) + '.' + cssEscape(classes[j]));
  return out;
}
function anchorFor(el) {
  for (const c of candidatesFor(el)) if (unique(c, el)) return c;
  return null;
}
function buildSelector(el) {
  if (!el || el === document.documentElement) return 'html';
  if (el === document.body) return 'body';
  const direct = anchorFor(el);
  if (direct) return direct;
  const hops = [];
  let cur = el;
  for (let depth = 0; depth < 8 && cur && cur !== document.body && cur !== document.documentElement; depth++) {
    hops.unshift(tagOf(cur) + ':nth-of-type(' + nthOfType(cur) + ')');
    const parent = cur.parentElement;
    if (!parent) break;
    const anchor = parent === document.body ? 'body' : anchorFor(parent);
    if (anchor) { const sel = anchor + ' > ' + hops.join(' > '); if (unique(sel, el)) return sel; }
    cur = parent;
  }
  const path = [];
  cur = el;
  while (cur && cur !== document.documentElement) {
    path.unshift(cur === document.body ? 'body' : tagOf(cur) + ':nth-of-type(' + nthOfType(cur) + ')');
    cur = cur.parentElement;
  }
  return path.join(' > ');
}
function fingerprint(el) {
  return {
    tag: tagOf(el), id: el.id || '', classes: Array.from(el.classList).slice(0, 8),
    text: collapse(el.innerText != null ? el.innerText : el.textContent).slice(0, 60),
    nth: nthOfType(el), parentTag: tagOf(el.parentElement),
    attrs: { name: el.getAttribute('name'), role: el.getAttribute('role'), type: el.getAttribute('type'), ariaLabel: el.getAttribute('aria-label'), href: el.getAttribute('href') },
  };
}
function findByFingerprint(fp) {
  if (!fp || !fp.tag) return null;
  const list = Array.from(document.getElementsByTagName(fp.tag)).filter((e) => !isOurs(e)).slice(0, 800);
  if (fp.id) { const byId = list.filter((e) => e.id === fp.id); if (byId.length === 1) return byId[0]; }
  const attrs = Object.entries(fp.attrs || {}).filter(([, v]) => v);
  const scored = [];
  for (const e of list) {
    let score = 0;
    for (const [k, v] of attrs) if ((k === 'ariaLabel' ? e.getAttribute('aria-label') : e.getAttribute(k)) === v) score += 3;
    const cls = new Set(e.classList);
    for (const c of fp.classes || []) if (cls.has(c)) score += 2;
    if (fp.text) { const t = collapse(e.innerText != null ? e.innerText : e.textContent).slice(0, 60); if (t && t.slice(0, 20) === fp.text.slice(0, 20)) score += 2; }
    if (fp.parentTag && tagOf(e.parentElement) === fp.parentTag) score += 1;
    if (fp.nth && nthOfType(e) === fp.nth) score += 1;
    if (score > 0) scored.push({ e, score });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  if (scored.length === 1 || scored[0].score > scored[1].score) return scored[0].e;
  return null;
}
// Resolve a monitor target: selector first, fingerprint as the fallback.
function resolveTarget(target) {
  const selector = typeof target === 'string' ? target : target && target.selector;
  const fp = typeof target === 'string' ? null : target && target.fingerprint;
  if (selector === PAGE_SELECTOR) return { el: document.documentElement, by: 'page' };
  let el = null, by = 'selector';
  if (selector) { try { el = document.querySelector(selector); } catch (_) { el = null; } }
  if (el && isOurs(el)) el = null;
  if (!el && fp) { el = findByFingerprint(fp); by = el ? 'fingerprint' : 'none'; }
  if (!el) by = 'none';
  return { el, by };
}
function measureFor(target) {
  const { el } = resolveTarget(target);
  return el ? measure(el) : missingSnapshot();
}
function describe(el) {
  if (!el || el.nodeType !== 1) return '';
  let s = tagOf(el);
  if (el.id) s += '#' + el.id;
  const cls = Array.from(el.classList).filter((c) => !STATE_CLASS.test(c)).slice(0, 2);
  if (cls.length) s += '.' + cls.join('.');
  return s;
}
function defaultLabel(el) {
  const fp = fingerprint(el);
  const base = describe(el);
  const t = fp.text ? ' "' + fp.text.slice(0, 24) + (fp.text.length > 24 ? '…' : '') + '"' : '';
  return (base + t).slice(0, 60);
}

// ---- the excerpt --------------------------------------------------------------
const EXCERPT_LEVELS = 12;
const EXCERPT_AROUND = 8;
/** Where the element sits: its ancestors, outermost first, as `describe` names them. */
function pathOf(el) {
  const out = [];
  let cur = el && el.parentElement;
  while (cur && cur !== document.documentElement && out.length < EXCERPT_LEVELS) { out.unshift(describe(cur)); cur = cur.parentElement; }
  return out;
}
/**
 * A bounded, sanitised view of the element and its surroundings, for the
 * compiler and the judge (monitor-resolver.js): its own markup with the code
 * taken out (sanitize.js), where it sits, and one line for each sibling and
 * child. Taken on demand — when a monitor is made and when a change is
 * confirmed — never on every report, so no markup rides the wire per change.
 */
function excerptOf(el) {
  if (el === document.documentElement) {
    const snap = measurePage();
    const lines = outlineOf(snap, 120);
    const boxes = [];
    for (const b of snap.blocks || []) if (b.text == null && boxes.length < EXCERPT_AROUND) boxes.push(b.t + (b.id ? '#' + b.id : '') + ' ' + b.w + 'x' + b.h);
    return { html: lines.join('\n'), path: [], siblings: [], children: boxes, childCount: (snap.blocks || []).length };
  }
  const one = (e) => { const t = collapse(e.innerText != null ? e.innerText : e.textContent).slice(0, 40); return describe(e) + (t ? ' "' + t + '"' : ''); };
  const around = (list) => Array.from(list || []).filter((e) => e !== el && !isOurs(e)).slice(0, EXCERPT_AROUND).map(one);
  return {
    html: sanitizeHtml(el.outerHTML, EXCERPT_HTML_MAX),
    path: pathOf(el),
    siblings: around(el.parentElement ? el.parentElement.children : []),
    children: around(el.children),
    childCount: el.childElementCount,
  };
}
function excerptFor(target) {
  const { el } = resolveTarget(target);
  return el ? excerptOf(el) : null;
}

GM.measure = measure;
GM.measurePage = measurePage;
GM.PAGE_SELECTOR = PAGE_SELECTOR;
GM.measureFor = measureFor;
GM.resolveTarget = resolveTarget;
GM.buildSelector = buildSelector;
GM.fingerprint = fingerprint;
GM.describe = describe;
GM.pathOf = pathOf;
GM.excerptFor = excerptFor;
GM.sanitizeHtml = sanitizeHtml;
GM.isOurs = isOurs;
GM.ensureHost = ensureHost;
