/**
 * The browser pool, on a real browser.
 *
 *   node scripts/check-pool.js
 *
 * Proves the primitive that lifts the one-org-at-a-time ceiling (pool.js): many
 * organisations, each in its own isolated context, driving at once; a capacity
 * that holds; and idle leases that free their own slot. Needs a browser — the
 * same chromium the runner uses — but no server.
 */
import { chromium } from 'playwright';
import { BrowserPool, PoolFull } from '../pool.js';

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(52)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✗  ${l.padEnd(52)} ${d}`); };

const PAGE = 'data:text/html,<title>pool</title><body>ok</body>';

const browser = await chromium.launch();
try {
  console.log('\n— concurrency + isolation ————————————————');
  const pool = new BrowserPool(browser, { max: 3, idleMs: 60_000, grace: 30_000 });

  // Three organisations acquire AT ONCE — the thing the singleton cannot do.
  const [a, b, c] = await Promise.all([pool.acquire('org-a'), pool.acquire('org-b'), pool.acquire('org-c')]);
  (a.context !== b.context && b.context !== c.context && a.context !== c.context)
    ? ok('three orgs, three distinct contexts', `active ${pool.active}/${pool.capacity}`)
    : bad('three orgs, three distinct contexts');

  // And drive them in parallel.
  await Promise.all([a.page.goto(PAGE), b.page.goto(PAGE), c.page.goto(PAGE)]);
  ok('all three drive concurrently', 'pages navigated in parallel');

  // Isolation: a cookie set for org A is invisible to org B.
  await a.context.addCookies([{ name: 'sess', value: 'A-only', url: 'https://example.com' }]);
  const leaked = await b.context.cookies('https://example.com');
  leaked.length === 0 ? ok('contexts are isolated', "A's cookie is not in B") : bad('contexts are isolated', JSON.stringify(leaked));

  // Re-acquiring an org returns its SAME lease, not a second context.
  (await pool.acquire('org-a')).context === a.context
    ? ok('re-acquiring an org reuses its lease') : bad('re-acquiring an org reuses its lease');

  console.log('\n— capacity ————————————————————————');
  // Full, and every lease warm (just touched): a fourth org is refused, not
  // silently starved — the caller turns PoolFull into "busy, try again".
  try { await pool.acquire('org-d'); bad('a full pool refuses a new org'); }
  catch (e) { e instanceof PoolFull ? ok('a full pool refuses a new org', 'PoolFull') : bad('a full pool refuses a new org', e.message); }

  // Releasing frees the slot for the next org.
  await pool.release('org-c');
  const d = await pool.acquire('org-d');
  (d && pool.active === 3) ? ok('releasing frees the slot for the next org', `active ${pool.active}/3`) : bad('releasing frees the slot');

  console.log('\n— idle leases free themselves ————————————');
  // A lease left untouched past idleMs closes on its own.
  const idle = new BrowserPool(browser, { max: 2, idleMs: 300, grace: 0 });
  await idle.acquire('quiet-org');
  await new Promise((r) => setTimeout(r, 700));
  idle.active === 0 ? ok('an idle lease closes itself', 'gone after idleMs') : bad('an idle lease closes itself', `active ${idle.active}`);

  // And a full pool evicts an idle lease to admit a new org.
  const room = new BrowserPool(browser, { max: 1, idleMs: 60_000, grace: 5_000 });
  const first = await room.acquire('first');
  first.lastUsed -= 10_000;                    // pretend it has been idle past grace
  const second = await room.acquire('second'); // must evict 'first' to fit
  (second && !room.has('first') && room.has('second'))
    ? ok('a full pool evicts an idle lease to admit a new org') : bad('a full pool evicts an idle lease');

  await Promise.all([pool.drain(), idle.drain(), room.drain()]);
} finally {
  await browser.close();
}

console.log(failures
  ? `\n  ${failures} failed\n`
  : '\n  OK — many orgs, isolated and concurrent, within a capacity that holds and frees.\n');
process.exit(failures ? 1 : 0);
