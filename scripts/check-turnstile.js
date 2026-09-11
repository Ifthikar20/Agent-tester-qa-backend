/**
 * Cloudflare Turnstile, on the page being driven.
 *
 *   node scripts/check-turnstile.js
 *
 * A sign-up behind Turnstile failed in the runner with "Verification failed",
 * and the step that noticed said nothing about why: Turnstile is built to stop
 * automated browsers, and the runner is one. The runner now says so — as the
 * widget loads, and on a step that fails on its page — and tells Cloudflare's
 * test keys, which make such a form testable, from a production key, which
 * does not.
 *
 * No server: the page is fulfilled in-process. It does need the network, since
 * the widget is Cloudflare's own script running on Cloudflare's test keys.
 */
import { chromium } from 'playwright';
import { widgetOf, widgetOn, watch, notice, hint, explain } from '../turnstile.js';

const VIEW = { width: 1180, height: 760 };

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(52)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(52)} ${d}`); };

// ---------------------------------------------------------------------------
console.log('\n— 1 · what a frame URL says ————————————————————————————');

// The widget's frame URL, with the site key where Cloudflare puts it.
const frame = (key) => `https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/x1y2z/${key}/light/fbE/new/normal/auto/`;
const PRODUCTION = '0x4AAAAAAAExampleExample';

for (const [key, holds, label] of [
  ['1x00000000000000000000AA', (w) => w?.kind === 'test' && w.passes === true, 'a test key that passes'],
  ['2x00000000000000000000AB', (w) => w?.kind === 'test' && w.passes === false, 'a test key that fails'],
  ['3x00000000000000000000FF', (w) => w?.kind === 'test' && !w.passes && /interactive/.test(w.does), 'the interactive test key, which a run cannot pass'],
  [PRODUCTION, (w) => w?.kind === 'production', 'a production key'],
]) {
  const w = widgetOf(frame(key));
  if (holds(w)) ok(label, key); else bad(label, JSON.stringify(w));
}

const keyless = widgetOf('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/new/normal/');
if (keyless?.kind === 'unknown') ok('a Turnstile frame with no readable key is still one');
else bad('a Turnstile frame with no readable key is still one', JSON.stringify(keyless));

if (widgetOf(`https://challenges.cloudflare.com.example.net/${PRODUCTION}/`) === null
    && widgetOf(`https://example.com/cdn-cgi/${PRODUCTION}/`) === null) {
  ok('and nothing else is taken for one', 'a lookalike host, a key-shaped path elsewhere');
} else bad('and nothing else is taken for one');

if (hint(widgetOf(frame('1x00000000000000000000AA'))) === null) ok('a passing test key is never blamed for a failure');
else bad('a passing test key is never blamed for a failure', hint(widgetOf(frame('1x00000000000000000000AA'))));

const blamed = hint(widgetOf(frame(PRODUCTION))) ?? '';
if (blamed.includes('production key') && blamed.includes('1x00000000000000000000AA') && blamed.includes('1x0000000000000000000000000000000AA')) {
  ok('a production key\'s failure names the test keys', 'site key and secret');
} else bad('a production key\'s failure names the test keys', blamed);

// ---------------------------------------------------------------------------
console.log('\n— 2 · a real widget, in the runner\'s browser ————————————————');

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--disable-dev-shm-usage'],
});
const PAGE = 'http://localhost/turnstile.html';
const fixture = (sitekey) => `<!doctype html><meta charset="utf-8"><title>Sign up</title>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<form><label>Email <input name="email"></label>
<div class="cf-turnstile" data-sitekey="${sitekey}" data-callback="passed" data-error-callback="failed"></div>
<button type="button">Get Started</button></form>
<p id="state">waiting</p>
<script>
  function passed() { document.getElementById('state').textContent = 'passed'; }
  function failed() { document.getElementById('state').textContent = 'failed'; return true; }
</script>`;

/** The widget has answered, one way or the other. */
const answered = (page, sitekey) => page.locator('#state').filter({ hasNotText: 'waiting' }).waitFor({ timeout: 20000 })
  .catch(() => { throw new Error(`the widget never answered on ${sitekey} — this check has to reach challenges.cloudflare.com`); });

async function open(sitekey) {
  const page = await browser.newPage({ viewport: VIEW });
  await page.route(PAGE, (route) => route.fulfill({ contentType: 'text/html', body: fixture(sitekey) }));
  const said = [];
  watch(page, (w) => said.push(notice(w)));
  await page.goto(PAGE);
  await answered(page, sitekey);
  return { page, said };
}

const pass = await open('1x00000000000000000000AA');
if (pass.said.length === 1 && pass.said[0].level === 'info' && pass.said[0].msg.includes('always passes')) {
  ok('a passing test key is named as it loads', pass.said[0].msg);
} else bad('a passing test key is named as it loads', JSON.stringify(pass.said));

const onPass = widgetOn(pass.page);
if (onPass?.key === '1x00000000000000000000AA' && explain('boom', pass.page) === 'boom') ok('and a failure on its page is left as it was');
else bad('and a failure on its page is left as it was', JSON.stringify(onPass));

// A new document says it again — once, not on every frame the widget loads.
await pass.page.reload();
await answered(pass.page, '1x00000000000000000000AA');
if (pass.said.length === 2) ok('said once per page', 'and again after a reload');
else bad('said once per page', `${pass.said.length} notices`);
await pass.page.close();

const fail = await open('2x00000000000000000000AB');
await fail.page.waitForTimeout(1500);        // time for the widget to retry its frame
if (fail.said.length === 1 && fail.said[0].level === 'warn' && fail.said[0].msg.includes('always fails')) {
  ok('a failing test key is a warning', fail.said[0].msg);
} else bad('a failing test key is a warning', JSON.stringify(fail.said));

const failed = explain('expected the URL to contain "/welcome"', fail.page);
if (failed.startsWith('expected the URL to contain "/welcome"') && failed.includes('always fails')) {
  ok('a step that fails on its page says why', failed.split('\n')[1].trim());
} else bad('a step that fails on its page says why', failed);
await fail.page.close();

await browser.close();
console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — Cloudflare\'s test keys are told from a production key, the runner says\n' +
    '       which as the widget loads, and a step that fails on its page says why.\n');
process.exit(failures ? 1 : 0);
