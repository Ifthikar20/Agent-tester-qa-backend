/**
 * A control that renames itself when clicked is still the control you clicked.
 *
 *   node scripts/check-toggles.js
 *
 * On viktor.com a person pressed the hamburger, "Open navigation", and then
 * "Solutions" inside the menu it opened. The recorder checks every name after
 * the click; the button now said "Close navigation", nothing matched the name
 * any more, the button was plainly still there — so the recorder decided the
 * name was wrong and dropped the click. "Show All 7 Questions" went the same
 * way. The saved script then clicked "Solutions" inside a menu nobody opens,
 * and the replay reported it never became visible.
 *
 * So: a proposal that was unique at click time, for an element that is still
 * there under the same role but a different name, is kept — with the name it
 * had when it was clicked, which is the name a fresh page shows at replay.
 * What must NOT change: a submit that hides its own form is still kept on the
 * click-time count, an unchanged button still resolves outright, and a name
 * that never described its element is still refused.
 *
 * No server and no network: every page is fulfilled in-process.
 */
import { chromium } from 'playwright';
import { Recorder } from '../recorder.js';
import { parseTarget, locate } from '../targets.js';
import { sleep } from '../cursor.js';

const VIEW = { width: 1180, height: 760 };
const HOME = 'http://toggles.test/home.html';

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(58)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(58)} ${d}`); };
const check = (l, cond, d = '') => (cond ? ok(l, d) : bad(l, d));
const lines = (steps) => steps.map((s) => `${s.op} ${s.target ?? s.value ?? s.to ?? s.url ?? ''}`.trim()).join(' | ');

const PAGE = `<main>
  <header>
    <button id="burger" aria-label="Open navigation" aria-expanded="false"
            onclick="var open = this.getAttribute('aria-expanded') !== 'true';
                     this.setAttribute('aria-expanded', open);
                     this.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
                     document.getElementById('menu').hidden = !open;">☰</button>
    <nav id="menu" hidden><a href="#/solutions">Solutions</a> <a href="#/pricing">Pricing</a></nav>
  </header>
  <section>
    <button id="faq" aria-expanded="false"
            onclick="var open = this.getAttribute('aria-expanded') !== 'true';
                     this.setAttribute('aria-expanded', open);
                     this.textContent = (open ? 'Hide' : 'Show') + ' All 7 Questions';
                     document.getElementById('faqs').hidden = !open;">Show All 7 Questions</button>
    <ul id="faqs" hidden><li>Why?</li><li>How?</li></ul>
  </section>
  <button id="dismiss" onclick="document.body.dataset.dismissed = '1'">Dismiss</button>
  <form onsubmit="return false"><label>Email <input></label>
    <button type="button" onclick="this.closest('form').hidden = true">Sign in</button></form>
</main>`;

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--disable-dev-shm-usage'],
});
const context = await browser.newContext({ viewport: VIEW });
await context.route('**/*', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
const page = await context.newPage();

const errors = [];
const recorder = new Recorder(page, { onError: (m) => errors.push(m) });
await recorder.attach();
await page.goto(HOME, { waitUntil: 'load' });
recorder.start(HOME, []);

// ---------------------------------------------------------------------------
console.log('\n— 1 · the hamburger, then an item inside the menu it opened ————');

await page.getByRole('button', { name: 'Open navigation' }).click();
await sleep(700);
await page.getByRole('link', { name: 'Solutions' }).click();
await sleep(700);
await recorder.queue;
const afterMenu = recorder.steps.slice();

const burger = afterMenu.find((s) => s.op === 'click' && /(^|\/)button:Open navigation$/.test(s.target ?? ''));
check('the press on "Open navigation" is kept, with the name it had', !!burger, lines(afterMenu));
check('the item inside the menu follows it',
  !!burger && afterMenu.indexOf(burger) < afterMenu.findIndex((s) => s.op === 'click' && /link:Solutions$/.test(s.target ?? '')),
  lines(afterMenu));

// ---------------------------------------------------------------------------
console.log('\n— 2 · an accordion that changes its own words ——————————————————');

await page.getByRole('button', { name: 'Show All 7 Questions' }).click();
await sleep(700);
await recorder.queue;
check('the press on "Show All 7 Questions" is kept',
  recorder.steps.some((s) => s.op === 'click' && /button:Show All 7 Questions$/.test(s.target ?? '')), lines(recorder.steps));

// ---------------------------------------------------------------------------
console.log('\n— 3 · what must not change ————————————————————————————————————');

await page.getByRole('button', { name: 'Dismiss' }).click();
await sleep(500);
await page.getByRole('button', { name: 'Sign in' }).click();
await sleep(700);
await recorder.queue;
const steps = recorder.stop(page.url());

check('an unchanged button still resolves outright',
  steps.some((s) => s.op === 'click' && /button:Dismiss$/.test(s.target ?? '')), lines(steps));
check('a submit that hides its own form is still kept',
  steps.some((s) => s.op === 'click' && /button:Sign in$/.test(s.target ?? '')), lines(steps));
check('nothing was dropped', !errors.length, errors.join('; '));

// ---------------------------------------------------------------------------
console.log('\n— 4 · the recorded names replay, in order, on a fresh page ————');

const fresh = await context.newPage();
await fresh.goto(HOME, { waitUntil: 'load' });
let replayed = 0;
let stuck = '';
for (const s of steps.filter((x) => x.op === 'click')) {
  const loc = locate(fresh, parseTarget(s.target));
  const visible = await loc.and(fresh.locator('*:visible')).count();
  if (visible !== 1) { stuck = `${s.target} resolves to ${visible} visible`; break; }
  await loc.click();
  await sleep(200);
  replayed++;
}
check('every recorded click resolves to one visible element when its turn comes',
  !stuck && replayed === steps.filter((x) => x.op === 'click').length, stuck || `${replayed} clicks`);

await browser.close();
console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — a control the click renames keeps the name it was clicked by,\n' +
    '       and everything the recorder already got right still holds.\n');
process.exit(failures ? 1 : 0);
