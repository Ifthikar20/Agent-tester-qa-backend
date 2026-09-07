/**
 * The case language, and everyone who has a copy of it.
 *
 * `flow.js` and `vocabulary.js` are the only files in this repository that more
 * than one project needs. The backend executes cases, the Vue app renders them,
 * and the browser extension writes them with no server in the picture — so all
 * three parse and print the same grammar, and the alternative to copying is
 * three implementations that agree until they don't.
 *
 * A copy is not a great answer. It is a better one than the two obvious
 * alternatives at this size: importing across project boundaries (the frontend
 * did exactly that, and a frontend that cannot build without the backend's tree
 * beside it is not a separate project), or a published package (right eventually,
 * absurd for two files nobody outside this repository consumes yet).
 *
 * What makes it safe is that the copy is CHECKED, not remembered:
 *
 *   npm run sync:lang     make every copy match
 *   npm run check:shared   fail if one does not
 *
 * When these become separate repositories, this list is what turns into a
 * published `@ghostclick/language` — the consumers are already written as if it
 * were one, which is the point of listing them here rather than reaching across
 * directories at build time.
 */
export const COPIES = [
  // The extension parses and writes whole cases offline, so it needs both.
  { from: 'flow.js', to: 'extension/lib/flow.js' },
  { from: 'vocabulary.js', to: 'extension/lib/vocabulary.js' },
  // The Vue app only ever renders a step — `showAction` and `labelAction` —
  // so it takes the vocabulary and not the document format.
  { from: 'vocabulary.js', to: 'web/src/lang/vocabulary.js' },
];
