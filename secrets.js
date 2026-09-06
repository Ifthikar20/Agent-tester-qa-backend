/**
 * The vault.
 *
 * A recorded password is written as $TODO and never as its value, so before a
 * flow can run someone has to say where the real one lives. That used to be a
 * literal in ops.js, which is fine for a demo and wrong the moment it is a real
 * account.
 *
 * Two sources, neither of them the repository:
 *   GC_SECRET_QA_PASS=…            environment
 *   .ghostclick/secrets.json       machine-local, gitignored
 *
 * Names are shown in the UI so you can see what is available; values are never
 * sent to a viewer, never logged, and never written into a diagram.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STORE = fileURLToPath(new URL('./.ghostclick/secrets.json', import.meta.url));

/**
 * Credentials for the two bundled demo apps, so `npm start` works with nothing
 * configured. They authenticate against demo.html and shop.html and nothing
 * else. Anything real comes from the environment and overrides these.
 */
const DEMO = { QA_USER: 'qa@example.com', QA_PASS: 'hunter2-but-from-a-vault' };

function load() {
  const out = new Map(Object.entries(DEMO));
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('GC_SECRET_') && v) out.set(k.slice('GC_SECRET_'.length), v);
  }
  try {
    for (const [k, v] of Object.entries(JSON.parse(readFileSync(STORE, 'utf8')))) {
      if (typeof v === 'string' && v) out.set(k, v);
    }
  } catch { /* no file is normal */ }
  return out;
}

let vault = load();
export const reload = () => { vault = load(); return names(); };

/** Just the names. A viewer never sees a value. */
export const names = () => [...vault.keys()].sort();

/** Which of them are still the bundled demo values, so the UI can say so. */
export const isDemo = (key) => DEMO[key] !== undefined && vault.get(key) === DEMO[key];

/** `secrets.QA_PASS` -> the value, or a message that says what to do about it. */
export function get(ref) {
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
      `No secret named ${key}. Set GC_SECRET_${key}, or add it to .ghostclick/secrets.json.` +
      (names().length ? ` Available: ${names().join(', ')}.` : ' Nothing is set yet.')
    );
  }
  return vault.get(key);
}
