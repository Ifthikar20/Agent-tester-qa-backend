/**
 * A frame's address is not the page's.
 *
 *   node scripts/check-frames.js
 *
 * The recorder's listeners run in every frame a page loads, and the binding
 * they report through never asked which frame called. A sign-in button another
 * site draws in a frame (accounts.google.com/gsi/button, Microsoft's
 * /v0.5/signinbutton) reported its OWN address, and the recording checked that
 * the PAGE had gone there. A LinkedIn recording got `url contains /gsi/button`
 * twice and `url contains /v0.5/signinbutton`, and replay failed with
 * "expected the URL to contain "/gsi/button", but it is "https://www.linkedin.com/"".
 *
 * No server and no network: every page is fulfilled in-process. One page, with
 * a frame from another origin whose button changes the frame's hash, a second
 * frame that scrolls, and the page's own link that changes the page's hash.
 */
import { chromium } from 'playwright';
import { Recorder } from '../recorder.js';
import { sleep } from '../cursor.js';

const VIEW = { width: 1180, height: 760 };
const HOME = 'http://notes.test/home.html';

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(58)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(58)} ${d}`); };
const check = (l, cond, d = '') => (cond ? ok(l, d) : bad(l, d));

/** The same measure the recorder checks a URL by. */
const pathOf = (u) => { try { const x = new URL(u); return `${x.pathname}${x.hash}`; } catch { return null; } };
const lines = (steps) => steps.map((s) => `${s.op} ${s.to ?? s.target ?? s.value ?? s.url ?? ''}`.trim()).join(' | ');

const PAGES = {
  'notes.test/home.html': '<main><h1>Home</h1>' +
    '<button onclick="document.body.dataset.dismissed=\'1\'">Dismiss</button> <a href="#/next">Next page</a>' +
    '<iframe id="gsi" title="Sign in with Google" src="http://frame.test/button.html?client_id=abc" style="width:320px;height:80px;border:0"></iframe>' +
    '<iframe id="terms" title="Terms" src="http://frame.test/terms.html" style="width:320px;height:120px;border:0"></iframe>' +
    '<div style="height:3000px"></div></main>',
  'frame.test/button.html': '<button onclick="location.hash=\'#pressed\'">Continue with Google</button>',
  'frame.test/terms.html': '<p>Terms</p><div style="height:3000px"></div><a href="#accept">Accept</a>',
};

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--disable-dev-shm-usage'],
});
const context = await browser.newContext({ viewport: VIEW });
await context.route('**/*', (route) => {
  const u = new URL(route.request().url());
  const body = PAGES[`${u.host}${u.pathname}`];
  return body ? route.fulfill({ contentType: 'text/html; charset=utf-8', body }) : route.abort('blockedbyclient');
});
const page = await context.newPage();

// Everywhere the page itself went. A URL check that names anywhere else can
// never pass on replay.
const visited = new Set();
page.on('framenavigated', (f) => { if (f === page.mainFrame()) visited.add(pathOf(f.url())); });

const errors = [];
const recorder = new Recorder(page, { onError: (m) => errors.push(m) });
await recorder.attach();
await page.goto(HOME, { waitUntil: 'load' });
recorder.start(HOME, []);

// ---------------------------------------------------------------------------
console.log('\n— 1 · a frame presses, changes its address and scrolls ————————');

await page.frameLocator('#gsi').getByRole('button', { name: 'Continue with Google' }).click();
await sleep(800);
await page.frame({ url: /terms\.html/ }).evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
await sleep(800);
await recorder.queue;
const inFrames = recorder.steps.slice();

check('a frame\'s address is never a URL check on the page',
  !inFrames.some((s) => s.op === 'expect'), lines(inFrames));
check('a frame scrolling is not the page scrolling',
  !inFrames.some((s) => s.op === 'scroll'), lines(inFrames));

// ---------------------------------------------------------------------------
console.log('\n— 2 · the page does the same ———————————————————————————————');

await page.getByRole('button', { name: 'Dismiss' }).click();
await sleep(800);
await page.getByRole('link', { name: 'Next page' }).click();
await sleep(800);
await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
await sleep(900);
await recorder.queue;
const steps = recorder.stop(page.url());

check('the page\'s own address change is still a check',
  steps.some((s) => s.op === 'expect' && s.assert === 'urlContains' && s.value === '/home.html#/next'), lines(steps));
check('the page\'s own press is still a step',
  steps.some((s) => s.op === 'click' && /Dismiss/.test(s.target ?? '')), errors.join('; '));
check('the page scrolling is still a step, once',
  steps.filter((s) => s.op === 'scroll').length === 1 && steps.some((s) => s.op === 'scroll' && s.to === 'bottom'));

const urls = steps.filter((s) => s.op === 'expect' && s.assert === 'urlContains');
// Not vacuous: the page's own hash change above guarantees at least one.
check('every URL check names somewhere the page itself went',
  urls.length > 0 && urls.every((s) => visited.has(s.value)),
  `checks: ${urls.map((s) => s.value).join(', ') || 'none'} — visited: ${[...visited].join(', ')}`);

await browser.close();
console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — what a frame does is filed at the page\'s address, a frame\'s route\n' +
    '       change or scroll is not a step, and the page\'s own still are.\n');
process.exit(failures ? 1 : 0);
