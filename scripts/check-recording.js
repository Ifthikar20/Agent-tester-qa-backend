/**
 * The three things that broke on a real marketing site.
 *
 *   npm start &
 *   node scripts/check-recording.js
 *
 * Every one of these is a regression test for something that actually
 * happened, against public/site.html — a page shaped like the site that broke:
 * the same link text in the header nav and the footer, long enough to need
 * scrolling, with a button that sends you back to the top.
 *
 *  1. A click on an ambiguous link was DROPPED. `link:Pricing` matched twice
 *     (header and footer), the recorder refused to name it, and the step
 *     vanished. You demonstrated eight things and got a script with three.
 *
 *  2. Scrolling was not expressible, so anything below the fold could only be
 *     reached by accident.
 *
 *  3. `expect url contains` failed with "Timeout 8000ms exceeded", which says
 *     nothing. The real cause was step 1: the click that should have navigated
 *     was never recorded, so the URL never changed.
 */
import { chromium } from 'playwright';
import { Recorder } from '../recorder.js';
import { OPS, validate } from '../ops.js';
import { VirtualCursor, sleep } from '../cursor.js';
import { parseFlow, flatten, toFlow } from '../flow.js';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const SITE = `${BASE}/site.html`;
const VIEW = { width: 1180, height: 760 };

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(46)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(46)} ${d}`); };

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: VIEW });
const cdp = await page.context().newCDPSession(page);
const cursor = new VirtualCursor(cdp, () => {});
const ctx = { cursor, emit: () => {}, onNavigate: async () => {} };

const errors = [];
const recorder = new Recorder(page, { onError: (m) => errors.push(m) });
await recorder.attach();

// ---------------------------------------------------------------------------
console.log('\n— 1 · a link that appears twice ——————————————————');

await page.goto(SITE, { waitUntil: 'domcontentloaded' });
recorder.start(SITE, []);

// Click the header's Pricing, then the footer's. Both say "Pricing"; a
// recorder that can only offer role+name has nothing to say about either.
await page.getByRole('navigation').getByRole('link', { name: 'Pricing' }).click();
await sleep(400);
await page.locator('footer').getByRole('link', { name: 'Pricing' }).click();
await sleep(500);

let steps = recorder.stop(page.url());
const clicks = steps.filter((s) => s.op === 'click');
if (clicks.length === 2) ok('both clicks recorded', clicks.map((c) => c.target).join('  +  '));
else bad('both clicks recorded', `${clicks.length} of 2 — ${errors.join('; ')}`);

if (clicks[0]?.target !== clicks[1]?.target) ok('and they are told apart');
else bad('and they are told apart', `both named "${clicks[0]?.target}"`);

// `.every()` on an empty array is true, so a run that recorded nothing would
// pass this vacuously — which is precisely the failure it exists to catch.
if (clicks.length && clicks.every((c) => /^(banner|navigation|contentinfo|main)\//.test(c.target))) {
  ok('named by the page\'s own regions', 'no test ids, no selectors');
} else bad('named by the page\'s own regions', clicks.map((c) => c.target).join(', '));

// Do they actually resolve, to the elements that were clicked?
for (const c of clicks) {
  const n = await page.getByRole('link', { name: 'Pricing' }).count();
  const scoped = await (async () => {
    const plan = validate({ suite: 'x', steps: [{ op: 'goto', url: SITE }, c] });
    return plan.steps.length;
  })().catch((e) => e.message);
  if (scoped === 2) ok(`"${c.target}" validates`, `(page has ${n} Pricing links)`);
  else bad(`"${c.target}" validates`, String(scoped));
}

// ---------------------------------------------------------------------------
console.log('\n— 2 · scrolling ————————————————————————————————————');

await page.goto(SITE, { waitUntil: 'domcontentloaded' });
recorder.start(SITE, []);
await page.mouse.wheel(0, 4000);                 // to the bottom, by hand
await sleep(900);
await page.mouse.wheel(0, -4000);                // and back
await sleep(900);
steps = recorder.stop(page.url());

const scrolls = steps.filter((s) => s.op === 'scroll');
if (scrolls.length >= 2) ok('scroll gestures recorded', scrolls.map((s) => s.to ?? s.target).join(' → '));
else bad('scroll gestures recorded', `${scrolls.length} recorded`);

if (scrolls.some((s) => s.to === 'bottom') && scrolls.some((s) => s.to === 'top')) {
  ok('as positions, not pixel offsets', 'survives a viewport change');
} else bad('as positions, not pixel offsets', JSON.stringify(scrolls));

// ---------------------------------------------------------------------------
console.log('\n— 3 · a click that moves the page ————————————————');

await page.goto(SITE, { waitUntil: 'domcontentloaded' });
recorder.start(SITE, []);
await page.mouse.wheel(0, 4000);
await sleep(900);
await page.getByRole('button', { name: 'Back to top' }).click();
await sleep(700);
steps = recorder.stop(page.url());

if (steps.some((s) => s.op === 'expect' && s.assert === 'atTop')) {
  ok('recorded as an assertion', 'a regression here now turns a run red');
} else bad('recorded as an assertion', JSON.stringify(steps.map((s) => s.op + (s.assert ?? ''))));

// ---------------------------------------------------------------------------
console.log('\n— 4 · replay ————————————————————————————————————————');

const flow = `%% suite "Harbour footer"
flowchart TD
  a(("${SITE}"))
  b["#pricing"]
  c["#docs"]

  a -->|scroll to bottom; click 'Pricing' : contentinfo/link| b
  b -->|scroll to top; click 'Docs' : navigation/link| c`;

const plan = validate(flatten(parseFlow(flow)));
let ran = 0, failed = null;
for (const step of plan.steps) {
  try { await OPS[step.op](page, step, ctx); ran++; }
  catch (e) { failed = `step ${ran} (${step.op}): ${e.message.split('\n')[0]}`; break; }
}
if (!failed) ok('the whole flow replays', `${ran} steps, footer link and all`);
else bad('the whole flow replays', failed);

if (toFlow(plan).includes('contentinfo/link')) ok('and round-trips through the language');
else bad('and round-trips through the language', 'the scope was lost');

// ---------------------------------------------------------------------------
console.log('\n— 5 · the timeout, when it is real ——————————————————');

await page.goto(SITE, { waitUntil: 'domcontentloaded' });
const t0 = Date.now();
let msg = null;
try {
  await OPS.expect(page, { op: 'expect', assert: 'urlContains', value: '/nowhere', timeout: 1500 }, ctx);
} catch (e) { msg = e.message; }
const took = Date.now() - t0;

if (msg && msg.includes('/nowhere') && msg.includes('site.html')) {
  ok('says what the URL actually is', msg.slice(0, 68) + '…');
} else bad('says what the URL actually is', msg ?? 'it passed');

if (took < 2500) ok('and gives up when told to', `${took}ms`);
else bad('and gives up when told to', `${took}ms`);

// A hash change is not a navigation. waitForURL's default `load` never fires
// for one, which is how an assertion about a correct URL used to time out.
await page.getByRole('navigation').getByRole('link', { name: 'Docs' }).click();
try {
  await OPS.expect(page, { op: 'expect', assert: 'urlContains', value: '#docs', timeout: 3000 }, ctx);
  ok('a hash route satisfies it', page.url());
} catch (e) { bad('a hash route satisfies it', e.message.split('\n')[0]); }

await browser.close();
console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — a repeated link is named by its region, scrolling is a step,\n' +
    '       a click that jumps to the top is an assertion, and a URL that\n' +
    '       never arrives says so.\n');
process.exit(failures ? 1 : 0);
