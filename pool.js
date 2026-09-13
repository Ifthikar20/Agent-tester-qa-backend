/**
 * A pool of isolated browser sessions, so more than one organisation can drive
 * at once.
 *
 * The runner time-shares ONE browser today: one organisation drives, the rest
 * are told `runner_busy`, and a handover REPLACES the single context (server.js,
 * newSession / resetSession, the `driver` singleton). That shared singleton is
 * the scaling ceiling — one page, one cookie jar, one org at a time.
 *
 * This makes the singleton a pool. Each organisation leases its OWN
 * BrowserContext — its own cookies, its own page — so N of them run at once,
 * isolated, capped by a capacity the box's RAM can hold. One browser with many
 * contexts is the cheap axis: a context is a cookie jar, not a process, so this
 * multiplies the concurrency of a single runner without a single extra
 * container. It is the model for headless runs.
 *
 * The human-login (attach) axis is different — a browser IS one signed-in
 * identity, so there it is capacity 1, scaled by running more browser
 * containers / runner replicas (docker/docker-compose.pool.yml) behind the same
 * acquire/release interface. Total concurrency is then replicas × contexts.
 *
 * Scope: this is the primitive, with its own proof (scripts/check-pool.js drives
 * it on a real browser). Adopting it in the live socket path — replacing the
 * `browser`/`page` singletons and giving each lease its own screencast — is the
 * seam marked in server.js; this module is what that seam leases from.
 */

export class PoolFull extends Error {
  constructor(max) {
    super(`browser pool is full (${max} in use)`);
    this.name = 'PoolFull';
  }
}

export class BrowserPool {
  /**
   * @param browser  a launched or connected Playwright Browser.
   * @param opts.max      how many contexts to hold at once (the capacity).
   * @param opts.idleMs   close a lease left untouched this long, freeing its slot.
   * @param opts.grace    on a FULL pool, only evict a lease idle at least this
   *                      long — so a burst of new orgs cannot tear down one that
   *                      is mid-action. Below it, a full pool throws PoolFull.
   * @param opts.viewport default context viewport (matches the runner's VIEW).
   */
  constructor(browser, { max = 4, idleMs = 5 * 60_000, grace = 15_000, viewport } = {}) {
    this._browser = browser;
    this._max = Math.max(1, max);
    this._idleMs = idleMs;
    this._grace = grace;
    this._viewport = viewport ?? { width: 1180, height: 760 };
    this._leases = new Map();   // org -> { org, context, page, since, lastUsed, timer }
  }

  get capacity() { return this._max; }
  get active() { return this._leases.size; }
  has(org) { return this._leases.has(org); }
  lease(org) { return this._leases.get(org) ?? null; }
  stats() { return { active: this.active, capacity: this._max, orgs: [...this._leases.keys()] }; }

  /**
   * The organisation's session, made if it has none.
   *
   * Reuses a live lease (touching it, so its idle countdown restarts). On a full
   * pool it evicts the longest-idle lease past `grace` to make room, and throws
   * PoolFull when nothing is idle enough — which the caller answers exactly the
   * way it answers runner_busy today, except now the answer is "come back in a
   * moment", not "someone else has the only browser".
   */
  async acquire(org, { storageState } = {}) {
    const have = this._leases.get(org);
    if (have) { this._touch(have); return have; }

    if (this._leases.size >= this._max && !(await this._evictIdle())) {
      throw new PoolFull(this._max);
    }

    const context = await this._browser.newContext({
      viewport: this._viewport,
      ...(storageState ? { storageState } : {}),
    });
    const page = await context.newPage();
    const lease = { org, context, page, since: Date.now(), lastUsed: Date.now(), timer: null };
    this._leases.set(org, lease);
    this._touch(lease);
    return lease;
  }

  /** Mark a lease active, restarting its idle countdown. Call it on every step. */
  touch(org) {
    const l = this._leases.get(org);
    if (l) this._touch(l);
  }

  _touch(lease) {
    lease.lastUsed = Date.now();
    if (lease.timer) clearTimeout(lease.timer);
    lease.timer = setTimeout(() => { this.release(lease.org).catch(() => {}); }, this._idleMs);
    lease.timer.unref?.();
  }

  /** Close the organisation's context and free its slot. Idempotent. */
  async release(org) {
    const l = this._leases.get(org);
    if (!l) return false;
    this._leases.delete(org);
    if (l.timer) clearTimeout(l.timer);
    try { await l.context.close(); } catch { /* already gone */ }
    return true;
  }

  /** The longest-idle lease past the grace window, closed. True if one went. */
  async _evictIdle() {
    const now = Date.now();
    let victim = null;
    for (const l of this._leases.values()) {
      if (now - l.lastUsed < this._grace) continue;      // still warm — leave it
      if (!victim || l.lastUsed < victim.lastUsed) victim = l;
    }
    if (!victim) return false;
    await this.release(victim.org);
    return true;
  }

  /** Close every lease (shutdown). Leaves the browser itself open. */
  async drain() {
    await Promise.all([...this._leases.keys()].map((o) => this.release(o)));
  }
}
