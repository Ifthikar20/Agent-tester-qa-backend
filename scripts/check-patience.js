/**
 * Late, or never coming?
 *
 *   npm start &
 *   node scripts/check-patience.js
 *
 * Those two failures look identical from the outside, and guessing between them
 * is how an afternoon goes: you raise the timeout, wait longer for the same
 * failure, and conclude the tool is broken. Or the opposite — you assume a name
 * is wrong and re-record something that only needed another second.
 *
 * So a step that cannot find its target keeps watching past the deadline, and
 * says which of the two it was. This checks that it never confuses them.
 */
import { chromium } from 'playwright';
import { OPS, validate } from '../ops.js';
import { VirtualCursor } from '../cursor.js';

const BASE = process.env.BASE_URL || 'http://localhost:3000';

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(46)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(46)} ${d}`); };

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1180, height: 760 } });
const cdp = await page.context().newCDPSession(page);
const ctx = { cursor: new VirtualCursor(cdp, () => {}), emit: () => {}, onNavigate: async () => {} };

const step = (target, extra = {}) => validate({ suite: 'x', steps: [{ op: 'click', target, ...extra }] }).steps[0];
const attempt = async (target, extra) => {
  try { await OPS.click(page, step(target, extra), ctx); return null; }
  catch (e) { return e.message; }
};

// ---------------------------------------------------------------------------
console.log('\n— an element that is merely late ——————————————————');

const arriveIn = async (ms) => {
  await page.goto(`${BASE}/slow.html?ms=${ms}`, { waitUntil: 'domcontentloaded' });
  await OPS.click(page, step('button:Load results'), ctx);
};

await arriveIn(3000);
const late = await attempt('link:Open the report', { timeout: 1000 });
if (late && /appeared \d+ms later/.test(late)) ok('is reported as a timing problem', late.split('\n')[0].slice(0, 52));
else bad('is reported as a timing problem', (late ?? 'it passed').split('\n')[0]);

if (late && /timing problem, not a naming one/.test(late)) ok('and says so in as many words');
else bad('and says so in as many words', 'the message is ambiguous');

const suggested = late?.match(/GC_TIMEOUT_MS=(\d+)/)?.[1];
if (suggested && Number(suggested) >= 3000) ok('and suggests a number that would work', `GC_TIMEOUT_MS=${suggested}`);
else bad('and suggests a number that would work', suggested ?? 'none');

// The proof: give it what it asked for.
await arriveIn(3000);
const withTime = await attempt('link:Open the report', { timeout: Number(suggested) || 6000 });
if (!withTime) ok('and with that, the step passes', 'waiting really was the fix');
else bad('and with that, the step passes', withTime.split('\n')[0]);

// ---------------------------------------------------------------------------
console.log('\n— an element that is never coming ————————————————');

await page.goto(`${BASE}/results.html`, { waitUntil: 'domcontentloaded' });
const never = await attempt('link:This link does not exist at all', { timeout: 1000 });
if (never && /waiting longer will not help/.test(never)) ok('says waiting will not help', never.split('\n')[0].slice(-46));
else bad('says waiting will not help', (never ?? 'it passed').split('\n')[0]);

if (never && !/timing problem/.test(never)) ok('and does not call it a timing problem');
else bad('and does not call it a timing problem', 'it blamed the clock');

// ---------------------------------------------------------------------------
console.log('\n— settling after a click ——————————————————————————');

// A click that starts a render should not hand over until the page is still.
// With a settle, the element that arrives during it is already there.
await page.goto(`${BASE}/slow.html?ms=400`, { waitUntil: 'domcontentloaded' });
const t0 = Date.now();
await OPS.click(page, step('button:Load results', { settle: 700 }), ctx);
const waited = Date.now() - t0;
const there = await page.getByRole('link', { name: 'Open the report' }).count();
if (there === 1) ok('a slow render is already done', `the click took ${waited}ms and waited it out`);
else bad('a slow render is already done', `${there} matches after ${waited}ms`);

// And it must not stall on a page that never stops moving.
await page.goto(`${BASE}/slow.html?ms=99999`, { waitUntil: 'domcontentloaded' });
const t1 = Date.now();
await OPS.click(page, step('button:Load results', { settle: 250 }), ctx);
const capped = Date.now() - t1;
if (capped < 4000) ok('and it gives up rather than stalling', `${capped}ms`);
else bad('and it gives up rather than stalling', `${capped}ms`);

await browser.close();
console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — late and never-coming are told apart, the late one names a number\n' +
    '       that works, and settling waits for the page without stalling on it.\n');
process.exit(failures ? 1 : 0);
