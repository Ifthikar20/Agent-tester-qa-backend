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
import WebSocket from 'ws';

const API = process.env.BASE_URL || 'http://localhost:3000';
const APP = `${API}/app`;
const SITE = `${API}/site.html`;

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

/**
 * Put the runner on a known page FIRST.
 *
 * What sections 1 and 2 assert — that you never see a bare black rectangle,
 * and that the canvas paints when you arrive from another screen — is about a
 * runner that HAS a page. They used to lean on whatever the server happened to
 * boot onto, which made the result depend on run history. History is gitignored
 * (`.gitignore`: `.ghostclick/`), so it does not travel: green on a machine
 * that has run something, red on a fresh clone, and neither answer had anything
 * to do with the property being tested.
 */
await page.goto(`${APP}/console`, { waitUntil: 'networkidle' });
await page.getByLabel('URL to open').fill(SITE);
await page.getByRole('button', { name: 'Open' }).click();
await page.waitForTimeout(3000);

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

// The property is "you never see a bare black rectangle" — not "a placeholder
// always appears". On a warm socket the store already holds a frame and replays
// it on attach, so there is legitimately nothing to wait for, and demanding the
// placeholder would fail the better outcome.
if (overlay) ok('says what it is waiting for', `“${overlay}”`);
else if (await lit() > 50) ok('or paints immediately', 'nothing to wait for');
else bad('says what it is waiting for', 'black, with no placeholder');

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

await page.getByLabel('URL to open').fill(SITE);
await page.getByRole('button', { name: 'Open' }).click();
await page.waitForTimeout(2500);

const box = await page.locator('canvas').boundingBox();
const mid = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
const frame = () => page.evaluate(() => {
  const c = document.querySelector('canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
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

// ---------------------------------------------------------------------------
console.log('\n— 4 · loading a saved case ————————————————————————');

// Self-contained: its own suite, removed at the end, so this does not depend on
// whatever happens to be checked in.
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
console.log('\n— 4b · Console takes you to the suite\'s page ——————');

/**
 * The Console button used to pass the suite id and nothing else, so the
 * breadcrumb read "Kestrel / Console" while the canvas showed whatever the
 * runner had been driving an hour earlier. Labelled with the suite, pointed
 * somewhere else.
 */
const other = (await post('/api/suites', { name: 'Check console other', baseUrl: API })).suite.id;
await post(`/api/suites/${other}/pages`, { name: 'Links', path: '/links.html' });
await post(`/api/suites/${sid}/pages`, { name: 'Results', path: '/results.html' });

const topConsole = () => page.getByRole('main').getByRole('link', { name: 'Console', exact: true });
const shown = () => page.evaluate(() => {
  const el = [...document.querySelectorAll('p')].find((e) => /^https?:\/\//.test(e.textContent.trim()));
  return el ? el.textContent.trim() : null;
});

// Park the runner somewhere unrelated, so a wrong answer is visible.
await page.goto(`${APP}/console?url=${API}/demo.html`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2200);

await page.goto(`${APP}/suites/${other}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await topConsole().click();
await page.waitForTimeout(3000);
if (/links\.html/.test(await shown() ?? '')) ok('it opens that suite\'s page', await shown());
else bad('it opens that suite\'s page', await shown());

// Suite → suite, without a full reload: the console stays mounted, so a new
// ?url= has to be acted on or the second button appears to do nothing.
await page.goto(`${APP}/suites/${sid}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await topConsole().click();
await page.waitForTimeout(3000);
if (/results\.html/.test(await shown() ?? '')) ok('and follows a second suite too', await shown());
else bad('and follows a second suite too', await shown());

// A page row points at its own page, which is the narrower meaning of "here".
await page.goto(`${APP}/suites/${other}/pages`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.getByRole('link', { name: 'Open in console' }).first().click();
await page.waitForTimeout(3000);
if (/links\.html/.test(await shown() ?? '')) ok('and a page row opens that page');
else bad('and a page row opens that page', await shown());

// ---------------------------------------------------------------------------
console.log('\n— 4c · Run takes you to where it happens ——————————');

/**
 * A run drives a real browser for tens of seconds. Pressing the button used to
 * leave you on a summary page while all of it happened somewhere you could not
 * see — a progress bar with the bar taken out.
 */
await post(`/api/suites/${other}/cases`, {
  name: 'Links loads',
  flow: `%% suite "x"\nflowchart TD\n  a(("${API}/links.html"))\n  b["/links.html"]\n  a --> b`,
});
await page.goto(`${APP}/suites/${other}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.getByRole('button', { name: /Run suite/ }).click();
await page.waitForTimeout(1500);

if (/\/app\/console/.test(page.url())) ok('it goes to the console', new URL(page.url()).search);
else bad('it goes to the console', page.url());

await page.waitForTimeout(5000);
const steps = await page.locator('section').filter({ has: page.locator('ol') }).first()
  .innerText().catch(() => '');
// What the panel says, not how it spells it: the run's own entry has to be in
// there. Asserting on a verb's wording only tests the wording.
if (/links\.html/.test(steps)) ok('and the steps are there to watch', steps.split('\n').filter(Boolean)[1] ?? '');
else bad('and the steps are there to watch', steps.replace(/\s+/g, ' ').slice(0, 60) || '(no run panel)');

// ---------------------------------------------------------------------------
console.log('\n— 4d · a suite page shows ITS OWN runs ————————————');

/**
 * Vue reuses a route component when only the parameter changes, so moving from
 * one suite to another never re-ran onMounted — and the new suite's page showed
 * the previous suite's runs under the new suite's name. Four passing runs on a
 * suite that had never been run once.
 */
const virgin = (await post('/api/suites', { name: 'Check console virgin', baseUrl: API })).suite.id;
await post(`/api/suites/${virgin}/pages`, { name: 'Results', path: '/results.html' });

await page.goto(`${APP}/suites/${other}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const busyLatest = await page.locator('section').filter({ hasText: 'Latest runs' }).first().innerText();
if (/Links loads/.test(busyLatest)) ok('a suite with runs shows them');
else bad('a suite with runs shows them', busyLatest.replace(/\s+/g, ' ').slice(0, 60));

// Switch WITHOUT a reload — the case that was broken.
await page.getByRole('link', { name: 'Check console virgin' }).first().click();
await page.waitForTimeout(1500);
const freshLatest = await page.locator('section').filter({ hasText: 'Latest runs' }).first().innerText();
if (/Nothing has run yet/.test(freshLatest)) ok('and switching to one without runs shows none');
else bad('and switching to one without runs shows none', freshLatest.replace(/\s+/g, ' ').slice(0, 70));

await fetch(`${API}/api/suites/${virgin}`, { method: 'DELETE' }).catch(() => {});

// ---------------------------------------------------------------------------
console.log('\n— 5 · the script box keeps up with the recording ——');

// Pressing Record produces a one-step flow immediately (the goto). The box used
// to take that and then ignore everything you demonstrated afterwards, because
// it only filled while empty — so a four-step recording showed one line.
// Sections 4b-4d end on a suite page, so come back to the console first.
await page.goto(`${APP}/console`, { waitUntil: 'networkidle' });
await page.locator('textarea').last().waitFor();
await page.getByRole('button', { name: 'clear' }).click().catch(() => {});
await page.locator('textarea').last().fill('');
await page.getByLabel('URL to open').fill(SITE);
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

// ---------------------------------------------------------------------------
console.log('\n— 6 · a recording that began with a redirect ———————');

/**
 * You type acme.com and the site sends you to https://www.acme.com — a
 * different host, often a different scheme, and an origin nobody allowed.
 *
 * The recording used to say it began where the redirect LANDED, which made it
 * unsaveable: the case is validated on the way in with the same gate the
 * executor uses, so step 0 was refused as an origin that is not allowed. The
 * button appeared to do nothing, because the refusal rendered at the bottom of
 * a long scrolling page. Two symptoms, one cause.
 *
 * It records the URL you ASKED for now, so replaying re-does the redirect.
 */
const redirected = (await post('/api/suites', { name: 'Check console redirect', baseUrl: API })).suite.id;

await page.goto(`${APP}/console?suite=${redirected}`, { waitUntil: 'networkidle' });
await page.locator('textarea').last().waitFor();
await page.getByLabel('URL to open').fill(`${API}/go/offsite`);
await page.getByRole('button', { name: 'Open' }).click();
await page.waitForTimeout(3000);

await page.getByRole('button', { name: '● Record' }).click();
await page.getByRole('button', { name: '■ Stop' }).waitFor();
await page.waitForTimeout(500);
const rb = await page.locator('canvas').boundingBox();
await page.mouse.move(rb.x + rb.width * 0.5, rb.y + rb.height * 0.3);
await page.mouse.click(rb.x + rb.width * 0.5, rb.y + rb.height * 0.3);
await page.waitForTimeout(900);
await page.getByRole('button', { name: '■ Stop' }).click();
await page.waitForTimeout(900);

// The recording's entry, read off the read-only box in the Recording card.
const recorded = await page.locator('textarea').first().inputValue();
const entryUrl = recorded.match(/n0\(\("([^"]+)"\)\)/)?.[1] ?? '(none)';
if (entryUrl.includes('/go/offsite')) ok('it starts from the link you asked for', entryUrl);
else bad('it starts from the link you asked for', entryUrl);

// And therefore it can be stored at all.
await page.getByPlaceholder('Sign in works').fill('Offsite recording');
await page.getByRole('button', { name: 'Save as a case' }).click();
await page.waitForTimeout(1500);

const stored = (await (await fetch(`${API}/api/cases`)).json()).cases
  .filter((c) => c.suiteId === redirected);
if (stored.length) ok('and saving it actually stores it', stored[0].name);
else bad('and saving it actually stores it', 'nothing in /api/cases');

// Saved means selectable — the picker is where you go back for it.
await page.waitForTimeout(400);
const options = (await page.locator('select option').allTextContents()).map((t) => t.trim());
if (options.some((t) => t.startsWith('Offsite recording'))) ok('and it is in the saved-case picker');
else bad('and it is in the saved-case picker', options.slice(0, 3).join(' | ') || '(no options)');

const card = () => page.locator('section').filter({ hasText: 'Save into this suite' }).first();
if (/Saved/.test(await card().innerText())) ok('and says so beside the button');
else bad('and says so beside the button', (await card().innerText()).replace(/\s+/g, ' ').slice(0, 70));

/**
 * And a REFUSAL has to appear there too. It used to set the page-level error,
 * which renders below the log at the bottom of a long scrolling page — indoor
 * plumbing for a message whose entire job is to be read. A save that is
 * refused and says nothing is indistinguishable from a dead button, which is
 * exactly how this was reported.
 *
 * Forced by deleting the suite behind the UI's back: a real refusal down the
 * real path, with nothing stubbed.
 */
await fetch(`${API}/api/suites/${redirected}`, { method: 'DELETE' });
await page.getByPlaceholder('Sign in works').fill('Into a suite that is gone');
await page.getByRole('button', { name: 'Save as a case' }).click();
await page.waitForTimeout(1200);
const refused = await card().innerText();
if (/no suite|not found|unknown/i.test(refused)) ok('and a refusal is shown there as well', refused.split('\n').at(-1)?.slice(0, 44));
else bad('and a refusal is shown there as well', refused.replace(/\s+/g, ' ').slice(0, 70));

// ---------------------------------------------------------------------------
console.log('\n— 7 · the console of the page you are driving ————————');

/**
 * A failing step usually has a reason the page already printed, and until now
 * that reason lived inside a browser nobody could open devtools on.
 *
 * public/noisy.html behaves like an app mid-incident: every level, one line
 * repeated the way a render loop repeats it, a credential printed the way a
 * hurried fetch wrapper prints it, and then an uncaught throw.
 */
await page.goto(`${APP}/console`, { waitUntil: 'networkidle' });
await page.locator('textarea').last().waitFor();
await page.getByLabel('URL to open').fill(`${API}/noisy.html`);
await page.getByRole('button', { name: 'Open' }).click();
await page.waitForTimeout(3000);

const panel = () => page.locator('section').filter({ hasText: 'Browser console' }).first();

// Folded away until asked for: a chatty app would otherwise be the whole page.
const hiddenAtFirst = !(await panel().innerText()).includes('render: AccountList');
await panel().getByRole('button', { name: /^Show/ }).click();
await page.waitForTimeout(400);
const printed = await panel().innerText();

if (hiddenAtFirst && /render: AccountList/.test(printed)) ok('it is folded away until you ask', 'then it shows');
else bad('it is folded away until you ask', hiddenAtFirst ? 'nothing appeared' : 'it was open already');

if (/GET \/api\/balances -> 500/.test(printed)) ok('an error the page logged is here');
else bad('an error the page logged is here', printed.replace(/\s+/g, ' ').slice(0, 70));

// An uncaught throw never reaches console.*, and it is the one you most want.
if (/__kestrel|TypeError|undefined/.test(printed)) ok('and an uncaught throw is too', 'pageerror is captured');
else bad('and an uncaught throw is too', 'only console.* was captured');

// Five identical lines are one fact printed five times.
if (/×5/.test(printed)) ok('a line repeated five times is folded', '×5');
else bad('a line repeated five times is folded', printed.replace(/\s+/g, ' ').slice(0, 70));

/**
 * The one that matters. A page logging the token it just sent is not unusual,
 * and a vault value that never leaves the server must not leave it through
 * here either. The demo credential is the fixture's own literal, so a leak
 * would be visible verbatim.
 */
if (!printed.includes('hunter2-but-from-a-vault') && /\$QA_PASS/.test(printed)) {
  ok('and a vault value is redacted, not printed', 'printed as $QA_PASS');
} else {
  bad('and a vault value is redacted, not printed',
      printed.includes('hunter2-but-from-a-vault') ? 'THE SECRET IS ON SCREEN' : 'it was not named either');
}

await fetch(`${API}/api/suites/${sid}`, { method: 'DELETE' }).catch(() => {});
await fetch(`${API}/api/suites/${other}`, { method: 'DELETE' }).catch(() => {});

console.log('\n— 8 · the address bar the canvas does not have ————————');

/**
 * The canvas is a video, so it has no chrome. You can watch a page navigate
 * somewhere else and have no way to learn where — and the navigations worth
 * seeing are the ones nobody asked for: a login that bounces to an identity
 * provider on another domain, a link that detours through a tracker, a 301 to
 * a path that is now a friendly 404.
 *
 * So the bar has to answer three things, and the third is the one that matters:
 * where am I, how did I get here, and did it leave the site I started on.
 */
await page.goto(`${APP}/console`, { waitUntil: 'networkidle' });
await page.locator('textarea').last().waitFor();

const bar = page.locator('div.rounded-t-xl').first();
const openUrl = async (u) => {
  await page.getByLabel('URL to open').fill(u);
  await page.getByRole('button', { name: 'Open' }).click();
  await page.waitForFunction((want) => {
    const el = document.querySelector('div.rounded-t-xl');
    return el && el.innerText.includes(want);
  }, u.replace(/^https?:\/\//, '').split('?')[0], { timeout: 20000 }).catch(() => {});
};

// A plain page: the address, and nothing invented around it.
await openUrl(`${API}/demo.html`);
let text = await bar.innerText();
if (/localhost:3000\/demo\.html/.test(text)) ok('the bar says where the runner is', text.split('\n')[0]);
else bad('the bar says where the runner is', text.replace(/\n/g, ' | ').slice(0, 70));
if (!/redirect|left /.test(text)) ok('and claims no redirect when there was none');
else bad('and claims no redirect when there was none', text.replace(/\n/g, ' | '));

/**
 * Two hops to somewhere else on the same site. The final URL alone cannot tell
 * you it took a detour, which is exactly why the count is shown.
 */
await openUrl(`${API}/go/tracked`);
text = await bar.innerText();
if (/pricing\.html/.test(text)) ok('it follows a redirect to where it landed', 'not where it was sent');
else bad('it follows a redirect to where it landed', text.replace(/\n/g, ' | ').slice(0, 70));
if (/2 redirects/.test(text)) ok('and says how many hops it took', '2 redirects');
else bad('and says how many hops it took', text.replace(/\n/g, ' | ').slice(0, 70));

// The chain itself, with the status each hop answered. "It works" and "it works
// after two 302s" are different facts about a link.
await bar.getByRole('button', { name: /redirect/ }).click();
const chain = await bar.innerText();
const hops = ['go/tracked', 'go/r?to=/pricing.html', 'pricing.html'].filter((h) => chain.includes(h));
if (hops.length === 3 && /302/.test(chain) && /200/.test(chain)) {
  ok('and can show every hop, with its status', '302 → 302 → 200');
} else bad('and can show every hop, with its status', chain.replace(/\n/g, ' | ').slice(0, 90));

/**
 * The address arrives before the page has been examined.
 *
 * Both `url` and `targets` carry it, but `targets` is emitted after discovery
 * has taken an aria snapshot of the whole page — hundreds of milliseconds on a
 * real site, during which the bar would still read the address you came FROM.
 * You would watch a redirect happen on the canvas and be told the old URL.
 *
 * Ordering rather than timing, so this asserts the actual claim without being
 * a stopwatch: whichever of the two arrives first must be the cheap one.
 */
const socket = new WebSocket(API.replace(/^http/, 'ws'));
const arrivals = [];
socket.on('message', (d, isBinary) => {
  if (isBinary) return;
  const ev = JSON.parse(d);
  if (ev.t === 'url' || ev.t === 'targets') arrivals.push({ t: ev.t, url: ev.url });
});
await new Promise((r) => { socket.on('open', r); socket.on('error', r); });

arrivals.length = 0;
await openUrl(`${API}/results.html`);
await new Promise((r) => setTimeout(r, 1500));
socket.close();

const forPage = arrivals.filter((a) => (a.url ?? '').includes('/results.html'));
if (forPage.length >= 2) ok('both the address and the page contents arrive', forPage.map((a) => a.t).join(' then '));
else bad('both the address and the page contents arrive', JSON.stringify(arrivals.slice(-4)));
if (forPage[0]?.t === 'url') ok('and the address comes first', 'not after discovery');
else bad('and the address comes first', `${forPage[0]?.t ?? 'nothing'} arrived first — the bar would lag`);

/**
 * The one that is not cosmetic. A redirect onto another host is how a run ends
 * up somewhere nobody allowed, and a host is not something you notice in a
 * truncated URL — so it is named rather than left to be read.
 */
await openUrl(`${API}/go/offsite`);
text = await bar.innerText();
if (/127\.0\.0\.1:3000/.test(text)) ok('a hop to another host shows that host', '127.0.0.1:3000');
else bad('a hop to another host shows that host', text.replace(/\n/g, ' | ').slice(0, 70));
if (/left localhost:3000/.test(text)) ok('and says which one it left', 'left localhost:3000');
else bad('and says which one it left', text.replace(/\n/g, ' | ').slice(0, 70));

await browser.close();
console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — the canvas paints when you arrive, says what it is waiting for\n' +
    '       before it can, the wheel reaches the page you are driving, and a\n' +
    '       saved case can be picked up and run from here — including one\n' +
    '       recorded after a redirect that left the origin. What the driven\n' +
    '       page printed is here too, with vault values redacted, and the\n' +
    '       address bar says where the runner is and what it went through.\n');
process.exit(failures ? 1 : 0);
