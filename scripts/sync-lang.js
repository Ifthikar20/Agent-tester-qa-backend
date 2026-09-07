/**
 * Make every copy of the case language match the original.
 *
 *   npm run sync:lang
 *
 * Edit `vocabulary.js` or `flow.js`, run this, commit both. `npm run
 * check:shared` is what stops you forgetting — this is what makes remembering
 * cheap. The list of copies is in scripts/copies.js, with why they exist.
 */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COPIES } from './copies.js';

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
console.log(changed ? `\n  ${changed} updated — commit them with ${COPIES.map((c) => c.from).filter((v, i, a) => a.indexOf(v) === i).join(' and ')}.\n`
                    : '\n  every copy already matches.\n');
