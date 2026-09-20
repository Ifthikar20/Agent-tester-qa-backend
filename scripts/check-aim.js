/**
 * A press lands on the element, and a URL check says what the press did.
 *
 *   npm start &
 *   node scripts/check-aim.js
 *
 * Against public/wrapped.html: a link whose words wrap onto two lines, so the
 * centre of its bounding box is the gap between them — a pixel the paragraph
 * owns. A replay used to press exactly there, report success, and fail a step
 * later with "did not navigate anywhere", a sentence about the wrong thing.
 *
 * Now (aim.js): the press is aimed at one of the link's own lines; a press that
 * cannot reach its element stops and says what it would have hit; a URL check
 * says what the press before it did; and a recording that leaves the site
 * keeps the host in the arrival it writes.
 *
 * Runs against another port with BASE_URL — and then ALLOWED_ORIGINS must
 * name it, because a goto is refused for an origin nobody allowed.
 */
import { chromium } from 'playwright';
import { Recorder } from '../recorder.js';
import { NavigationLog } from '../navlog.js';
import { OPS, validate } from '../ops.js';
import { VirtualCursor, sleep } from '../cursor.js';
import { parseFlow, flatten, toFlow } from '../flow.js';
import { hitAt, missMessage, arrivalFailure } from '../aim.js';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const PAGE = `${BASE}/wrapped.html`;
const HOST = new URL(BASE).host;
const OTHER = `127.0.0.1:${new URL(BASE).port || '80'}`;
const TEXT = 'These 20-year-olds have grown their AI note-taking app for students by 5';

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(46)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(46)} ${d}`); };
const first = (s) => String(s ?? '').split('\n')[0];

// ---------------------------------------------------------------------------
console.log('\n— the sentences, offline ———————————————————————');
{
  const miss = missMessage('text:These 20-year-olds…', { ok: false, relation: 'around', what: 'paragraph', self: 'link' }, [[557, 380], [341, 397]]);
  if (first(miss) === '"text:These 20-year-olds…" is on the page, but the press would land on the paragraph around the link, not on the link — so nothing was pressed.'
      && /\n  Tried 557,380 and 341,397\.$/.test(miss)) ok('a gap the element does not paint', 'the paragraph around the link');
  else bad('a gap the element does not paint', first(miss));

  const over = missMessage('link:Read it here', { ok: false, relation: 'over', what: 'div "Cookie notice"', self: 'link' });
  if (/would land on div "Cookie notice" over the link, not on the link — so nothing was pressed\.$/.test(first(over))) ok('a layer over it', 'div "Cookie notice" over the link');
  else bad('a layer over it', first(over));

  const off = missMessage('link:X', { ok: false, relation: 'nothing', what: 'nothing', self: 'link' });
  if (/would land outside the window, not on the link/.test(first(off))) ok('outside the window', 'outside the window');
  else bad('outside the window', first(off));

  const plain = arrivalFailure('/x', 'https://a.test/b');
  if (plain === 'expected the URL to contain "/x", but it is "https://a.test/b"') ok('a URL check with nothing pressed before it', 'the URL, and no accusation');
  else bad('a URL check with nothing pressed before it', plain);

  const press = { how: "clicking 'Go' : button", on: 'button "Go"', urlBefore: 'https://a.test/b', navSeq: 3 };
  const still = arrivalFailure('/x', 'https://a.test/b', press, { seq: 3, redirects: 0 }, 8000);
  if (first(still) === 'expected the URL to contain "/x", but it is still "https://a.test/b" — the page did not change after clicking \'Go\' : button; the press landed on the button "Go", and nothing navigated in the 8.0s this waited.'
      && /\n  A link that opens a new tab, a download, a menu, or a handler that did nothing all look like this from here\.$/.test(still)) ok('a press that changed nothing', 'the page did not change after clicking …');
  else bad('a press that changed nothing', first(still));

  const moved = arrivalFailure('/x', 'https://a.test/c', { ...press, how: "clicking 'Blog' : link" }, { seq: 4, redirects: 2 }, 8000);
  if (moved === 'expected the URL to contain "/x", but clicking \'Blog\' : link took the page to "https://a.test/c" through 2 redirects, which does not contain it') ok('a press that went somewhere else', 'took the page to …, through 2 redirects');
  else bad('a press that went somewhere else', moved);
}

// ---------------------------------------------------------------------------
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1180, height: 760 } });
const cdp = await page.context().newCDPSession(page);
const cursor = new VirtualCursor(cdp, () => {});
const nav = new NavigationLog(page);
nav.attach();
const logs = [];
const ctx = { cursor, emit: (e) => logs.push(e), nav, onNavigate: async () => {} };

console.log('\n— the link wraps ———————————————————————————————');
await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
const em = page.locator('#story em');
const shape = await em.evaluate((e) => {
  const b = e.getBoundingClientRect();
  const rects = [...e.getClientRects()].map((q) => ({ x: q.left, y: q.top, w: q.width, h: q.height }));
  const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
  const hit = document.elementFromPoint(cx, cy);
  return { rects, box: { x: b.left, y: b.top, w: b.width, h: b.height }, centre: [cx, cy], hitTag: hit?.tagName, inLink: Boolean(hit?.closest('a')) };
});
if (shape.rects.length >= 2) ok('the link is on two lines', `${shape.rects.length} boxes`);
else bad('the link is on two lines', `${shape.rects.length} box — widen the words or narrow the paragraph`);
if (shape.hitTag === 'P' && !shape.inLink) ok('and the centre of its box is the paragraph', `${Math.round(shape.centre[0])},${Math.round(shape.centre[1])} — where a press used to go`);
else bad('and the centre of its box is the paragraph', `${shape.hitTag}, in the link: ${shape.inLink}`);
const gap = await em.evaluate(hitAt, { dx: shape.box.w / 2, dy: shape.box.h / 2 });
if (!gap.ok && gap.relation === 'around' && gap.what === 'paragraph' && gap.self === 'link') ok('hitAt says so', `${gap.relation}: the ${gap.what} around the ${gap.self}`);
else bad('hitAt says so', JSON.stringify(gap));

// ---------------------------------------------------------------------------
console.log('\n— pressed on its words ——————————————————————————');
const flowOf = (mark = '') => `%% suite "x"\nflowchart TD\n  a(("${PAGE}"))\n  b["/pricing.html"]\n  a -->|click '${TEXT}' : text| b\n${mark}\n`;
const run = async (flow) => {
  logs.length = 0;
  const plan = validate(flatten(parseFlow(flow)));
  for (const step of plan.steps) await OPS[step.op](page, step, ctx);
  await sleep(300);
};
const fails = async (flow) => { try { await run(flow); return null; } catch (e) { return first(e.message); } };
const inside = ([x, y], rects) => rects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);

let e = await fails(flowOf());
if (!e && /\/pricing\.html$/.test(page.url())) ok('the click reaches the page it links to', page.url());
else bad('the click reaches the page it links to', e ?? page.url());
const press = ctx.lastPress;
if (press && inside([press.x, press.y], shape.rects) && Math.hypot(press.x - shape.centre[0], press.y - shape.centre[1]) > 2) {
  ok('pressed inside one of the link\'s lines', `${Math.round(press.x)},${Math.round(press.y)}, not the centre ${Math.round(shape.centre[0])},${Math.round(shape.centre[1])}`);
} else bad('pressed inside one of the link\'s lines', JSON.stringify(press && [press.x, press.y]));
if (press?.on?.startsWith('link')) ok('and knows what it landed on', press.on);
else bad('and knows what it landed on', press?.on ?? 'nothing recorded');

// A recorded point on the second line: no drift warning, and the press goes there.
const line2 = shape.rects[1];
const size = `${Math.round(shape.box.w)}x${Math.round(shape.box.h)} in 1180x760`;
e = await fails(flowOf(`%% at 1 ${Math.round(line2.x + 20)},${Math.round(line2.y + line2.h / 2)} ${size}`));
let warned = logs.filter((l) => l.t === 'log' && /recorded at/.test(l.msg));
if (!e && !warned.length) ok('a recorded point on the second line is no drift', 'no warning');
else bad('a recorded point on the second line is no drift', e ?? warned[0]?.msg);
if (ctx.lastPress && inside([ctx.lastPress.x, ctx.lastPress.y], [line2])) ok('and is the line that is pressed', `${Math.round(ctx.lastPress.x)},${Math.round(ctx.lastPress.y)}`);
else bad('and is the line that is pressed', JSON.stringify(ctx.lastPress && [ctx.lastPress.x, ctx.lastPress.y]));

// A recorded point far away: the warning names the aim point, inside a line, not the union centre.
e = await fails(flowOf(`%% at 1 30,30 ${size}`));
warned = logs.find((l) => l.t === 'log' && /recorded at 30,30 but resolves to \d+,\d+/.test(l.msg));
const m = warned && warned.msg.match(/resolves to (\d+),(\d+)/);
if (!e && m && inside([Number(m[1]), Number(m[2])], shape.rects)) ok('a far recorded point warns with the aim point', `resolves to ${m[1]},${m[2]}`);
else bad('a far recorded point warns with the aim point', e ?? warned?.msg ?? 'no warning');

// ---------------------------------------------------------------------------
console.log('\n— a press that cannot land says so ——————————————');
e = await fails(`%% suite "x"\nflowchart TD\n  a(("${PAGE}?covered"))\n  b["/pricing.html"]\n  a -->|click 'Read it here' : link| b\n`);
if (e && /^"link:Read it here" is on the page, but the press would land on div "Veil" over the link, not on the link — so nothing was pressed\.$/.test(e)) ok('the layer is named and nothing is pressed', 'div "Veil" over the link');
else bad('the layer is named and nothing is pressed', e ?? 'it passed');
if (/wrapped\.html\?covered$/.test(page.url())) ok('and the page is where it was', page.url());
else bad('and the page is where it was', page.url());

// ---------------------------------------------------------------------------
console.log('\n— the URL check says what the click did ———————————');
const steps = (...s) => validate({ suite: 'x', steps: s }).steps;
const attempt = async (list) => {
  logs.length = 0;
  try { for (const step of list) await OPS[step.op](page, step, ctx); return null; } catch (err) { return err.message; }
};
const goto = { op: 'goto', url: PAGE };
const nowhere = { op: 'expect', assert: 'urlContains', value: '/nowhere', timeout: 800 };
const said = [];

let r = await attempt(steps(goto, nowhere)); said.push(r);
if (r === `expected the URL to contain "/nowhere", but it is "${PAGE}"`) ok('nothing pressed: the URL, and no accusation', r.slice(0, 46));
else bad('nothing pressed: the URL, and no accusation', r ?? 'it passed');

r = await attempt(steps(goto, { op: 'click', target: 'button:Does nothing' }, nowhere)); said.push(r);
if (r && /is still "[^"]+" — the page did not change after clicking 'Does nothing' : button; the press landed on the button "Does nothing", and nothing navigated in the 0\.8s this waited\./.test(r) && !/took the page to/.test(r)) ok('a button that did nothing: the page did not change', 'the press landed on the button "Does nothing"');
else bad('a button that did nothing: the page did not change', r ?? 'it passed');

r = await attempt(steps(goto, { op: 'click', target: `text:${TEXT}` }, nowhere)); said.push(r);
if (r && new RegExp(`^expected the URL to contain "/nowhere", but clicking 'These 20-year-olds have grown their AI note-taking app for[^']*' : text took the page to "${BASE.replace(/[.]/g, '\\.')}/pricing\\.html", which does not contain it$`).test(r)) ok('a link: took the page to …', r.slice(r.indexOf('took')));
else bad('a link: took the page to …', r ?? 'it passed');

r = await attempt(steps({ op: 'goto', url: `${BASE}/links.html` }, { op: 'click', target: 'link:Pricing via the tracker' }, nowhere)); said.push(r);
if (r && /took the page to "[^"]+\/pricing\.html" through 2 redirects, which does not contain it$/.test(r)) ok('through a tracker: the redirects are counted', '… through 2 redirects');
else bad('through a tracker: the redirects are counted', r ?? 'it passed');

if (said.every((x) => x && !/did not navigate anywhere/.test(x))) ok('and none of them accuses the step before', 'the old suffix is gone');
else bad('and none of them accuses the step before', said.find((x) => !x || /did not navigate anywhere/.test(x)) ?? '');

// ---------------------------------------------------------------------------
console.log('\n— a click that leaves the site is recorded as one ——');
const notes = [];
const recorder = new Recorder(page, { nav, onNote: (msg) => notes.push(msg) });
await recorder.attach();
await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
recorder.start(PAGE, []);
await page.getByRole('link', { name: 'Read it on the other host' }).click();
await sleep(1600);
let recorded = recorder.stop(page.url());
const arrival = recorded.find((s) => s.op === 'expect' && s.assert === 'urlContains');
if (arrival?.value === `${OTHER}/pricing.html`) ok('the arrival names the host it left for', arrival.value);
else bad('the arrival names the host it left for', JSON.stringify(arrival?.value ?? null));
if (notes.includes(`this click leaves ${HOST} for ${OTHER} — the arrival check names the host`)) ok('and says so in the log', notes.find((n) => /leaves/.test(n)));
else bad('and says so in the log', notes.join(' | ') || 'no note');
const text = toFlow({ suite: 'Recorded', steps: recorded });
const back = flatten(parseFlow(text)).steps.find((s) => s.op === 'expect' && s.assert === 'urlContains');
if (arrival && back?.value === arrival.value) ok('the script round-trips it', text.split('\n').find((l) => l.includes(OTHER))?.trim().slice(0, 44));
else bad('the script round-trips it', JSON.stringify(back?.value ?? null));
if (arrival) {
  const pass = await attempt(steps({ op: 'expect', assert: 'urlContains', value: arrival.value, timeout: 800 }));
  if (pass === null) ok('and the check passes on the other host', page.url());
  else bad('and the check passes on the other host', first(pass));
}

await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
notes.length = 0;
recorder.start(PAGE, []);
await page.getByRole('link', { name: 'Read it here' }).click();
await sleep(1200);
recorded = recorder.stop(page.url());
const same = recorded.find((s) => s.op === 'expect' && s.assert === 'urlContains');
if (same?.value === '/pricing.html' && !notes.length) ok('a click on this host records the path alone', same.value);
else bad('a click on this host records the path alone', `${JSON.stringify(same?.value ?? null)}, ${notes.length} note(s)`);

await browser.close();
console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — a wrapped link is pressed on its words, a press that would miss\n' +
    '       says what it would have hit, a URL check says what the press before\n' +
    '       it did, and a click that leaves the site is recorded as one.\n');
process.exit(failures ? 1 : 0);
