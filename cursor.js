const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// easeInOutQuad — slow start, fast middle, slow landing. Reads as intentional.
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

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

  async glideTo(x, y, ms = 420) {
    const [sx, sy] = [this.x, this.y];
    const frames = Math.max(1, Math.round(ms / 16));
    for (let i = 1; i <= frames; i++) {
      const e = ease(i / frames);
      await this.moveTo(sx + (x - sx) * e, sy + (y - sy) * e);
      await sleep(16);
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

  async click() {
    const base = { x: this.x, y: this.y, button: 'left', clickCount: 1 };
    this.emit({ t: 'press', x: this.x, y: this.y });

    this.buttons = 1;
    await this.cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 });
    await sleep(70); // a press with no duration is invisible on a 10fps feed
    this.buttons = 0;
    await this.cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });
  }
}

export { sleep };
