/**
 * Where a click actually took you, and what it went through on the way.
 *
 * A link that "works" can still be wrong: it 301s to a path that no longer
 * exists, it detours through a tracker that adds 400ms, it lands on a 404 that
 * renders a friendly page so the URL assertion passes anyway, or it quietly
 * leaves your origin. None of that is visible from the final URL alone, which
 * is all a recording used to keep.
 *
 * So every main-frame document navigation is recorded as a CHAIN — each hop
 * with its status — and kept until the next one. Sub-resources are ignored: a
 * page loads a hundred of them and none is where the click took you.
 *
 * This only observes. Nothing here decides whether a chain is acceptable; that
 * is what the `status` and `redirect` assertions are for, and they are written
 * by a person who knows what the link is supposed to do.
 */
const MAX_HOPS = 12;            // a chain longer than this is a loop, not a route

export class NavigationLog {
  constructor(page, { onNavigation } = {}) {
    this.page = page;
    this.onNavigation = onNavigation ?? (() => {});
    /** @type {{url:string, status:number|null}[]} the most recent chain */
    this.chain = [];
    /**
     * Bumped for every navigation recorded.
     *
     * An assertion that only compared the chain's URL with the address bar
     * matched the PREVIOUS navigation whenever the click it followed had not
     * committed yet — and cheerfully reported "0 redirects" about a link that
     * took two. A counter makes "newer than the thing I just did" expressible.
     */
    this.seq = 0;
    this.queue = Promise.resolve();
  }

  attach() {
    this.page.on('response', (res) => {
      const req = res.request();
      // Only top-level document navigations. An iframe or an image is not
      // where the click took you.
      if (!req.isNavigationRequest()) return;
      if (req.frame() !== this.page.mainFrame()) return;
      // A 3xx is a hop, not a landing. Wait for the response that stops.
      const s = res.status();
      if (s >= 300 && s < 400) return;

      // Serialised, so two navigations in flight cannot interleave their hops.
      this.queue = this.queue.then(() => this.#record(req)).catch(() => {});
    });
  }

  async #record(req) {
    const hops = [];
    for (let r = req; r && hops.length < MAX_HOPS; r = r.redirectedFrom()) {
      const res = await r.response().catch(() => null);
      hops.unshift({ url: r.url(), status: res?.status() ?? null });
    }
    this.chain = hops;
    this.seq++;
    this.onNavigation(this.summary());
  }

  /** The chain, plus the two questions anyone actually asks about it. */
  summary() {
    const hops = this.chain;
    const last = hops.at(-1) ?? null;
    return {
      seq: this.seq,
      hops,
      url: last?.url ?? null,
      status: last?.status ?? null,
      redirects: Math.max(0, hops.length - 1),
      // A hop that changes origin is worth naming on its own: it is how you
      // end up with a recording whose entry URL was never allowed.
      leftOrigin: hops.length > 1 && originOf(hops[0].url) !== originOf(last?.url),
    };
  }

  /** Human-readable, for a log line or a `%% via` comment. */
  static describe({ hops }) {
    if (!hops?.length) return '(no navigation)';
    if (hops.length === 1) return `${hops[0].status ?? '?'} ${hops[0].url}`;
    return hops.map((h, i) => (i === hops.length - 1 ? `→ ${h.status ?? '?'} ${h.url}` : `${h.status ?? '?'} ${h.url}`)).join(' ');
  }
}

const originOf = (u) => { try { return new URL(u).origin; } catch { return null; } };
