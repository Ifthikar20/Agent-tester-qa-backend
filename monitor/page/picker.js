// ---------------------------------------------------------------------------
// picker.js — the DevTools-style element picker, the selection outline and the
// flash. Shares scope with core.js (GM, measure, buildSelector, ...) and
// watcher.js.
//
// The person is not in this page. They are on the console's canvas, and every
// pointer move there becomes a real mouseMoved in this page (cursor.js), so
// the capture-phase listeners below see exactly what a person's mouse would
// produce. The highlight is drawn here, inside the page, which is what makes it
// arrive in the screencast; the click is swallowed here, which is what keeps a
// button or a link from firing while it is being chosen.
//
// Ported from the monitoring proof of concept's injected/picker.js, minus its
// in-page drawer and toasts — the ghostclick UI is the panel. What the pointer
// is over is also told to the runner in words (`__gcMonitorHover`), because a
// label inside a JPEG frame is not something a person can rely on reading.
// ---------------------------------------------------------------------------
let hoverEl = null;
let hoverRaf = 0;
let hoverSentAt = 0;
let hoverTrail = 0;
/** At most one hover report per this many ms; the last one always goes. */
const HOVER_EVERY_MS = 80;

// ---- geometry helpers
function place(box, el) {
  if (!el || !el.isConnected) { box.style.display = 'none'; return; }
  const r = el.getBoundingClientRect();
  box.style.display = 'block';
  box.style.left = r.left + 'px';
  box.style.top = r.top + 'px';
  box.style.width = r.width + 'px';
  box.style.height = r.height + 'px';
}
function paintHover() {
  ensureHost();
  const { hl, hlLabel } = GM.ui;
  if (!GM.picking || !hoverEl) { hl.style.display = 'none'; hlLabel.style.display = 'none'; return; }
  place(hl, hoverEl);
  const r = hoverEl.getBoundingClientRect();
  const cs = getComputedStyle(hoverEl);
  hlLabel.replaceChildren();
  const b = document.createElement('b'); b.textContent = describe(hoverEl);
  const i = document.createElement('i'); i.textContent = Math.round(r.width) + ' × ' + Math.round(r.height) + '  ·  ' + cs.fontSize;
  hlLabel.appendChild(b); hlLabel.appendChild(i);
  hlLabel.style.display = 'block';
  const lh = hlLabel.offsetHeight || 20;
  let top = r.top - lh - 4;
  if (top < 4) top = Math.min(r.bottom + 4, window.innerHeight - lh - 4);
  hlLabel.style.top = top + 'px';
  hlLabel.style.left = Math.max(4, Math.min(r.left, window.innerWidth - hlLabel.offsetWidth - 8)) + 'px';
  reportHover();
}
/**
 * What is under the pointer, told to the runner as words — the label drawn
 * above is inside a JPEG frame a person may not be able to read. Throttled,
 * with a trailing report, so a sweep across a page is a few reports and the
 * element the pointer settled on is always the last one said.
 */
function reportHover() {
  if (!GM.picking || !hoverEl) return;
  const now = Date.now();
  const wait = hoverSentAt + HOVER_EVERY_MS - now;
  if (wait > 0) {
    if (!hoverTrail) hoverTrail = setTimeout(function () { hoverTrail = 0; reportHover(); }, wait);
    return;
  }
  hoverSentAt = now;
  try {
    const r = hoverEl.getBoundingClientRect();
    const cs = getComputedStyle(hoverEl);
    send('__gcMonitorHover', {
      describe: describe(hoverEl), tag: tagOf(hoverEl),
      text: collapse(hoverEl.innerText != null ? hoverEl.innerText : hoverEl.textContent).slice(0, 60),
      w: Math.round(r.width), h: Math.round(r.height), fontSize: cs.fontSize,
    });
  } catch (_) { /* an element that went away between the paint and the report */ }
}
function paintSel() {
  if (!GM.shadow) return;
  const cur = GM.selected && GM.selected.el;
  if (cur && cur.isConnected) place(GM.ui.sel, cur); else GM.ui.sel.style.display = 'none';
}

// ---- picking
function targetOf(e) {
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];
  let t = path[0];
  if (t && t.nodeType !== 1) t = t.parentElement || null;
  if (!t || isOurs(t)) return null;
  let root = t.getRootNode();
  while (root instanceof ShadowRoot && root !== GM.shadow) { t = root.host; root = t.getRootNode(); }
  if (isOurs(t)) return null;
  return t;
}
function onMove(e) {
  if (!GM.picking) return;
  const t = targetOf(e);
  if (!t || t === hoverEl) return;
  hoverEl = t;
  if (!hoverRaf) hoverRaf = requestAnimationFrame(() => { hoverRaf = 0; paintHover(); });
}
function swallow(e) {
  if (!GM.picking) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.type === 'click') {
    const t = targetOf(e) || hoverEl;
    if (t) select(t);
  }
}
function onKey(e) {
  if (!GM.picking) return;
  if (e.key === 'Escape') {
    e.preventDefault(); e.stopImmediatePropagation();
    stopPicker();
    send('__gcMonitorSelected', { cancelled: true });
  }
}
function onScrollOrResize() {
  if (GM.picking && hoverEl) paintHover();
  if (GM.selected) paintSel();
  if (GM.ui.flash && GM.ui.flash.style.display === 'block' && GM.flashEl) place(GM.ui.flash, GM.flashEl);
}
window.addEventListener('mousemove', onMove, { capture: true, passive: true });
for (const t of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'auxclick']) window.addEventListener(t, swallow, true);
window.addEventListener('keydown', onKey, true);
window.addEventListener('scroll', onScrollOrResize, { capture: true, passive: true });
window.addEventListener('resize', onScrollOrResize, { passive: true });

// No crosshair on <html>: the person's pointer is on a canvas elsewhere, so a
// cursor style here would be invisible — and a style change on the document
// element is a mutation the page's other observers would see.
function startPicker() {
  ensureHost();
  GM.picking = true;
  hoverEl = null;
  return true;
}
function stopPicker() {
  GM.picking = false;
  hoverEl = null;
  if (hoverTrail) { clearTimeout(hoverTrail); hoverTrail = 0; }
  if (GM.ui.hl) { GM.ui.hl.style.display = 'none'; GM.ui.hlLabel.style.display = 'none'; }
  return true;
}
/**
 * The click chose `el`. Every part of the answer is worked out on its own,
 * because a page can make any one of them throw — a selector that CSS.escape
 * refuses, a measurement on something the page tore down as it was clicked —
 * and a pick that throws halfway is a pick nobody hears about: the runner
 * still says "picking" and the person is left wondering what they clicked.
 * Whatever could be read is sent, and `readError` says what could not.
 */
function select(el) {
  stopPicker();
  let snapshot, selector, fp, label, readError = null;
  try { snapshot = measure(el); } catch (err) { snapshot = missingSnapshot(); readError = 'measure: ' + (err && err.message ? err.message : String(err)); }
  try { selector = buildSelector(el); } catch (err) { selector = tagOf(el) || '*'; readError = readError || 'selector: ' + (err && err.message ? err.message : String(err)); }
  try { fp = fingerprint(el); } catch (_) { fp = null; }
  try { label = defaultLabel(el); } catch (_) { label = selector; }
  GM.selected = { el, selector, fingerprint: fp, snapshot, label };
  try { paintSel(); } catch (_) { /* the outline is a courtesy */ }
  send('__gcMonitorSelected', { selector, fingerprint: fp, snapshot, label, url: location.href, readError });
}
function clearSelection() {
  GM.selected = null;
  if (GM.ui.sel) GM.ui.sel.style.display = 'none';
  return true;
}
/** The overlay out of a screenshot's way — only ever while picking, when it has something on screen. */
function setHostHidden(hidden) {
  if (GM.host) GM.host.style.visibility = hidden ? 'hidden' : '';
  return true;
}
function flash(target) {
  ensureHost();
  const { el } = resolveTarget(target);
  if (!el) return false;
  GM.flashEl = el;
  place(GM.ui.flash, el);
  setTimeout(() => { GM.ui.flash.style.display = 'none'; GM.flashEl = null; }, 2000);
  return true;
}
GM.startPicker = startPicker;
GM.stopPicker = stopPicker;
GM.clearSelection = clearSelection;
GM.setHostHidden = setHostHidden;
GM.flash = flash;
