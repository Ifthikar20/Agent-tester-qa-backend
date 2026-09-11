/**
 * Cloudflare Turnstile on the page being driven.
 *
 * Turnstile exists to tell a person from an automated browser, and the browser
 * a run drives IS an automated one. On a page with a production key a sign-up
 * does not get past it — "Verification failed" — and the step that notices is
 * an assertion a few steps later whose message says nothing about why. That is
 * Turnstile working, not the runner breaking, and it is not something to get
 * around.
 *
 * What makes a form behind Turnstile testable is Cloudflare's own test keys. An
 * environment on 1x00000000000000000000AA passes every time and one on
 * 2x00000000000000000000AB fails every time, with the widget still in the page
 * and the backend still verifying the token — each paired with its test
 * secret, because a production secret rejects the dummy token a test key hands
 * out. https://developers.cloudflare.com/turnstile/troubleshooting/testing/
 *
 * So the runner says which of those it is looking at. The widget is an iframe
 * from challenges.cloudflare.com whose URL carries the site key — public by
 * design, it is in every visitor's page — and that is enough to tell a test key
 * from a production one without reading anything inside the page.
 */
import { TURNSTILE_HOST } from './mode.js';

/** Cloudflare's test site keys, and what each one does. */
export const TEST_KEYS = {
  '1x00000000000000000000AA': { passes: true, does: 'always passes' },
  '1x00000000000000000000BB': { passes: true, does: 'always passes, invisibly' },
  '2x00000000000000000000AB': { passes: false, does: 'always fails' },
  '2x00000000000000000000BB': { passes: false, does: 'always fails, invisibly' },
  '3x00000000000000000000FF': { passes: false, does: 'forces an interactive challenge a run cannot complete' },
};

/** The secrets that go with them, on the backend of the environment under test. */
export const TEST_SECRETS = {
  passes: '1x0000000000000000000000000000000AA',
  fails: '2x0000000000000000000000000000000AA',
};

const PRODUCTION_KEY = /\/0x[0-9A-Za-z_-]{10,}\//;

/**
 * What a frame's URL says about the widget in it. Pure.
 *
 * @returns null when the frame is not Turnstile's; otherwise
 *   { kind: 'test', key, passes, does } | { kind: 'production' } | { kind: 'unknown' }.
 *   `unknown` is a Turnstile frame whose URL no longer carries the key where it
 *   used to — Cloudflare's to change, and no reason to say nothing.
 */
export function widgetOf(url) {
  const u = String(url ?? '');
  if (!u.startsWith(`${TURNSTILE_HOST}/`)) return null;
  const key = Object.keys(TEST_KEYS).find((k) => u.includes(`/${k}/`));
  if (key) return { kind: 'test', key, ...TEST_KEYS[key] };
  return { kind: PRODUCTION_KEY.test(u) ? 'production' : 'unknown' };
}

/**
 * The widget on the page right now, if there is one — the least passable of
 * them, since that is the one a failure is most likely about.
 */
export function widgetOn(page) {
  let found = [];
  try { found = page.frames().map((f) => widgetOf(f.url())).filter(Boolean); } catch { /* a closed page has no widget */ }
  return found.find((w) => w.kind !== 'test') ?? found.find((w) => !w.passes) ?? found[0] ?? null;
}

const TO_TEST = 'point the suite at an environment on Cloudflare\'s test keys: '
  + `site key 1x00000000000000000000AA with secret ${TEST_SECRETS.passes} to pass, `
  + `2x00000000000000000000AB with ${TEST_SECRETS.fails} to fail`;

const keyed = (w) => (w.kind === 'production' ? 'a production key' : 'a key the runner could not read');

/** The log line for a widget as it loads. */
export function notice(w) {
  if (w.kind === 'test') {
    return { level: w.passes ? 'info' : 'warn', msg: `Cloudflare Turnstile here is on test key ${w.key}, which ${w.does}.` };
  }
  return {
    level: 'warn',
    msg: `Cloudflare Turnstile is on this page with ${keyed(w)}. It stops automated browsers, `
      + `so a run cannot get past it here — to test this flow, ${TO_TEST}.`,
  };
}

/**
 * What a step that failed on a widget's page should also say, or null when the
 * widget is no reason: a test key that passes has already done its part.
 */
export function hint(w) {
  if (!w || (w.kind === 'test' && w.passes)) return null;
  if (w.kind === 'test') {
    return `\n  Cloudflare Turnstile here is on test key ${w.key}, which ${w.does} — `
      + 'if this step needed to get past it, the environment should be on 1x00000000000000000000AA.';
  }
  return `\n  Cloudflare Turnstile is on this page with ${keyed(w)}, which stops automated browsers — `
    + 'if this step needed to get past it, that is why.'
    + `\n  To test this flow, ${TO_TEST}.`;
}

/** A failed step's message, with the widget's part in it when it had one. */
export const explain = (message, page) => message + (hint(widgetOn(page)) ?? '');

/**
 * Say so as each widget loads: once per widget per document.
 *
 * On the frame's own navigation, which Playwright already reports, so there is
 * nothing to poll — and as it loads rather than only when a step fails, because
 * a person recording by hand meets the widget long before any step does.
 */
export function watch(page, onWidget) {
  let said = new Set();
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) { said = new Set(); return; }
    const w = widgetOf(frame.url());
    if (!w) return;
    const which = w.key ?? w.kind;
    if (said.has(which)) return;          // Turnstile reloads its own frame to retry
    said.add(which);
    onWidget(w);
  });
}
