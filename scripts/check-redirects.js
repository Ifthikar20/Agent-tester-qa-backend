/**
 * Where a click actually took you, and what it went through on the way.
 *
 *   npm start &
 *   node scripts/check-redirects.js
 *
 * Against public/links.html, whose four links all "work" and are each wrong in
 * a different way — none of it visible from the final URL, which is all a
 * recording used to keep:
 *
 *   /pricing.html   200, straight there
 *   /go/tracked     302 → 302 → 200, detouring through a tracker
 *   /go/moved       301 → 302 → 200, moved twice
 *   /go/gone        404, behind a perfectly friendly page
 *
 * That last one is the point. `expect url contains "/go/gone"` passes on it.
 */
import { chromium } from 'playwright';
import { Recorder } from '../recorder.js';
import { NavigationLog } from '../navlog.js';
import { OPS, validate } from '../ops.js';
import { VirtualCursor, sleep } from '../cursor.js';
import { parseFlow, flatten, toFlow } from '../flow.js';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const PAGE = `${BASE}/links.html`;

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
const nav = new NavigationLog(page);
nav.attach();
const ctx = { cursor, emit: () => {}, nav, onNavigate: async () => {} };

// ---------------------------------------------------------------------------
console.log('\n— what the chain looks like ——————————————————————');

const CASES = [
  ['/pricing.html', 200, 0],
  ['/go/tracked',   200, 2],
  ['/go/moved',     200, 2],
  ['/go/gone',      404, 0],
];
for (const [path, status, hops] of CASES) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await sleep(300);
  const n = nav.summary();
  if (n.status === status && n.redirects === hops) {
    ok(`${path}`, `${status}, ${hops} redirect${hops === 1 ? '' : 's'}${hops ? ` — ${n.hops.map((h) => h.status).join(' → ')}` : ''}`);
  } else bad(`${path}`, `got ${n.status} with ${n.redirects} redirects`);
}

// ---------------------------------------------------------------------------
console.log('\n— the assertions ——————————————————————————————————');

const run = async (flow) => {
  const plan = validate(flatten(parseFlow(flow)));
  for (const step of plan.steps) await OPS[step.op](page, step, ctx);
  await sleep(400);      // let the last navigation settle before the next flow
};
const fails = async (flow) => {
  try { await run(flow); return null; } catch (e) { return e.message.split('\n')[0]; }
};

const F = (clauses, target = 'Pricing via the tracker') =>
  `%% suite "x"\nflowchart TD\n  a(("${PAGE}"))\n  a -->|click '${target}' : link; ${clauses}| a`;

if (!(await fails(F("check status 200; check 2 redirects; check redirect via '/go/r'")))) {
  ok('the tracker detour is describable', '200, two hops, through /go/r');
} else bad('the tracker detour is describable', await fails(F("check status 200; check 2 redirects")));

const wrongCount = await fails(F('check no redirect'));
if (wrongCount && /got 2/.test(wrongCount)) ok('and a wrong hop count fails', wrongCount.slice(0, 46));
else bad('and a wrong hop count fails', wrongCount ?? 'it passed');

const wrongVia = await fails(F("check redirect via '/checkout'"));
if (wrongVia && /never passed through/.test(wrongVia)) ok('and a route it never took fails', wrongVia.slice(0, 46));
else bad('and a route it never took fails', wrongVia ?? 'it passed');

// The one a URL assertion cannot catch.
const rotted = `%% suite "x"\nflowchart TD\n  a(("${PAGE}"))\n  b["/go/gone"]\n  a -->|click 'A link that rotted' : link| b`;
if (!(await fails(rotted))) ok('a 404 still satisfies the URL assertion', 'which is exactly the problem');
else bad('a 404 still satisfies the URL assertion', 'the URL check failed for another reason');

const caught = await fails(F('check status 200', 'A link that rotted'));
if (caught && /expected HTTP 200, got 404/.test(caught)) ok('and the status assertion catches it', caught.slice(0, 46));
else bad('and the status assertion catches it', caught ?? 'it passed');

// ---------------------------------------------------------------------------
console.log('\n— recording keeps it ——————————————————————————————');

const recorder = new Recorder(page, { nav });
await recorder.attach();
await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
recorder.start(PAGE, []);
await page.getByRole('link', { name: 'Pricing, moved twice' }).click();
await sleep(1600);
const steps = recorder.stop(page.url());

const click = steps.find((s) => s.op === 'click');
if (click?.via?.length === 3) ok('a click records the chain it caused', click.via.map((h) => h.status).join(' → '));
else bad('a click records the chain it caused', JSON.stringify(click?.via ?? null));

const flow = toFlow({ suite: 'Recorded', steps });
if (/%% via \d+ 301 .* -> 302 .* -> 200 /.test(flow)) {
  ok('and writes it into the script as evidence', flow.split('\n').find((l) => l.startsWith('%% via'))?.slice(0, 44));
} else bad('and writes it into the script as evidence', 'no %% via comment');

if (flow.includes('check status') || flow.includes('check redirect')) {
  bad('without inventing an assertion', 'it added one nobody asked for');
} else ok('without inventing an assertion', 'what to assert is your decision');

await browser.close();
console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — every hop is captured with its status, a friendly 404 is caught\n' +
    '       by the status assertion the URL one cannot, and a recorded click\n' +
    '       carries the chain it caused.\n');
process.exit(failures ? 1 : 0);
