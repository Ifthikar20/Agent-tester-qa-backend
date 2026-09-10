/**
 * Request limits: how much any one address may ask of this process.
 *
 * The runner drives a real browser, so one client sending requests as fast as
 * it can is not a nuisance but an outage — a scan, a run or a screenshot is
 * seconds of Chrome each. And a gated runner answers a bad token with a 401 at
 * no cost to the caller, which is exactly the shape a guessing loop wants. So
 * there is a ceiling per address on the API, a much lower one on failed
 * authentication — past it the address is refused everything until the window
 * ends — and ceilings on socket tickets, socket connections, and messages per
 * socket.
 *
 *   GC_API_RATE          600/m     every /api request, per address
 *   GC_AUTH_FAIL_RATE    20/5m     bad tokens per address before it is shut out
 *   GC_TICKET_RATE       30/m      POST /api/socket-ticket, per address
 *   GC_WS_CONNECT_RATE   30/m      socket upgrades, per address
 *   GC_WS_MESSAGE_RATE   3000/10s  messages, per socket (a canvas sends a
 *                                  pointer position every frame)
 *
 * On whenever auth is on, which is the deployed shape, or when any of these is
 * named. A laptop runner is one person's, and the repository's check suites
 * hammer it on purpose; limiting that by default would only make them flaky.
 *
 * Counters live in this process, in fixed windows — the arithmetic and the
 * rate syntax of the control plane's ratelimit.py, so the numbers in the two
 * services read the same. One runner process is the deployment's shape
 * (docs/DEPLOY.md), which makes in-process shared enough; a second runner
 * behind the same edge would need them moved to Redis.
 */
import { isIP } from 'node:net';
import { AUTH_ON } from './mode.js';

const UNITS = { s: 1, m: 60, h: 3600, d: 86400 };
const NAMES = ['GC_API_RATE', 'GC_AUTH_FAIL_RATE', 'GC_TICKET_RATE', 'GC_WS_CONNECT_RATE', 'GC_WS_MESSAGE_RATE'];

/** '600/m' -> { limit: 600, ms: 60000 }. '20/5m' -> { limit: 20, ms: 300000 }. */
export function parseRate(spec, name = 'rate') {
  const m = /^(\d+)\/(\d*)([smhd])$/.exec(String(spec ?? '').trim());
  if (!m || Number(m[1]) < 1) throw new Error(`${name}="${spec}" is not a rate — write it like 600/m or 20/5m`);
  return { limit: Number(m[1]), ms: Number(m[2] || 1) * UNITS[m[3]] * 1000 };
}

export class Limiter {
  /**
   * A rate counts requests, and the one past the limit is refused. A `budget`
   * counts things that went wrong — failed authentications — and spending its
   * last allowance is itself what shuts the key out, so the attempt after the
   * limit is never made at all: 20/5m is twenty tries, not twenty-one.
   *
   * `shared` limiters sweep themselves; one made per socket holds one key and
   * dies with it.
   */
  constructor(spec, name = 'rate', { shared = true, budget = false } = {}) {
    Object.assign(this, parseRate(spec, name));
    this.name = name;
    this.edge = budget ? this.limit : this.limit + 1;   // the count at which the key is out
    this.windows = new Map();   // key -> { count, until }
    if (shared) setInterval(() => this.sweep(), Math.min(this.ms, 60_000)).unref?.();
  }

  /** Count one against `key`: { over, first, retryAfter } — `first` is the hit that put the key out, once a window. */
  hit(key, now = Date.now()) {
    let w = this.windows.get(key);
    if (!w || now >= w.until) {
      w = { count: 0, until: now + this.ms };
      this.windows.set(key, w);
    }
    w.count += 1;
    return { over: w.count >= this.edge, first: w.count === this.edge, retryAfter: secondsLeft(w, now) };
  }

  /** Seconds until `key` may try again, or 0 if it is not out. Counts nothing. */
  blocked(key, now = Date.now()) {
    const w = this.windows.get(key);
    return w && now < w.until && w.count >= this.edge ? secondsLeft(w, now) : 0;
  }

  sweep(now = Date.now()) {
    for (const [key, w] of this.windows) if (now >= w.until) this.windows.delete(key);
  }
}

const secondsLeft = (w, now) => Math.max(1, Math.ceil((w.until - now) / 1000));

/** A limiter that never says no, for a runner that is not limited. */
const OPEN = { hit: () => ({ over: false, first: false, retryAfter: 0 }), blocked: () => 0 };

/**
 * How many proxies' X-Forwarded-For entries to believe. Behind the edge it is
 * 1: Caddy REPLACES the header with the address it accepted the connection
 * from, so its entry is the client and nothing a client sends can move it.
 * On a laptop it is 0, where the header is whatever the client typed.
 */
function trustedProxies() {
  const raw = (process.env.GC_TRUSTED_PROXY_COUNT ?? '').trim();
  if (raw === '') return 0;
  if (!/^\d+$/.test(raw)) throw new Error(`GC_TRUSTED_PROXY_COUNT="${raw}" must be a whole number of proxies, like 1`);
  return Number(raw);
}

/**
 * The caller's address — the same arithmetic as the control plane's
 * events.client_ip, so a limit in either service is keyed on the same
 * address, and like it the value is parsed before it is believed.
 */
export function clientIp(req, trusted = TRUSTED) {
  const forwarded = String(req.headers?.['x-forwarded-for'] ?? '');
  if (trusted > 0 && forwarded) {
    const hops = forwarded.split(',').map((h) => h.trim()).filter(Boolean);
    const candidate = hops.length >= trusted ? hops[hops.length - trusted].replace(/^\[|\]$/g, '') : '';
    if (isIP(candidate)) return candidate;
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

const setting = (name, fallback) => (process.env[name] ?? '').trim() || fallback;

/** Whether this process limits at all, the limits it was started with, and why they could not be read. */
export const ENFORCED = AUTH_ON || NAMES.some((name) => (process.env[name] ?? '').trim() !== '');
export let TRUSTED = 0;
export let LIMITS = { api: OPEN, authFail: OPEN, tickets: OPEN, connect: OPEN, messages: null };
export let LIMIT_ERROR = null;
try {
  TRUSTED = trustedProxies();
  if (ENFORCED) {
    LIMITS = {
      api: new Limiter(setting('GC_API_RATE', '600/m'), 'GC_API_RATE'),
      authFail: new Limiter(setting('GC_AUTH_FAIL_RATE', '20/5m'), 'GC_AUTH_FAIL_RATE', { budget: true }),
      tickets: new Limiter(setting('GC_TICKET_RATE', '30/m'), 'GC_TICKET_RATE'),
      connect: new Limiter(setting('GC_WS_CONNECT_RATE', '30/m'), 'GC_WS_CONNECT_RATE'),
      // A spec, not a limiter: every socket gets its own.
      messages: setting('GC_WS_MESSAGE_RATE', '3000/10s'),
    };
    parseRate(LIMITS.messages, 'GC_WS_MESSAGE_RATE');
  }
} catch (err) {
  LIMIT_ERROR = err.message;
}
