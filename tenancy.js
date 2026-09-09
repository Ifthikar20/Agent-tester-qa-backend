/**
 * One runner, many organisations (docs/AUTH.md §10, the runner half).
 *
 * The token says which organisation is calling, and everything below turns
 * that one claim into the four rules the runner enforces:
 *
 *   the workspace   every store is keyed by the organisation — its origins,
 *                   its vault, its history, its suites — and a request only
 *                   ever sees its own. A suite id from another organisation
 *                   is "no suite", never "not yours" [authz-tenancy-1].
 *   the driver      there is one Chromium and one run lock. Whoever opens a
 *                   page or starts a run is the DRIVING organisation, and
 *                   everyone else is told the runner is busy rather than shown
 *                   somebody else's browser. The lock lets go when the run
 *                   has ended and none of that organisation's sockets has
 *                   been active for a minute.
 *   the plan        `ent` in the token is what the organisation's plan allows,
 *                   and it is enforced HERE, never only in the UI: a refusal
 *                   is a 402 naming the limit and the plan, whoever asked.
 *   the version     `ent_v` rises whenever the plan changes; a token minted
 *                   before the change is refused once a newer one has been
 *                   seen, so a downgrade takes effect on the next request
 *                   rather than when the old tokens run out (§8.6).
 *
 * With auth off there is one organisation, `local`, and every rule reduces
 * to what the runner always did: the same code path, with nothing to refuse.
 * Pure where it can be — the lock and the plan take an injectable clock and
 * no claims at all — so a check can exercise them without a browser.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { LOCAL, assertOrg, isOrg } from './org.js';
import * as origins from './origins.js';
import * as vault from './secrets.js';
import * as history from './runs.js';
import * as suites from './suites.js';

export { LOCAL, isOrg };

/** The organisation a set of claims acts for; no claims is the laptop, `local`. */
export const orgOf = (claims) => (claims ? assertOrg(String(claims.org)) : LOCAL);

// ------------------------------------------------------------- the workspace

const spaces = new Map();

/**
 * Everything one organisation owns, opened once and shared by every caller.
 * The slug is checked before any path is built from it.
 */
export function workspace(org) {
  assertOrg(org);
  let space = spaces.get(org);
  if (!space) {
    space = {
      org,
      origins: origins.forOrg(org),
      vault: vault.forOrg(org),
      history: history.forOrg(org),
      suites: suites.forOrg(org),
    };
    spaces.set(org, space);
  }
  return space;
}

// ------------------------------------------------------------- the migration

const ROOT = fileURLToPath(new URL('./', import.meta.url));
const FLAT_STATE = ['origins.json', 'runs.json', 'secrets.json'];

/**
 * Move a runner's old flat files into the `local` organisation, once.
 *
 * Before tenancy the state was `.ghostclick/origins.json` and the suites were
 * `suites/*.json`. Those files were made by a runner with no login, which is
 * exactly what `local` means, so that is where they go — in BOTH modes. A
 * gated runner that inherits a flat allowlist must not hand it to whichever
 * organisation signs in first; under `local` no token can reach it.
 *
 * Only ever a rename, and only when the destination does not exist: nothing
 * is deleted, and a file that has already been moved is left alone.
 * Returns what was moved, so the boot banner can say so.
 */
export function migrate(root = ROOT) {
  const moved = [];
  const state = join(root, '.ghostclick');
  for (const name of FLAT_STATE) {
    const from = join(state, name);
    const to = join(state, LOCAL, name);
    if (existsSync(from) && !existsSync(to)) {
      mkdirSync(join(state, LOCAL), { recursive: true });
      renameSync(from, to);
      moved.push(`.ghostclick/${name} -> .ghostclick/${LOCAL}/${name}`);
    }
  }
  const dir = join(root, 'suites');
  let flat = [];
  try { flat = readdirSync(dir).filter((f) => f.endsWith('.json') && statSync(join(dir, f)).isFile()); } catch { /* no suites yet */ }
  for (const f of flat) {
    const to = join(dir, LOCAL, f);
    if (existsSync(to)) continue;
    mkdirSync(join(dir, LOCAL), { recursive: true });
    renameSync(join(dir, f), to);
    moved.push(`suites/${f} -> suites/${LOCAL}/${f}`);
  }
  return moved;
}

// ------------------------------------------------------------- the driver

/** How long an idle organisation keeps the browser after its run has ended. */
export const IDLE_MS = 60_000;

export class RunnerBusy extends Error {
  constructor(org) {
    super('another organisation has the browser right now');
    this.name = 'RunnerBusy';
    this.org = org;
  }
}

/**
 * Who is driving the one browser.
 *
 * `org` is whose page is on the screen: it changes only when another
 * organisation takes over, so frames never go to anyone but the organisation
 * whose page they show, even after the lock has lapsed. `holder()` is the
 * lock itself — the same organisation while a run is in progress or while
 * any of its sockets has been active within `idleMs`, and nobody otherwise.
 */
export class Driver {
  constructor({ idleMs = IDLE_MS, now = Date.now, isRunning = () => false } = {}) {
    this.idleMs = idleMs;
    this.now = now;
    this.isRunning = isRunning;
    this.org = null;
    this.lastActive = 0;
  }

  /** The organisation holding the lock, or null. */
  holder() {
    if (!this.org) return null;
    if (this.isRunning()) return this.org;
    return this.now() - this.lastActive < this.idleMs ? this.org : null;
  }

  held() { return this.holder() !== null; }

  /** Whether this organisation's sockets should see the page. */
  sees(org) { return this.org !== null && org === this.org; }

  /**
   * Take the browser for `org`. Throws RunnerBusy while someone else holds
   * it; returns whether the page changed hands.
   */
  claim(org) {
    const holder = this.holder();
    if (holder && holder !== org) throw new RunnerBusy(holder);
    const changed = this.org !== org;
    this.org = org;
    this.lastActive = this.now();
    return changed;
  }

  /** A socket of `org` did something: the lock lives another `idleMs`. */
  touch(org) {
    if (org === this.org) this.lastActive = this.now();
  }

  /** When the lock will lapse on its own, in ms from now — or null while a run holds it. */
  lapsesIn() {
    if (!this.org || this.isRunning()) return null;
    return Math.max(0, this.lastActive + this.idleMs - this.now());
  }

  /** The lock as `org` sees it. */
  describe(org) {
    const holder = this.holder();
    return { org: this.org, held: holder !== null, mine: this.org !== null && this.org === org };
  }
}

// ------------------------------------------------------------- the plan

export class EntitlementError extends Error {
  constructor(limit, plan) {
    super(`the ${plan ?? 'current'} plan does not allow this (${limit})`);
    this.name = 'EntitlementError';
    this.limit = limit;
    this.plan = plan ?? null;
  }
}

/**
 * What the token's plan allows, as questions with one answer each.
 *
 * `ent` is the runner-enforced subset the control plane put in the token: a
 * count is a number or null for unlimited, a switch is true or false. Nothing
 * here reads a number from anywhere but the claims. No claims — auth off —
 * is unlimited, because there is no plan on a laptop.
 *
 * A count the token does not mention is unlimited: the control plane says
 * what it limits. A switch the token does not mention is OFF: a capability
 * has to be granted, not assumed.
 */
export function entitlements(claims) {
  const gated = claims != null;
  const ent = (gated && claims.ent && typeof claims.ent === 'object') ? claims.ent : {};
  const plan = gated ? (typeof claims.plan === 'string' && claims.plan ? claims.plan : null) : null;
  return {
    plan,
    limit(key) {
      if (!gated) return null;
      const v = ent[key];
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    },
    enabled(key) { return !gated || ent[key] === true; },
    /** Throw when `used` plus `want` more would pass the limit. */
    check(key, used, want = 1) {
      const max = this.limit(key);
      if (max !== null && used + want > max) throw new EntitlementError(key, plan);
    },
    /** Throw when the switch is off. */
    demand(key) {
      if (!this.enabled(key)) throw new EntitlementError(key, plan);
    },
  };
}

// ------------------------------------------------------------- the role

export class Forbidden extends Error {
  constructor(role) {
    super(`this needs an owner or admin of the organisation, and the token says ${role ?? 'nothing'}`);
    this.name = 'Forbidden';
    this.role = role ?? null;
  }
}

/**
 * Owners and admins manage the organisation's origins and vault; members run
 * and view (docs/AUTH.md §10). The role is read from the token and nowhere
 * else. No claims is the laptop, where there is nobody to refuse.
 */
export const manages = (claims) => claims == null || claims.role === 'owner' || claims.role === 'admin';

export function requireManager(claims) {
  if (!manages(claims)) throw new Forbidden(claims?.role);
}

// ------------------------------------------------------------- the version

export class StaleEntitlements extends Error {
  constructor(org) {
    super('the organisation’s plan has changed since this token was minted');
    this.name = 'StaleEntitlements';
    this.org = org;
  }
}

const versions = new Map();   // org -> the highest ent_v this process has seen

/**
 * Note a token's `ent_v`, and refuse it if a newer one has been seen for the
 * organisation. In memory, in this process: a restart forgets, and the next
 * token re-establishes the high-water mark within ten minutes.
 */
export function noteVersion(claims) {
  if (claims == null) return;
  const org = orgOf(claims);
  const v = Number(claims.ent_v) || 0;
  const seen = versions.get(org) ?? 0;
  if (v < seen) throw new StaleEntitlements(org);
  if (v > seen) versions.set(org, v);
}

/** Whether a socket's bound claims have been overtaken by a newer token. */
export function stale(claims) {
  if (claims == null) return false;
  return (Number(claims.ent_v) || 0) < (versions.get(orgOf(claims)) ?? 0);
}

/** For the checks. */
export const forgetVersions = () => versions.clear();
