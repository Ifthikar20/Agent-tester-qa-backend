/**
 * Suggested fixes and the heal setting, through a real runner.
 *
 *   node scripts/check-fixes.js       (starts its own gated runner on a free port)
 *
 * check-heal.js proves the rules and the store in-process. This is the part
 * only a running server can show: that the routes answer in the contract's
 * shapes, that the role, the organisation and the operator's switch are
 * enforced where the request lands and not in a page, that a run of a saved
 * case turns a fix into a suggestion and says so on the socket in the right
 * order, and that accepting one writes a case that then runs green on its own.
 *
 * The runner gets GC_HEAL=ai and a key that is not a key: the organisation
 * that runs never opts in, so its runs are safe, and ANTHROPIC_BASE_URL points
 * at a port nothing listens on, so even a mistake here could not reach the
 * network. What it proves about the key is that it is never said back.
 *
 * Tokens are signed with a throwaway key, like check-tenancy.js. The port is
 * checked free first, and never one of the ports a person runs ghostclick on.
 */
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { applyFix, changesCase, SAVED_KINDS, StaleFix } from '../fixes.js';
import { parseFlow, flatten, showAction } from '../flow.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(62)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(62)} ${d}`); };
const check = (l, cond, d = '') => (cond ? ok(l, d) : bad(l, d));
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

// ---------------------------------------------------------------------------
const pair = generateKeyPairSync('ed25519');
const PUBLIC_PEM = pair.publicKey.export({ type: 'spki', format: 'pem' });
const KID = createHash('sha256').update(JSON.stringify({
  crv: 'Ed25519', kty: 'OKP', x: pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url'),
})).digest('base64url');
const nowS = () => Math.floor(Date.now() / 1000);
const TEAM = { 'suites.max': 25, 'runs.per_day': 500, 'origins.max': 20, 'vault.enabled': true, 'history.retention_days': 90 };
const ORGS = ['check-fix-a', 'check-fix-b'];
function tokenFor(org, over = {}) {
  const claims = {
    iss: 'ghostclick-control', aud: 'ghostclick-runner', sub: `sub-${org}`, email: `qa@${org}.example`,
    org, role: 'admin', plan: 'team', amr: ['password', 'otp'], auth_time: nowS(), su: nowS() + 600,
    ent: TEAM, ent_v: 1, sid: `sid-${org}`, iat: nowS(), exp: nowS() + 600, jti: `j-${Math.random()}`, off: [], ...over,
  };
  const input = `${b64({ alg: 'EdDSA', typ: 'JWT', kid: KID })}.${b64(claims)}`;
  return `${input}.${cryptoSign(null, Buffer.from(input), pair.privateKey).toString('base64url')}`;
}

/** Ports a person may be using, whatever is listening on them right now. */
const RESERVED = new Set([3000, 3001, 3100, 3200]);
async function freePort(from) {
  for (let port = from; port < from + 60; port++) {
    if (RESERVED.has(port)) continue;
    // Bound the way app.listen(PORT) binds: every interface.
    const free = await new Promise((res) => {
      const probe = createServer();
      probe.once('error', () => res(false));
      probe.listen(port, () => probe.close(() => res(true)));
    });
    if (free) return port;
  }
  throw new Error(`no free port from ${from}`);
}

const FAKE_KEY = 'sk-ant-check-fixes-not-a-real-key-0123456789';
const cleanup = () => {
  for (const org of ORGS) {
    rmSync(join(ROOT, '.ghostclick', org), { recursive: true, force: true });
    rmSync(join(ROOT, 'suites', org), { recursive: true, force: true });
  }
};

/** A runner child with this check's environment; `out` collects everything it prints. */
function start(port, extra = {}) {
  const env = {
    // HOME_URL is about:blank, not empty. Empty lets the runner reopen the
    // newest run in `.ghostclick/local` — which, in a checkout somebody uses,
    // is a real site: the child then waits on a navigation to it before its
    // socket handler exists, so every socket check below fails, and the check
    // has reached the network. about:blank opens nothing, and it is not an
    // http(s) URL, so the boot's `origins.add(HOME_URL)` refuses it before it
    // writes a word to anybody's allowlist.
    ...process.env, PORT: String(port), HOME_URL: 'about:blank',
    GC_AUTH_PUBLIC_KEYS: JSON.stringify({ [KID]: PUBLIC_PEM }), GC_WEB_ORIGIN: `http://127.0.0.1:${port}`,
    GC_DEMO: '1', GC_BLOCK_PRIVATE: '0', GC_SWITCHES_OFF: '',
    GC_TIMEOUT_MS: '2000', GC_GRACE_MS: '1000', GC_PACE_MS: '0',
    GC_API_RATE: '100000/m', GC_AUTH_FAIL_RATE: '100000/m', GC_TICKET_RATE: '100000/m', GC_WS_CONNECT_RATE: '100000/m',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    ...extra,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const child = spawn(process.execPath, [join(ROOT, 'server.js')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env });
  const run = { child, out: '', exited: null };
  child.stdout.on('data', (d) => { run.out += d; });
  child.stderr.on('data', (d) => { run.out += d; });
  child.on('exit', (code) => { run.exited = code ?? -1; });
  return run;
}
async function stop(run) {
  if (run.exited !== null) return;
  run.child.kill('SIGTERM');
  for (let i = 0; i < 20 && run.exited === null; i++) await wait(150);
  if (run.exited === null) run.child.kill('SIGKILL');
  await wait(300);
}

cleanup();

// ---------------------------------------------------------------------------
console.log('\n— a moved suggestion, written into a case (no runner) ——————————————');

/**
 * `moved` (heal.js LAYOUT_REACH): the element is the one recorded, somewhere
 * else, and accepting says so in the case — its `%% at` line, and nothing
 * else. On a case people recorded, with four positions and an entry mark, so a
 * rewrite that re-drew the others would show.
 */
const stepsOf = (flow) => flatten(parseFlow(flow)).steps;
const atLines = (flow) => new Map(String(flow).split('\n').map((l) => l.trim().match(/^%% at (\d+) (.+)$/))
  .filter(Boolean).map((m) => [Number(m[1]), m[2]]));
const entryMark = (flow) => String(flow).split('\n').map((l) => l.trim()).find((l) => l.startsWith('%% entry')) ?? null;
const thrown = (fn) => { try { fn(); return null; } catch (err) { return err; } };
{
  const recorded = JSON.parse(readFileSync(join(ROOT, 'scripts', 'fixtures', 'heal-corpus', 'cases.json'), 'utf8'))
    .find((c) => c.id === 'signin-settings').flow;
  const before = stepsOf(recorded);
  const moved = {
    kind: 'moved', tier: 'rule', step: 3, op: 'click', from: showAction(before[3]), to: null, insert: null,
    at: { x: 400, y: 420, w: 87, h: 38, vw: 1180, vh: 760 }, note: 'moved', reason: null, confidence: null, saved: false,
  };
  const out = applyFix(recorded, moved);
  const was = atLines(recorded);
  const now = atLines(out.flow);
  check('accepting a moved fix rewrites exactly that step\'s %% at line',
    now.get(3) === '400,420 87x38 in 1180x760' && was.get(3) !== now.get(3) && now.size === was.size && was.size === 4 &&
    [...was].every(([i, v]) => i === 3 || now.get(i) === v) && entryMark(out.flow) === entryMark(recorded) &&
    out.steps === before.length && out.index === 3, `%% at 3 ${was.get(3)} -> ${now.get(3)}`);
  const after = stepsOf(out.flow);
  const without = (s) => JSON.stringify({ ...s, at: undefined });
  check('and every step — the moved one\'s target and op included — is otherwise the same',
    after.length === before.length && after.every((s, i) => without(s) === without(before[i]) &&
      (i === 3 || JSON.stringify(s.at) === JSON.stringify(before[i].at))));

  const edited = recorded.replace("click 'Sign in' : button", "click 'Log on' : button");
  const stale = thrown(() => applyFix(edited, moved));
  const otherOne = thrown(() => applyFix(recorded, { ...moved, occurrence: 1 }));
  check('a case edited since makes it stale, and so does the wrong occurrence',
    stale instanceof StaleFix && otherOne instanceof StaleFix, stale?.why);
  const nowhere = thrown(() => applyFix(recorded, { ...moved, at: { x: 'left' } }));
  check('a moved fix with no usable position changes nothing, and is refused as such',
    nowhere && !(nowhere instanceof StaleFix) && /changes nothing/.test(nowhere.message) &&
    changesCase(moved) && !changesCase({ ...moved, at: null }) && !changesCase({ ...moved, kind: 'waited' }) && SAVED_KINDS.has('moved'));
  const fractional = applyFix(recorded, { ...moved, at: { x: 400.4, y: 419.6, w: 87.2, h: 38, vw: 1180, vh: 760 } });
  check('a position is written in whole numbers, which is all a %% at line can hold',
    atLines(fractional.flow).get(3) === '400,420 87x38 in 1180x760');

  /**
   * A case stored the older way: `flowchart TD`, and the edge's actions
   * chained on one line (suites/local/treasury-demo.json, as recorded).
   * toFlow re-draws that as `testcase TD` with every action on a line of its
   * own — the same steps, so a read-back cannot tell, but a person can. A
   * position is one line, and only that line may change.
   */
  const chart = [
    '%% suite "Recorded flow"',
    'flowchart TD',
    '  n0(("http://localhost:3000/demo.html"))',
    '  n1["/demo.html#/dashboard"]',
    '  n2["/demo.html#/settings"]',
    '',
    "  n0 -->|fill 'Email' : label = 'qa@example.com'; fill 'Password' : label = $QA_PASS; click 'Sign in' : button| n1",
    "  n1 -->|click 'Settings' : link| n2",
    '',
    '%% entry ["link:Settings","textbox:Email","textbox:Password","button:Sign in"]',
    '%% at 1 590,228 560x41 in 1180x760',
    '%% at 2 590,308 560x41 in 1180x760',
    '%% at 3 353,371 87x38 in 1180x760',
    '%% at 5 165,23 57x16 in 1180x760',
    '',
  ].join('\n');
  const chartSteps = stepsOf(chart);
  const signIn = chartSteps.findIndex((s) => s.op === 'click' && s.target === 'button:Sign in');
  const settings = chartSteps.findIndex((s) => s.op === 'click' && s.target === 'link:Settings');
  const chartMove = { ...moved, step: signIn, from: showAction(chartSteps[signIn]) };
  const chartOut = applyFix(chart, chartMove);
  const A = chart.split('\n');
  const B = chartOut.flow.split('\n');
  const changed = A.flatMap((l, k) => (l === B[k] ? [] : [k]));
  check('on a flowchart-format case, accepting it changes that %% at line and not one other byte',
    signIn === 3 && A.length === B.length && changed.length === 1 && A[changed[0]] === '%% at 3 353,371 87x38 in 1180x760' &&
    B[changed[0]] === '%% at 3 400,420 87x38 in 1180x760' && B[1] === 'flowchart TD',
    changed.map((k) => `${A[k]} -> ${B[k]}`).join(' | ') || `${A.length} vs ${B.length} lines`);
  const lostMark = chart.replace('%% at 5 165,23 57x16 in 1180x760\n', '');
  const putBack = applyFix(lostMark, { ...moved, step: settings, from: showAction(chartSteps[settings]),
    at: { x: 165, y: 23, w: 57, h: 16, vw: 1180, vh: 760 } });
  check('a step with no %% at line gets one, after the others, and nothing else moves',
    settings === 5 && putBack.flow === chart, putBack.flow === chart ? '' : putBack.flow.split('\n').slice(-4).join(' | '));
  check('and the older format goes stale exactly as the newer one does',
    thrown(() => applyFix(chart.replace("click 'Sign in' : button", "click 'Log on' : button"), chartMove)) instanceof StaleFix &&
    thrown(() => applyFix(chart, { ...chartMove, occurrence: 1 })) instanceof StaleFix);
}

// ---------------------------------------------------------------------------
console.log('\n— the setting is read strictly at boot ——————————————————————');

let PORT = await freePort(Number(process.env.GC_FIXES_PORT) || 8411);
{
  const refused = start(PORT, { GC_HEAL: 'sometimes' });
  for (let i = 0; i < 60 && refused.exited === null; i++) await wait(250);
  check('an unknown GC_HEAL stops the runner, naming the variable',
    refused.exited === 1 && /GC_HEAL is "sometimes", which is not a mode/.test(refused.out),
    refused.out.trim().split('\n').find((l) => /GC_HEAL/.test(l))?.trim() ?? `exit ${refused.exited}`);
  await stop(refused);

  const refusedDay = start(PORT, { GC_HEAL: 'ai', GC_HEAL_AI_MAX_CALLS_PER_DAY: 'lots' });
  for (let i = 0; i < 60 && refusedDay.exited === null; i++) await wait(250);
  check('and so does a daily model budget that is not a number',
    refusedDay.exited === 1 && /GC_HEAL_AI_MAX_CALLS_PER_DAY is "lots"/.test(refusedDay.out),
    refusedDay.out.trim().split('\n').find((l) => /PER_DAY/.test(l))?.trim() ?? `exit ${refusedDay.exited}`);
  await stop(refusedDay);

  const keyless = start(PORT, { GC_HEAL: 'ai', ANTHROPIC_API_KEY: undefined });
  for (let i = 0; i < 80 && !/ai fixes +->/.test(keyless.out) && keyless.exited === null; i++) await wait(250);
  const line = keyless.out.split('\n').find((l) => /ai fixes +->/.test(l))?.trim() ?? '(no line)';
  check('with no key the banner says so, and ai runs as safe', /no key — ANTHROPIC_API_KEY is unset, so ai runs as safe/.test(line), line);
  await stop(keyless);
}

// ---------------------------------------------------------------------------
console.log('\n— a gated runner with GC_HEAL=ai ———————————————————————————');

PORT = await freePort(PORT);
const BASE = `http://127.0.0.1:${PORT}`;
// One model call a day per organisation, so the ceiling is reached by the
// second ask; the key is a fake and the API address a closed port, so the one
// ask that is made fails fast with a connection error and nothing leaves.
const server = start(PORT, { GC_HEAL: 'ai', ANTHROPIC_API_KEY: FAKE_KEY, GC_HEAL_AI_MAX_CALLS_PER_DAY: '1' });

const A = tokenFor('check-fix-a');
const M = tokenFor('check-fix-a', { role: 'member', sub: 'sub-member' });
const OFF = tokenFor('check-fix-a', { off: ['runner.heal'], sub: 'sub-switched' });
const B = tokenFor('check-fix-b', { role: 'owner' });
const said = [];                                   // every body the runner answered, for the key check
const call = async (tok, path, { method = 'GET', body } = {}) => {
  const r = await fetch(`${BASE}${path}`, {
    method, headers: { authorization: `Bearer ${tok}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  said.push(text);
  let json = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, headers: r.headers };
};
async function socketFor(tok) {
  const { ticket } = (await call(tok, '/api/socket-ticket', { method: 'POST' })).body;
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?ticket=${ticket}`, { origin: BASE });
  const got = { events: [] };
  ws.on('message', (d, bin) => { if (!bin) { said.push(String(d)); try { got.events.push(JSON.parse(d)); } catch { /* ignore */ } } });
  await new Promise((res) => { ws.on('open', res); ws.on('error', res); setTimeout(res, 8000); });
  await wait(300);
  return { ws, got, reset: () => { got.events.length = 0; } };
}
const until = async (got, pred, ms = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const hit = got.events.find(pred); if (hit) return hit; await wait(100); }
  return null;
};

try {
  let up = false;
  for (let i = 0; i < 80 && !up && server.exited === null; i++) {
    up = await fetch(`${BASE}/healthz`).then((r) => r.ok).catch(() => false);
    if (!up) await wait(500);
  }
  if (!up) throw new Error(`no answer on ${PORT}\n${server.out.trim().split('\n').slice(-6).join('\n')}`);

  const fixesLine = server.out.split('\n').find((l) => /fixes +->/.test(l))?.trim() ?? '';
  const aiLine = server.out.split('\n').find((l) => /ai fixes +->/.test(l))?.trim() ?? '';
  check('the banner names the mode and says a key was found', /ai — rule fixes, then Claude/.test(fixesLine) && /key found \(environment\)/.test(aiLine), aiLine);

  // -- state ------------------------------------------------------------------
  const state = (await call(A, '/api/state')).body.heal;
  check('/api/state carries heal in the contract\'s shape',
    JSON.stringify(state) === JSON.stringify({ mode: 'ai', ai: { enabled: false, available: true, reason: 'organisation' }, plan: { enabled: false, available: true, reason: 'organisation' }, canManage: true }),
    JSON.stringify(state));
  const memberState = (await call(M, '/api/settings/heal')).body;
  check('GET /api/settings/heal answers a member, who cannot manage it', memberState.mode === 'ai' && memberState.canManage === false);
  const offState = (await call(OFF, '/api/state')).body.heal;
  check('the runner.heal switch forces the mode off, and says why',
    offState?.mode === 'off' && offState.ai.available === false && offState.ai.reason === 'switch', JSON.stringify(offState));
  const preflight = await fetch(`${BASE}/api/settings/heal`, { method: 'OPTIONS', headers: { origin: BASE } });
  check('a browser may send the PUT', /\bPUT\b/.test(preflight.headers.get('access-control-allow-methods') ?? ''));

  const a = await socketFor(A);
  const ready = a.got.events.find((e) => e.t === 'ready');
  check('and so does the socket greeting', JSON.stringify(ready?.heal) === JSON.stringify(state), JSON.stringify(ready?.heal));

  // -- the setting -------------------------------------------------------------
  const asMember = await call(M, '/api/settings/heal', { method: 'PUT', body: { ai: true } });
  check('a member cannot opt the organisation in', asMember.status === 403 && asMember.body.error === 'forbidden');
  const switchedPut = await call(OFF, '/api/settings/heal', { method: 'PUT', body: { ai: true } });
  check('nor can anyone while the switch is off', switchedPut.status === 403 && switchedPut.body.error === 'switched_off' && switchedPut.body.switch === 'runner.heal');
  const notBool = await call(B, '/api/settings/heal', { method: 'PUT', body: { ai: 'yes' } });
  check('ai must be a boolean', notBool.status === 400 && /true or false/.test(notBool.body.error ?? ''));
  const optIn = await call(B, '/api/settings/heal', { method: 'PUT', body: { ai: true } });
  const file = join(ROOT, '.ghostclick', 'check-fix-b', 'heal.json');
  check('an owner opts in, and the model is then available to that organisation only',
    optIn.status === 200 && JSON.stringify(optIn.body) === JSON.stringify({ mode: 'ai', ai: { enabled: true, available: true, reason: null }, plan: { enabled: false, available: true, reason: 'organisation' }, canManage: true }) &&
    existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).ai === true && (await call(A, '/api/state')).body.heal.ai.enabled === false,
    JSON.stringify(optIn.body));
  // Two consents, independent: drafting tests from a page read (chat-plan.js)
  // is its own yes, and a file written before it existed reads as no.
  const planIn = await call(B, '/api/settings/heal', { method: 'PUT', body: { plan: true } });
  const aiOff = await call(B, '/api/settings/heal', { method: 'PUT', body: { ai: false } });
  const kept = JSON.parse(readFileSync(file, 'utf8'));
  check('drafting tests is its own consent, kept beside the other',
    planIn.status === 200 && planIn.body.plan.enabled === true && planIn.body.plan.reason === null && planIn.body.ai.enabled === true
    && aiOff.status === 200 && aiOff.body.ai.enabled === false && aiOff.body.plan.enabled === true && kept.ai === false && kept.plan === true,
    JSON.stringify([planIn.body?.plan, aiOff.body?.ai, kept]));
  const neither = await call(B, '/api/settings/heal', { method: 'PUT', body: { plan: 'yes' } });
  check('plan must be a boolean too', neither.status === 400 && /true or false/.test(neither.body.error ?? ''));
  await call(B, '/api/settings/heal', { method: 'PUT', body: { ai: true, plan: false } });

  // -- a run of a saved case, whose fix becomes a suggestion -------------------
  await call(A, '/api/origins', { method: 'POST', body: { origin: BASE } });
  const suite = (await call(A, '/api/suites', { method: 'POST', body: { name: 'Check fixes', baseUrl: BASE } })).body.suite;
  const LOST = `%% suite "Paycheck state"\ntestcase TD\n  n0(("${BASE}/select.html"))\n  n1{{"Paid Bi-weekly in Texas"}}\n\n  n0 -->|click 'Texas' : option| n1`;
  const kase = (await call(A, `/api/suites/${suite.id}/cases`, { method: 'POST', body: { name: 'Choose Texas', flow: LOST } })).body.case;
  const runCase = () => call(A, `/api/suites/${suite.id}/run?case=${kase.id}&pace=0`, { method: 'POST' });

  a.reset();
  const first = await runCase();
  const heals = a.got.events.filter((e) => e.t === 'step.heal');
  const fix = heals[0]?.fix;
  check('the run passes with a rule fix', first.status === 200 && first.body.outcomes?.[0]?.ok === true && first.body.outcomes[0].fixed === 1,
    JSON.stringify(first.body.outcomes?.[0] ?? first.body).slice(0, 120));
  check('step.heal carries the fix, saved, with its id',
    heals.length === 1 && heals[0].i === 1 && fix?.kind === 'opened_menu' && fix.tier === 'rule' && fix.step === 1 && fix.op === 'click' &&
    fix.from === "click 'Texas' : option" && fix.insert === "click 'California' : button" && fix.to === null &&
    fix.reason === null && fix.confidence === null && fix.saved === true && /^fx_/.test(fix.id ?? '') && typeof fix.note === 'string',
    JSON.stringify(fix));
  const order = a.got.events.map((e) => e.t);
  const passAt = a.got.events.findIndex((e) => e.t === 'step.pass' && e.i === 1);
  const pass = a.got.events[passAt];
  check('then the pending count, then step.pass with the fixes, then run.end with fixed',
    order.indexOf('step.heal') < order.indexOf('fixes') && order.indexOf('fixes') < passAt &&
    a.got.events.find((e) => e.t === 'fixes')?.pending === 1 && pass?.fixes?.length === 1 && pass.fixes[0].id === fix?.id &&
    !a.got.events.some((e) => e.t === 'step.pass' && e.i !== 1 && 'fixes' in e) &&
    a.got.events.find((e) => e.t === 'run.end')?.fixed === 1, order.filter((t) => /step|fixes|run/.test(t)).join(' '));
  const listed = (await call(M, '/api/fixes')).body.fixes ?? [];
  const s = listed[0];
  check('GET /api/fixes lists it as a Suggestion',
    listed.length === 1 && s.id === fix?.id && s.status === 'pending' && s.suiteId === suite.id && s.caseId === kase.id &&
    s.caseName === 'Choose Texas' && s.seen === 1 && typeof s.createdAt === 'string' && typeof s.lastSeenAt === 'string' && s.saved === true,
    JSON.stringify(s).slice(0, 140));
  const runs = (await call(A, '/api/runs')).body.latest ?? [];
  check('and /api/runs rows carry fixed and fixes', runs[0]?.fixed === 1 && runs[0].fixes?.[0]?.kind === 'opened_menu');

  a.reset();
  await runCase();
  check('the same fix on the next run is the same suggestion, seen twice, and no new count',
    (await call(A, '/api/fixes')).body.fixes?.[0]?.seen === 2 && (await call(A, '/api/fixes')).body.fixes.length === 1 &&
    !a.got.events.some((e) => e.t === 'fixes'));

  const theirs = await call(B, '/api/fixes');
  const theirsAccept = await call(B, `/api/fixes/${fix.id}/accept`, { method: 'POST' });
  check('another organisation sees none of it, and cannot accept it', theirs.body.fixes?.length === 0 && theirsAccept.status === 404,
    `${theirs.body.fixes?.length} listed, accept ${theirsAccept.status}`);
  const switchedAccept = await call(OFF, `/api/fixes/${fix.id}/accept`, { method: 'POST' });
  const switchedList = await call(OFF, '/api/fixes');
  check('with the switch off it can be read, not accepted',
    switchedAccept.status === 403 && switchedAccept.body.switch === 'runner.heal' && switchedList.status === 200);
  const badStatus = await call(A, '/api/fixes?status=maybe');
  check('an unknown status is a 400', badStatus.status === 400);

  // -- accept -------------------------------------------------------------------
  a.reset();
  const accepted = await call(M, `/api/fixes/${fix.id}/accept`, { method: 'POST' });
  const steps = accepted.body.case?.flow ? accepted.body.case.flow : '';
  check('a member accepts it, and the case gains the opening click',
    accepted.status === 200 && accepted.body.fix?.status === 'accepted' && accepted.body.case?.suiteId === suite.id &&
    accepted.body.case.caseId === kase.id && accepted.body.case.steps === 4 &&
    /click 'California' : button; click 'Texas' : option/.test(steps), JSON.stringify(accepted.body).slice(0, 160));
  const stored = (await call(A, `/api/suites/${suite.id}`)).body.suite?.cases?.find((c) => c.id === kase.id);
  check('the suite on disk holds the new flow, and the count went out', stored?.flow === steps && (await until(a.got, (e) => e.t === 'fixes', 2000))?.pending === 0);
  a.reset();
  const green = await runCase();
  check('and the case now passes without any fix', green.body.outcomes?.[0]?.ok === true && green.body.outcomes[0].fixed === 0 &&
    !a.got.events.some((e) => e.t === 'step.heal') && a.got.events.find((e) => e.t === 'run.end')?.fixed === 0);

  // -- stale, and rejected --------------------------------------------------------
  await call(A, `/api/suites/${suite.id}/cases/${kase.id}`, { method: 'PATCH', body: { flow: LOST } });
  await runCase();
  const back = (await call(A, '/api/fixes')).body.fixes?.[0];
  check('when the case loses the click again, the suggestion is pending again', back?.id === fix.id && back.status === 'pending' && back.seen === 3);
  await call(A, `/api/suites/${suite.id}/cases/${kase.id}`, { method: 'PATCH', body: { flow: LOST.replace("'Texas'", "'Utah'") } });
  const stale = await call(A, `/api/fixes/${fix.id}/accept`, { method: 'POST' });
  const staleList = (await call(A, '/api/fixes?status=stale')).body.fixes ?? [];
  const untouched = (await call(A, `/api/suites/${suite.id}`)).body.suite?.cases?.find((c) => c.id === kase.id);
  check('a case edited since is a 409 stale, and is not rewritten',
    stale.status === 409 && stale.body.error === 'stale' && staleList.some((x) => x.id === fix.id) && /'Utah'/.test(untouched?.flow ?? ''),
    JSON.stringify(stale.body));
  await call(A, `/api/suites/${suite.id}/cases/${kase.id}`, { method: 'PATCH', body: { flow: LOST } });
  await runCase();
  a.reset();
  const rejected = await call(M, `/api/fixes/${fix.id}/reject`, { method: 'POST' });
  // The count goes out as the answer does, and the socket may deliver it second.
  const dropped = await until(a.got, (e) => e.t === 'fixes' && e.pending === 0, 3000);
  a.reset();
  await runCase();
  const after = (await call(A, '/api/fixes?status=all')).body.fixes?.find((x) => x.id === fix.id);
  check('a member rejects it, and a later run does not bring it back',
    rejected.status === 200 && rejected.body.fix?.status === 'rejected' && dropped !== null && after?.status === 'rejected' && after.seen === 5 &&
    (await call(A, '/api/fixes')).body.fixes.length === 0 && !a.got.events.some((e) => e.t === 'fixes'), `seen ${after?.seen}`);

  // -- a moved suggestion: a recorded position out of date -------------------------
  // select.html's State button, recorded 40px above where it is. The organisation
  // has not opted in to the model, so this is the rule alone. Its place is
  // measured first by an unsaved run, from what the run says about it; `in 0x0`
  // leaves the point unscaled whatever window the runner has.
  const DRIFT = (hoverAt, clickAt) => `%% suite "Drift"\ntestcase TD\n  n0(("${BASE}/select.html"))\n  n1{{"Paid Bi-weekly in California"}}\n\n` +
    `  n0 -->|hover 'Bi-weekly' : button; click 'California' : button| n1\n\n%% at 1 ${hoverAt}\n%% at 2 ${clickAt}`;
  const FAR_HOVER = '5,700 10x10 in 0x0';
  a.reset();
  a.ws.send(JSON.stringify({ t: 'command', text: DRIFT(FAR_HOVER, '5,5 10x10 in 0x0') }));
  const measured = await until(a.got, (e) => e.t === 'run.end', 60000);
  const place = a.got.events.filter((e) => e.t === 'log').map((e) => String(e.msg ?? ''))
    .map((m) => m.match(/^button:California: recorded at 5,5 but resolves to (\d+),(\d+)/) ?? m.match(/^button:California moved from 5,5 to (\d+),(\d+)/))
    .find(Boolean);
  const [cx, cy] = place ? [Number(place[1]), Number(place[2])] : [NaN, NaN];
  check('an unsaved run says where the State button is, and passes', measured?.ok === true && Number.isInteger(cx) &&
    !a.got.events.some((e) => e.t === 'step.heal'), `${cx},${cy}`);

  const DRIFT_FLOW = DRIFT(FAR_HOVER, `${cx},${cy - 40} 10x10 in 0x0`);
  const driftCase = (await call(A, `/api/suites/${suite.id}/cases`, { method: 'POST', body: { name: 'Pick California', flow: DRIFT_FLOW } })).body.case;
  const runDrift = () => call(A, `/api/suites/${suite.id}/run?case=${driftCase?.id}&pace=0`, { method: 'POST' });
  a.reset();
  const drifted = await runDrift();
  const movedHeals = a.got.events.filter((e) => e.t === 'step.heal').map((e) => e.fix);
  const mfix = movedHeals[0];
  check('a run whose button moved 40px passes, and offers the new position as a suggestion',
    drifted.body.outcomes?.[0]?.ok === true && movedHeals.length === 1 && mfix?.kind === 'moved' && mfix.tier === 'rule' &&
    mfix.step === 2 && mfix.op === 'click' && mfix.from === "click 'California' : button" && mfix.to === null && mfix.insert === null &&
    mfix.reason === null && mfix.confidence === null && mfix.saved === true && /^fx_/.test(mfix.id ?? '') &&
    Object.keys(mfix.at ?? {}).join() === 'x,y,w,h,vw,vh' && mfix.at.x === cx && mfix.at.y === cy &&
    a.got.events.some((e) => e.t === 'log' && e.level === 'info' && /^button:California moved from \d+,\d+ to \d+,\d+ — the layout shifted$/.test(e.msg)) &&
    !a.got.events.some((e) => e.t === 'step.thinking'), JSON.stringify(mfix));
  const movedListed = ((await call(A, '/api/fixes')).body.fixes ?? []).find((x) => x.id === mfix?.id);
  check('GET /api/fixes lists it with its position', movedListed?.status === 'pending' && JSON.stringify(movedListed.at) === JSON.stringify(mfix?.at),
    JSON.stringify(movedListed?.at));

  await call(A, `/api/suites/${suite.id}/cases/${driftCase?.id}`, { method: 'PATCH', body: { flow: DRIFT_FLOW.replace("click 'California' : button", "click 'Bi-weekly' : button") } });
  const movedStale = await call(A, `/api/fixes/${mfix?.id}/accept`, { method: 'POST' });
  const untouchedDrift = (await call(A, `/api/suites/${suite.id}`)).body.suite?.cases?.find((c) => c.id === driftCase?.id);
  check('a case edited since is a 409 stale for a moved fix too, and is not rewritten',
    movedStale.status === 409 && movedStale.body.error === 'stale' && /click 'Bi-weekly' : button\| n1/.test(untouchedDrift?.flow ?? ''),
    JSON.stringify(movedStale.body));

  await call(A, `/api/suites/${suite.id}/cases/${driftCase?.id}`, { method: 'PATCH', body: { flow: DRIFT_FLOW } });
  await runDrift();
  a.reset();
  const movedAccepted = await call(M, `/api/fixes/${mfix?.id}/accept`, { method: 'POST' });
  const newFlow = movedAccepted.body.case?.flow ?? '';
  const marks = atLines(newFlow);
  const at2 = mfix?.at ? `${mfix.at.x},${mfix.at.y} ${mfix.at.w}x${mfix.at.h} in ${mfix.at.vw}x${mfix.at.vh}` : '?';
  check('seen again it is pending; accepted, it rewrites that step\'s %% at line and no other',
    movedAccepted.status === 200 && movedAccepted.body.fix?.status === 'accepted' && marks.size === 2 &&
    marks.get(2) === at2 && marks.get(1) === FAR_HOVER && movedAccepted.body.case.steps === 4 &&
    JSON.stringify(stepsOf(newFlow).map((s) => ({ ...s, at: undefined }))) === JSON.stringify(stepsOf(DRIFT_FLOW).map((s) => ({ ...s, at: undefined }))),
    `%% at 2 ${marks.get(2)}; %% at 1 ${marks.get(1)}`);
  a.reset();
  const settled = await runDrift();
  check('and the case then runs with no suggestion and no warning about that step',
    settled.body.outcomes?.[0]?.ok === true && !a.got.events.some((e) => e.t === 'step.heal') &&
    !a.got.events.some((e) => e.t === 'log' && /^button:California(:| moved)/.test(String(e.msg ?? ''))));

  // -- the switch reaches the run --------------------------------------------------
  const off = await socketFor(OFF);
  off.ws.send(JSON.stringify({ t: 'command', text: LOST }));
  const offEnd = await until(off.got, (e) => e.t === 'run.end');
  check('a run started under the switch gets no fixes at all', offEnd?.ok === false && offEnd.fixed === 0 &&
    !off.got.events.some((e) => e.t === 'step.heal'), JSON.stringify(offEnd));
  off.ws.close();

  // -- the model's budget: per run, and per organisation per day ------------------
  // The review that found a run's six calls could be spent 500 times a day by
  // any member asked for a ceiling across runs. This organisation opts in, and a
  // broken case (an option no list holds) is put to the model twice.
  const optedIn = await call(A, '/api/settings/heal', { method: 'PUT', body: { ai: true } });
  // Atlantis is in neither of select.html's lists, so no rule can help.
  const BROKEN = LOST.replace("'Texas'", "'Atlantis'");
  const askRun = async () => {
    a.reset();
    a.ws.send(JSON.stringify({ t: 'command', text: BROKEN }));
    const end = await until(a.got, (e) => e.t === 'run.end', 60000);
    return { end, logs: a.got.events.filter((e) => e.t === 'log').map((e) => String(e.msg ?? '')) };
  };
  const asked = await askRun();
  const capped = await askRun();
  check('an opted-in organisation\'s broken step is put to the model, and fails as it would have',
    optedIn.body?.ai?.reason === null && asked.end?.ok === false && asked.end.fixed === 0 &&
    asked.logs.some((m) => /^AI unavailable: APIConnection/.test(m)),
    asked.logs.find((m) => /^AI/.test(m)) ?? JSON.stringify(asked.end));
  check('and once the day\'s calls are spent the next run does not ask at all',
    capped.end?.ok === false && capped.logs.some((m) => /no AI calls left/.test(m)) && !capped.logs.some((m) => /^AI unavailable/.test(m)),
    capped.logs.find((m) => /^AI/.test(m)) ?? JSON.stringify(capped.end));
  a.ws.close();

  const leaked = [...said, server.out].some((t) => t.includes(FAKE_KEY));
  check('the key is never in a response, an event or the runner\'s output', !leaked);
} catch (err) {
  bad('the runner survived the fixes checks', [err.message, ...server.out.trim().split(/\r?\n/).slice(-8)].join(' | '));
} finally {
  await stop(server);
  cleanup();
}

console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — the heal state is the contract\'s, the role, the organisation and the\n'
    + '       switch are enforced by the runner, a saved case\'s fix becomes one\n'
    + '       suggestion that accepting writes into the case, and the key is never said.\n');
process.exit(failures ? 1 : 0);
