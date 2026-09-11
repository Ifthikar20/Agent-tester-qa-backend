/**
 * A saved sign-in, so a run can start already logged in.
 *
 * Some logins cannot be recorded and replayed. "Continue with Google" refuses
 * to run in an automated browser at all — Google blocks sign-in from a browser
 * "controlled through software automation rather than a human" — and a passkey
 * or an emailed code is no better. The flow that needs testing is everything
 * PAST the login, and re-doing the login on every run is the part that cannot
 * be done here.
 *
 * So a person signs in once in their OWN browser, and the resulting session —
 * the cookies treasury.sh set for itself, not anything Google holds — is handed
 * to the runner, which opens its browser already carrying it. This is
 * Playwright's own `storageState`, and reusing it is exactly what Playwright's
 * docs recommend for authenticated tests.
 *
 * A session is a live credential, so it is treated like one, the way the vault
 * (secrets.js) treats a password:
 *
 *   - ONE session PER ORGANISATION, under `.ghostclick/<org>/session.json`,
 *     machine-local and gitignored. Acme's saved login is Acme's, and no token
 *     for another organisation can reach it.
 *   - It is only ever loaded for an origin the organisation STILL allows. A
 *     cookie is a key to a host; replaying one for a host nobody approved is
 *     the same leak the origin gate exists to stop, so the allowlist is checked
 *     when it is saved AND again every time it is loaded — an origin removed in
 *     between is dropped, not replayed.
 *   - Values never leave the server: never sent to a viewer, and redacted out
 *     of the driven page's console the way vault values are (server.js).
 *
 * This module knows organisations and origins, not plans: whether an
 * organisation may use a saved session at all is the caller's question, decided
 * where the token is read.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './org.js';

/** Two characters would redact everywhere; a real cookie or token is not that short. */
const SECRET_MIN = 8;

/**
 * `https://app.treasury.sh:8443` -> `app.treasury.sh`, or null if it will not
 * parse. The hostname, not the host: cookies are not port-specific, so the port
 * must not be part of the comparison or a cookie for `localhost` would never
 * match the allowed origin `http://localhost:3000`.
 */
const hostOf = (origin) => { try { return new URL(origin).hostname.toLowerCase(); } catch { return null; } };

/**
 * Cookie-domain match, as a browser does it: a cookie for `d` is sent to host
 * `h` when they are equal, or `h` is a subdomain of `d`. So a `.treasury.sh`
 * cookie is kept when `app.treasury.sh` is allowed, and an `app.treasury.sh`
 * cookie is not kept merely because `treasury.sh` is.
 */
function domainMatch(host, cookieDomain) {
  const d = String(cookieDomain ?? '').replace(/^\./, '').toLowerCase();
  if (!d || !host) return false;
  return host === d || host.endsWith(`.${d}`);
}

/**
 * Keep only the parts of a storageState that belong to an allowed origin.
 * Pure, so the gate can be tested without a browser or a disk.
 *
 * @param state  a Playwright storageState: { cookies: [...], origins: [...] }
 * @param allowedOrigins  the organisation's current allowlist
 * @returns {{cookies: object[], origins: object[]}} — possibly empty
 */
export function filterToAllowed(state, allowedOrigins) {
  const hosts = (allowedOrigins ?? []).map(hostOf).filter(Boolean);
  const cookies = (Array.isArray(state?.cookies) ? state.cookies : [])
    .filter((c) => hosts.some((h) => domainMatch(h, c?.domain)));
  const origins = (Array.isArray(state?.origins) ? state.origins : [])
    .filter((o) => allowedOrigins?.includes(o?.origin));
  return { cookies, origins };
}

/** Every stored value long enough to be worth redacting: cookie values and localStorage. */
function secretsIn(state) {
  const out = [];
  for (const c of state?.cookies ?? []) if (typeof c?.value === 'string' && c.value.length >= SECRET_MIN) out.push(c.value);
  for (const o of state?.origins ?? []) for (const kv of o?.localStorage ?? []) {
    if (typeof kv?.value === 'string' && kv.value.length >= SECRET_MIN) out.push(kv.value);
  }
  return out;
}

/** The soonest a stored cookie expires, as epoch seconds — or null if none do (session cookies). */
function soonestExpiry(state) {
  const times = (state?.cookies ?? []).map((c) => c?.expires).filter((e) => typeof e === 'number' && e > 0);
  return times.length ? Math.min(...times) : null;
}

const stores = new Map();

/**
 * The saved session of one organisation, the same object for every caller
 * (memoised, like the vault and the allowlist, so the socket and an HTTP call
 * see one state).
 *
 * The parsed file is cached and only re-read when its mtime changes, so the
 * per-console-line redaction below is a map lookup rather than a disk read, yet
 * a session imported by `scripts/session.js` while the server runs is still
 * picked up the next time a page is opened — no restart.
 */
export function forOrg(org) {
  const have = stores.get(org);
  if (have) return have;

  const file = join(stateDir(org), 'session.json');
  let cache = null;         // the parsed storageState, or null for none
  let mtime = 0;

  function ensureFresh() {
    let stat = null;
    try { stat = statSync(file); } catch { cache = null; mtime = 0; return; }
    if (stat.mtimeMs === mtime && cache) return;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      cache = { cookies: parsed.cookies ?? [], origins: parsed.origins ?? [] };
      mtime = stat.mtimeMs;
    } catch { cache = null; mtime = 0; /* unreadable is the same as absent */ }
  }

  const store = {
    org,
    path: () => file,

    /**
     * Save a session, keeping only what belongs to an allowed origin.
     *
     * Refuses rather than silently store nothing: if none of the cookies match
     * an allowed origin, the fix is to allow that origin first, and the message
     * says so — the same shape as the origin gate's other refusals.
     */
    set(state, allowedOrigins) {
      const kept = filterToAllowed(state, allowedOrigins);
      if (!kept.cookies.length && !kept.origins.length) {
        const had = [...new Set((state?.cookies ?? []).map((c) => String(c?.domain ?? '').replace(/^\./, '')).filter(Boolean))];
        throw new Error(
          'None of this session belongs to an allowed origin, so nothing was saved.'
          + (had.length ? ` It has cookies for: ${had.join(', ')}.` : '')
          + ` Allowed right now: ${(allowedOrigins ?? []).join(', ') || 'nothing'}.`
          + ' Allow the origin first, then import the session.',
        );
      }
      mkdirSync(stateDir(org), { recursive: true });
      writeFileSync(file, JSON.stringify(kept, null, 2), { mode: 0o600 });
      cache = kept;
      try { mtime = statSync(file).mtimeMs; } catch { mtime = 0; }
      return store.summary();
    },

    /** Forget the saved session. */
    clear() {
      cache = null; mtime = 0;
      try { rmSync(file); return true; } catch { return false; }
    },

    /**
     * The storageState to open a context with, filtered AGAIN to what is
     * allowed right now — an origin removed since the session was saved must
     * not be reopened just because a file remembers it — or null when there is
     * nothing to load. This is the only method the runner calls to inject.
     */
    state(allowedOrigins) {
      ensureFresh();
      if (!cache) return null;
      const kept = filterToAllowed(cache, allowedOrigins);
      return (kept.cookies.length || kept.origins.length) ? kept : null;
    },

    /** Every stored value worth stripping from the console. Cheap: no disk read. */
    values: () => (cache ? secretsIn(cache) : []),

    /**
     * What is safe to show about the saved session: never a value. Cookie names
     * and the origins they belong to, the count, and when it goes stale — enough
     * for the console to say "signed in for treasury.sh, expires Friday".
     */
    summary() {
      ensureFresh();
      if (!cache) return { loaded: false, origins: [], cookies: 0, names: [], expires: null };
      const origins = [...new Set([
        ...cache.cookies.map((c) => String(c?.domain ?? '').replace(/^\./, '')).filter(Boolean),
        ...cache.origins.map((o) => o?.origin).filter(Boolean),
      ])];
      return {
        loaded: true,
        origins,
        cookies: cache.cookies.length,
        names: [...new Set(cache.cookies.map((c) => c?.name).filter(Boolean))],
        expires: soonestExpiry(cache),
      };
    },
  };
  stores.set(org, store);
  return store;
}

/** A one-line note for the boot/handover log — names the origins, never a value. */
export function describe(state) {
  const origins = [...new Set((state?.cookies ?? []).map((c) => String(c?.domain ?? '').replace(/^\./, '')).filter(Boolean))];
  const n = state?.cookies?.length ?? 0;
  return `${n} cookie${n === 1 ? '' : 's'}${origins.length ? ` for ${origins.join(', ')}` : ''}`;
}
