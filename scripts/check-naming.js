/**
 * Naming an element the page and the browser disagree about.
 *
 *   npm start &
 *   node scripts/check-naming.js
 *
 * Every case here came out of one recording session against a real marketing
 * site, which dropped five interactions in a row and said so:
 *
 *   Dropped a click — could not name that element. Tried:
 *     link:Docs (names a different element), banner/link:Docs (names a
 *     different element), text:Docs (names a different element)
 *   Dropped a click — ... nth1/link:Pricing (names a different element),
 *     link:Pricing (2 matches), text:Pricing (3 matches)
 *   Dropped a hover — ... (nothing usable)
 *
 * One cause underneath all of it: the proposer counted candidates with
 * querySelectorAll and the runner resolves them with getByRole, which reads the
 * accessibility tree. A responsive site keeps its mobile menu in the DOM and
 * hides it with visibility:hidden, so the page saw three "Pricing" links and
 * the browser saw two — every count off by one, every ordinal one element to
 * the left. A count taken over a different set than the one that will resolve
 * it is not a count.
 *
 * public/nav.html is that page, reduced: a hidden mobile menu, a nav repeated
 * in the footer, a link that navigates somewhere carrying the same nav, and a
 * div with nothing to call it.
 */
import { chromium } from 'playwright';
import WebSocket from 'ws';
import { fileURLToPath } from 'node:url';
import { parseFlow, flatten } from '../flow.js';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const WS_URL = process.env.WS_URL || BASE.replace(/^http/, 'ws');
const VIEW = { width: 1180, height: 760 };
const PROPOSE = fileURLToPath(new URL('../extension/lib/propose.js', import.meta.url));

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(52)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(52)} ${d}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
console.log('\n— the page counts what the browser can see ————————————');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: VIEW });
await page.goto(`${BASE}/nav.html`);
await page.addScriptTag({ path: PROPOSE });

/** What the page would offer for the nth <a> whose text is `text`. */
const proposalsFor = (text, i) => page.evaluate(([t, idx]) => {
  const links = [...document.querySelectorAll('a')].filter((a) => a.textContent.trim() === t);
  return self.__gcPropose.propose(links[idx]).map((c) => ({ target: c.target, n: c.n }));
}, [text, i]);

const pwCount = (name) => page.getByRole('link', { name }).count();

// The disagreement itself, stated as a number. Three in the DOM, two in the
// accessibility tree, and the proposer must side with the browser.
const inDom = await page.evaluate(() =>
  [...document.querySelectorAll('a')].filter((a) => a.textContent.trim() === 'Pricing').length);
const inTree = await pwCount('Pricing');
if (inDom === 3 && inTree === 2) ok('the fixture really does disagree', `${inDom} in the DOM, ${inTree} in the tree`);
else bad('the fixture really does disagree', `${inDom} in the DOM, ${inTree} in the tree — expected 3 and 2`);

const main = await proposalsFor('Pricing', 1);      // the visible header nav
const foot = await proposalsFor('Pricing', 2);      // the footer
const nOf = (list, t) => list.find((c) => c.target === t)?.n;

if (nOf(main, 'link:Pricing') === inTree) ok('and the proposer counts the tree, not the DOM', `link:Pricing n=${inTree}`);
else bad('and the proposer counts the tree, not the DOM', `said n=${nOf(main, 'link:Pricing')}, browser says ${inTree}`);

// The ordinal is the one that actually bit: the hidden menu came first in the
// DOM, so every index was one too low and named the element to its left.
const ordinalOf = (list) => list.map((c) => c.target).find((t) => /^nth\d+\//.test(t));
const mainOrd = ordinalOf(main);
const footOrd = ordinalOf(foot);
if (mainOrd === 'nth1/link:Pricing') ok('the header link is the browser’s first', mainOrd);
else bad('the header link is the browser’s first', String(mainOrd));
if (footOrd === 'nth2/link:Pricing') ok('and the footer link is its second', footOrd);
else bad('and the footer link is its second', String(footOrd));

// And they resolve to what they claim.
for (const [label, ord, want] of [['nth1', mainOrd, 'Main'], ['nth2', footOrd, 'Footer']]) {
  const i = Number(/^nth(\d+)\//.exec(ord ?? '')?.[1] ?? 0);
  const nav = i ? await page.getByRole('link', { name: 'Pricing' }).nth(i - 1)
    .evaluate((e) => e.closest('nav').getAttribute('aria-label')) : '(none)';
  if (nav === want) ok(`${ord} really is the ${want.toLowerCase()} one`);
  else bad(`${ord} really is the ${want.toLowerCase()} one`, `resolved into the ${nav} nav`);
}

// ---------------------------------------------------------------------------
console.log('\n— a scope is only offered when it can resolve —————————');

/**
 * The runner reads `contentinfo/` as getByRole('contentinfo').first(), so a
 * landmark scope is a claim about WHICH region. The innermost one used to be
 * taken unconditionally, which named a footer link `navigation/link:Pricing` —
 * and the header's nav is the first navigation, so it named the header's link.
 */
const scopes = (list) => list.map((c) => c.target).filter((t) => /^[a-z]+\//.test(t) && !/^nth/.test(t));
const footScopes = scopes(foot);
if (!footScopes.some((t) => t.startsWith('navigation/'))) {
  ok('a footer link is not called "the first navigation"', footScopes.join(' ') || '(none)');
} else {
  bad('a footer link is not called "the first navigation"', footScopes.join(' '));
}
if (footScopes.some((t) => t.startsWith('contentinfo/'))) ok('it is called what it is', 'contentinfo/link:Pricing');
else bad('it is called what it is', footScopes.join(' ') || '(no scope offered)');

// ---------------------------------------------------------------------------
console.log('\n— an element with nothing to call it ——————————————————');

const card = await page.evaluate(() => {
  const el = document.getElementById('hovercard');
  return {
    ownRole: String(self.__gcPropose.roleOf(el)),
    ownName: self.__gcPropose.nameOf(el),
    itself: self.__gcPropose.proposeFor(el),
    offered: self.__gcPropose.propose(el).map((c) => ({ target: c.target, n: c.n, enclosing: !!c.enclosing })),
  };
});
if (card.ownRole === 'null' && !card.ownName && !card.itself.length) {
  ok('the fixture div really has no name of its own', 'no role, no label, no text');
} else {
  bad('the fixture div really has no name of its own', `${card.ownRole} ${JSON.stringify(card.ownName)}`);
}
if (card.offered.length) ok('so something enclosing it is offered', card.offered.map((c) => c.target).join(', '));
else bad('so something enclosing it is offered', '(nothing usable) — the step would be dropped');
if (card.offered.every((c) => c.enclosing)) ok('and it is labelled as enclosing, not as the element');
else bad('and it is labelled as enclosing, not as the element', JSON.stringify(card.offered));

// ---------------------------------------------------------------------------
console.log('\n— a control whose only name is its alt text ————————————');

/**
 * An icon link: a logo, a search button, a close X. It has no text at all, and
 * the whole of its accessible name is the img's alt attribute.
 *
 * The name computation here walked TEXT NODES, so it read that name as "" and
 * offered nothing for it — while the browser could see two links called
 * "Support". Not an edge case: a whole class of controls could not be recorded.
 */
const icon = await page.evaluate(() => {
  const links = [...document.querySelectorAll('a')].filter((a) => a.querySelector('img[alt="Support"]'));
  return { name: self.__gcPropose.nameOf(links[1]), offered: self.__gcPropose.propose(links[1]).map((c) => c.target) };
});
if (icon.name === 'Support') ok('an icon link is named by its alt text', `"${icon.name}"`);
else bad('an icon link is named by its alt text', `"${icon.name}" — the browser calls it "Support"`);
if (icon.offered.some((t) => t === 'contentinfo/link:Support' || t === 'nth2/link:Support')) {
  ok('and the footer one is told apart from the header one', icon.offered.join(', '));
} else {
  bad('and the footer one is told apart from the header one', icon.offered.join(', ') || '(nothing usable)');
}

// ---------------------------------------------------------------------------
console.log('\n— ambiguous, with no role to count on ——————————————————');

/**
 * A control built from divs: click handlers, no role, identical text.
 *
 * The proposer's positional backstop is only ever offered for ROLE targets, so
 * the only thing on offer here is `text:Choose`, and it matches both. There is
 * nothing more the page can say — which is why the runner has to be the one to
 * answer it, using the same query that will resolve it at replay.
 */
const pick = await page.evaluate(() =>
  self.__gcPropose.propose(document.querySelectorAll('.pick')[1]).map((c) => ({ target: c.target, n: c.n })));
const pickTargets = pick.map((c) => c.target);
if (pickTargets.length && pickTargets.every((t) => !/^nth\d+\//.test(t))) {
  ok('the page offers no ordinal for a roleless control', pickTargets.join(', '));
} else {
  bad('the page offers no ordinal for a roleless control', pickTargets.join(', ') || '(nothing)');
}
if (pick.some((c) => c.n > 1)) ok('and what it does offer is ambiguous', `text:Choose n=${pick[0].n}`);
else bad('and what it does offer is ambiguous', JSON.stringify(pick));

await browser.close();

// ---------------------------------------------------------------------------
console.log('\n— recording it, for real ——————————————————————————————');

/**
 * The half that matters. Everything above is about what the page proposes; this
 * drives the runner the way a person does and asserts that nothing is lost —
 * including the click that navigates, which is the one the old code always
 * dropped and the one a person most wants recorded.
 */
const probe = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const pp = await probe.newPage({ viewport: VIEW });
await pp.goto(`${BASE}/nav.html`);
const at = async (loc) => {
  const b = await loc.boundingBox();
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
};
const POINTS = {
  secondChoose: await at(pp.locator('.pick').nth(1)),
  footerPricing: await at(pp.getByRole('contentinfo').getByRole('link', { name: 'Pricing' })),
  headerDocs: await at(pp.getByRole('banner').getByRole('link', { name: 'Docs' })),
};
await probe.close();

const ws = new WebSocket(WS_URL);
const errors = [];
let flow = '';
ws.on('message', (d, isBinary) => {
  if (isBinary) return;
  const ev = JSON.parse(d);
  if (ev.t === 'recorded') flow = ev.flow;
  if (ev.t === 'log' && ev.level === 'error') errors.push(ev.msg);
});
const send = (o) => ws.send(JSON.stringify(o));
const clickAt = async (p) => { send({ t: 'human.move', ...p }); await wait(150); send({ t: 'human.click' }); await wait(700); };

await new Promise((r) => { ws.on('open', r); ws.on('error', r); });
await wait(400);
send({ t: 'open', url: `${BASE}/nav.html` });
await wait(2500);
send({ t: 'record.start' });
await wait(400);

await clickAt(POINTS.secondChoose);           // ambiguous, and no role to count on
await clickAt(POINTS.footerPricing);          // ambiguous: two links, same name
await clickAt(POINTS.headerDocs);             // navigates to a page with the same nav
await wait(1500);
send({ t: 'record.stop' });
await wait(1200);
ws.close();

const clicksIn = (f) => { try { return flatten(parseFlow(f)).steps.filter((x) => x.op === 'click').length; } catch { return '?'; } };
const dropped = errors.filter((m) => /^Dropped a/.test(m));
if (!dropped.length) ok('nothing was dropped', `3 interactions, ${clicksIn(flow)} steps`);
else dropped.forEach((m) => bad('nothing was dropped', m.slice(0, 96)));

/**
 * Read the STEPS, not the picture.
 *
 * A mermaid edge label is written for a person — `click 'Pricing' :
 * contentinfo/link` — so grepping the diagram for a target tests the label
 * renderer rather than the recording. The IR is what will be replayed.
 */
let steps = [];
try { steps = flatten(parseFlow(flow)).steps; } catch (e) { bad("the recording parses", e.message); }

const clicks = steps.filter((s) => s.op === 'click');
const pricing = clicks.find((s) => /Pricing/.test(s.target ?? ''));
const docs = clicks.find((s) => /Docs/.test(s.target ?? ''));

// Named correctly, not merely named. A step that resolves to the header's
// Pricing when the footer's was clicked is worse than a dropped one, because
// nothing says so.
if (pricing && /^(contentinfo\/link|nth2\/link):Pricing$/.test(pricing.target)) {
  ok('the footer link is recorded as the footer’s', pricing.target);
} else {
  bad('the footer link is recorded as the footer’s', pricing?.target ?? '(no Pricing click)');
}
if (docs) ok('and the click that navigates survived', docs.target);
else bad('and the click that navigates survived', 'the step is not in the recording');

// The runner's own answer to an ambiguity the page could not resolve.
const chose = clicks.find((s) => /Choose/.test(s.target ?? ''));
if (chose && /^nth2\/text:Choose$/.test(chose.target)) ok('the runner numbered what the page could not', chose.target);
else bad('the runner numbered what the page could not', chose?.target ?? '(no Choose click)');

console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — the proposer counts what the browser can see, offers only scopes\n'
    + '       that resolve, finds a name for an element that has none, and keeps\n'
    + '       the click that navigates to a page carrying the same nav.\n');
process.exit(failures ? 1 : 0);
