/**
 * One runner, many organisations (docs/AUTH.md §10, the runner half).
 *
 *   node scripts/check-tenancy.js       (starts its own gated runner; no npm start needed)
 *
 * Three things, and every one of them is a way to see or drive somebody
 * else's browser if it is wrong.
 *
 *   the partition   every store is keyed by the organisation in the token: a
 *                   suite of Acme's is a 404 for Globex — read, patch and
 *                   delete — and the old flat files land under `local`, where
 *                   no token reaches them.
 *   the plan        the numbers in the token are enforced by the runner and
 *                   not by the UI: the fourth suite on `free` is a 402 to a
 *                   bare fetch, the third origin too, a plan without the vault
 *                   cannot resolve a `$KEY`, a run past `runs.per_day` never
 *                   touches the browser, history past `retention_days` is
 *                   gone, a member cannot allow an origin, and a token older
 *                   than the plan is refused.
 *   the driver      one Chromium, one driving organisation: frames, the URL
 *                   and the targets reach that organisation's sockets and no
 *                   other; anyone else is 409 runner_busy on every path to the
 *                   browser; the lock lets go after the run when the driver
 *                   goes quiet, and tells the room; sign-out in one tab ends
 *                   the session's other sockets.
 *
 * Tokens are signed with a THROWAWAY key generated here, like check-auth.js:
 * the runner must have no way to mint its own credentials. The lock's idle
 * window is set short through GC_RUNNER_IDLE_MS so the release can be watched
 * without waiting a minute for it.
 */
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { verify, parseKeys } from '../auth.js';
import { Driver, EntitlementError, entitlements, manages, migrate, noteVersion, stale, forgetVersions, orgOf } from '../tenancy.js';
import { isOrg, LOCAL } from '../org.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(54)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(54)} ${d}`); };
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

// ---------------------------------------------------------------------------
// The throwaway keypair, and the organisations this check signs for.
const pair = generateKeyPairSync('ed25519');
const PUBLIC_PEM = pair.publicKey.export({ type: 'spki', format: 'pem' });
const kidOf = (publicKey) => {
  const x = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url');
  return createHash('sha256').update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x })).digest('base64url');
};
const KID = kidOf(pair.publicKey);
const KEYS = parseKeys(JSON.stringify({ [KID]: PUBLIC_PEM }));

const nowS = () => Math.floor(Date.now() / 1000);
const TEAM = { 'suites.max': 25, 'runs.per_day': 500, 'origins.max': 20, 'vault.enabled': true, 'history.retention_days': 90 };
const FREE = { 'suites.max': 3, 'runs.per_day': 20, 'origins.max': 2, 'vault.enabled': false, 'history.retention_days': 7 };
const ORGS = ['check-acme', 'check-globex', 'check-zero', 'check-stale'];

/** A token for `org`; override what a case needs. */
function tokenFor(org, over = {}) {
  const claims = {
    iss: 'ghostclick-control', aud: 'ghostclick-runner', sub: `sub-${org}`, email: `qa@${org}.example`,
    org, role: 'admin', plan: 'team', amr: ['password', 'otp'], auth_time: nowS(), su: nowS() + 600,
    ent: TEAM, ent_v: 7, sid: `sid-${org}`, iat: nowS(), exp: nowS() + 600, jti: `j-${Math.random()}`, ...over,
  };
  const input = `${b64({ alg: 'EdDSA', typ: 'JWT', kid: KID })}.${b64(claims)}`;
  return `${input}.${cryptoSign(null, Buffer.from(input), pair.privateKey).toString('base64url')}`;
}

// ---------------------------------------------------------------------------
console.log('\n— the organisation, as a directory name ————————————————');

for (const good of ['acme', 'ada-2', 'a', 'local', 'x'.repeat(63)]) if (!isOrg(good)) bad('slugs are accepted', good);
for (const evil of ['../local', 'Acme', 'a b', '', '.', '..', 'a/b', 'a\\b', '-a', 'x'.repeat(64), null, 42]) {
  if (isOrg(evil)) bad('a non-slug is refused', JSON.stringify(evil));
}
ok('a slug is a directory name and nothing else is', '5 accepted, 11 refused');
try { verify(tokenFor('../local'), KEYS); bad('a signed token whose org is not a slug is refused', 'accepted'); }
catch (err) { if (err.name === 'AuthError' && /slug/.test(err.message)) ok('a signed token whose org is not a slug is refused', err.message); else bad('a signed token whose org is not a slug is refused', err.message); }
if (orgOf(null) === LOCAL && orgOf({ org: 'acme' }) === 'acme') ok('no claims is the local organisation');
else bad('no claims is the local organisation');

// ---------------------------------------------------------------------------
console.log('\n— the migration, on a scratch tree ————————————————————');

const scratch = mkdtempSync(join(tmpdir(), 'gc-tenancy-'));
mkdirSync(join(scratch, '.ghostclick'), { recursive: true });
mkdirSync(join(scratch, 'suites'), { recursive: true });
writeFileSync(join(scratch, '.ghostclick', 'origins.json'), '{"origins":["https://old.example"]}');
writeFileSync(join(scratch, '.ghostclick', 'runs.json'), '{"runs":[]}');
writeFileSync(join(scratch, 'suites', 'old.json'), '{"id":"old"}');
mkdirSync(join(scratch, 'suites', 'check-acme'));
writeFileSync(join(scratch, 'suites', 'check-acme', 'theirs.json'), '{"id":"theirs"}');
const { moved, failed } = migrate(scratch);
const after = [
  existsSync(join(scratch, '.ghostclick', LOCAL, 'origins.json')),
  existsSync(join(scratch, '.ghostclick', LOCAL, 'runs.json')),
  existsSync(join(scratch, 'suites', LOCAL, 'old.json')),
  !existsSync(join(scratch, '.ghostclick', 'origins.json')),
  !existsSync(join(scratch, 'suites', 'old.json')),
  existsSync(join(scratch, 'suites', 'check-acme', 'theirs.json')),
];
if (after.every(Boolean) && moved.length === 3 && failed.length === 0) ok('flat state and suites move under local, once', moved.length + ' moves');
else bad('flat state and suites move under local, once', JSON.stringify({ after, moved, failed }));
if (migrate(scratch).moved.length === 0) ok('and a second boot moves nothing');
else bad('and a second boot moves nothing');
writeFileSync(join(scratch, 'suites', 'old.json'), '{"id":"old-again"}');
if (migrate(scratch).moved.length === 0 && existsSync(join(scratch, 'suites', 'old.json'))) ok('a file whose destination exists is left where it is', 'never overwritten');
else bad('a file whose destination exists is left where it is');
/**
 * A move that cannot happen must not stop the runner.
 *
 * migrate() runs at module scope in server.js, so a throw here is a runner
 * that refuses to boot on a checkout it used to serve fine — a read-only bind
 * mount, a repository owned by another user. The failure is reported and the
 * banner says so; nothing is lost, because nothing was moved.
 */
const locked = mkdtempSync(join(tmpdir(), 'gc-tenancy-ro-'));
mkdirSync(join(locked, '.ghostclick'), { recursive: true });
writeFileSync(join(locked, '.ghostclick', 'origins.json'), '{"origins":[]}');
// A file where the destination DIRECTORY has to be is a write this cannot do,
// on every platform — which is the point, since chmod is a no-op on Windows.
writeFileSync(join(locked, '.ghostclick', LOCAL), 'not a directory');
try {
  const ro = migrate(locked);
  if (ro.moved.length === 0 && ro.failed.length === 1) ok('a move it cannot make is reported, not thrown', ro.failed[0]);
  else bad('a move it cannot make is reported, not thrown', JSON.stringify(ro));
} catch (err) {
  bad('a move it cannot make is reported, not thrown', `it threw ${err.code ?? err.message}`);
}
rmSync(locked, { recursive: true, force: true });
rmSync(scratch, { recursive: true, force: true });

// ---------------------------------------------------------------------------
console.log('\n— the lock, with a clock of its own ———————————————————');

let clock = 1000;
let runs = false;
const d = new Driver({ idleMs: 100, now: () => clock, isRunning: () => runs });
if (d.holder() === null && !d.sees('a') && d.describe('a').mine === false) ok('nobody drives until someone opens a page');
else bad('nobody drives until someone opens a page');
d.claim('a');
try { d.claim('b'); bad('a second organisation is refused while the first is active'); }
catch (err) { if (err.name === 'RunnerBusy' && err.org === 'a') ok('a second organisation is refused while the first is active', `busy: ${err.org}`); else bad('a second organisation is refused while the first is active', err.message); }
if (d.claim('a') === false) ok('the driver may claim again, and nothing changes hands');
else bad('the driver may claim again, and nothing changes hands');
clock += 150;
runs = true;
try { d.claim('b'); bad('a run holds the lock past the idle window'); } catch { ok('a run holds the lock past the idle window'); }
runs = false;
if (d.holder() === null && d.sees('a') && d.describe('b').held === false) ok('after the run and a quiet minute the lock lapses, and the page is still theirs');
else bad('after the run and a quiet minute the lock lapses, and the page is still theirs', JSON.stringify(d.describe('b')));
clock += 10; d.touch('b');
if (d.holder() === null) ok('an outsider touching it holds nothing');
else bad('an outsider touching it holds nothing');
if (d.claim('b') === true && d.sees('b') && !d.sees('a') && d.holder() === 'b') ok('then another organisation takes it, and the first no longer sees the page');
else bad('then another organisation takes it, and the first no longer sees the page');
if (d.lapsesIn() === 100) ok('and says when it will let go', `${d.lapsesIn()}ms`);
else bad('and says when it will let go', String(d.lapsesIn()));

// ---------------------------------------------------------------------------
console.log('\n— the plan, read from the claims alone ————————————————');

const off = entitlements(null);
if (off.limit('suites.max') === null && off.enabled('vault.enabled') && off.plan === null) ok('no claims is unlimited and has the vault', 'the laptop');
else bad('no claims is unlimited and has the vault');
const free = entitlements({ ent: FREE, plan: 'free' });
try { free.check('suites.max', 2); ok('within the limit passes'); } catch (err) { bad('within the limit passes', err.message); }
try { free.check('suites.max', 3); bad('at the limit is refused'); }
catch (err) { if (err instanceof EntitlementError && err.limit === 'suites.max' && err.plan === 'free') ok('at the limit is refused, naming limit and plan', err.message); else bad('at the limit is refused, naming limit and plan', err.message); }
try { free.check('runs.per_day', 18, 3); bad('a batch that would cross the limit is refused'); } catch { ok('a batch that would cross the limit is refused', '18 used, 3 wanted, 20 allowed'); }
try { free.demand('vault.enabled'); bad('a switch that is off is refused'); } catch (err) { if (err.limit === 'vault.enabled') ok('a switch that is off is refused'); else bad('a switch that is off is refused', err.message); }
const sparse = entitlements({ ent: {}, plan: 'odd' });
if (sparse.limit('suites.max') === null && !sparse.enabled('vault.enabled')) ok('a count the token omits is unlimited; a switch it omits is off');
else bad('a count the token omits is unlimited; a switch it omits is off');
const stringy = entitlements({ ent: { 'suites.max': '3', 'vault.enabled': 'true' } });
if (stringy.limit('suites.max') === null && !stringy.enabled('vault.enabled')) ok('a string is not a number and not true', 'no comparison against "3"');
else bad('a string is not a number and not true');
if (manages(null) && manages({ role: 'owner' }) && manages({ role: 'admin' }) && !manages({ role: 'member' }) && !manages({ role: 'god' })) ok('owners and admins manage; members and strangers do not');
else bad('owners and admins manage; members and strangers do not');

forgetVersions();
noteVersion({ org: 'v-org', ent_v: 3 });
noteVersion({ org: 'v-org', ent_v: 5 });
try { noteVersion({ org: 'v-org', ent_v: 4 }); bad('a token older than the plan is refused once a newer one was seen'); }
catch (err) { if (err.name === 'StaleEntitlements') ok('a token older than the plan is refused once a newer one was seen', 'saw 5, got 4'); else bad('a token older than the plan is refused once a newer one was seen', err.message); }
if (stale({ org: 'v-org', ent_v: 4 }) && !stale({ org: 'v-org', ent_v: 5 }) && !stale({ org: 'other', ent_v: 1 }) && !stale(null)) ok('and a socket bound to the old claims knows it is stale', 'per organisation');
else bad('and a socket bound to the old claims knows it is stale');
forgetVersions();

// ---------------------------------------------------------------------------
console.log('\n— a gated runner, two organisations ———————————————————');

const PORT = Number(process.env.GC_TENANCY_PORT) || 3406;
const BASE = `http://127.0.0.1:${PORT}`;
const IDLE_MS = 3000;

// Nothing of a previous run may survive into this one; the same rm runs at the end.
const cleanup = () => {
  for (const org of ORGS) {
    rmSync(join(ROOT, '.ghostclick', org), { recursive: true, force: true });
    rmSync(join(ROOT, 'suites', org), { recursive: true, force: true });
  }
};
cleanup();
// History from ten days ago for one organisation whose plan keeps seven.
mkdirSync(join(ROOT, '.ghostclick', 'check-stale'), { recursive: true });
writeFileSync(join(ROOT, '.ghostclick', 'check-stale', 'runs.json'), JSON.stringify({ runs: [
  { at: Date.now() - 10 * 86_400_000, suite: 'Old', suiteId: null, caseId: null, caseName: null, url: 'https://old.example/', ms: 1, total: 1, passed: 1, failed: 0, ok: true, error: null, step: null },
  { at: Date.now() - 1000, suite: 'New', suiteId: null, caseId: null, caseName: null, url: 'https://new.example/', ms: 1, total: 1, passed: 1, failed: 0, ok: true, error: null, step: null },
] }));

const child = spawn(process.execPath, [join(ROOT, 'scripts/start.js')], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env, PORT: String(PORT), GC_SKIP_BUILD: '1', HOME_URL: '',
    GC_AUTH_PUBLIC_KEYS: JSON.stringify({ [KID]: PUBLIC_PEM }), GC_WEB_ORIGIN: BASE,
    // A laptop with a login: the bundled pages on this port are what there is
    // to drive, so the private-address block is off and the fixtures are on.
    GC_DEMO: '1', GC_BLOCK_PRIVATE: '0', GC_RUNNER_IDLE_MS: String(IDLE_MS),
  },
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });

const A = tokenFor('check-acme');
const B = tokenFor('check-globex', { role: 'owner', plan: 'free', ent: FREE, sub: 'sub-globex' });
const call = async (tok, path, { method = 'GET', body } = {}) => {
  const r = await fetch(`${BASE}${path}`, {
    method, headers: { authorization: `Bearer ${tok}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const ticketFor = async (tok) => (await call(tok, '/api/socket-ticket', { method: 'POST' })).body.ticket;
/** Open a socket for a token and collect everything it receives. */
async function socketFor(tok) {
  const ticket = await ticketFor(tok);
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?ticket=${ticket}`, { origin: BASE });
  // Frame SIZES as well as the count, because "a frame arrived" and "a
  // picture of somebody's page arrived" are different claims: a freshly
  // reset context is on about:blank, whose JPEG is a few hundred bytes of
  // white, while a rendered page is tens of kilobytes.
  const got = { events: [], frames: 0, bytes: [], closed: null };
  ws.on('message', (d, bin) => {
    if (bin) { got.frames++; got.bytes.push(d.length); }
    else { try { got.events.push(JSON.parse(d)); } catch { /* ignore */ } }
  });
  ws.on('close', (code) => { got.closed = code; });
  await new Promise((res) => { ws.on('open', res); ws.on('error', res); setTimeout(res, 8000); });
  // The greeting arrives right after the open.
  await wait(300);
  return { ws, got, send: (m) => ws.send(JSON.stringify(m)),
           reset: () => { got.events.length = 0; got.frames = 0; got.bytes.length = 0; } };
}
/** Wait until `pred` finds an event, or give up. */
const until = async (got, pred, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const hit = got.events.find(pred); if (hit) return hit; await wait(100); }
  return null;
};
const isEnt = (r, limit, plan) => r.status === 402 && r.body.error === 'entitlement' && r.body.limit === limit && r.body.plan === plan;

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    up = await fetch(`${BASE}/app/`).then((r) => r.ok).catch(() => false);
    if (!up) await wait(500);
  }
  if (!up) throw new Error(`no answer on ${PORT}\n${out.trim().split('\n').slice(-6).join('\n')}`);
  if (/tenancy *-> *state is kept per organisation/.test(out)) ok('the banner says state is per organisation');
  else bad('the banner says state is per organisation', (out.split('\n').find((l) => l.includes('tenancy')) ?? '(no line)').trim());

  // -- the partition --------------------------------------------------------
  const made = await call(A, '/api/suites', { method: 'POST', body: { name: 'Check tenancy A', baseUrl: 'https://a.example' } });
  const sid = made.body.suite?.id;
  if (made.status === 200 && sid && existsSync(join(ROOT, 'suites', 'check-acme', `${sid}.json`))) ok('a suite lands in suites/<org>/', `suites/check-acme/${sid}.json`);
  else bad('a suite lands in suites/<org>/', JSON.stringify(made));
  const theirs = await call(B, `/api/suites/${sid}`);
  const patched = await call(B, `/api/suites/${sid}`, { method: 'PATCH', body: { name: 'Stolen' } });
  const deleted = await call(B, `/api/suites/${sid}`, { method: 'DELETE' });
  if (theirs.status === 404 && patched.status === 404 && deleted.status === 404) ok('another organisation cannot read, patch or delete it', '404, 404, 404 — never a 403');
  else bad('another organisation cannot read, patch or delete it', `${theirs.status} ${patched.status} ${deleted.status}`);
  const still = await call(A, `/api/suites/${sid}`);
  if (still.status === 200 && still.body.suite.name === 'Check tenancy A') ok('and it is untouched for its owner');
  else bad('and it is untouched for its owner', JSON.stringify(still.body).slice(0, 80));
  const bList = (await call(B, '/api/suites')).body.suites ?? [];
  if (!bList.some((s) => s.id === sid)) ok('nor listed for anyone else');
  else bad('nor listed for anyone else');
  const bCases = (await call(B, `/api/suites/${sid}/cases`, { method: 'POST', body: { name: 'x', flow: 'goto https://a.example/' } })).status;
  if (bCases === 404) ok('a case cannot be added to it from outside', '404 from the nested route too, never a 403');
  else bad('a case cannot be added to it from outside', String(bCases));
  /**
   * The id reaches the filesystem as a path, so it is validated as a slug or
   * it is "no suite" — never stripped down to something else and then unlinked
   * raw. Sanitising in the reader and trusting the caller in the writer let
   * `a/../../local/<id>` read one file and delete another organisation's.
   */
  const decoy = await call(B, '/api/suites', { method: 'POST', body: { name: 'alocalcheck traversal victim', baseUrl: 'https://b.example' } });
  const victim = join(ROOT, 'suites', LOCAL, 'check-traversal-victim.json');
  mkdirSync(join(ROOT, 'suites', LOCAL), { recursive: true });
  writeFileSync(victim, '{"id":"check-traversal-victim","name":"Victim","pages":[],"cases":[]}');
  const traversal = await call(B, `/api/suites/${encodeURIComponent('a/../../local/check-traversal-victim')}`, { method: 'DELETE' });
  if (traversal.status === 404 && existsSync(victim)) ok('a suite id that is not a slug deletes nothing', `404, and suites/${LOCAL}/ is untouched`);
  else bad('a suite id that is not a slug deletes nothing', `${traversal.status}, victim ${existsSync(victim) ? 'survived' : 'WAS DELETED'}`);
  rmSync(victim, { force: true });
  if (decoy.body.suite?.id) await call(B, `/api/suites/${decoy.body.suite.id}`, { method: 'DELETE' });

  // -- the plan -------------------------------------------------------------
  const codes = [];
  // The first on this runner's own origin, so the run and scan refusals
  // further down can get past the origin gate to the lock.
  for (let i = 1; i <= 4; i++) codes.push((await call(B, '/api/suites', { method: 'POST', body: { name: `Check free ${i}`, baseUrl: i === 1 ? BASE : `https://b${i}.example` } })));
  if (codes.slice(0, 3).every((r) => r.status === 200) && isEnt(codes[3], 'suites.max', 'free')) ok('the fourth suite on free is 402 — to a bare fetch', JSON.stringify(codes[3].body));
  else bad('the fourth suite on free is 402 — to a bare fetch', codes.map((r) => r.status).join(' '));
  const qs = await call(B, '/api/suites/quickstart', { method: 'POST', body: { url: `${BASE}/demo.html` } });
  if (isEnt(qs, 'suites.max', 'free')) ok('and so is a quickstart, before the browser is touched');
  else bad('and so is a quickstart, before the browser is touched', JSON.stringify(qs));
  const state0 = (await call(B, '/api/state')).body;
  if (state0.usage?.suites?.used === 3 && state0.usage.suites.max === 3 && state0.plan === 'free' && state0.org === 'check-globex') ok('/api/state reports the usage the refusal was made from', JSON.stringify(state0.usage.suites));
  else bad('/api/state reports the usage the refusal was made from', JSON.stringify(state0.usage));

  // In demo mode every organisation starts with the runner's own origin
  // seeded (origins.js), and the seed counts: one more is the second, and
  // the one after that is the third.
  const o1 = await call(B, '/api/origins', { method: 'POST', body: { origin: BASE } });
  const o2 = await call(B, '/api/origins', { method: 'POST', body: { origin: 'https://b3.example' } });
  if (o1.status === 200 && isEnt(o2, 'origins.max', 'free')) ok('the third origin on free is 402', JSON.stringify(o2.body));
  else bad('the third origin on free is 402', `${o1.status} ${o2.status}`);
  const aOrigins = (await call(A, '/api/origins')).body.origins ?? [];
  if (!aOrigins.includes(BASE)) ok('an origin allowed by one organisation is not allowed for another');
  else bad('an origin allowed by one organisation is not allowed for another', aOrigins.join(' '));

  const M = tokenFor('check-acme', { role: 'member', sub: 'sub-member' });
  const asMember = await call(M, '/api/origins', { method: 'POST', body: { origin: 'https://m.example' } });
  const asMemberDel = await call(M, '/api/origins', { method: 'DELETE', body: { origin: 'https://a.example' } });
  if (asMember.status === 403 && asMember.body.error === 'forbidden' && asMemberDel.status === 403) ok('a member cannot allow or remove an origin', '403 forbidden');
  else bad('a member cannot allow or remove an origin', `${asMember.status} ${asMemberDel.status}`);
  const asMemberSuite = await call(M, '/api/suites', { method: 'POST', body: { name: 'By a member', baseUrl: 'https://a.example' } });
  if (asMemberSuite.status === 200) ok('but may make a suite', 'members run and view');
  else bad('but may make a suite', String(asMemberSuite.status));

  // runs.per_day: a plan that allows no runs today never reaches the browser.
  const Z = tokenFor('check-zero', { ent: { ...TEAM, 'runs.per_day': 0 }, plan: 'trial', sub: 'sub-zero' });
  await call(Z, '/api/origins', { method: 'POST', body: { origin: BASE } });
  const zs = (await call(Z, '/api/suites', { method: 'POST', body: { name: 'Zero', baseUrl: BASE } })).body.suite;
  const flowTo = (url, path) => `testcase TD\n  a(("${url}"))\n  b["${path}"]\n  a --> b`;
  const zCase = await call(Z, `/api/suites/${zs.id}/cases`, { method: 'POST', body: { name: 'load', flow: flowTo(`${BASE}/demo.html`, '/demo.html') } });
  if (zCase.status !== 200) bad('a case can be added for the run refusal', JSON.stringify(zCase.body));
  const zRun = await call(Z, `/api/suites/${zs.id}/run`, { method: 'POST' });
  if (isEnt(zRun, 'runs.per_day', 'trial')) ok('a run past runs.per_day is 402', JSON.stringify(zRun.body));
  else bad('a run past runs.per_day is 402', JSON.stringify(zRun));
  const zq = await call(Z, '/api/suites/quickstart', { method: 'POST', body: { url: `${BASE}/demo.html` } });
  if (isEnt(zq, 'runs.per_day', 'trial')) ok('and so is a quickstart');
  else bad('and so is a quickstart', JSON.stringify(zq));

  // history.retention_days: what the plan keeps is what the page shows.
  const S = tokenFor('check-stale', { ent: { ...FREE, 'history.retention_days': 7 }, plan: 'free', sub: 'sub-stale' });
  const kept = (await call(S, '/api/runs')).body;
  if (kept.totals?.runs === 1 && kept.latest?.[0]?.suite === 'New') ok('history older than retention_days is pruned', 'ten-day-old run gone, yesterday’s kept');
  else bad('history older than retention_days is pruned', JSON.stringify(kept.totals));

  // -- the driver -----------------------------------------------------------
  await call(A, '/api/origins', { method: 'POST', body: { origin: BASE } });
  const a = await socketFor(A);
  const b = await socketFor(B);
  const aReady = a.got.events.find((e) => e.t === 'ready');
  const bReady = b.got.events.find((e) => e.t === 'ready');
  if (aReady && bReady && !('secrets' in aReady) && !('secrets' in bReady)) ok('the greeting never carries vault names');
  else bad('the greeting never carries vault names', JSON.stringify({ aReady, bReady }));
  if (bReady?.url === null && bReady.driving?.mine === false && bReady.driving.org === null && bReady.origins?.includes(BASE) && !bReady.origins.includes('https://a.example')) ok('and carries the URL only for the driver, and the organisation’s own origins');
  else bad('and carries the URL only for the driver, and the organisation’s own origins', JSON.stringify(bReady));
  const names = (await call(B, '/api/state')).body.secrets;
  if (Array.isArray(names)) ok('vault names come from /api/state under the token', names.join(', ') || '(none)');
  else bad('vault names come from /api/state under the token');

  a.reset(); b.reset();
  a.send({ t: 'open', url: `${BASE}/demo.html` });
  const aUrl = await until(a.got, (e) => e.t === 'url' || e.t === 'targets');
  await wait(1500);
  if (aUrl && a.got.frames > 0) ok('the driver receives frames, the URL and the targets', `${a.got.frames} frames`);
  else bad('the driver receives frames, the URL and the targets', `url=${JSON.stringify(aUrl)} frames=${a.got.frames}`);
  const bLeak = b.got.events.filter((e) => ['url', 'targets', 'nav', 'console', 'log'].includes(e.t));
  if (b.got.frames === 0 && bLeak.length === 0) ok('and the other organisation receives nothing of it', '0 frames, 0 page events');
  else bad('and the other organisation receives nothing of it', `${b.got.frames} frames, ${bLeak.map((e) => e.t).join(' ')}`);
  const bDriving = b.got.events.find((e) => e.t === 'driving');
  if (bDriving && bDriving.org === 'check-acme' && bDriving.held === true && bDriving.mine === false) ok('it is told who is driving instead', JSON.stringify(bDriving));
  else bad('it is told who is driving instead', JSON.stringify(bDriving));

  b.reset();
  b.send({ t: 'frame.request' });
  await wait(800);
  if (b.got.frames === 0) ok('a frame.request from the other organisation gets no frame');
  else bad('a frame.request from the other organisation gets no frame', `${b.got.frames} frames`);
  b.send({ t: 'open', url: `${BASE}/shop.html` });
  const bRefused = await until(b.got, (e) => e.t === 'refused' && e.of === 'open');
  if (bRefused?.error === 'runner_busy' && bRefused.org === 'check-acme') ok('open over the socket is refused runner_busy', JSON.stringify(bRefused));
  else bad('open over the socket is refused runner_busy', JSON.stringify(bRefused));
  b.send({ t: 'record.start' });
  const bRec = await until(b.got, (e) => e.t === 'refused' && e.of === 'record.start');
  if (bRec?.error === 'runner_busy') ok('and so is record.start');
  else bad('and so is record.start', JSON.stringify(bRec));
  b.send({ t: 'command', text: `goto ${BASE}/shop.html` });
  const bCmd = await until(b.got, (e) => e.t === 'refused' && e.of === 'command');
  if (bCmd?.error === 'runner_busy') ok('and a command');
  else bad('and a command', JSON.stringify(bCmd));
  const bSuite = codes[0].body.suite;
  await call(B, `/api/suites/${bSuite.id}/cases`, { method: 'POST', body: { name: 'load', flow: flowTo(`${BASE}/shop.html`, '/shop.html') } });
  const bRun = await call(B, `/api/suites/${bSuite.id}/run`, { method: 'POST' });
  if (bRun.status === 409 && bRun.body.error === 'runner_busy' && bRun.body.org === 'check-acme') ok('a run over HTTP is 409 runner_busy naming the driver', JSON.stringify(bRun.body));
  else bad('a run over HTTP is 409 runner_busy naming the driver', JSON.stringify(bRun));
  const bScan = await call(B, `/api/suites/${bSuite.id}/pages`, { method: 'POST', body: { name: 'Home', path: '/' } });
  const scanned = await call(B, `/api/suites/${bSuite.id}/pages/${bScan.body.page?.id}/scan`, { method: 'POST' });
  if (scanned.status === 409 && scanned.body.error === 'runner_busy') ok('and so is a scan');
  else bad('and so is a scan', JSON.stringify(scanned));
  const bState = (await call(B, '/api/state')).body;
  if (bState.url === null && bState.driving?.org === 'check-acme' && bState.driving.mine === false) ok('/api/state shows the other organisation no URL', JSON.stringify(bState.driving));
  else bad('/api/state shows the other organisation no URL', JSON.stringify({ url: bState.url, driving: bState.driving }));

  // The extension's hand-off lands in the token's organisation only.
  a.reset(); b.reset();
  const rec = await call(A, '/api/recording', { method: 'POST', body: { flow: `testcase TD\n  a(("${BASE}/demo.html")) --> b["/demo.html"]` } });
  const aImported = await until(a.got, (e) => e.t === 'imported', 3000);
  await wait(300);
  if (rec.status === 200 && aImported && !b.got.events.some((e) => e.t === 'imported')) ok('a recording reaches the token’s organisation and no other', `${aImported.steps} steps`);
  else bad('a recording reaches the token’s organisation and no other', JSON.stringify({ rec: rec.status, aImported, b: b.got.events.map((e) => e.t) }));
  const recB = await call(B, '/api/recording', { method: 'POST', body: { flow: 'testcase TD\n  a(("https://a.example/")) --> b' } });
  if (recB.status === 400) ok('and is checked against that organisation’s allowlist', '400 for an origin only Acme allowed');
  else bad('and is checked against that organisation’s allowlist', String(recB.status));

  // The lock lets go when the driver goes quiet, and the room is told. The
  // driver touches it once more first, so the quiet starts now and not at
  // whatever moment the tests above left it.
  a.send({ t: 'frame.request' });
  await wait(200);
  a.reset(); b.reset();
  const released = await until(b.got, (e) => e.t === 'driving' && e.held === false, IDLE_MS + 4000);
  if (released && released.org === 'check-acme') ok('when the driver goes quiet the lock lapses and the room is told', `after ~${IDLE_MS}ms idle`);
  else bad('when the driver goes quiet the lock lapses and the room is told', JSON.stringify(b.got.events.filter((e) => e.t === 'driving')));
  a.reset(); b.reset();
  b.send({ t: 'open', url: `${BASE}/shop.html` });
  const bUrl = await until(b.got, (e) => e.t === 'url' || e.t === 'targets');
  await wait(1500);
  if (bUrl && b.got.frames > 0) ok('then the other organisation takes the browser and sees its own page', `${b.got.frames} frames`);
  else bad('then the other organisation takes the browser and sees its own page', `url=${JSON.stringify(bUrl)} frames=${b.got.frames}`);
  const aLost = a.got.events.find((e) => e.t === 'driving');
  const aLeak = a.got.events.filter((e) => ['url', 'targets'].includes(e.t));
  if (aLost?.org === 'check-globex' && aLost.mine === false && a.got.frames === 0 && aLeak.length === 0) ok('and the previous driver is told, and sees none of it', JSON.stringify(aLost));
  else bad('and the previous driver is told, and sees none of it', JSON.stringify({ aLost, frames: a.got.frames, leak: aLeak.length }));
  a.send({ t: 'open', url: `${BASE}/demo.html` });
  const aRefused = await until(a.got, (e) => e.t === 'refused' && e.of === 'open');
  if (aRefused?.error === 'runner_busy' && aRefused.org === 'check-globex') ok('and is now the one refused');
  else bad('and is now the one refused', JSON.stringify(aRefused));

  // vault.enabled: a plan without the vault cannot resolve a $KEY, and the
  // refusal is a plan refusal, not a broken page.
  b.reset();
  b.send({ t: 'command', text: `goto ${BASE}/demo.html\nfill textbox:Email with $QA_USER` });
  const vaultRefusal = await until(b.got, (e) => e.t === 'refused' && e.error === 'entitlement', 25000);
  const ended = await until(b.got, (e) => e.t === 'run.end', 25000);
  if (vaultRefusal?.limit === 'vault.enabled' && vaultRefusal.plan === 'free' && ended && ended.ok === false) ok('a plan without the vault cannot resolve a $KEY', JSON.stringify(vaultRefusal));
  else bad('a plan without the vault cannot resolve a $KEY', JSON.stringify({ vaultRefusal, ended }));

  // Now the same lapse the other way, and the assertion this file used to
  // skip: the organisation that takes a lapsed lock must inherit nothing of
  // the page the previous one left open.
  b.send({ t: 'frame.request' });
  await wait(200);
  a.reset(); b.reset();
  const released2 = await until(a.got, (e) => e.t === 'driving' && e.held === false, IDLE_MS + 4000);
  if (released2 && released2.org === 'check-globex') ok('the second driver goes quiet in its turn', `after ~${IDLE_MS}ms idle`);
  else bad('the second driver goes quiet in its turn', JSON.stringify(a.got.events.filter((e) => e.t === 'driving')));
  a.reset(); b.reset();
  /**
   * The direction that actually matters, and the one this file used to skip.
   *
   * The waiting organisation claims the lapsed lock WITHOUT opening anything,
   * so whatever it now sees it inherited. It must see nothing: the browser is
   * reset when the lock changes hands, so there is no frame of the previous
   * driver's page, no URL, no target list, and a socket opened a moment later
   * greets with `url: null`. Testing only the case where the newcomer
   * navigates first proves nothing, because the navigation covers the leak.
   */
  a.send({ t: 'command', text: 'click link:Cart' });
  await wait(2500);
  const inheritedUrl = a.got.events.find((e) => e.t === 'url' && e.url);
  const inheritedTargets = a.got.events.find((e) => e.t === 'targets' && (e.url || (e.items ?? []).length));
  const aTook = a.got.events.find((e) => e.t === 'driving' && e.mine === true);
  const aState1 = (await call(A, '/api/state')).body;
  const fresh = await socketFor(A);
  const greeting = await until(fresh.got, (e) => e.t === 'ready');
  fresh.ws.close();
  if (a.got.frames === 0 && !inheritedUrl && !inheritedTargets && aState1.url === null && greeting?.url === null) {
    ok('the organisation that takes the lapsed lock inherits nothing', 'no frame, no URL, no targets, greeting url null');
  } else {
    bad('the organisation that takes the lapsed lock inherits nothing',
        JSON.stringify({ frames: a.got.frames, bytes: a.got.bytes, url: inheritedUrl?.url, targets: inheritedTargets?.url, state: aState1.url, greeting: greeting?.url }));
  }
  // And a plan that never navigates does not get to run on it either: with no
  // `goto` there is no URL for validate() to check, so the gate would simply
  // not happen for it (docs/AUTH.md §11).
  const strayLog = a.got.events.find((e) => e.t === 'log' && /Nothing is open yet/.test(e.msg ?? ''));
  if (aTook && strayLog) ok('and a plan with no goto is refused rather than run on what was there', strayLog.msg);
  else bad('and a plan with no goto is refused rather than run on what was there', JSON.stringify(a.got.events.map((e) => e.t)));

  // Step-up on the socket, and a member on the socket.
  const staleSu = await socketFor(tokenFor('check-acme', { su: nowS() - 1, sub: 'sub-stale-su' }));
  staleSu.send({ t: 'origin.add', origin: 'https://another.example' });
  const suRefused = await until(staleSu.got, (e) => e.t === 'refused' && e.of === 'origin.add');
  if (suRefused?.error === 'step_up_required') ok('origin.add over the socket needs step-up', 'refused: step_up_required');
  else bad('origin.add over the socket needs step-up', JSON.stringify(suRefused));
  staleSu.ws.close();
  const m = await socketFor(M);
  m.send({ t: 'origin.add', origin: 'https://another.example' });
  const mRefused = await until(m.got, (e) => e.t === 'refused' && e.of === 'origin.add');
  if (mRefused?.error === 'forbidden') ok('and an owner or admin', 'refused: forbidden for a member');
  else bad('and an owner or admin', JSON.stringify(mRefused));
  m.ws.close();

  // sid: goodbye in one tab ends the session's other sockets.
  const a2 = await socketFor(A);
  a2.send({ t: 'bye' });
  await wait(600);
  if (a.got.closed === 4403 && a2.got.closed === 1000) ok('{t:"bye"} ends the session’s other sockets too', `codes ${a2.got.closed}, ${a.got.closed}`);
  else bad('{t:"bye"} ends the session’s other sockets too', `codes ${a2.got.closed}, ${a.got.closed}`);

  // ent_v: a newer plan makes older tokens worthless, and closes their sockets.
  const b2 = await socketFor(B);   // bound to ent_v 7
  const newer = await call(B, '/api/state', {});
  const bumped = await call(tokenFor('check-globex', { role: 'owner', plan: 'free', ent: FREE, ent_v: 8 }), '/api/state');
  const older = await call(B, '/api/state');
  if (newer.status === 200 && bumped.status === 200 && older.status === 401 && older.body.error === 'stale_entitlements') ok('a token older than the plan is 401 stale_entitlements', 'ent_v 7 after 8');
  else bad('a token older than the plan is 401 stale_entitlements', `${newer.status} ${bumped.status} ${older.status} ${older.body.error}`);
  b2.send({ t: 'frame.request' });
  await wait(600);
  if (b2.got.closed === 4401) ok('and a socket bound to the old claims is closed on its next message', `code ${b2.got.closed}`);
  else bad('and a socket bound to the old claims is closed on its next message', String(b2.got.closed));
  b.ws.close();

  // The old flat files went under local, where no token reaches them.
  const localSuites = existsSync(join(ROOT, 'suites', LOCAL)) ? readdirSync(join(ROOT, 'suites', LOCAL)) : [];
  const seenByA = (await call(tokenFor('check-acme', { sub: 'sub-list' }), '/api/suites')).body.suites.map((s) => s.id);
  if (!existsSync(join(ROOT, 'suites', 'treasury-demo.json')) && !seenByA.includes('treasury-demo')) ok('the pre-tenancy suites live under local and are not any organisation’s', `${localSuites.length} under suites/local`);
  else bad('the pre-tenancy suites live under local and are not any organisation’s', seenByA.join(' '));
} catch (err) {
  bad('the runner survived the tenancy checks', [err.message, ...out.trim().split(/\r?\n/).slice(-8)].join(' | '));
} finally {
  child.kill('SIGTERM');
  await wait(300);
  child.kill('SIGKILL');
  cleanup();
}

console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — every store is the organisation’s own, the plan is enforced by\n'
    + '       the runner with a 402 that names limit and plan, and one\n'
    + '       organisation at a time drives the browser while the others are\n'
    + '       told it is busy and shown nothing of its page.\n');
process.exit(failures ? 1 : 0);
