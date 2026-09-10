/**
 * The case language, and everyone who has a copy of it.
 *
 * `flow.js` and `vocabulary.js` are the only files here that more than one
 * project needs. The runner executes cases, the browser extension writes them
 * with no server in the picture, and the Vue app renders them — so all three
 * parse and print the same grammar, and the alternative to copying is three
 * implementations that agree until they don't.
 *
 * The split moved one of those three out of reach. Two copies are still in
 * this repository and are still checked byte for byte, because a copy that is
 * checked is safe and a copy that is remembered is not. The UI's copy is in
 * ghostclick-web now, and no check that runs here can say anything true about
 * a file in a repository this checkout does not have.
 *
 * What replaces it is a number. The language declares LANGUAGE_VERSION, the
 * runner reports it at `/api/version`, and a consumer holding a copy compares
 * itself against the runner it is talking to — which is what a published
 * package would settle at install time, settled instead at the one moment the
 * two halves are in the same room. The digest below is what keeps the number
 * honest: it pins the bytes the number describes, so a grammar that changes
 * without the version moving fails `npm run check:shared` here, rather than
 * surprising the UI a fortnight later.
 *
 *   npm run sync:lang      make every copy match, and re-pin a bumped version
 *   npm run check:shared   fail if a copy has drifted, or the version has not
 *
 * A copy is still not a great answer, and it is still a better one than the
 * alternatives at this size: importing across a repository boundary is now
 * impossible rather than merely unwise, and publishing a package for two files
 * with two consumers is a release process nobody has asked for yet. When there
 * is a `@ghostclick/language`, this file is what it is made from and the
 * version in vocabulary.js is its first version number.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));

/** Copies that live in THIS repository, and are therefore checkable byte for byte. */
export const COPIES = [
  // The extension parses and writes whole cases offline, so it needs both.
  { from: 'flow.js', to: 'extension/lib/flow.js' },
  { from: 'vocabulary.js', to: 'extension/lib/vocabulary.js' },
];

/** The files the version describes, in the order the digest takes them. */
export const LANGUAGE_SOURCES = ['vocabulary.js', 'flow.js'];

/**
 * The bytes of the language, as one hash.
 *
 * Normalised to LF first. `.gitattributes` marks these files text, so a
 * checkout with core.autocrlf on holds CRLF in the working tree and would
 * otherwise hash differently from the same commit on a machine that does not —
 * a version check whose answer depends on which operating system ran it is a
 * version check people turn off.
 */
export const languageDigest = () => createHash('sha256')
  .update(LANGUAGE_SOURCES.map((p) => readFileSync(root(p), 'utf8').replace(/\r\n/g, '\n')).join('\0'))
  .digest('hex')
  .slice(0, 16);

/**
 * What the current LANGUAGE_VERSION is pinned to.
 *
 * Written by `npm run sync:lang`, and only once the version in vocabulary.js
 * has actually been bumped — which is the whole mechanism. Re-pinning on every
 * change with no bump would make this a hash of whatever happens to be there,
 * which proves nothing to anybody.
 */
export const PINNED = { version: 1, digest: '15032f2a2d928662' };
