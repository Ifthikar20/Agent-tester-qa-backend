/**
 * Defects: numbered, filed by the runner, triaged by people (defects.js).
 *
 *   node scripts/check-defects.js       (starts its own gated runner for the second half)
 *
 * The registry first, fed runs made up here with a clock of their own:
 *
 *   the number      DEF-YYMM-NNN, a counter per month that starts again each
 *                   month and is never handed out twice — not after a
 *                   restart, not after a prune — found however it is typed.
 *   the identity    the same sentence on the same site is one defect, however
 *                   long it waited; on another site it is another.
 *   the lifecycle   the runner's: a failure is filed, a pass of an affected
 *                   case closes it, a failure after that reopens it under the
 *                   same number — each exactly once, however often history is
 *                   folded in, even for two runs inside one millisecond.
 *   the triage      a person's: assignee, severity, known issue or won't-fix,
 *                   all or nothing, with who did it. The facts cannot be
 *                   written, and a pass unparks.
 *
 * Then over HTTP, against a gated runner on a THROWAWAY key like
 * check-tenancy.js: history on disk is numbered on the first read, an admin
 * triages and a member is 403, another organisation is 404, a bad field is a
 * 400 that changes nothing, and run history names each failed run's defect.
 *
 * Throwaway organisations, whose `.ghostclick/<org>/` are removed at the end.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as defects from '../defects.js';
import { stateDir } from '../org.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN = 60_000;
const DAY = 86_400_000;

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(62)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(62)} ${d}`); };
const threw = (fn) => { try { fn(); return null; } catch (err) { return err; } };

const ORG = 'check-defects';
const HTTP_ORG = 'check-defects-http';
const OTHER_ORG = 'check-defects-other';
const cleanup = () => { for (const org of [ORG, HTTP_ORG, OTHER_ORG]) rmSync(stateDir(org), { recursive: true, force: true }); };

/**
 * A run the way runs.js records one. Without `target` it is a run recorded
 * before runs named the step that failed, which history still holds.
 */
function run(at, { pass = false, error = null, step = null, target, suite = 'Shop', suiteId = 'su-shop', caseId = 'cs-a', caseName = 'Checkout', url = 'https://shop.example/cart' } = {}) {
  return {
    at, suite: caseName ? `${suite} · ${caseName}` : suite, suiteId, caseId, caseName, url, ms: 10,
    total: 5, passed: pass ? 5 : 2, failed: pass ? 0 : 1, ok: pass,
    error: pass ? null : error, step: pass ? null : step,
    ...(target === undefined ? {} : { target: pass ? null : target }),
  };
}

const TEXAS = '"option:Texas" never became visible — and it did not turn up in the 10.5s this waited, so waiting longer will not help.';
const CART = 'expected the URL to contain "/cart", but it is "https://shop.example/"';
const THANKS = 'Nothing on the page says "Thank you"';
const STAGING = 'https://staging.shop.example/cart';
const SEPT = Date.UTC(2026, 8, 10, 12, 0, 0);
const OCT = Date.UTC(2026, 9, 2, 9, 0, 0);
const PERSON = { sub: 'sub-monica', email: 'monica@shop.example' };

cleanup();

// ---------------------------------------------------------------------------
console.log('\n— the number ——————————————————————————————————————————————————');

if (defects.monthOf(SEPT) === '2609' && defects.formatId('2609', 7) === 'DEF-2609-007' && defects.formatId('2609', 1234) === 'DEF-2609-1234') ok('DEF-YYMM-NNN, and wider past 999 rather than cut short', 'DEF-2609-007 · DEF-2609-1234');
else bad('DEF-YYMM-NNN, and wider past 999 rather than cut short', `${defects.monthOf(SEPT)} ${defects.formatId('2609', 7)}`);
const spellings = ['DEF-2609-007', 'def-2609-7', '2609-007', '#2609-7', '2609007', ' def 2609 07 '];
const read = spellings.map((s) => defects.canonicalId(s));
if (read.every((id) => id === 'DEF-2609-007')) ok('every way of typing a number reads as that number', `${spellings.length} spellings`);
else bad('every way of typing a number reads as that number', JSON.stringify(read));
const junk = ['DEF-2613-001', 'DEF-2609-000', 'DEF-2609', 'checkout', '26-09-7', '', null];
if (junk.every((s) => defects.canonicalId(s) === null)) ok('and nothing else reads as one', 'month 13, number 0, a word, nothing');
else bad('and nothing else reads as one', JSON.stringify(junk.map((s) => defects.canonicalId(s))));

// ---------------------------------------------------------------------------
console.log('\n— filed by the runner ————————————————————————————————————————');

const history = [
  run(SEPT, { error: TEXAS, step: 3 }),
  run(SEPT + MIN, { error: TEXAS.replace('10.5s', '10.4s'), step: 3, caseId: 'cs-b', caseName: 'Pay' }),
  run(SEPT + 2 * MIN, { error: CART, step: 1, caseId: 'cs-c', caseName: 'Search' }),
  run(SEPT + 3 * MIN, { error: TEXAS, step: 3, url: STAGING }),
  run(OCT, { error: THANKS, step: 0, caseId: 'cs-d', caseName: 'Receipt' }),
];
let reg = defects.open(ORG);
let changes = reg.sync(history);
const byId = () => Object.fromEntries(reg.list().map((d) => [d.id, d]));

const filed = changes.filter((c) => c.kind === 'filed').map((c) => c.id);
if (JSON.stringify(filed) === JSON.stringify(['DEF-2609-001', 'DEF-2609-002', 'DEF-2609-003', 'DEF-2610-001'])) ok('four distinct failures, four numbers, October from 001 again', filed.join(' '));
else bad('four distinct failures, four numbers, October from 001 again', JSON.stringify(changes));

let all = byId();
const texas = all['DEF-2609-001'];
if (texas && texas.hits === 2 && texas.cases.length === 2 && texas.title.includes('10.4s')) ok('running out at 10.4s is the same defect as at 10.5s', '2 hits, 2 cases, newest wording');
else bad('running out at 10.4s is the same defect as at 10.5s', JSON.stringify(texas));
if (all['DEF-2609-003']?.origin === 'https://staging.shop.example') ok('the same sentence on another site is another defect', all['DEF-2609-003'].origin);
else bad('the same sentence on another site is another defect', JSON.stringify(all['DEF-2609-003']));
const filing = reg.get('DEF-2609-001').activity[0];
if (texas?.reporter === 'ghostclick' && filing?.kind === 'filed' && filing.by === null) ok('the reporter is the application', `"${filing.text}"`);
else bad('the reporter is the application', JSON.stringify(filing));

const sev = Object.fromEntries(Object.values(all).map((d) => [d.id, d.severity]));
if (sev['DEF-2610-001'] === 'critical' && sev['DEF-2609-001'] === 'major' && sev['DEF-2609-002'] === 'minor') ok('severity is worked out: first step critical, two cases major', 'one case, mid-flow, minor');
else bad('severity is worked out: first step critical, two cases major', JSON.stringify(sev));

if (reg.sync(history).length === 0 && byId()['DEF-2609-001'].hits === 2) ok('folding the same history again changes nothing', 'a run is folded once');
else bad('folding the same history again changes nothing', JSON.stringify(byId()['DEF-2609-001']));

// Two cases can finish inside one millisecond, and the second must still count.
history.push(run(OCT, { error: CART, step: 1, caseId: 'cs-e', caseName: 'Filter' }));
changes = reg.sync(history);
const cart = byId()['DEF-2609-002'];
if (changes.length === 0 && cart.hits === 2 && cart.cases.length === 2) ok('a run in the same millisecond as the last one folded counts', 'no skip, no double count');
else bad('a run in the same millisecond as the last one folded counts', JSON.stringify({ changes, cart }));

// ---------------------------------------------------------------------------
console.log('\n— one sentence about different steps ————————————————————————');

// Playwright says the same thing of every wait that runs out, so the step is
// what tells a missing receipt from a missing price — and a defect filed from
// runs recorded before runs named their step is taken over, not filed twice.
const ORG_STEPS = 'check-defects-steps';
rmSync(stateDir(ORG_STEPS), { recursive: true, force: true });
const steps = defects.open(ORG_STEPS);
const TIMEOUT = 'locator.waitFor: Timeout 8000ms exceeded.';
const THANKS_STEP = "see 'Thank you for your order'";
const PRICE_STEP = "see 'Enterprise pricing'";
const stepHistory = [
  run(SEPT, { error: TIMEOUT, step: 2, caseId: 'cs-r', caseName: 'Receipt' }),
  run(SEPT + MIN, { error: TIMEOUT, step: 2, caseId: 'cs-r', caseName: 'Receipt', target: THANKS_STEP }),
  run(SEPT + 2 * MIN, { error: TIMEOUT.replace('8000ms', '5000ms'), step: 2, caseId: 'cs-c', caseName: 'Coupon', target: THANKS_STEP }),
  run(SEPT + 3 * MIN, { error: TIMEOUT, step: 2, caseId: 'cs-p', caseName: 'Pricing', target: PRICE_STEP }),
];
const stepFiled = steps.sync(stepHistory).filter((c) => c.kind === 'filed').map((c) => c.id);
const byStep = Object.fromEntries(steps.list().map((d) => [d.id, d]));
if (JSON.stringify(stepFiled) === JSON.stringify(['DEF-2609-001', 'DEF-2609-002'])
    && byStep['DEF-2609-001']?.target === THANKS_STEP && byStep['DEF-2609-001'].cases.length === 2
    && byStep['DEF-2609-002']?.target === PRICE_STEP && byStep['DEF-2609-002'].cases.length === 1) ok('the same timeout on two steps is two defects, on one step one', 'Receipt + Coupon · Pricing');
else bad('the same timeout on two steps is two defects, on one step one', JSON.stringify(steps.list().map((d) => [d.id, d.target, d.cases.length])));
const adopted = byStep['DEF-2609-001'];
const adoptedRuns = steps.runsOf('DEF-2609-001', stepHistory).length;
if (adopted?.hits === 3 && adoptedRuns === 3 && steps.idFor(stepHistory[0]) === 'DEF-2609-001') ok('a defect filed before runs named their step keeps its number', 'and the runs it was filed from');
else bad('a defect filed before runs named their step keeps its number', `${adopted?.hits} hits, ${adoptedRuns} runs, ${steps.idFor(stepHistory[0])}`);
rmSync(stateDir(ORG_STEPS), { recursive: true, force: true });

// ---------------------------------------------------------------------------
console.log('\n— closed and reopened by the runner ——————————————————————————');

history.push(run(OCT + MIN, { pass: true, caseId: 'cs-c', caseName: 'Search' }));
changes = reg.sync(history);
if (changes.some((c) => c.kind === 'closed' && c.id === 'DEF-2609-002') && byId()['DEF-2609-002'].status === 'closed') ok('an affected case passing closes the defect', 'Search passed');
else bad('an affected case passing closes the defect', JSON.stringify(changes));

const parkClosed = threw(() => reg.triage('DEF-2609-002', { resolution: 'wont_fix' }, PERSON));
if (parkClosed?.name === 'BadTriage') ok('a closed defect cannot be parked', parkClosed.message);
else bad('a closed defect cannot be parked', String(parkClosed));

history.push(run(OCT + 2 * MIN, { error: CART, step: 1, caseId: 'cs-c', caseName: 'Search' }));
changes = reg.sync(history);
all = byId();
if (changes.some((c) => c.kind === 'reopened' && c.id === 'DEF-2609-002') && all['DEF-2609-002'].status === 'reopened' && all['DEF-2609-002'].reopened === 1) ok('failing again reopens it under the same number', 'DEF-2609-002, reopened once');
else bad('failing again reopens it under the same number', JSON.stringify(changes));

// ---------------------------------------------------------------------------
console.log('\n— triaged by people ——————————————————————————————————————————');

const before = JSON.stringify(reg.get('DEF-2609-001'));
const e1 = threw(() => reg.triage('DEF-2609-001', { severity: 'blocker' }, PERSON));
const e2 = threw(() => reg.triage('DEF-2609-001', { title: 'Fixed it', hits: 0 }, PERSON));
const e3 = threw(() => reg.triage('DEF-2609-001', { severity: 'critical', assignee: { email: 'not an address' } }, PERSON));
if ([e1, e2, e3].every((e) => e?.name === 'BadTriage') && JSON.stringify(reg.get('DEF-2609-001')) === before) ok('a bad severity, a fact, or one bad field of two writes nothing', `"${e2.message.slice(0, 34)}…"`);
else bad('a bad severity, a fact, or one bad field of two writes nothing', [e1, e2, e3].map(String).join(' | '));
const e4 = threw(() => reg.triage('DEF-2601-999', { severity: 'minor' }, PERSON));
if (e4?.name === 'NoSuchDefect') ok('a number nobody was given is no defect', e4.message);
else bad('a number nobody was given is no defect', String(e4));

let t = reg.triage('2609-1', { severity: 'trivial', assignee: { id: 7, email: 'monica@shop.example', name: 'Monica' } }, PERSON);
if (t.id === 'DEF-2609-001' && t.severity === 'trivial' && t.severityBy === 'person' && t.autoSeverity === 'major'
    && t.assignee?.id === '7' && t.activity.slice(-2).every((e) => e.by?.email === PERSON.email)) ok('a person overrules the severity and assigns it, and it says who', 'trivial over major · Monica');
else bad('a person overrules the severity and assigns it, and it says who', JSON.stringify(t));
t = reg.triage('DEF-2609-001', { severity: null }, PERSON);
if (t.severity === 'major' && t.severityBy === 'ghostclick') ok('null gives the severity back to the runner', 'major again');
else bad('null gives the severity back to the runner', JSON.stringify(t));

t = reg.triage('DEF-2609-003', { resolution: 'wont_fix' }, PERSON);
if (t.status === 'wont_fix') ok("a person parks a failing defect as won't fix");
else bad("a person parks a failing defect as won't fix", JSON.stringify(t));
history.push(run(OCT + 3 * MIN, { pass: true, url: STAGING }));
reg.sync(history);
const unparked = reg.get('DEF-2609-003');
if (unparked.status === 'closed' && /no longer won't fix/.test(unparked.activity.at(-1)?.text)) ok('a pass closes a parked defect, and unparks it', `"${unparked.activity.at(-1).text}"`);
else bad('a pass closes a parked defect, and unparks it', JSON.stringify(unparked.activity.at(-1)));
history.push(run(OCT + 4 * MIN, { error: TEXAS, step: 3, url: STAGING }));
reg.sync(history);
const back = byId()['DEF-2609-003'];
if (back.status === 'reopened' && back.severity === 'major') ok('so coming back is reopened, not hidden — and a regression is major', `${back.status} · ${back.severity}`);
else bad('so coming back is reopened, not hidden — and a regression is major', JSON.stringify(back));

// ---------------------------------------------------------------------------
console.log('\n— kept ———————————————————————————————————————————————————————————');

const restarted = defects.open(ORG);
if (JSON.stringify(restarted.list()) === JSON.stringify(reg.list()) && restarted.sync(history).length === 0) ok('a restart reads back every number, fact and triage', `${restarted.list().length} defects, nothing folded twice`);
else bad('a restart reads back every number, fact and triage', `${restarted.list().length} vs ${reg.list().length}`);
reg = restarted;

history.push(run(OCT + 5 * MIN, { error: 'The basket is empty', step: 2, caseId: 'cs-f', caseName: 'Basket' }));
const basket = reg.sync(history).find((c) => c.kind === 'filed');
if (basket?.id === 'DEF-2610-002') ok('and carries on counting from where it was', basket.id);
else bad('and carries on counting from where it was', JSON.stringify(basket));

history.push(run(OCT + 6 * MIN, { pass: true, caseId: 'cs-f', caseName: 'Basket' }));
reg.sync(history);
const dropped = reg.prune(7, OCT + 30 * DAY);
const kept = reg.list();
if (dropped === 2 && kept.length === 3 && !kept.some((d) => d.status === 'closed')) ok('retention forgets closed defects, never open ones', `${dropped} closed forgotten, ${kept.length} open kept`);
else bad('retention forgets closed defects, never open ones', `${dropped} dropped · ${kept.map((d) => `${d.id}:${d.status}`).join(' ')}`);
history.push(run(OCT + 20 * DAY, { error: 'The receipt has no total', step: 4, caseId: 'cs-g', caseName: 'Totals' }));
const totals = reg.sync(history).find((c) => c.kind === 'filed');
if (totals?.id === 'DEF-2610-003') ok('and a forgotten number is never handed out again', `${totals.id}, not DEF-2610-002`);
else bad('and a forgotten number is never handed out again', JSON.stringify(totals));

// ---------------------------------------------------------------------------
console.log('\n— over HTTP, on a gated runner ———————————————————————————————————');

const pair = generateKeyPairSync('ed25519');
const PUBLIC_PEM = pair.publicKey.export({ type: 'spki', format: 'pem' });
const x = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url');
const KID = createHash('sha256').update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x })).digest('base64url');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const nowS = () => Math.floor(Date.now() / 1000);
const TEAM = { 'suites.max': 25, 'runs.per_day': 500, 'origins.max': 20, 'vault.enabled': true, 'history.retention_days': 90 };

/** A token for `org`, made the way check-tenancy.js makes them; override what a case needs. */
function tokenFor(org, over = {}) {
  const claims = {
    iss: 'ghostclick-control', aud: 'ghostclick-runner', sub: `sub-${org}`, email: `qa@${org}.example`,
    org, role: 'admin', plan: 'team', amr: ['password', 'otp'], auth_time: nowS(), su: nowS() + 600,
    ent: TEAM, ent_v: 1, sid: `sid-${org}`, iat: nowS(), exp: nowS() + 600, jti: `j-${Math.random()}`, ...over,
  };
  const input = `${b64({ alg: 'EdDSA', typ: 'JWT', kid: KID })}.${b64(claims)}`;
  return `${input}.${cryptoSign(null, Buffer.from(input), pair.privateKey).toString('base64url')}`;
}

const PORT = Number(process.env.GC_DEFECTS_PORT) || 8313;
const BASE = `http://127.0.0.1:${PORT}`;
const seededAt = Date.now() - 5 * MIN;
const FIRST = `DEF-${defects.monthOf(seededAt)}-001`;
mkdirSync(stateDir(HTTP_ORG), { recursive: true });
writeFileSync(join(stateDir(HTTP_ORG), 'runs.json'), JSON.stringify({ runs: [
  run(seededAt, { error: TEXAS, step: 3 }),
  run(seededAt + 1, { error: CART, step: 1, caseId: 'cs-c', caseName: 'Search' }),
  run(seededAt + 2, { pass: true, caseId: 'cs-z', caseName: 'Browse' }),
] }));

// server.js, not scripts/start.js, for the reason check-tenancy.js gives.
const child = spawn(process.execPath, [join(ROOT, 'server.js')], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env, PORT: String(PORT), HOME_URL: '',
    GC_AUTH_PUBLIC_KEYS: JSON.stringify({ [KID]: PUBLIC_PEM }), GC_WEB_ORIGIN: BASE,
    GC_API_RATE: '100000/m', GC_AUTH_FAIL_RATE: '100000/m',
  },
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });

const call = async (tok, path, { method = 'GET', body } = {}) => {
  const r = await fetch(`${BASE}${path}`, {
    method, headers: { authorization: `Bearer ${tok}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const ADMIN = tokenFor(HTTP_ORG);
const MEMBER = tokenFor(HTTP_ORG, { role: 'member', sub: 'sub-member', email: 'member@shop.example' });
const STRANGER = tokenFor(OTHER_ORG);

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    // Any answer will do: these routes need the gate, not the browser.
    up = await fetch(`${BASE}/healthz`).then(() => true).catch(() => false);
    if (!up) await wait(500);
  }
  if (!up) throw new Error(`no answer on ${PORT}\n${out.trim().split('\n').slice(-6).join('\n')}`);

  const listed = await call(ADMIN, '/api/defects');
  const ids = (listed.body.defects ?? []).map((d) => d.id).sort();
  if (listed.status === 200 && ids.length === 2 && ids[0] === FIRST && listed.body.totals?.open === 2
      && existsSync(join(stateDir(HTTP_ORG), 'defects.json'))) ok('history on disk is numbered on the first read', ids.join(' '));
  else bad('history on disk is numbered on the first read', JSON.stringify(listed).slice(0, 160));

  const loose = FIRST.toLowerCase().replace(/-0+(\d)$/, '-$1');
  const one = await call(ADMIN, `/api/defects/${loose}`);
  if (one.status === 200 && one.body.defect?.id === FIRST && one.body.runs?.length === 1 && one.body.defect.activity?.[0]?.kind === 'filed') ok('one defect by a loose spelling, with its runs and activity', `${loose} → ${FIRST}`);
  else bad('one defect by a loose spelling, with its runs and activity', JSON.stringify(one).slice(0, 160));

  const asMember = await call(MEMBER, `/api/defects/${FIRST}`, { method: 'PATCH', body: { severity: 'critical' } });
  const memberRead = await call(MEMBER, `/api/defects/${FIRST}`);
  if (asMember.status === 403 && asMember.body.error === 'forbidden' && memberRead.status === 200 && memberRead.body.defect.severityBy === 'ghostclick') ok('a member reads but cannot triage', '403 forbidden, nothing changed');
  else bad('a member reads but cannot triage', `${asMember.status} ${memberRead.status} ${memberRead.body.defect?.severityBy}`);

  const triaged = await call(ADMIN, `/api/defects/${FIRST}`, { method: 'PATCH', body: { severity: 'critical', resolution: 'known_issue', assignee: { id: 'u-7', email: 'monica@shop.example', name: 'Monica' } } });
  const d = triaged.body.defect;
  if (triaged.status === 200 && d?.status === 'known_issue' && d.severity === 'critical' && d.assignee?.name === 'Monica'
      && d.activity.slice(-3).every((e) => e.by?.email === `qa@${HTTP_ORG}.example`)) ok('an admin triages, and the token says who', `${d.status} · ${d.severity} · ${d.assignee.name}`);
  else bad('an admin triages, and the token says who', JSON.stringify(triaged).slice(0, 200));

  const badSeverity = await call(ADMIN, `/api/defects/${FIRST}`, { method: 'PATCH', body: { severity: 'blocker' } });
  const badFact = await call(ADMIN, `/api/defects/${FIRST}`, { method: 'PATCH', body: { hits: 0 } });
  const after = (await call(ADMIN, `/api/defects/${FIRST}`)).body.defect;
  if (badSeverity.status === 400 && badFact.status === 400 && after?.severity === 'critical' && after.hits === 1) ok('a bad severity or a fact is a 400 that changes nothing', `"${badFact.body.error?.slice(0, 30)}…"`);
  else bad('a bad severity or a fact is a 400 that changes nothing', `${badSeverity.status} ${badFact.status} ${JSON.stringify(after)?.slice(0, 80)}`);

  const theirs = await call(STRANGER, `/api/defects/${FIRST}`);
  const theirPatch = await call(STRANGER, `/api/defects/${FIRST}`, { method: 'PATCH', body: { severity: 'minor' } });
  const theirList = await call(STRANGER, '/api/defects');
  if (theirs.status === 404 && theirPatch.status === 404 && theirList.body.defects?.length === 0) ok('another organisation has no such defect', '404, 404, and an empty list');
  else bad('another organisation has no such defect', `${theirs.status} ${theirPatch.status} ${theirList.body.defects?.length}`);

  const nobody = await call(ADMIN, '/api/defects/DEF-2601-999');
  if (nobody.status === 404) ok('a number nobody was given is a 404', nobody.body.error);
  else bad('a number nobody was given is a 404', String(nobody.status));

  const latest = (await call(ADMIN, '/api/runs')).body.latest ?? [];
  const failed = latest.filter((r) => !r.ok);
  if (failed.length === 2 && failed.every((r) => /^DEF-\d{4}-\d{3,}$/.test(r.defect ?? '')) && latest.filter((r) => r.ok).every((r) => r.defect === null)) ok("run history names each failed run's defect", failed.map((r) => r.defect).join(' '));
  else bad("run history names each failed run's defect", JSON.stringify(latest.map((r) => r.defect)));
  const fromHistory = (await call(ADMIN, `/api/defects/${FIRST}`)).body.runs ?? [];
  if (fromHistory.length === 1 && fromHistory.every((r) => !('defect' in r))) ok('without writing the number onto the run itself', 'history stays a record of runs');
  else bad('without writing the number onto the run itself', JSON.stringify(fromHistory));
} finally {
  // The whole tree on Windows: the runner's Chromium outlives a plain kill there.
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill();
  cleanup();
}

console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — every distinct failure gets a number no other defect will ever have; the\n' +
    '       runner files, closes and reopens it exactly once; people triage only what\n' +
    '       is theirs; and the routes keep it to the organisation and its admins.\n');
process.exit(failures ? 1 : 0);
