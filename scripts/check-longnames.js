/**
 * Two ways a recording came back unrunnable from a real site.
 *
 *   npm start &
 *   node scripts/check-longnames.js
 *
 * Against public/results.html — a sticky header over a list of result cards.
 *
 *  1. A TRUNCATED NAME. A card link wraps a kicker, a heading and a summary,
 *     so its accessible name is all of that at once — 178 characters here. The
 *     proposer cut names to 80 to keep scripts readable, and the runner then
 *     looked them up with exact:true. The target could never match. It failed
 *     at replay, minutes into a run, having looked perfectly reasonable in the
 *     script.
 *
 *  2. A STICKY ANCHOR. A pinned header is always the topmost interactive thing
 *     in view, so every scroll anchored to the same link and replaying them
 *     moved nothing. The recording said "scroll to Features" three times.
 */
import { chromium } from 'playwright';
import { Recorder } from '../recorder.js';
import { OPS, validate } from '../ops.js';
import { VirtualCursor, sleep } from '../cursor.js';
import { parseFlow, flatten } from '../flow.js';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const PAGE = `${BASE}/results.html`;

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
const cursor = new VirtualCursor(cdp, () => {});
const ctx = { cursor, emit: () => {}, onNavigate: async () => {} };

const errors = [];
const recorder = new Recorder(page, { onError: (m) => errors.push(m) });
await recorder.attach();

// ---------------------------------------------------------------------------
console.log('\n— 1 · a link whose name is a whole paragraph ——————');

await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
const cardName = await page.getByRole('link', { name: /Joint vs/ }).first()
  .evaluate((e) => e.innerText.replace(/\s+/g, ' ').trim());
console.log(`     (its accessible name is ${cardName.length} characters)`);

recorder.start(PAGE, []);
await page.getByRole('link', { name: /Joint vs/ }).first().click();
await sleep(700);
let steps = recorder.stop(page.url());

const click = steps.find((s) => s.op === 'click');
if (click) ok('the click is recorded', click.target);
else bad('the click is recorded', errors.join('; ') || 'nothing');

// The whole point: whatever it proposed has to actually resolve.
if (click) {
  const n = await page.locator('*').count().catch(() => 0);
  let resolved = null;
  try {
    validate({ suite: 'x', steps: [{ op: 'goto', url: PAGE }, click] });
    const { locate, parseTarget } = await import('../targets.js');
    resolved = await locate(page, parseTarget(click.target)).count();
  } catch (e) { resolved = e.message; }
  if (resolved === 1) ok('and its target resolves to one element', `on a page of ${n} nodes`);
  else bad('and its target resolves to one element', String(resolved));
}

if (click) ok('and it is readable', `${click.target.length} chars`);

// ---------------------------------------------------------------------------
console.log('\n— 1a · the invariant, on every proposal —————————————');

/**
 * Assert on the CANDIDATES, not on whichever one happened to win.
 *
 * `text:` matches on a substring, so it resolves happily even when the name is
 * truncated or the wrong case — which masked both bugs when this check only
 * looked at the chosen target. The property that matters is upstream: an EXACT
 * strategy must never be handed a name the element does not actually have.
 */
const proposals = await page.evaluate(() => {
  const el = [...document.querySelectorAll('a.card')][0];
  const P = self.__gcPropose;
  const dom = (n) => {
    let out = [];
    const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
    let t; while ((t = w.nextNode())) {
      const h = t.parentElement;
      if (!h || h.tagName === 'SCRIPT' || h.tagName === 'STYLE') continue;
      out.push(t.nodeValue);
    }
    return out.join(' ').replace(/\s+/g, ' ').trim();
  };
  return { real: dom(el), cands: P.propose(el).map((c) => c.target) };
});

const EXACT = /^(?:[a-z0-9]+\/)?(link|button|textbox|checkbox|radio|combobox|tab|menuitem|label|placeholder|testid):/;
const exact = proposals.cands.filter((t) => EXACT.test(t));

const cut = exact.find((t) => {
  const name = t.slice(t.indexOf(':') + 1);
  return proposals.real.startsWith(name) && name.length < proposals.real.length;
});
if (!cut) ok('no exact strategy carries a truncated name', `${exact.length} exact proposal(s) checked`);
else bad('no exact strategy carries a truncated name', `“…${cut.slice(-26)}” is a cut of the real name`);

const miscased = exact.find((t) => {
  const name = t.slice(t.indexOf(':') + 1);
  return !proposals.real.includes(name) && proposals.real.toLowerCase().includes(name.toLowerCase());
});
if (!miscased) ok('and none is the rendered casing', 'names come from DOM text');
else bad('and none is the rendered casing', `“${miscased.slice(0, 44)}…”`);

// ---------------------------------------------------------------------------
console.log('\n— 1b · a short name that is styled uppercase ——————');

// `text-transform: uppercase` changes innerText and not the accessible name.
// A recorder that reads rendered text emits `button:LOAD MORE RESULTS`, which
// getByRole — matching the real name, `Load more results` — never finds.
await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
recorder.start(PAGE, []);
await page.locator('#more').click();
await sleep(600);
const shouty = recorder.stop(page.url()).find((s) => s.op === 'click');

if (shouty) ok('the click is recorded', shouty.target);
else bad('the click is recorded', errors.join('; ') || 'nothing');

if (shouty) {
  const { locate, parseTarget } = await import('../targets.js');
  const n = await locate(page, parseTarget(shouty.target)).count().catch(() => -1);
  if (n === 1) ok('and it resolves', shouty.target);
  else bad('and it resolves', `${n} matches for ${shouty.target}`);
}

// Again: assert on the proposals. A `text:` target matches case-insensitively
// enough to hide this, and a role target does not.
const shoutCands = await page.evaluate(() => self.__gcPropose.propose(document.querySelector('#more')).map((c) => c.target));
const asRole = shoutCands.find((t) => /^(?:[a-z0-9]+\/)?button:/.test(t));
if (asRole === 'button:Load more results') ok('and the role proposal has the real casing', asRole);
else bad('and the role proposal has the real casing', asRole ?? '(none offered)');

// ---------------------------------------------------------------------------
console.log('\n— 1c · a name with a colon in it ——————————————————');

/**
 * The aria snapshot is YAML, and YAML single-quotes an entry whose content
 * would otherwise be ambiguous — which happens as soon as a name contains
 * ": ". A price, a stat, a headline with a colon. Discovery's pattern only
 * accepted the bare form, so those elements vanished from the target panel,
 * from the entry fingerprint, and from the "did you mean" hint: the tool
 * insisted a link was not there while you were looking at it.
 */
const { discover } = await import('../targets.js');
const found = (await discover(page)).map((t) => t.target);
const withColon = found.find((t) => /Joint vs\. separate bank accounts: which/.test(t));
if (withColon) ok('discovery sees a name containing ": "', `${found.length} targets in total`);
else bad('discovery sees a name containing ": "', `not among ${found.length}: ${found.slice(0, 3).join(', ')}`);

// ---------------------------------------------------------------------------
console.log('\n— 1d · a step recorded before the fix ————————————');

// A recording made by the old proposer keeps its mangled name — the fix
// changes what gets written, not what is already written. So the failure has
// to name the mangling and hand back something you can paste.
const realName = await page.getByRole('link', { name: /Joint vs/ }).first()
  .evaluate((e) => e.textContent.replace(/\s+/g, ' ').trim());
const stale = `link:${realName.toUpperCase().slice(0, 17)}${realName.slice(17, 80)}`;

let msg = null;
try {
  await OPS.click(page, validate({ suite: 'x', steps: [{ op: 'click', target: stale }] }).steps[0], ctx);
} catch (e) { msg = e.message; }

if (msg && /the page has that element/.test(msg)) ok('it says the element IS there');
else bad('it says the element IS there', (msg ?? 'it passed').split('\n')[0].slice(0, 60));

if (msg && /cut short and in the wrong case/.test(msg)) ok('and names both manglings');
else bad('and names both manglings', 'the diagnosis is vague');

const use = msg?.match(/use instead:\s+(\S.*)/)?.[1]?.trim();
if (use) {
  let works = false;
  try {
    await OPS.click(page, validate({ suite: 'x', steps: [{ op: 'click', target: use }] }).steps[0], ctx);
    works = true;
  } catch { /* no */ }
  if (works) ok('and the replacement it offers works', use.slice(0, 52));
  else bad('and the replacement it offers works', use);
} else bad('and the replacement it offers works', 'none offered');

await page.goto(PAGE, { waitUntil: 'domcontentloaded' });

// ---------------------------------------------------------------------------
console.log('\n— 2 · scrolling under a sticky header ————————————');

await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
recorder.start(PAGE, []);
await page.mouse.move(590, 400);
// Come to rest in the MIDDLE. Scrolling to an end records `to: top`/`bottom`
// and never consults the anchor at all — which is how the first version of
// this check passed with the sticky-header bug still in place.
for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 260); await sleep(140); }
await sleep(900);
for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 260); await sleep(140); }
await sleep(900);
steps = recorder.stop(page.url());

const anchored = steps.filter((s) => s.op === 'scroll' && s.target);
if (anchored.length) ok('a scroll that stops mid-page names an anchor', anchored.map((s) => s.target).join(' → '));
else bad('a scroll that stops mid-page names an anchor', steps.filter((s) => s.op === 'scroll').map((s) => s.to).join(', ') || 'no scroll at all');

const scrolls = steps.filter((s) => s.op === 'scroll');
if (scrolls.length) ok('scrolling is recorded', scrolls.map((s) => s.to ?? s.target).join(' → '));
else bad('scrolling is recorded', 'nothing');

const pinnedAnchor = scrolls.find((s) => s.target && /:(Features|Pricing|Learn)$/.test(s.target));
if (!pinnedAnchor) ok('and never anchors to the sticky header', 'it does not move with the page');
else bad('and never anchors to the sticky header', pinnedAnchor.target);

const dupes = scrolls.filter((s, i) => i && scrolls[i - 1].target === s.target && scrolls[i - 1].to === s.to);
if (!dupes.length) ok('and no two in a row are identical', 'a repeat is a step that does nothing');
else bad('and no two in a row are identical', `${dupes.length} repeated`);

// ---------------------------------------------------------------------------
console.log('\n— 3 · and the recording replays ————————————————————');

const flow = [
  '%% suite "Results"', 'flowchart TD', `  a(("${PAGE}"))`, '',
  `  a -->|${scrolls.length ? 'scroll to bottom; ' : ''}click ${
    click ? `'${click.target.slice(click.target.indexOf(':') + 1)}' : ${click.target.slice(0, click.target.indexOf(':'))}` : ''
  }| a`,
].join('\n');

let plan = null;
try { plan = validate(flatten(parseFlow(flow))); } catch (e) { bad('the flow parses', e.message); }
if (plan) {
  let ran = 0, failed = null;
  for (const step of plan.steps) {
    try { await OPS[step.op](page, step, ctx); ran++; }
    catch (e) { failed = `step ${ran}: ${e.message.split('\n')[0]}`; break; }
  }
  if (!failed) ok('every step runs', `${ran} steps`);
  else bad('every step runs', failed);
}

await browser.close();
console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — a link named by a whole paragraph gets a handle that resolves,\n' +
    '       and a sticky header never becomes a scroll anchor.\n');
process.exit(failures ? 1 : 0);
