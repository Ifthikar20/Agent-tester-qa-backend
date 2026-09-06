/**
 * The picker.
 *
 * Armed, it highlights whatever is under the cursor and SWALLOWS the next
 * click — capture phase, preventDefault and stopImmediatePropagation — so the
 * page cannot react while the panel is still asking what you meant. The click
 * is replayed for real only after you answer.
 *
 * Getting that order wrong is the whole ballgame: click a sidebar link without
 * suppressing it and the page navigates away while the panel is asking about a
 * button that no longer exists.
 *
 * Naming is delegated to lib/propose.js, which the server's teach mode injects
 * from the same file.
 */
(function () {
  if (window.__gcPickerInstalled) return;
  window.__gcPickerInstalled = true;

  const { SCOPE, propose, best, nameOf } = self.__gcPropose;

  let armed = false;
  let held = null;              // the element awaiting an answer
  let box = null;

  const overlay = () => {
    if (box) return box;
    box = document.createElement('div');
    Object.assign(box.style, {
      position: 'fixed', zIndex: '2147483647', pointerEvents: 'none',
      border: '2px solid #e8a33d', background: 'rgba(232,163,61,.14)',
      borderRadius: '3px', transition: 'all .05s linear', display: 'none',
    });
    document.documentElement.appendChild(box);
    return box;
  };

  const paint = (el) => {
    const b = overlay();
    if (!el) { b.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    Object.assign(b.style, {
      display: 'block', top: `${r.top}px`, left: `${r.left}px`,
      width: `${r.width}px`, height: `${r.height}px`,
    });
  };

  const onMove = (e) => {
    if (!armed) return;
    paint(e.target.closest(SCOPE));
  };

  // Swallow everything a click is made of, or the page reacts to mousedown.
  const swallow = (e) => {
    if (!armed) return;
    const el = e.target.closest(SCOPE);
    if (!el) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type !== 'click') return;

    held = el;
    armed = false;
    paint(null);
    chrome.runtime.sendMessage({
      t: 'picked',
      href: location.href,
      preview: best(propose(el)) ?? '(unnameable)',
      name: nameOf(el),
      tag: el.tagName.toLowerCase(),
      isField: /^(input|textarea|select)$/.test(el.tagName.toLowerCase()),
      value: el.value ?? null,
      candidates: propose(el),
    });
  };

  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
    document.addEventListener(type, swallow, true);
  }
  document.addEventListener('mousemove', onMove, true);

  /** Now that the panel knows what you meant, let the page have the event. */
  const perform = (op, value) => {
    const el = held;
    held = null;
    if (!el) return;
    if (op === 'click') { el.click(); return; }
    if (op === 'fill') {
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
      // Frameworks listen for their own setter, so go through the prototype's
      // rather than assigning .value directly, or React never sees the change.
      const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
      if (setter) setter.call(el, value); else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };

  chrome.runtime.onMessage.addListener((m, _s, reply) => {
    if (m.t === 'arm')     { armed = true;  held = null; paint(null); reply?.({ ok: true }); }
    if (m.t === 'disarm')  { armed = false; held = null; paint(null); reply?.({ ok: true }); }
    if (m.t === 'perform') { perform(m.op, m.value); reply?.({ ok: true }); }
    if (m.t === 'href')    { reply?.({ href: location.href }); }
    return true;
  });

  chrome.runtime.sendMessage({ t: 'ready', href: location.href }).catch?.(() => {});
})();
