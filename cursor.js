const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// easeInOutQuad — slow start, fast middle, slow landing. Reads as intentional.
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** ~60fps. The grid glide frames are scheduled on, not a delay added to them. */
const FRAME = 16;

/**
 * One object owns the pointer position.
 *
 * Every move does two things in the same tick: injects a real mouseMoved into
 * Chrome, and emits a cursor event to the overlay. Because click() takes no
 * coordinates and fires wherever the cursor already is, the drawn arrow and
 * the injected click can never disagree about where they are.
 */
export class VirtualCursor {
  constructor(cdp, emit) {
    this.cdp = cdp;
    this.emit = emit;
    this.x = 40;
    this.y = 40;
    this.buttons = 0; // CDP wants the held-button bitmask on every event
  }

  async moveTo(x, y) {
    this.x = x;
    this.y = y;
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y, buttons: this.buttons,
    });
    this.emit({ t: 'cursor', x, y });
  }

  /**
   * Travel to a point over `ms`, and take `ms` doing it.
   *
   * The frames used to be a fixed count with a flat `sleep(16)` after each one
   * — but each frame also awaits a CDP round trip, so the sleep was on TOP of
   * the work rather than including it. A 420ms glide really took 26 × (16 +
   * rtt), around 500-550ms, and `ms` under-reported itself by a quarter. That
   * matters now that a person can set this number: a knob that lies about its
   * units is worse than no knob.
   *
   * So frames are scheduled against a deadline. Each one lands on the next
   * 16ms mark measured from the start, and a slow round trip eats into its own
   * frame instead of pushing every later one back. The loop always finishes at
   * t = 1, so the final position is exact rather than nearly.
   *
   * ms <= 0 means "do not perform" — one move, no animation. That is the whole
   * mechanism behind a fast run.
   */
  async glideTo(x, y, ms = 420) {
    const [sx, sy] = [this.x, this.y];
    if (!(ms > 0)) { await this.moveTo(x, y); return; }

    const start = Date.now();
    let due = 0;
    for (;;) {
      const t = Math.min(1, (Date.now() - start) / ms);
      const e = ease(t);
      await this.moveTo(sx + (x - sx) * e, sy + (y - sy) * e);
      if (t >= 1) return;
      due += FRAME;
      await sleep(Math.max(0, start + due - Date.now()));
    }
  }

  /**
   * Turn the wheel, where the pointer is.
   *
   * Without this the console could point and click but never move the page, so
   * anything below the fold was unreachable by hand — you could watch a footer
   * go by on the feed and have no way to touch it. CCD's mouseWheel is the same
   * event a real wheel produces, so momentum, sticky headers and scroll-linked
   * animations all behave as they would for a person.
   */
  async wheel(deltaY, deltaX = 0) {
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: this.x, y: this.y,
      deltaX, deltaY, buttons: this.buttons,
    });
    this.emit({ t: 'wheel', x: this.x, y: this.y, deltaY });
  }

  /**
   * @param {number} pressMs how long to hold the button. A press with no
   *   duration is invisible on a ~10fps feed, which is the only reason this is
   *   not zero — so a run nobody is watching should pass 0.
   */
  async click(pressMs = 70) {
    const base = { x: this.x, y: this.y, button: 'left', clickCount: 1 };
    this.emit({ t: 'press', x: this.x, y: this.y });

    this.buttons = 1;
    await this.cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 });
    if (pressMs > 0) await sleep(pressMs);
    this.buttons = 0;
    await this.cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });
  }
}

export { sleep };
