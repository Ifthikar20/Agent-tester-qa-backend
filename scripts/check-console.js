/**
 * The console: what you see, and whether you can drive it.
 *
 *   npm start &
 *   node scripts/check-console.js
 *
 * Three regressions, all of which looked like "the app is broken":
 *
 *  1. A BLACK CANVAS. Chrome's screencast is damage-driven — a page sitting
 *     still emits nothing. The server primes each socket with one frame, but
 *     the socket opens when the app loads and the canvas only exists once you
 *     navigate to the console, so that frame arrived, found no canvas, and was
 *     dropped. On an idle page the next one never came.
 *
 *  2. NO WAY TO SCROLL. The canvas forwarded clicks and keys but not the
 *     wheel, so anything below the fold could be watched going past and never
 *     touched.
 *
 *  3. NOTHING TO READ WHILE WAITING. A black rectangle is indistinguishable
 *     from a crash, so there is now a state that says which kind of waiting
 *     this is.
 */
import { chromium } from 'playwright';

const APP = `${process.env.BASE_URL || 'http://localhost:3000'}/app`;
const SITE = `${process.env.BASE_URL || 'http://localhost:3000'}/site.html`;

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(46)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(46)} ${d}`); };

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });

/** How much of the canvas is not black? Asks the canvas, not the DOM. */
const lit = () => page.evaluate(() => {
  const c = document.querySelector('canvas');
  if (!c) return -1;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4000) if (d[i] + d[i + 1] + d[i + 2] > 60) n++;
  return n;
});

// ---------------------------------------------------------------------------
console.log('\n— 1 · arriving at the console ————————————————————');

// Watch for the placeholder from the first paint: its whole job is to be there
// in the window before a frame exists.
let overlay = null;
page.on('domcontentloaded', async () => {
  for (let i = 0; i < 80 && !overlay; i++) {
    overlay = await page.evaluate(() => {
      const el = [...document.querySelectorAll('p')]
        .find((e) => /Connecting to|Waiting for|Opening /.test(e.textContent));
      return el ? el.textContent.trim() : null;
    }).catch(() => null);
    await new Promise((r) => setTimeout(r, 25));
  }
});

await page.goto(`${APP}/console`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

if (overlay) ok('says what it is waiting for', `“${overlay}”`);
else bad('says what it is waiting for', 'no placeholder was ever shown');

const noOverlay = await page.evaluate(() =>
  ![...document.querySelectorAll('p')].some((e) => /Connecting to|Waiting for/.test(e.textContent)));
if (noOverlay) ok('and gets out of the way once painted');
else bad('and gets out of the way once painted', 'still showing');

// ---------------------------------------------------------------------------
console.log('\n— 2 · the canvas is not black ————————————————————');

// The sequence that broke it: sit on another screen long enough for the driven
// page to go idle, THEN navigate to the console within the app.
await page.goto(`${APP}/dashboard`, { waitUntil: 'networkidle' });
await page.waitForTimeout(3500);
await page.getByRole('link', { name: 'Console', exact: true }).click();
await page.waitForTimeout(2000);

const n = await lit();
if (n > 50) ok('painted after arriving from elsewhere', `${n} lit samples`);
else bad('painted after arriving from elsewhere', `${n} lit samples — black`);

// ---------------------------------------------------------------------------
console.log('\n— 3 · scrolling the page you are driving ——————————');

await page.getByPlaceholder('localhost:3000/demo.html').fill(SITE);
await page.getByRole('button', { name: 'Open' }).click();
await page.waitForTimeout(2500);

const box = await page.locator('canvas').boundingBox();
const mid = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
const frame = () => page.evaluate(() => {
  const c = document.querySelector('canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, Math.min(400, c.height)).data;
  let h = 0;
  for (let i = 0; i < d.length; i += 997) h = (h * 31 + d[i]) % 1e9;
  return h;
});

const before = await frame();
await page.mouse.move(mid.x, mid.y);
for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 600); await page.waitForTimeout(90); }
await page.waitForTimeout(1200);
const after = await frame();

if (before !== after) ok('the wheel moves the driven page', 'the feed changed');
else bad('the wheel moves the driven page', 'the feed is identical — the wheel is not reaching it');

// The buttons, for a page too long to wheel through.
await page.getByRole('button', { name: '↑ Top' }).click();
await page.waitForTimeout(1400);
const top = await frame();
if (top !== after) ok('and the Top button brings it back');
else bad('and the Top button brings it back', 'no change');

// ---------------------------------------------------------------------------
console.log('\n— 4 · loading a saved case ————————————————————————');

// Self-contained: its own suite, removed at the end, so this does not depend on
// whatever happens to be checked in.
const API = process.env.BASE_URL || 'http://localhost:3000';
const post = (path, body) => fetch(`${API}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then((r) => r.json());

await fetch(`${API}/api/suites/check-console-tmp`, { method: 'DELETE' }).catch(() => {});
const made = await post('/api/suites', { name: 'Check console tmp', baseUrl: API });
const sid = made.suite?.id;
const flow = `%% suite "A saved case"
flowchart TD
  a(("${SITE}"))
  b["#docs"]

  a -->|scroll to bottom; click 'Docs' : contentinfo/link| b`;
await post(`/api/suites/${sid}/cases`, { name: 'Footer takes you to Docs', flow });

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const picker = page.locator('select');
if (await picker.count()) ok('the picker is there once a case exists');
else bad('the picker is there once a case exists', 'no select rendered');

const labels = (await page.locator('select option').allTextContents()).map((t) => t.trim());
const mine = labels.find((t) => t.startsWith('Footer takes you to Docs'));
if (mine) ok('and lists the case that was just saved', mine);
else bad('and lists the case that was just saved', labels.join(' / '));

if (mine) {
  await picker.selectOption({ label: mine });
  await page.waitForTimeout(500);
  const box = await page.locator('textarea').last().inputValue();
  if (box.includes("click 'Docs' : contentinfo/link")) ok('selecting one loads its flow');
  else bad('selecting one loads its flow', box.slice(0, 70));

  // The banner names what is loaded, so a script you did not type is not a
  // mystery when you come back to the tab.
  const banner = await page.getByText(/Loaded/).first().textContent().catch(() => '');
  if (/Footer takes you to Docs/.test(banner)) ok('and says which case it is');
  else bad('and says which case it is', banner);

  await page.getByRole('button', { name: 'Run script' }).click();
  await page.waitForTimeout(9000);
  // Ask the history, not the DOM: `.text-critical` also matches the Record
  // button, so counting it here reported a failure that never happened.
  const hist = await fetch(`${API}/api/runs`).then((r) => r.json());
  const last = hist.latest?.[0];
  if (last && last.suite === 'A saved case' && last.ok) ok('and it runs', `${last.total} steps, ${last.ms}ms`);
  else bad('and it runs', last ? `${last.suite}: ${last.error ?? 'not ok'}` : 'nothing recorded');
}

// ---------------------------------------------------------------------------
console.log('\n— 5 · the script box keeps up with the recording ——');

// Pressing Record produces a one-step flow immediately (the goto). The box used
// to take that and then ignore everything you demonstrated afterwards, because
// it only filled while empty — so a four-step recording showed one line.
await page.getByRole('button', { name: 'clear' }).click().catch(() => {});
await page.locator('textarea').last().fill('');
await page.getByPlaceholder('localhost:3000/demo.html').fill(SITE);
await page.getByRole('button', { name: 'Open' }).click();
await page.waitForTimeout(2500);

await page.getByRole('button', { name: '● Record' }).click();
await page.getByRole('button', { name: '■ Stop' }).waitFor();
await page.waitForTimeout(400);
const atStart = (await page.locator('textarea').last().inputValue()).match(/-->/g)?.length ?? 0;

const cb = await page.locator('canvas').boundingBox();
const spot = (x, y) => ({ x: cb.x + x * cb.width / 1180, y: cb.y + y * cb.height / 760 });
for (const [x, y] of [[894, 26], [959, 26]]) {
  const q = spot(x, y);
  await page.mouse.move(q.x, q.y); await page.mouse.click(q.x, q.y);
  await page.waitForTimeout(900);
}
await page.getByRole('button', { name: '■ Stop' }).click();
await page.waitForTimeout(900);
const atEnd = (await page.locator('textarea').last().inputValue()).match(/-->/g)?.length ?? 0;

if (atEnd > atStart) ok('it grows as you demonstrate', `${atStart} edges → ${atEnd}`);
else bad('it grows as you demonstrate', `stuck at ${atEnd} edges`);

await fetch(`${API}/api/suites/${sid}`, { method: 'DELETE' }).catch(() => {});

await browser.close();
console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — the canvas paints when you arrive, says what it is waiting for\n' +
    '       before it can, the wheel reaches the page you are driving, and a\n' +
    '       saved case can be picked up and run from here.\n');
process.exit(failures ? 1 : 0);
