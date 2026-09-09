/**
 * Which origins may be driven — decided at runtime, by a human, and remembered.
 *
 * This used to be an env var read at boot, so pointing the runner at a new app
 * meant stopping it, exporting a variable and starting again. The gate itself
 * was never the problem; needing a restart to open it was.
 *
 * So the allowlist is still a hard gate in front of every `goto`, and a plan
 * still cannot add to it — only a person can, through the UI, one origin at a
 * time. That is the distinction that matters: the list exists to stop generated
 * text from reaching arbitrary hosts, not to stop you from choosing one.
 *
 * One list PER ORGANISATION (docs/AUTH.md §10). An origin that Acme allowed is
 * a decision Acme made about where Acme's browser may go; Globex allowing it
 * is a separate decision, and the two lists live in separate files under
 * `.ghostclick/<org>/`. `forOrg(org)` hands back the organisation's list, the
 * same object every time, so every caller in the process sees one state.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEMO } from './mode.js';
import { stateDir } from './org.js';

/**
 * This process's own origin, where the bundled demo apps live. Seeded as
 * drivable in demo mode and never otherwise: a gated runner on a public
 * address has nothing of its own to drive, and its own origin is exactly the
 * one a page must not be pointed at (docs/AUTH.md §11).
 */
const own = () => `http://localhost:${process.env.PORT || 3000}`;

/** Loopback and the private ranges, including where cloud metadata lives. */
export const PRIVATE_HOST =
  /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[?::1\]?|.*\.local|.*\.internal)$/i;

/**
 * Turn what a person types into a URL. "treasury.acme.com" is a host, not a
 * relative path, and making them type the scheme is the kind of friction that
 * ends with the tool unused.
 */
export function normalizeUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('No URL given');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : `${/^(localhost|127\.|0\.0\.0\.0|\[?::1)/i.test(raw) ? 'http' : 'https'}://${raw}`;
  let u;
  try { u = new URL(withScheme); } catch { throw new Error(`Cannot read "${raw}" as a URL`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Only http and https can be driven, not ${u.protocol}`);
  }
  return u;
}

const stores = new Map();

/**
 * The allowlist of one organisation. Memoised: two callers asking for the
 * same organisation must share one Set, or an origin allowed through the
 * socket would not be allowed for the next HTTP call.
 *
 * Seeds are the operator's, not the organisation's: the demo origin in demo
 * mode and ALLOWED_ORIGINS from the environment are boot-time decisions
 * made by whoever started the process, so every organisation gets them.
 * They still count towards `origins.max` — the plan bounds the size of the
 * list, and the list is what the gate reads.
 */
export function forOrg(org) {
  const have = stores.get(org);
  if (have) return have;

  const STORE = join(stateDir(org), 'origins.json');
  const fromEnv = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  let saved = [];
  try { saved = JSON.parse(readFileSync(STORE, 'utf8')).origins ?? []; } catch { /* first run */ }
  const allowed = new Set([...(DEMO ? [own()] : []), ...saved, ...fromEnv]);

  function persist() {
    try {
      mkdirSync(stateDir(org), { recursive: true });
      writeFileSync(STORE, JSON.stringify({ origins: [...allowed] }, null, 2));
    } catch { /* read-only checkout; the list still works for this session */ }
  }

  const store = {
    org,
    list: () => [...allowed],
    has: (origin) => allowed.has(origin) || allowed.has('*'),

    add(input) {
      const u = normalizeUrl(input);
      if (allowed.has(u.origin)) return { origin: u.origin, added: false, private: PRIVATE_HOST.test(u.hostname) };
      allowed.add(u.origin);
      persist();
      return { origin: u.origin, added: true, private: PRIVATE_HOST.test(u.hostname) };
    },

    remove(origin) {
      if (DEMO && origin === own()) throw new Error('That is where the demo apps are served from');
      const gone = allowed.delete(origin);
      if (gone) persist();
      return gone;
    },
  };
  stores.set(org, store);
  return store;
}
