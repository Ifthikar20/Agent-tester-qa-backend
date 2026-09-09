/**
 * Who may drive the browser.
 *
 *   node scripts/check-auth.js          (starts its own server; no npm start needed)
 *
 * Three things, and the middle one is the reason this file exists at all.
 *
 *   the verifier     auth.js refuses every forgery it is supposed to refuse.
 *                    Pure, instant, and the place where the JWT folklore lives:
 *                    alg confusion, "none", a missing expiry, a swapped MAC.
 *   the two agree    a token minted by the Django control plane, in Python,
 *                    verifies in Node. Both sides implement HS256 from their
 *                    own standard library, so nothing but a test can tell you
 *                    they still produce the same bytes. A base64 padding
 *                    difference would pass every unit test on both sides
 *                    separately and fail every login.
 *   the gate         a real runner refuses an unauthenticated API call and an
 *                    unauthenticated socket, and still serves the UI and the
 *                    pages it drives, which must stay open.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { verify, bearer, MIN_SECRET } from '../auth.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SECRET = 'check-auth-secret-long-enough-for-hmac-0123456789';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(50)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(50)} ${d}`); };
const skip = (l, d = '') => console.log(`  ·  ${l.padEnd(50)} ${d}`);

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

/**
 * Sign a token here, so the check can build ones that are deliberately wrong.
 *
 * This deliberately does NOT live in auth.js. The runner must have no way to
 * mint its own credentials — an executor that can authorise itself is not
 * authorising anything — so the only signer in the repository outside the
 * control plane is this test.
 */
function sign(claims, { secret = SECRET, header = { alg: 'HS256', typ: 'JWT' } } = {}) {
  const input = `${b64(header)}.${b64(claims)}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}

const soon = () => Math.floor(Date.now() / 1000) + 600;

/** Assert a token is refused, and say why it was supposed to be. */
function refuses(label, token, secret = SECRET) {
  try {
    verify(token, secret);
    bad(label, 'IT WAS ACCEPTED');
  } catch (err) {
    if (err.name === 'AuthError') ok(label, err.message);
    else bad(label, `threw ${err.name}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n— the verifier ————————————————————————————————————————');

try {
  const claims = verify(sign({ sub: '7', email: 'qa@example.com', exp: soon() }), SECRET);
  if (claims.sub === '7') ok('a good token is accepted', `sub=${claims.sub}`);
  else bad('a good token is accepted', JSON.stringify(claims));
} catch (err) { bad('a good token is accepted', err.message); }

// The three that JWT libraries have historically got wrong.
//
// "none" gets two shapes on purpose. The classic attack drops the signature
// entirely, and that is refused for a duller reason — three segments, one
// empty. The one that actually exercises the algorithm pin keeps a signature
// segment and only lies in the header, so if the pin were removed the token
// would reach the MAC check with a real string to compare.
refuses('"alg":"none" with no signature is refused',
  `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: '7', exp: soon() })}.`);
refuses('"alg":"none" carrying a signature is refused',
  `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: '7', exp: soon() })}.${b64('anything')}`);
refuses('a different algorithm is refused',
  sign({ sub: '7', exp: soon() }, { header: { alg: 'HS512', typ: 'JWT' } }));
refuses('a token with no expiry is refused', sign({ sub: '7' }));

// Forgery, in the three shapes it actually takes.
const good = sign({ sub: '7', exp: soon() });
refuses('a tampered payload is refused',
  `${good.split('.')[0]}.${b64({ sub: 'admin', exp: soon() })}.${good.split('.')[2]}`);
refuses('another secret does not sign for us', sign({ sub: '7', exp: soon() }, { secret: `${SECRET}x` }));
refuses('a truncated signature is refused', good.slice(0, -4));

// Time, both directions.
refuses('an expired token is refused', sign({ sub: '7', exp: Math.floor(Date.now() / 1000) - 3600 }));
refuses('a token dated in the future is refused',
  sign({ sub: '7', iat: Math.floor(Date.now() / 1000) + 7200, exp: soon() + 7200 }));

// Nonsense, which must be a clean refusal rather than a stack trace — this
// runs on whatever a stranger puts in a query string.
for (const junk of ['', 'abc', 'a.b', 'a.b.c.d', '..', null, undefined]) {
  try { verify(junk, SECRET); bad('junk is refused', `accepted ${JSON.stringify(junk)}`); }
  catch (err) {
    if (err.name !== 'AuthError') bad('junk is refused', `${JSON.stringify(junk)} threw ${err.name}`);
  }
}
ok('junk is refused rather than thrown on', '7 shapes');

// The key itself.
refuses(`a secret under ${MIN_SECRET} chars is refused`, good, 'short');
refuses('an empty secret is refused', good, '');

// The header parser.
const HEADERS = [['Bearer abc', 'abc'], ['bearer abc', 'abc'], ['Bearer  abc', 'abc'],
                 ['abc', null], ['Basic abc', null], ['', null], [undefined, null], ['Bearer', null]];
const wrong = HEADERS.filter(([h, want]) => bearer(h) !== want);
if (!wrong.length) ok('Authorization headers are read correctly', `${HEADERS.length} shapes`);
else bad('Authorization headers are read correctly', JSON.stringify(wrong));

// ---------------------------------------------------------------------------
console.log('\n— Python signs it, Node checks it —————————————————————');

/**
 * The only assertion here that cannot be made on one side alone.
 *
 * Both implement HS256 from their own standard library — no shared package, by
 * design — so "we both wrote a JWT" is a claim nothing verifies until a token
 * crosses. Unpadded base64url is the classic way this diverges, and it fails
 * silently at every login rather than at either project's tests.
 */
const AUTH_DIR = join(ROOT, 'auth');
const python = spawnSync('python3', ['-c',
  'import sys; sys.path.insert(0, ".");\n'
  + 'from accounts.tokens import mint\n'
  + 'import os\n'
  + 'print(mint(subject=42, email="qa@example.com", secret=os.environ["S"], ttl=600,\n'
  + '           org="acme", role="admin", ent={"suites.max": 25, "vault.enabled": True, "runs.per_day": None}, ent_v=7))',
], { cwd: AUTH_DIR, encoding: 'utf8', env: { ...process.env, S: SECRET } });

if (!existsSync(AUTH_DIR)) {
  skip('the control plane is not in this checkout', 'auth/ is absent');
} else if (python.error || python.status !== 0) {
  // A missing python3 is not a broken contract, so it is a visible skip and
  // not a failure — but it is never silent, because the half it covers is the
  // half neither project can test alone.
  skip('python3 could not mint a token', (python.stderr || python.error?.message || '').trim().split('\n').pop());
} else {
  const minted = python.stdout.trim();
  try {
    const claims = verify(minted, SECRET);
    if (claims.sub === '42' && claims.email === 'qa@example.com' && claims.scope === 'run') {
      ok('Django mints a token this runner accepts', `sub=${claims.sub} scope=${claims.scope}`);
    } else {
      bad('Django mints a token this runner accepts', JSON.stringify(claims));
    }
    if (claims.exp - claims.iat === 600) ok('and the expiry it asked for survives the trip', '600s');
    else bad('and the expiry it asked for survives the trip', `${claims.exp - claims.iat}s`);
    /**
     * The tenancy claims (docs/AUTH.md §10) are the only way the runner learns
     * which organisation is calling. Python's None must arrive as JSON null —
     * "unlimited" — and not as the string "None", which would compare as
     * greater than every number and read as unlimited by accident.
     */
    const ent = claims.ent ?? {};
    if (claims.org === 'acme' && claims.role === 'admin' && claims.ent_v === 7
        && ent['suites.max'] === 25 && ent['vault.enabled'] === true && ent['runs.per_day'] === null) {
      ok('and so do the organisation, role and entitlements', `org=${claims.org} role=${claims.role} ent_v=${claims.ent_v}`);
    } else {
      bad('and so do the organisation, role and entitlements', JSON.stringify({ org: claims.org, role: claims.role, ent, ent_v: claims.ent_v }));
    }
  } catch (err) {
    bad('Django mints a token this runner accepts', err.message);
  }
  // And the key actually matters, rather than both sides ignoring it.
  refuses('a Django token signed elsewhere is refused', minted, `${SECRET}-different`);
}

// ---------------------------------------------------------------------------
console.log('\n— the control plane\u2019s own tests ————————————————————');

/**
 * Run Django's suite from here rather than leaving it to a second command.
 *
 * "Everything is green" has to mean one thing. A control plane whose tests are
 * only run by whoever remembers `manage.py test` is a control plane whose tests
 * stop being run — and this is the half holding the password hashing, the CSRF
 * rotation and the rule that a token is minted only for the session's own user.
 *
 * It skips loudly rather than failing when there is no Python: auth/ is
 * optional, and a laptop running the bundled runner should not need Django
 * installed to have a green suite.
 */
if (!existsSync(AUTH_DIR)) {
  skip('the control plane is not in this checkout', 'auth/ is absent');
} else {
  const django = spawnSync('python3', ['manage.py', 'test', '--verbosity', '1'], {
    cwd: AUTH_DIR, encoding: 'utf8', timeout: 180000,
    env: { ...process.env, DJANGO_DEBUG: '1', GC_AUTH_SECRET: SECRET },
  });
  const report = `${django.stdout ?? ''}${django.stderr ?? ''}`;
  const ran = /Ran (\d+) test/.exec(report)?.[1];
  if (django.error && django.error.code === 'ENOENT') {
    skip('python3 is not installed', 'the control plane was not exercised');
  } else if (/No module named .django./.test(report)) {
    skip('django is not installed', 'pip install -r auth/requirements.txt');
  } else if (django.status === 0) {
    ok('django tests pass', `${ran ?? '?'} tests`);
  } else {
    bad('django tests pass', report.trim().split('\n').slice(-8).join('\n        '));
  }
}

// ---------------------------------------------------------------------------
console.log('\n— a weak secret stops the runner ——————————————————————');

const weak = spawnSync(process.execPath, [join(ROOT, 'scripts/start.js')], {
  cwd: ROOT, timeout: 25000, encoding: 'utf8',
  env: { ...process.env, PORT: '3405', GC_SKIP_BUILD: '1', GC_AUTH_SECRET: 'short' },
});
if (weak.status !== 0 && /at least 32/.test(weak.stderr ?? '')) {
  ok('a short GC_AUTH_SECRET refuses to start', `exit ${weak.status}`);
} else {
  bad('a short GC_AUTH_SECRET refuses to start', `exit ${weak.status} — a weak shared key still worked`);
}

// ---------------------------------------------------------------------------
console.log('\n— the gate, on a running runner ———————————————————————');

const PORT = Number(process.env.GC_AUTH_PORT) || 3404;
const BASE = `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, [join(ROOT, 'scripts/start.js')], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(PORT), GC_SKIP_BUILD: '1', HOME_URL: '', GC_AUTH_SECRET: SECRET },
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });

const token = sign({ sub: '42', email: 'qa@example.com', scope: 'run', exp: soon() });
const socket = (query) => new Promise((res) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws${query}`);
  const done = (r) => { try { ws.close(); } catch { /* already gone */ } res(r); };
  ws.on('open', () => done('open'));
  ws.on('error', (e) => done(e.message));
  setTimeout(() => done('timed out'), 8000);
});

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    up = await fetch(`${BASE}/app/`).then((r) => r.ok).catch(() => false);
    if (!up) await wait(500);
  }
  if (!up) {
    bad('a gated runner starts', `no answer on ${PORT}\n${out.trim().split('\n').slice(-6).join('\n')}`);
  } else {
    if (/auth *-> *on/.test(out)) ok('and says so at boot', 'auth -> on');
    else bad('and says so at boot', (out.split('\n').find((l) => l.includes('auth')) ?? '(no line)').trim());

    const anon = await fetch(`${BASE}/api/state`);
    if (anon.status === 401) ok('/api without a token is 401', (await anon.json()).error);
    else bad('/api without a token is 401', String(anon.status));

    const withTok = await fetch(`${BASE}/api/state`, { headers: { authorization: `Bearer ${token}` } });
    if (withTok.ok) ok('/api with one is allowed', '200');
    else bad('/api with one is allowed', String(withTok.status));

    const stale = await fetch(`${BASE}/api/state`, {
      headers: { authorization: `Bearer ${sign({ sub: '42', exp: Math.floor(Date.now() / 1000) - 3600 })}` },
    });
    if (stale.status === 401) ok('an expired token is 401 at the door', (await stale.json()).error);
    else bad('an expired token is 401 at the door', String(stale.status));

    // The socket is the one that matters: a refused upgrade must be refused
    // BEFORE it becomes a connection receiving screencast frames.
    const noTok = await socket('');
    if (/401/.test(noTok)) ok('the socket refuses an upgrade with no token', noTok);
    else bad('the socket refuses an upgrade with no token', noTok);

    const badTok = await socket('?t=not.a.token');
    if (/401/.test(badTok)) ok('and one with a forged token', badTok);
    else bad('and one with a forged token', badTok);

    const goodTok = await socket(`?t=${encodeURIComponent(token)}`);
    if (goodTok === 'open') ok('and accepts a real one');
    else bad('and accepts a real one', goodTok);

    /**
     * What must NOT be gated. The UI has to load in order to render a login
     * form, and the pages under test are fetched by the driven browser, which
     * has no token and never will.
     */
    for (const [label, path] of [['the UI still loads', '/app/'], ['and the pages it drives', '/demo.html']]) {
      const r = await fetch(BASE + path);
      if (r.ok) ok(label, `${r.status} ${path}`);
      else bad(label, `${r.status} ${path} — a login screen you cannot reach`);
    }

    // The extension records from a page it cannot get a token on. Open, and
    // deliberately so — it validates and never executes.
    const rec = await fetch(`${BASE}/api/recording`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flow: 'testcase TD\n  a(("http://evil.example.com/")) --> b' }),
    });
    if (rec.status === 400) ok('the extension hand-off is still reachable', 'and still origin-gated');
    else bad('the extension hand-off is still reachable', `${rec.status} — expected the origin gate, not the auth gate`);
  }
} finally {
  child.kill('SIGTERM');
  await wait(300);
  child.kill('SIGKILL');
}

console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — forgeries are refused, a token minted in Python verifies in Node,\n'
    + '       and a gated runner turns away both an API call and a socket while\n'
    + '       still serving the UI and the pages it drives.\n');
process.exit(failures ? 1 : 0);
