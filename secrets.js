/**
 * The vault.
 *
 * A recorded password is written as $TODO and never as its value, so before a
 * flow can run someone has to say where the real one lives. That used to be a
 * literal in ops.js, which is fine for a demo and wrong the moment it is a real
 * account.
 *
 * One vault PER ORGANISATION (docs/AUTH.md §10), and the sources say who put
 * a value there:
 *
 *   .ghostclick/<org>/secrets.json   the organisation's own, machine-local, gitignored
 *   GC_SECRET_QA_PASS=…              the environment — the `local` organisation only.
 *                                    A value in the process environment belongs to
 *                                    whoever started the process, and handing it to
 *                                    every organisation on a shared runner is the
 *                                    leak the vault exists to prevent.
 *   the bundled demo credentials     every organisation, in demo mode only: they
 *                                    open the fixture pages and nothing else, and
 *                                    the fixtures are only served in demo mode.
 *
 * Names are shown in the UI so you can see what is available; values are never
 * sent to a viewer, never logged, and never written into a diagram. Whether a
 * plan may resolve a value at all (`vault.enabled`) is decided by the caller
 * that holds the token, not here: this module knows organisations, not plans.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEMO as DEMO_MODE } from './mode.js';
import { LOCAL, stateDir } from './org.js';

/**
 * Credentials for the two bundled demo apps, so `npm start` works with nothing
 * configured. They authenticate against demo.html and shop.html and nothing
 * else. Anything real comes from the environment and overrides these.
 */
const DEMO = { QA_USER: 'qa@example.com', QA_PASS: 'hunter2-but-from-a-vault' };

function load(org) {
  const out = new Map(DEMO_MODE ? Object.entries(DEMO) : []);
  if (org === LOCAL) {
    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith('GC_SECRET_') && v) out.set(k.slice('GC_SECRET_'.length), v);
    }
  }
  try {
    for (const [k, v] of Object.entries(JSON.parse(readFileSync(join(stateDir(org), 'secrets.json'), 'utf8')))) {
      if (typeof v === 'string' && v) out.set(k, v);
    }
  } catch { /* no file is normal */ }
  return out;
}

const vaults = new Map();

/** The vault of one organisation, the same object for every caller. */
export function forOrg(org) {
  const have = vaults.get(org);
  if (have) return have;

  let vault = load(org);
  const names = () => [...vault.keys()].sort();
  const store = {
    org,
    reload: () => { vault = load(org); return names(); },

    /** Just the names. A viewer never sees a value. */
    names,

    /** Which of them are still the bundled demo values, so the UI can say so. */
    isDemo: (key) => DEMO[key] !== undefined && vault.get(key) === DEMO[key],

    /** `secrets.QA_PASS` -> the value, or a message that says what to do about it. */
    get(ref) {
      const key = String(ref ?? '').replace(/^secrets\./, '');
      if (key === 'TODO') {
        throw new Error(
          'This step still says $TODO — the recorder never captured the password. ' +
          `Rename it to a key you have set${names().length ? ` (${names().join(', ')})` : ''}, ` +
          'e.g. $QA_PASS, and set GC_SECRET_QA_PASS.'
        );
      }
      if (!vault.has(key)) {
        throw new Error(
          `No secret named ${key}. Set GC_SECRET_${key}, or add it to .ghostclick/${org}/secrets.json.` +
          (names().length ? ` Available: ${names().join(', ')}.` : ' Nothing is set yet.')
        );
      }
      return vault.get(key);
    },
  };
  vaults.set(org, store);
  return store;
}
