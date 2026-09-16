// ---------------------------------------------------------------------------
// watcher.js — per-monitor observation inside the page. Reports a snapshot to
// the runner whenever a monitored element's change signature changes.
// Shares scope with core.js and picker.js.
//
// One ResizeObserver per element and one MutationObserver on the document,
// debounced (250 ms, a second at most under a mutation storm) with a settle
// pass 300 ms later for values that were still animating. A report goes out
// only when the signature changed, so a page that is busy but not different
// costs the runner nothing.
//
// Ported from the monitoring proof of concept's injected/watcher.js.
// ---------------------------------------------------------------------------
const W = { timer: 0, firstAt: 0, pendingReason: null, settleTimer: 0, mo: null, bound: false };

function arm(m) {
  if (!m || !m.id || !m.selector) return null;
  const prev = GM.monitors.get(m.id);
  if (prev && prev.ro) prev.ro.disconnect();
  const entry = { id: m.id, selector: m.selector, fingerprint: m.fingerprint || null, label: m.label || '', el: null, ro: null, lastSig: null, lastSnapshot: null };
  GM.monitors.set(m.id, entry);
  ensureObservers();
  return tickOne(entry, 'rearmed', true);
}
function disarm(id) {
  const e = GM.monitors.get(id);
  if (!e) return false;
  if (e.ro) e.ro.disconnect();
  GM.monitors.delete(id);
  if (!GM.monitors.size) teardownObservers();
  return true;
}
/**
 * The runner's list for this document, applied: monitors it no longer names
 * are disarmed, new ones armed. For a same-document route change — the
 * DOMContentLoaded handshake below covers a new document. Not before the DOM
 * exists: measuring then would report every element missing.
 */
function sync(list) {
  if (document.readyState === 'loading') return false;
  const want = new Map((list || []).map((m) => [m.id, m]));
  for (const id of [...GM.monitors.keys()]) if (!want.has(id)) disarm(id);
  for (const [id, m] of want) if (!GM.monitors.has(id)) arm(m);
  return true;
}
function armed() { return [...GM.monitors.keys()]; }

function tickOne(entry, reason, force) {
  const { el, by } = resolveTarget(entry);
  let selectorNew = null;
  if (el !== entry.el) {
    if (entry.ro) { entry.ro.disconnect(); entry.ro = null; }
    if (el) {
      entry.ro = new ResizeObserver(() => schedule('resize'));
      try { entry.ro.observe(el); } catch (_) {}
      if (by === 'fingerprint') selectorNew = buildSelector(el);
      if (entry.lastSig != null) reason = 'rearmed';
    }
    entry.el = el;
  }
  const snap = el ? measure(el) : missingSnapshot();
  if (!el && entry.lastSig !== 'missing') reason = 'missing';
  const changed = snap.sig !== entry.lastSig;
  entry.lastSig = snap.sig;
  entry.lastSnapshot = snap;
  const payload = { monitorId: entry.id, selector: entry.selector, reason, resolvedBy: by, selectorNew, missing: !el, snapshot: snap, ts: Date.now() };
  if (changed || force) send('__gcMonitorReport', payload);
  if (GM.selected) paintSel();
  return payload;
}
function tickAll(reason) {
  W.timer = 0; W.firstAt = 0;
  for (const entry of GM.monitors.values()) tickOne(entry, reason, false);
  clearTimeout(W.settleTimer);
  W.settleTimer = setTimeout(() => { for (const entry of GM.monitors.values()) tickOne(entry, 'settle', false); }, 300);
}
// Trailing debounce (250 ms) with a max wait (1 s) so mutation storms cannot starve us.
function schedule(reason) {
  if (!GM.monitors.size) return;
  const now = Date.now();
  if (!W.firstAt) W.firstAt = now;
  W.pendingReason = reason;
  clearTimeout(W.timer);
  const overdue = now - W.firstAt >= 1000;
  W.timer = setTimeout(() => tickAll(W.pendingReason), overdue ? 0 : 250);
}
function onMutations(records) {
  for (const r of records) { if (!isOurs(r.target)) { schedule('mutation'); return; } }
}
function onViewport() { schedule('viewport'); }
function onAnim(e) { if (!isOurs(e.target)) schedule('mutation'); }
function ensureObservers() {
  if (W.mo) return;
  W.mo = new MutationObserver(onMutations);
  W.mo.observe(document.documentElement, { childList: true, attributes: true, characterData: true, subtree: true });
  if (!W.bound) {
    window.addEventListener('resize', onViewport, { passive: true });
    document.addEventListener('transitionend', onAnim, true);
    document.addEventListener('animationend', onAnim, true);
    W.bound = true;
  }
}
function teardownObservers() {
  if (W.mo) { W.mo.disconnect(); W.mo = null; }
  clearTimeout(W.timer); W.timer = 0; W.firstAt = 0;
}
// Heartbeat: the runner calls this every few seconds as a safety net.
window.__gcMonitorMeasureAll = function () {
  const out = [];
  for (const entry of GM.monitors.values()) {
    const { el, by } = resolveTarget(entry);
    const snap = el ? measure(el) : missingSnapshot();
    out.push({ monitorId: entry.id, selector: entry.selector, reason: 'heartbeat', resolvedBy: by, selectorNew: null, missing: !el, snapshot: snap, ts: Date.now() });
  }
  return { ts: Date.now(), url: location.href, monitors: out };
};
GM.arm = arm;
GM.disarm = disarm;
GM.sync = sync;
GM.armed = armed;
GM.tick = () => tickAll('manual');

// Boot handshake: after every load, ask the runner which monitors belong to
// this document and arm them. No overlay is created here — a page nobody is
// monitoring is left exactly as it was.
async function boot() {
  if (typeof window.__gcMonitorList !== 'function') return;
  let list = [];
  try { list = await window.__gcMonitorList(location.href); } catch (_) { return; }
  for (const m of list || []) arm(m);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => boot(), { once: true });
else boot();
