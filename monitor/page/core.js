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

GM.measure = measure;
GM.measureFor = measureFor;
GM.resolveTarget = resolveTarget;
GM.buildSelector = buildSelector;
GM.fingerprint = fingerprint;
GM.describe = describe;
GM.isOurs = isOurs;
GM.ensureHost = ensureHost;
