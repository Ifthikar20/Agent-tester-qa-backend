/**
 * Make every copy of the case language match, and record what version it is.
 *
 *   npm run sync:lang
 *
 * Edit `vocabulary.js` or `flow.js`, run this, commit everything it touched.
 * `npm run check:shared` is what stops you forgetting; this is what makes
 * remembering cheap. scripts/copies.js says who holds a copy and why.
 *
 * Two jobs, and the second one arrived with the split. The copies inside this
 * repository can be made to match by copying. The one in ghostclick-web cannot
 * — this side has no access to it — so what it gets instead is a version
 * number it can compare itself against at runtime, and this is where that
 * number is recorded as describing particular bytes.
 *
 * It will not bump the version for you. A script that silently re-pinned the
 * digest on every edit would turn the whole mechanism into a hash of whatever
 * is currently there: it would always pass, and the UI would go on believing
 * it holds version 1 of a grammar that has moved twice. Deciding that the
 * language changed is a judgement, so this makes the judgement visible and
 * refuses to make it.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGUAGE_VERSION } from '../vocabulary.js';
import { COPIES, PINNED, languageDigest } from './copies.js';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const read = (p) => { try { return readFileSync(root(p), 'utf8'); } catch { return null; } };

let changed = 0;
for (const { from, to } of COPIES) {
  if (read(from) === read(to)) { console.log(`  ok       ${to}`); continue; }
  mkdirSync(dirname(root(to)), { recursive: true });
  copyFileSync(root(from), root(to));
  changed++;
  console.log(`  copied   ${to}  <-  ${from}`);
}

// ---------------------------------------------------------------- the version
const digest = languageDigest();
const PIN_FILE = root('scripts/copies.js');

if (digest === PINNED.digest && LANGUAGE_VERSION === PINNED.version) {
  console.log(`  ok       language version ${LANGUAGE_VERSION} (${digest})`);
} else if (LANGUAGE_VERSION === PINNED.version && PINNED.digest !== 'PENDING') {
  // The grammar moved and the number did not. This is the case the whole
  // mechanism exists for, and the only thing to do about it is say so.
  console.log(`\n  the case language has CHANGED and LANGUAGE_VERSION is still ${LANGUAGE_VERSION}.`);
  console.log('\n  If the change alters what a consumer sees — a new verb, a new syntax, a');
  console.log('  different way of writing one back — bump LANGUAGE_VERSION in vocabulary.js');
  console.log('  and run this again. If it does not (a comment, a rename nobody can see),');
  console.log(`  bump it anyway: the number costs nothing and a copy that believes it is\n  current when it is not costs an afternoon.\n`);
  process.exit(1);
} else {
  const src = readFileSync(PIN_FILE, 'utf8');
  const next = src.replace(/export const PINNED = \{[^}]*\};/,
    `export const PINNED = { version: ${LANGUAGE_VERSION}, digest: '${digest}' };`);
  if (next === src) {
    console.log('\n  could not find PINNED in scripts/copies.js to update — edit it by hand.\n');
    process.exit(1);
  }
  writeFileSync(PIN_FILE, next);
  changed++;
  console.log(`  pinned   language version ${LANGUAGE_VERSION} (${digest})  <-  was ${PINNED.version} (${PINNED.digest})`);
  console.log('\n  Tell ghostclick-web: its copy of vocabulary.js needs the same update, and');
  console.log(`  the version it compares against a runner is now ${LANGUAGE_VERSION}.`);
}

console.log(changed
  ? `\n  ${changed} updated — commit them together with the language.\n`
  : '\n  every copy already matches.\n');
