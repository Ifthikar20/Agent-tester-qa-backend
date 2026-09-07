/**
 * Where the runner points when it starts.
 *
 * It used to be a constant: `http://localhost:3000/demo.html`, the bundled demo
 * app, every launch. Reasonable to see once, strange on the fortieth, when what
 * you were actually working on was a staging URL.
 *
 * The rule now, in order:
 *
 *   1. HOME_URL, if someone named one on the command line. An explicit choice
 *      beats an inferred one.
 *   2. The newest run in history whose origin is STILL ALLOWED. It is a URL
 *      that ran here before, so it normally passes — but an origin you have
 *      since removed should not be re-opened just because a file remembers it.
 *   3. Nothing. The console says "Nothing open yet", which is the truth, rather
 *      than a black rectangle under the word "waiting", which reads as a hang.
 *
 * Pure on purpose — no fs, no network, no browser. The version that lived
 * inside server.js could not be tested without starting a browser and binding a
 * port, so the branch that matters most (empty history, the state of every
 * fresh clone, because `.ghostclick/` is gitignored) was never exercised at
 * all. This file is the same split that took vocabulary.js out of flow.js.
 *
 * @param {object}   opts
 * @param {string?}  opts.envUrl     process.env.HOME_URL
 * @param {object[]} opts.runs       run history, OLDEST first (runs.js `list()`)
 * @param {(origin: string) => boolean} opts.isAllowed
 * @returns {string|null}
 */
export function chooseHome({ envUrl, runs = [], isAllowed = () => true } = {}) {
  if (envUrl) return envUrl;

  // Newest first. `list()` hands back oldest first, and reading the array in
  // the wrong direction would reliably reopen whatever you ran a fortnight ago.
  for (let i = runs.length - 1; i >= 0; i--) {
    const url = runs[i]?.url;
    if (!url) continue;
    try {
      if (isAllowed(new URL(url).origin)) return url;
    } catch { /* not a URL any more; skip it rather than throw at boot */ }
  }
  return null;
}
