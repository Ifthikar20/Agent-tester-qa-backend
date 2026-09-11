/**
 * The things that broke on real sites.
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
 *
 *  4. A paycheck calculator's select opened on the PRESS and took pointer
 *     events away from the page, so the click went to <html>. The recording
 *     kept the option and lost the click that opened the list, and replay
 *     waited for an option in a list nobody had opened. That one is against
 *     public/select.html.
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

// ---------------------------------------------------------------------------
console.log('\n— 6 · a select that opens on the press ——————————————');

// Demonstrated the way the console does it — glide there, then press and
// release wherever the pointer is — because a select that opens on the press
// only goes missing when the press and the release land on different things.
const SELECT = `${BASE}/select.html`;
async function demonstrate(locator) {
  await locator.scrollIntoViewIfNeeded();
  const b = await locator.boundingBox();
  await cursor.glideTo(b.x + b.width / 2, b.y + b.height / 2, 240);
  await cursor.click();
  await sleep(400);
}

await page.goto(SELECT, { waitUntil: 'domcontentloaded' });
errors.length = 0;
recorder.start(SELECT, []);
await sleep(700);                          // let the recorder see the page at rest
// exact: a bare name is a substring to Playwright, and "Monthly" is inside "Semi-monthly".
await demonstrate(page.getByRole('button', { name: 'Bi-weekly', exact: true }));    // opens on click
await demonstrate(page.getByRole('option', { name: 'Monthly', exact: true }));
await demonstrate(page.getByRole('button', { name: 'California', exact: true }));   // opens on the press
await demonstrate(page.getByRole('option', { name: 'Texas', exact: true }));
steps = recorder.stop(page.url());

const chose = steps.filter((s) => s.op === 'click').map((s) => s.target);
const meant = ['button:Bi-weekly', 'option:Monthly', 'button:California', 'option:Texas'];
if (chose.join() === meant.join()) ok('the click that opened each list is a step', chose.join(' → '));
else bad('the click that opened each list is a step', `${chose.join(' → ') || 'nothing'}${errors.length ? ` — ${errors.join('; ')}` : ''}`);

// The opener is the last control the pointer was over before the option, so
// the hover inference would name it as well — by a value it no longer has.
const inferred = [...steps.filter((s) => s.op === 'hover').map((s) => s.target), ...errors.filter((m) => m.includes('hover'))];
if (!inferred.length) ok('and no hover is inferred on top of the click');
else bad('and no hover is inferred on top of the click', inferred.join('; '));

const replay = validate({ suite: 'x', steps });
ran = 0; failed = null;
for (const step of replay.steps) {
  try { await OPS[step.op](page, step, ctx); ran++; }
  catch (e) { failed = `step ${ran} (${step.op} ${step.target ?? step.url}): ${e.message.split('\n')[0]}`; break; }
}
const summary = await page.locator('#summary').textContent();
if (!failed && summary === 'Paid Monthly in Texas') ok('and the recording replays', summary);
else bad('and the recording replays', failed ?? summary);

// A recording made before this lost the opening click. Its replay should say
// so, rather than that nothing like "Texas" is anywhere on the page.
await page.goto(SELECT, { waitUntil: 'domcontentloaded' });
let said = '';
try { await OPS.click(page, { op: 'click', target: 'option:Texas', timeout: 1000 }, ctx); }
catch (e) { said = e.message; }
if (said.includes('list is open') && said.includes('button:California')) ok('an option nobody opened says why', 'and names the dropdowns');
else bad('an option nobody opened says why', said.split('\n').slice(1, 3).join(' | ') || 'it passed');

await browser.close();
console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — a repeated link is named by its region, scrolling is a step,\n' +
    '       a click that jumps to the top is an assertion, a URL that never\n' +
    '       arrives says so, and a select that opens on the press keeps the\n' +
    '       click that opened it.\n');
process.exit(failures ? 1 : 0);
