/**
 * The suite layer, end to end, against a running server.
 *
 *   npm start &
 *   node scripts/check-suites.js
 *
 * What this is actually protecting:
 *
 *  - A suite fixes ONE origin. If adding a page could point somewhere else,
 *    the origin decision made at creation would be worth nothing.
 *  - Nothing unrunnable is ever stored. A suite whose cases only fail when you
 *    run them is a suite nobody trusts.
 *  - The gate holds for the two endpoints that touch the browser, and answers
 *    with something the UI can act on rather than an error it has to parse.
 *  - Run history is scoped by suite, so a suite page and the dashboard are the
 *    same view over different slices.
 *  - `expect text` asks whether the text is visible ANYWHERE, not whether the
 *    first node in DOM order happens to be visible. A hidden <label> that
 *    sorts first used to time out an assertion about text plainly on screen.
 */
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ID = 'check-suites-tmp';

let failures = 0;
const pad = (s, n) => String(s).padEnd(n);

function ok(label, detail = '') {
  console.log(`  ✓  ${pad(label, 46)} ${detail}`);
}
function bad(label, detail) {
  failures++;
  console.log(`  ✕  ${pad(label, 46)} ${detail}`);
}

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** Assert the call is refused, and that the reason says why. */
async function refuses(label, path, opts, expect) {
  const r = await call(path, opts);
  if (r.status < 400) return bad(label, `accepted it (${r.status})`);
  if (expect && !expect.test(r.body.error ?? '')) return bad(label, `wrong reason: ${r.body.error}`);
  ok(label, r.body.error?.slice(0, 60) ?? '');
}

// --------------------------------------------------------------------------
console.log('\n— the suite model ————————————————————————————————');

await call(`/api/suites/${ID}`, { method: 'DELETE' });          // from a previous run

await refuses('rejects a suite with no name', '/api/suites',
  { method: 'POST', body: { name: '', baseUrl: BASE } }, /required/i);
await refuses('rejects a non-http base', '/api/suites',
  { method: 'POST', body: { name: 'X', baseUrl: 'file:///etc/passwd' } }, /http/i);

const made = await call('/api/suites', { method: 'POST', body: { name: 'Check suites tmp', baseUrl: BASE } });
if (!made.body.ok) { console.error(`  could not create the suite: ${made.body.error}`); process.exit(1); }
const id = made.body.suite.id;
ok('creates a suite', id);

await refuses('a page cannot leave the origin', `/api/suites/${id}/pages`,
  { method: 'POST', body: { name: 'Away', path: 'https://evil.example.com/x' } }, /leaves|one origin/i);
await refuses('an expectation must be a known kind', `/api/suites/${id}/pages`,
  { method: 'POST', body: { name: 'P', path: '/', expect: [{ kind: 'eval', value: 'fetch(1)' }] } }, /unknown expectation/i);

const pg = (await call(`/api/suites/${id}/pages`,
  { method: 'POST', body: { name: 'Shop', path: '/shop.html' } })).body.page;
ok('adds a page', pg.path);

// --------------------------------------------------------------------------
console.log('\n— what makes an unseen page scriptable ———————————');

const scan = await call(`/api/suites/${id}/pages/${pg.id}/scan`, { method: 'POST' });
if (!scan.body.ok) bad('scans the page', scan.body.error);
else ok('scans the page', scan.body.page.targets.map((t) => t.target).join(' · '));

const names = new Set((scan.body.page?.targets ?? []).map((t) => t.name));
if (names.has('Search') && names.has('Cart')) ok('discovery found what is on it');
else bad('discovery found what is on it', [...names].join(', ') || 'nothing');

await call(`/api/suites/${id}/pages/${pg.id}`, {
  method: 'PATCH',
  // "Search" is the regression: on this page it is a hidden <label>, a visible
  // <button> and a visible <p>, and the label sorts first.
  body: { expect: [{ kind: 'url', value: '/shop.html' }, { kind: 'text', value: 'Search' }] },
});
ok('stores the expectations');

// --------------------------------------------------------------------------
console.log('\n— nothing unrunnable is stored ————————————————————');

await refuses('rejects an unreadable case', `/api/suites/${id}/cases`,
  { method: 'POST', body: { name: 'x', flow: `flowchart TD\n a(("${BASE}/")) -->|clik 'Go' : button| b` } },
  /unreadable/i);
await refuses('rejects a case with no entry node', `/api/suites/${id}/cases`,
  { method: 'POST', body: { name: 'x', flow: 'flowchart TD\n a["x"] --> b\n b --> a' } }, /entry/i);
await refuses('rejects a case that leaves the allowlist', `/api/suites/${id}/cases`,
  { method: 'POST', body: { name: 'x', flow: 'flowchart TD\n a(("https://evil.example.com/"))' } },
  /not allow/i);
await refuses('rejects a raw-selector target', `/api/suites/${id}/cases`,
  { method: 'POST', body: { name: 'x', flow: `flowchart TD\n a(("${BASE}/")) -->|click 'x' : css| b` } },
  /unknown target strategy|bad target/i);

const check = (await call(`/api/suites/${id}/pages/${pg.id}/check`)).body.flow;
const added = await call(`/api/suites/${id}/cases`,
  { method: 'POST', body: { name: 'Shop loads', pageId: pg.id, flow: check } });
if (added.body.ok) ok('turns expectations into a case', `${added.body.case.steps} steps`);
else bad('turns expectations into a case', added.body.error);

// --------------------------------------------------------------------------
console.log('\n— running it ——————————————————————————————————————');

const run = await call(`/api/suites/${id}/run`, { method: 'POST' });
if (!run.body.ok) bad('runs the suite', run.body.error);
else if (run.body.passed === run.body.total) ok('runs the suite', `${run.body.passed}/${run.body.total} cases passed`);
else bad('runs the suite', run.body.outcomes.filter((o) => !o.ok).map((o) => `${o.name}: ${o.error}`).join('; '));

const hist = (await call(`/api/runs?suite=${id}`)).body;
if (hist.totals.runs >= 1) ok('history is scoped to the suite', `${hist.totals.runs} run(s)`);
else bad('history is scoped to the suite', 'no runs recorded');

const all = (await call('/api/runs')).body;
if (all.totals.runs >= hist.totals.runs) ok('the unscoped view is a superset', `${all.totals.runs} in total`);
else bad('the unscoped view is a superset', `${all.totals.runs} < ${hist.totals.runs}`);

// --------------------------------------------------------------------------
console.log('\n— one URL in, a running test out ——————————————————');

const qs = await call('/api/suites/quickstart', { method: 'POST', body: { url: `${BASE}/shop.html` } });
if (!qs.body.ok) bad('quickstart builds and runs a suite', qs.body.error);
else if (!qs.body.run.ok) bad('quickstart builds and runs a suite', qs.body.run.error);
else ok('quickstart builds and runs a suite',
        `"${qs.body.suite.name}" — ${qs.body.targets} targets, ${qs.body.run.passed}/${qs.body.run.total} steps`);

const qid = qs.body.suite?.id;
const qpage = qs.body.suite?.pages?.[0];
if (qpage?.expect.length === 1 && qpage.expect[0].kind === 'url') {
  ok('it asserts only the URL', 'text expectations stay a human choice');
} else bad('it asserts only the URL', JSON.stringify(qpage?.expect));

if (qpage?.linked?.length) ok('it offers the pages the app links to', qpage.linked.map((l) => l.path).join(' · '));
else bad('it offers the pages the app links to', 'no links found');

if ((qpage?.linked ?? []).every((l) => l.path.startsWith('/'))) ok('link suggestions stay on the origin');
else bad('link suggestions stay on the origin', JSON.stringify(qpage.linked));

await refuses('quickstart refuses an unallowed origin', '/api/suites/quickstart',
  { method: 'POST', body: { url: 'https://not-allowed.example.com/' } }, /not allow/i);

if (qid) await call(`/api/suites/${qid}`, { method: 'DELETE' });

// --------------------------------------------------------------------------
console.log('\n— the gate ————————————————————————————————————————');

const walled = await call('/api/suites', { method: 'POST', body: { name: 'Check suites walled', baseUrl: 'https://not-allowed.example.com' } });
const wid = walled.body.suite.id;
const wpg = (await call(`/api/suites/${wid}/pages`, { method: 'POST', body: { name: 'Home', path: '/' } })).body.page;

const gated = await call(`/api/suites/${wid}/pages/${wpg.id}/scan`, { method: 'POST' });
if (gated.status === 409 && gated.body.needsOrigin === 'https://not-allowed.example.com') {
  ok('scan refuses an unallowed origin', 'and names the one it needs');
} else bad('scan refuses an unallowed origin', `${gated.status} ${JSON.stringify(gated.body)}`);

const gatedRun = await call(`/api/suites/${wid}/run`, { method: 'POST' });
if (gatedRun.status === 409 && gatedRun.body.needsOrigin) ok('run refuses an unallowed origin');
else bad('run refuses an unallowed origin', `${gatedRun.status}`);

if ((await call('/api/state')).body.origins.includes('https://not-allowed.example.com')) {
  bad('creating a suite does not allow its origin', 'it was allowed');
} else ok('creating a suite does not allow its origin');

await call(`/api/suites/${wid}`, { method: 'DELETE' });
await call(`/api/suites/${id}`, { method: 'DELETE' });
const gone = await call(`/api/suites/${id}`);
if (gone.status === 404) ok('deletes cleanly'); else bad('deletes cleanly', `${gone.status}`);

console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — a suite fixes one origin, stores nothing unrunnable, and the gate\n' +
    '       holds for both endpoints that touch the browser.\n');
process.exit(failures ? 1 : 0);
