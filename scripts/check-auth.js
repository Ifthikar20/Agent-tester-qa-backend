/**
 * Who may drive the browser.
 *
 *   node scripts/check-auth.js          (starts its own server; no npm start needed)
 *
 * Four things, and the second is the reason this file exists at all.
 *
 *   the verifier     auth.js refuses every forgery it is supposed to refuse.
 *                    Pure, instant, and the place where the JWT folklore lives:
 *                    alg confusion, "none", an HS256 token with a "good" MAC, a
 *                    key it was not given, a missing expiry, a lifetime the
 *                    control plane never mints.
 *   the two agree    a token minted by the Django control plane, in Python,
 *                    verifies in Node. Both sides implement EdDSA-over-JWT from
 *                    their own libraries — no shared package, by design — so
 *                    nothing but a test can tell you they still produce the
 *                    same bytes. A base64 padding difference would pass every
 *                    unit test on both sides separately and fail every login.
 *   the reach        reach.js refuses every address the driven page must not
 *                    fetch, and a real runner aborts the request.
 *   the gate         a real runner refuses an unauthenticated API call, a
 *                    socket with no ticket, a ticket presented twice, a token
 *                    in the socket URL, a socket from another origin — and
 *                    still serves the UI, which must stay open.
 *
 * The test signs with a THROWAWAY Ed25519 key generated here. That is the
 * only signer in the repository outside the control plane, and it lives in a
 * test on purpose: the runner must have no way to mint its own credentials.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { verify, bearer, parseKeys, MAX_LIFETIME_S } from '../auth.js';
import { isPrivateAddress, blockedName, blocked } from '../reach.js';
import { csp, TURNSTILE_HOST } from '../mode.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(50)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(50)} ${d}`); };
const skip = (l, d = '') => console.log(`  ·  ${l.padEnd(50)} ${d}`);

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

// ---------------------------------------------------------------------------
// The throwaway keypair, and its kid the way the control plane derives one:
// the RFC 7638 thumbprint of the public JWK, so the same public key always has
// the same name whoever computed it.
const pair = generateKeyPairSync('ed25519');
const PRIVATE_PEM = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
const PUBLIC_PEM = pair.publicKey.export({ type: 'spki', format: 'pem' });
const kidOf = (publicKey) => {
  const x = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url');
  return createHash('sha256').update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x })).digest('base64url');
};
const KID = kidOf(pair.publicKey);
const KEYS = parseKeys(JSON.stringify({ [KID]: PUBLIC_PEM }));
const other = generateKeyPairSync('ed25519');

/** Sign a token here, so the check can build ones that are deliberately wrong. */
function sign(claims, { key = pair.privateKey, header = { alg: 'EdDSA', typ: 'JWT', kid: KID } } = {}) {
  const input = `${b64(header)}.${b64(claims)}`;
  return `${input}.${cryptoSign(null, Buffer.from(input), key).toString('base64url')}`;
}
/** An HS256 token with a correct MAC under some secret — the confusion attack in its plainest shape. */
function hs256(claims, secret = PUBLIC_PEM) {
  const input = `${b64({ alg: 'HS256', typ: 'JWT', kid: KID })}.${b64(claims)}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}

const nowS = () => Math.floor(Date.now() / 1000);
/** A full, valid set of claims; override what a case needs. */
const claimsFor = (over = {}) => ({
  iss: 'ghostclick-control', aud: 'ghostclick-runner', sub: '42', email: 'qa@example.com',
  org: 'acme', role: 'admin', amr: ['password'], auth_time: nowS(), su: nowS() + 600,
  ent: { 'suites.max': 25 }, ent_v: 7, sid: 'abc', iat: nowS(), exp: nowS() + 600, jti: 'j1', ...over,
});

/** Assert a token is refused, and say why it was supposed to be. */
function refuses(label, token, keys = KEYS) {
  try {
    verify(token, keys);
    bad(label, 'IT WAS ACCEPTED');
  } catch (err) {
    if (err.name === 'AuthError') ok(label, err.message);
    else bad(label, `threw ${err.name}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n— the verifier ————————————————————————————————————————');

try {
  const claims = verify(sign(claimsFor()), KEYS);
  if (claims.sub === '42' && claims.org === 'acme') ok('a good token is accepted', `sub=${claims.sub} org=${claims.org}`);
  else bad('a good token is accepted', JSON.stringify(claims));
} catch (err) { bad('a good token is accepted', err.message); }

// The algorithm. Three shapes of the same attack: no signature at all, a
// signature segment with "none" in the header, and an HS256 token whose MAC
// is correct under the PUBLIC key — the classic confusion, which a verifier
// that branches on `alg` and feeds the public key to an HMAC accepts.
refuses('"alg":"none" with no signature is refused', `${b64({ alg: 'none', typ: 'JWT', kid: KID })}.${b64(claimsFor())}.`);
refuses('"alg":"none" carrying a signature is refused', `${b64({ alg: 'none', typ: 'JWT', kid: KID })}.${b64(claimsFor())}.${b64('anything')}`);
refuses('an HS256 token is refused outright', hs256(claimsFor()));
refuses('HS256 under any other secret too', hs256(claimsFor(), 'check-auth-secret-long-enough-for-hmac-0123456789'));
refuses('a different asymmetric algorithm is refused', sign(claimsFor(), { header: { alg: 'ES256', typ: 'JWT', kid: KID } }));

// The key. A kid it was not given is a refusal, not a search.
refuses('a kid the runner was not given is refused', sign(claimsFor(), { header: { alg: 'EdDSA', typ: 'JWT', kid: 'someone-else' } }));
refuses('a token with no kid is refused', sign(claimsFor(), { header: { alg: 'EdDSA', typ: 'JWT' } }));
refuses('another Ed25519 key does not sign for us', sign(claimsFor(), { key: other.privateKey }));
refuses('the right kid over the wrong key is still refused', sign(claimsFor(), { key: other.privateKey }));
refuses('an empty key set accepts nothing', sign(claimsFor()), new Map());

// Forgery, in the shapes it actually takes.
const good = sign(claimsFor());
refuses('a tampered payload is refused', `${good.split('.')[0]}.${b64(claimsFor({ sub: 'admin' }))}.${good.split('.')[2]}`);
refuses('a truncated signature is refused', good.slice(0, -4));
refuses('a signature of the wrong length is refused', `${good}AAAA`);

// The claims that are required, not optional.
for (const missing of ['iss', 'aud', 'sub', 'org', 'iat', 'exp']) {
  const c = claimsFor(); delete c[missing];
  refuses(`a token with no ${missing} is refused`, sign(c));
}
refuses('a token for another audience is refused', sign(claimsFor({ aud: 'ghostclick-admin' })));
refuses('a token from another issuer is refused', sign(claimsFor({ iss: 'someone' })));
refuses('an empty org is refused', sign(claimsFor({ org: '' })));
// The org becomes a directory name on the runner (.ghostclick/<org>/), so a
// token whose org could climb out of one is refused before any path is built.
refuses('an org that is not a slug is refused', sign(claimsFor({ org: '../local' })));
refuses('and one with a capital letter or a space', sign(claimsFor({ org: 'Acme Corp' })));

// Time, both directions, and the lifetime between.
refuses('an expired token is refused', sign(claimsFor({ iat: nowS() - 4000, exp: nowS() - 3600 })));
refuses('a token dated in the future is refused', sign(claimsFor({ iat: nowS() + 7200, exp: nowS() + 7800 })));
refuses(`a lifetime over ${MAX_LIFETIME_S}s is refused`, sign(claimsFor({ iat: nowS(), exp: nowS() + 86400 })));
refuses('a token not valid yet (nbf) is refused', sign(claimsFor({ nbf: nowS() + 3600 })));
try {
  verify(sign(claimsFor({ iat: nowS() - 30, exp: nowS() + 630 })), KEYS);
  ok('a lifetime of exactly 660s is the ceiling, and passes');
} catch (err) { bad('a lifetime of exactly 660s is the ceiling, and passes', err.message); }
try {
  verify(sign(claimsFor({ exp: nowS() - 30 })), KEYS);
  ok('and a minute of clock skew is allowed', 'expired 30s ago');
} catch (err) { bad('and a minute of clock skew is allowed', err.message); }

// Nonsense, which must be a clean refusal rather than a stack trace — this
// runs on whatever a stranger puts in a header.
for (const junk of ['', 'abc', 'a.b', 'a.b.c.d', '..', null, undefined, `${b64('[]')}.${b64('[]')}.${b64('x')}`]) {
  try { verify(junk, KEYS); bad('junk is refused', `accepted ${JSON.stringify(junk)}`); }
  catch (err) {
    if (err.name !== 'AuthError') bad('junk is refused', `${JSON.stringify(junk)} threw ${err.name}`);
  }
}
ok('junk is refused rather than thrown on', '8 shapes');

// The key set itself: public, Ed25519, or nothing.
for (const [label, json] of [
  ['a private key in the set is refused', JSON.stringify({ k: PRIVATE_PEM })],
  ['an RSA key in the set is refused', JSON.stringify({ k: generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }) })],
  ['a set that is not JSON is refused', 'not json'],
  ['a set that is not an object is refused', '["pem"]'],
]) {
  try { parseKeys(json); bad(label, 'accepted'); } catch (err) { if (err.name === 'AuthError') ok(label, err.message.slice(0, 60)); else bad(label, err.message); }
}
try {
  // A PEM whose newlines survived as real newlines inside the JSON string,
  // which is what an env file read through double quotes produces.
  const loose = `{"${KID}": "${PUBLIC_PEM}"}`;
  if (parseKeys(loose).has(KID)) ok('a set with real newlines in the PEM is read anyway', 'double-quoted .env');
  else bad('a set with real newlines in the PEM is read anyway');
} catch (err) { bad('a set with real newlines in the PEM is read anyway', err.message); }
if (parseKeys('').size === 0 && parseKeys(undefined).size === 0) ok('and no set at all is auth off', 'empty map');
else bad('and no set at all is auth off');

// The header parser.
const HEADERS = [['Bearer abc', 'abc'], ['bearer abc', 'abc'], ['Bearer  abc', 'abc'],
                 ['abc', null], ['Basic abc', null], ['', null], [undefined, null], ['Bearer', null]];
const wrong = HEADERS.filter(([h, want]) => bearer(h) !== want);
if (!wrong.length) ok('Authorization headers are read correctly', `${HEADERS.length} shapes`);
else bad('Authorization headers are read correctly', JSON.stringify(wrong));

// ---------------------------------------------------------------------------
console.log('\n— the policy the UI is served under ————————————————————');

/**
 * The CSP is built from the mode (mode.js). Turnstile is the one thing that
 * widens it, and only when the control plane will actually ask for the
 * widget: a site key nobody set must leave script-src at 'self', and a set
 * one must admit exactly Cloudflare's host and no other.
 */
const plainCsp = csp({ authOrigin: '', turnstile: false });
if (/default-src 'self'/.test(plainCsp) && !/script-src/.test(plainCsp) && !/cloudflare/.test(plainCsp)) ok('without Turnstile, script-src is default-src \'self\'', 'no third-party host');
else bad('without Turnstile, script-src is default-src \'self\'', plainCsp);
const withTurnstile = csp({ authOrigin: '', turnstile: true });
if (withTurnstile.includes(`script-src 'self' ${TURNSTILE_HOST}`) && withTurnstile.includes(`frame-src ${TURNSTILE_HOST}`) && /frame-ancestors 'none'/.test(withTurnstile)) {
  ok('with GC_TURNSTILE_SITE_KEY the widget\'s host is admitted', 'script-src and frame-src, nothing else');
} else bad('with GC_TURNSTILE_SITE_KEY the widget\'s host is admitted', withTurnstile);
if (!/unsafe-inline'[^;]*script|script-src[^;]*unsafe-inline/.test(withTurnstile)) ok('and inline script stays refused');
else bad('and inline script stays refused', withTurnstile);
if (csp({ authOrigin: 'http://localhost:8000', turnstile: false }).includes('connect-src \'self\' wss: https: http://localhost:8000')) ok('a laptop control plane joins connect-src only', 'GC_AUTH_ORIGIN');
else bad('a laptop control plane joins connect-src only', csp({ authOrigin: 'http://localhost:8000', turnstile: false }));

// ---------------------------------------------------------------------------
console.log('\n— Python signs it, Node checks it —————————————————————');

/**
 * The only assertion here that cannot be made on one side alone.
 *
 * Both implement EdDSA-over-JWT from their own libraries — no shared package,
 * by design — so "we both wrote a JWT" is a claim nothing verifies until a
 * token crosses. Unpadded base64url and the kid derivation are the two
 * places this diverges, and both fail silently at every login rather than at
 * either project's tests.
 */
const AUTH_DIR = join(ROOT, 'auth');
const python = spawnSync('python3', ['-c',
  'import sys; sys.path.insert(0, ".");\n'
  + 'from accounts.tokens import mint, kid_of, load_private\n'
  + 'import os\n'
  + 'print(kid_of(load_private(os.environ["K"])))\n'
  + 'print(mint(subject=42, email="qa@example.com", key=os.environ["K"], ttl=600,\n'
  + '           org="acme", role="admin", plan="team", ent={"suites.max": 25, "vault.enabled": True, "runs.per_day": None}, ent_v=7,\n'
  + '           amr=["otp", "password"], auth_time=1, su=2, sid="s"))',
], { cwd: AUTH_DIR, encoding: 'utf8', env: { ...process.env, K: PRIVATE_PEM } });

if (!existsSync(AUTH_DIR)) {
  skip('the control plane is not in this checkout', 'auth/ is absent');
} else if (python.error || python.status !== 0) {
  // A missing python3 is not a broken contract, so it is a visible skip and
  // not a failure — but it is never silent, because the half it covers is the
  // half neither project can test alone.
  skip('python3 could not mint a token', (python.stderr || python.error?.message || '').trim().split('\n').pop());
} else {
  const [pyKid, minted] = python.stdout.trim().split(/\r?\n/);
  if (pyKid === KID) ok('Python and Node derive the same kid from one key', KID.slice(0, 12));
  else bad('Python and Node derive the same kid from one key', `python=${pyKid} node=${KID}`);
  try {
    const claims = verify(minted, KEYS);
    if (claims.sub === '42' && claims.email === 'qa@example.com' && claims.iss === 'ghostclick-control' && claims.aud === 'ghostclick-runner') {
      ok('Django mints a token this runner accepts', `sub=${claims.sub} kid=${KID.slice(0, 8)}`);
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
    // The plan's name rides along for the 402 the runner answers with
    // ({error: 'entitlement', limit, plan}); nothing is decided by it.
    if (claims.plan === 'team') ok('and the plan’s name, for the refusals', `plan=${claims.plan}`);
    else bad('and the plan’s name, for the refusals', JSON.stringify(claims.plan));
    /**
     * amr is a LIST of the methods used (docs/AUTH.md §8): a second factor
     * rides beside the password, in the runner's vocabulary, and the runner
     * reads su — never amr — to decide step-up; but a runner that later
     * wants to know whether a session proved a second factor must find the
     * word here, not a joined string or the last one only.
     */
    if (Array.isArray(claims.amr) && claims.amr.length === 2 && claims.amr.includes('password') && claims.amr.includes('otp')
        && claims.auth_time === 1 && claims.su === 2 && claims.sid === 's' && typeof claims.jti === 'string') {
      ok('and amr, auth_time, su, sid and jti', `amr=${claims.amr} su=${claims.su}`);
    } else bad('and amr, auth_time, su, sid and jti', JSON.stringify({ amr: claims.amr, auth_time: claims.auth_time, su: claims.su, sid: claims.sid, jti: claims.jti }));
  } catch (err) {
    bad('Django mints a token this runner accepts', err.message);
  }
  // And the key actually matters, rather than both sides ignoring it.
  refuses('a Django token is refused under another key set', minted, parseKeys(JSON.stringify({ [KID]: other.publicKey.export({ type: 'spki', format: 'pem' }) })));
}

// ---------------------------------------------------------------------------
console.log('\n— the control plane’s own tests ————————————————————');

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
    env: { ...process.env, DJANGO_DEBUG: '1' },
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
console.log('\n— the reach of the driven page ————————————————————————');

const PRIVATE = ['127.0.0.1', '127.9.9.9', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
                 '169.254.169.254', '169.254.1.1', '0.0.0.0', '100.100.100.100', '::1', '::', 'fe80::1', 'fd00::1',
                 '::ffff:10.0.0.1', '[::1]'];
const PUBLIC = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '192.169.0.1', '100.128.0.1', '2606:4700::1111'];
const wrongPrivate = PRIVATE.filter((a) => !isPrivateAddress(a));
const wrongPublic = PUBLIC.filter((a) => isPrivateAddress(a));
if (!wrongPrivate.length) ok('every loopback, private and link-local address is refused', `${PRIVATE.length} literals`);
else bad('every loopback, private and link-local address is refused', wrongPrivate.join(' '));
if (!wrongPublic.length) ok('and public addresses are not', `${PUBLIC.length} literals`);
else bad('and public addresses are not', wrongPublic.join(' '));

const NAMES = ['localhost', 'LOCALHOST', 'foo.localhost', 'control', 'runner', 'redis', 'postgres', 'caddy',
               'postgres.internal', 'api.corp.internal', 'printer.local', 'redis.'];
const OK_NAMES = ['example.com', 'control.example.com', 'redis.example.com', 'internal.example.com', 'localdomain.example.com'];
const missedNames = NAMES.filter((n) => !blockedName(n));
const overNames = OK_NAMES.filter((n) => blockedName(n));
if (!missedNames.length) ok('bare compose hostnames, *.internal and *.local are refused by name', `${NAMES.length} names`);
else bad('bare compose hostnames, *.internal and *.local are refused by name', missedNames.join(' '));
if (!overNames.length) ok('and ordinary hostnames are not', `${OK_NAMES.length} names`);
else bad('and ordinary hostnames are not', overNames.join(' '));

// The resolver half, with a fake resolver so no DNS is needed: a public
// name that answers with a private address is caught as the address.
const fakeDns = async (host) => (host === 'rebind.example.com' ? [{ address: '169.254.169.254', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]);
const rebound = await blocked('http://rebind.example.com/latest/meta-data/', fakeDns);
if (rebound && /169\.254\.169\.254/.test(rebound)) ok('a public name resolving to a private address is refused', rebound);
else bad('a public name resolving to a private address is refused', String(rebound));
if ((await blocked('https://www.example.com/', fakeDns)) === null) ok('and one resolving publicly is allowed');
else bad('and one resolving publicly is allowed');
if ((await blocked('http://169.254.169.254/latest/meta-data/')) && (await blocked('http://[::1]:8000/')) && (await blocked('http://control:8000/auth/me'))) {
  ok('literals and bare names never reach the resolver');
} else bad('literals and bare names never reach the resolver');
if ((await blocked('data:text/html,hi')) === null) ok('and a data: URL is not the network');
else bad('and a data: URL is not the network');

// ---------------------------------------------------------------------------
console.log('\n— a signing key stops the runner ——————————————————————');

/**
 * The cutover is one-directional. A GC_AUTH_SECRET in the environment means
 * a deployment half moved, with the old shared key still lying next to the
 * browser; the runner refuses to start rather than ignore it.
 */
const withSecret = spawnSync(process.execPath, [join(ROOT, 'scripts/start.js')], {
  cwd: ROOT, timeout: 25000, encoding: 'utf8',
  env: { ...process.env, PORT: '3405', GC_SKIP_BUILD: '1', GC_AUTH_SECRET: 'check-auth-secret-long-enough-for-hmac-0123456789' },
});
if (withSecret.status !== 0 && /must not hold a signing key/.test(withSecret.stderr ?? '')) {
  ok('GC_AUTH_SECRET in the environment refuses to start', `exit ${withSecret.status}`);
} else {
  bad('GC_AUTH_SECRET in the environment refuses to start', `exit ${withSecret.status} — the old shared key was tolerated`);
}
const badKeys = spawnSync(process.execPath, [join(ROOT, 'scripts/start.js')], {
  cwd: ROOT, timeout: 25000, encoding: 'utf8',
  env: { ...process.env, PORT: '3405', GC_SKIP_BUILD: '1', GC_AUTH_PUBLIC_KEYS: JSON.stringify({ k: PRIVATE_PEM }), GC_WEB_ORIGIN: 'http://127.0.0.1:3405' },
});
if (badKeys.status !== 0 && /must not hold a signing key/.test(badKeys.stderr ?? '')) {
  ok('a private key in GC_AUTH_PUBLIC_KEYS refuses to start', `exit ${badKeys.status}`);
} else {
  bad('a private key in GC_AUTH_PUBLIC_KEYS refuses to start', `exit ${badKeys.status}`);
}
const noOrigin = spawnSync(process.execPath, [join(ROOT, 'scripts/start.js')], {
  cwd: ROOT, timeout: 25000, encoding: 'utf8',
  env: { ...process.env, PORT: '3405', GC_SKIP_BUILD: '1', GC_AUTH_PUBLIC_KEYS: JSON.stringify({ [KID]: PUBLIC_PEM }), GC_WEB_ORIGIN: '' },
});
if (noOrigin.status !== 0 && /GC_WEB_ORIGIN/.test(noOrigin.stderr ?? '')) {
  ok('auth on with no GC_WEB_ORIGIN refuses to start', 'no origin to check sockets against');
} else {
  bad('auth on with no GC_WEB_ORIGIN refuses to start', `exit ${noOrigin.status}`);
}

// ---------------------------------------------------------------------------
console.log('\n— the gate, on a running runner ———————————————————————');

const PORT = Number(process.env.GC_AUTH_PORT) || 3404;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = BASE;
const child = spawn(process.execPath, [join(ROOT, 'scripts/start.js')], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env, PORT: String(PORT), GC_SKIP_BUILD: '1', HOME_URL: '',
    GC_AUTH_PUBLIC_KEYS: JSON.stringify({ [KID]: PUBLIC_PEM }), GC_WEB_ORIGIN: ORIGIN,
  },
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });

const token = sign(claimsFor());
const auth = { authorization: `Bearer ${token}` };
const ticketFor = async (tok = token) => {
  const r = await fetch(`${BASE}/api/socket-ticket`, { method: 'POST', headers: { authorization: `Bearer ${tok}` } });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
/** Open a socket; resolve with 'open' or the refusal, and the socket when open. */
const socket = (query, { origin = ORIGIN } = {}) => new Promise((res) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws${query}`, origin ? { origin } : {});
  const done = (r) => res({ r, ws });
  ws.on('open', () => done('open'));
  ws.on('error', (e) => done(e.message));
  setTimeout(() => done('timed out'), 8000);
});
const closedWith = (ws) => new Promise((res) => {
  if (ws.readyState === WebSocket.CLOSED) return res(ws._closeCode ?? 'closed');
  ws.on('close', (code) => res(code));
  setTimeout(() => res('still open'), 8000);
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
    if (/auth *-> *on/.test(out) && out.includes(KID)) ok('and says so at boot, naming the key', `auth -> on; ${KID.slice(0, 12)}…`);
    else bad('and says so at boot, naming the key', (out.split('\n').find((l) => l.includes('auth')) ?? '(no line)').trim());

    const anon = await fetch(`${BASE}/api/state`);
    if (anon.status === 401) ok('/api without a token is 401', (await anon.json()).error);
    else bad('/api without a token is 401', String(anon.status));

    const withTok = await fetch(`${BASE}/api/state`, { headers: auth });
    if (withTok.ok) ok('/api with one is allowed', '200');
    else bad('/api with one is allowed', String(withTok.status));

    const stale = await fetch(`${BASE}/api/state`, { headers: { authorization: `Bearer ${sign(claimsFor({ iat: nowS() - 4000, exp: nowS() - 3600 }))}` } });
    if (stale.status === 401) ok('an expired token is 401 at the door', (await stale.json()).error);
    else bad('an expired token is 401 at the door', String(stale.status));

    const hs = await fetch(`${BASE}/api/state`, { headers: { authorization: `Bearer ${hs256(claimsFor())}` } });
    if (hs.status === 401) ok('and so is an HS256 token', (await hs.json()).error);
    else bad('and so is an HS256 token', String(hs.status));

    // The headers every response carries (docs/AUTH.md §11).
    for (const [label, path, headers] of [['the UI', '/app/', {}], ['the API', '/api/state', auth]]) {
      const r = await fetch(BASE + path, { headers });
      const csp = r.headers.get('content-security-policy') ?? '';
      const want = [
        ["frame-ancestors 'none'", /frame-ancestors 'none'/.test(csp)],
        ["default-src 'self'", /default-src 'self'/.test(csp)],
        ['X-Frame-Options DENY', r.headers.get('x-frame-options') === 'DENY'],
        ['nosniff', r.headers.get('x-content-type-options') === 'nosniff'],
        ['Referrer-Policy', r.headers.get('referrer-policy') === 'strict-origin-when-cross-origin'],
        ['Permissions-Policy', /camera=\(\)/.test(r.headers.get('permissions-policy') ?? '')],
      ];
      const lacking = want.filter(([, has]) => !has).map(([n]) => n);
      if (!lacking.length) ok(`${label} carries the security headers`, `CSP, frame, nosniff, referrer, permissions`);
      else bad(`${label} carries the security headers`, `missing ${lacking.join(', ')}`);
    }
    const cors = await fetch(`${BASE}/api/state`, { headers: { ...auth, origin: 'https://evil.example' } });
    if (!cors.headers.get('access-control-allow-origin')) ok('no wildcard CORS with auth on', 'another origin gets no allow-origin at all');
    else bad('no wildcard CORS with auth on', cors.headers.get('access-control-allow-origin'));
    const corsOk = await fetch(`${BASE}/api/state`, { headers: { ...auth, origin: ORIGIN } });
    if (corsOk.headers.get('access-control-allow-origin') === ORIGIN) ok('and the app origin is echoed', ORIGIN);
    else bad('and the app origin is echoed', String(corsOk.headers.get('access-control-allow-origin')));

    // The socket. What rides in the URL is a ticket, and only a ticket.
    const { r: noTicket } = await socket('');
    if (/401/.test(noTicket)) ok('the socket refuses an upgrade with no ticket', noTicket);
    else bad('the socket refuses an upgrade with no ticket', noTicket);

    const { r: jwtInUrl } = await socket(`?t=${encodeURIComponent(token)}`);
    if (/401/.test(jwtInUrl)) ok('and a JWT in the URL, even a valid one', jwtInUrl);
    else bad('and a JWT in the URL, even a valid one', jwtInUrl);

    const t1 = await ticketFor();
    if (t1.status === 200 && typeof t1.ticket === 'string' && t1.ticket.length >= 43 && t1.expiresIn === 30) ok('a Bearer buys a 30-second ticket', `${t1.ticket.length} chars`);
    else bad('a Bearer buys a 30-second ticket', JSON.stringify(t1));
    const anonTicket = await fetch(`${BASE}/api/socket-ticket`, { method: 'POST' });
    if (anonTicket.status === 401) ok('and nothing else does', '401 without a token');
    else bad('and nothing else does', String(anonTicket.status));

    const { r: wrongOrigin } = await socket(`?ticket=${t1.ticket}`, { origin: 'https://evil.example' });
    if (/403/.test(wrongOrigin)) ok('a ticket from another origin is refused', wrongOrigin);
    else bad('a ticket from another origin is refused', wrongOrigin);
    const { r: noOriginAtAll } = await socket(`?ticket=${t1.ticket}`, { origin: null });
    if (/403/.test(noOriginAtAll)) ok('and with no Origin at all', noOriginAtAll);
    else bad('and with no Origin at all', noOriginAtAll);

    const { r: opened, ws: live } = await socket(`?ticket=${t1.ticket}`);
    if (opened === 'open') ok('and accepted from the app origin', 'open');
    else bad('and accepted from the app origin', opened);
    // The greeting names the organisation and its lock, and never the
    // vault's key names: those come from /api/state under the token
    // (docs/AUTH.md §9.6 [websocket-3]).
    if (opened === 'open') {
      const greeting = await new Promise((res) => {
        live.on('message', (d, bin) => { if (!bin) { const ev = JSON.parse(d); if (ev.t === 'ready') res(ev); } });
        setTimeout(() => res(null), 4000);
      });
      if (greeting && !('secrets' in greeting) && greeting.org === 'acme' && greeting.driving && Array.isArray(greeting.origins)) {
        ok('the greeting names the organisation and carries no vault names', `org=${greeting.org}`);
      } else bad('the greeting names the organisation and carries no vault names', JSON.stringify(greeting));
    }
    const { r: reused } = await socket(`?ticket=${t1.ticket}`);
    if (/401/.test(reused)) ok('a ticket presented twice is refused', reused);
    else bad('a ticket presented twice is refused', reused);
    const { r: forged } = await socket(`?ticket=${'A'.repeat(43)}`);
    if (/401/.test(forged)) ok('and a ticket nobody issued', forged);
    else bad('and a ticket nobody issued', forged);

    // bye: the socket is dropped at once.
    if (opened === 'open') {
      live.send(JSON.stringify({ t: 'bye' }));
      const code = await closedWith(live);
      if (code === 1000) ok('{t:"bye"} closes the socket immediately', `code ${code}`);
      else bad('{t:"bye"} closes the socket immediately', String(code));
    }

    // At most five outstanding tickets per subject.
    const bought = [];
    for (let i = 0; i < 5; i++) bought.push(await ticketFor());
    const sixth = await ticketFor();
    if (bought.every((b) => b.status === 200) && sixth.status === 429) ok('a sixth outstanding ticket is refused', '429');
    else bad('a sixth outstanding ticket is refused', `${bought.map((b) => b.status)} then ${sixth.status}`);

    // At most three live sockets per subject; a fourth closes the oldest.
    const socks = [];
    for (const b of bought.slice(0, 4)) socks.push((await socket(`?ticket=${b.ticket}`)).ws);
    const oldest = await closedWith(socks[0]);
    if (oldest === 4409 && socks.slice(1).every((s) => s.readyState === WebSocket.OPEN)) ok('a fourth socket closes the oldest', `code ${oldest}`);
    else bad('a fourth socket closes the oldest', `oldest ${oldest}; others ${socks.slice(1).map((s) => s.readyState)}`);
    for (const s of socks) { try { s.close(); } catch { /* gone */ } }
    await wait(200);

    // The socket dies with its token.
    const dying = sign(claimsFor({ exp: nowS() + 2 }));
    const short = await ticketFor(dying);
    const { r: openedShort, ws: shortWs } = await socket(`?ticket=${short.ticket}`);
    if (openedShort === 'open') {
      const code = await closedWith(shortWs);
      if (code === 4401) ok('a socket closes at its token’s exp with 4401', `code ${code}`);
      else bad('a socket closes at its token’s exp with 4401', String(code));
    } else bad('a socket closes at its token’s exp with 4401', openedShort);

    // maxPayload: a megabyte is a generous bound on a command.
    const big = await ticketFor();
    const { r: openedBig, ws: bigWs } = await socket(`?ticket=${big.ticket}`);
    if (openedBig === 'open') {
      bigWs.send(JSON.stringify({ t: 'command', text: 'x'.repeat(2 * 1024 * 1024) }));
      const code = await closedWith(bigWs);
      if (code === 1009) ok('a 2 MiB message closes the socket', `code ${code}`);
      else bad('a 2 MiB message closes the socket', String(code));
    } else bad('a 2 MiB message closes the socket', openedBig);

    // Step-up: allowing an origin needs a recent authentication, on both paths.
    const staleSu = sign(claimsFor({ su: nowS() - 1 }));
    const refused = await fetch(`${BASE}/api/origins`, { method: 'POST', headers: { ...auth, authorization: `Bearer ${staleSu}`, 'content-type': 'application/json' }, body: JSON.stringify({ origin: 'https://example.com' }) });
    if (refused.status === 403 && (await refused.json()).error === 'step_up_required') ok('POST /api/origins past su is 403 step_up_required');
    else bad('POST /api/origins past su is 403 step_up_required', String(refused.status));
    const fresh = await fetch(`${BASE}/api/origins`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ origin: 'https://example.com' }) });
    if (fresh.ok) ok('and within su it is allowed', '200');
    else bad('and within su it is allowed', String(fresh.status));
    const sT = await ticketFor(staleSu);
    const { r: openedStale, ws: staleWs } = await socket(`?ticket=${sT.ticket}`);
    if (openedStale === 'open') {
      const got = await new Promise((res) => {
        staleWs.on('message', (d, bin) => { if (!bin) { const ev = JSON.parse(d); if (ev.t === 'refused') res(ev); } });
        staleWs.send(JSON.stringify({ t: 'origin.add', origin: 'https://another.example' }));
        setTimeout(() => res(null), 4000);
      });
      if (got?.error === 'step_up_required' && got.of === 'origin.add') ok('and origin.add over the socket says the same', 'refused: step_up_required');
      else bad('and origin.add over the socket says the same', JSON.stringify(got));
      staleWs.close();
    } else bad('and origin.add over the socket says the same', openedStale);

    // The driven page's reach, on the real browser: this runner's own
    // loopback is the nearest private address there is.
    const meT = await ticketFor();
    const { r: openedMe, ws: meWs } = await socket(`?ticket=${meT.ticket}`);
    if (openedMe === 'open') {
      await fetch(`${BASE}/api/origins`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ origin: BASE }) });
      const blockedLine = await new Promise((res) => {
        meWs.on('message', (d, bin) => { if (!bin) { const ev = JSON.parse(d); if (ev.t === 'log' && /blocked .*private address/.test(ev.msg)) res(ev.msg); } });
        meWs.send(JSON.stringify({ t: 'open', url: `${BASE}/app/` }));
        setTimeout(() => res(null), 15000);
      });
      if (blockedLine) ok('the driven page cannot reach a private address', blockedLine.slice(0, 60));
      else bad('the driven page cannot reach a private address', 'the navigation to 127.0.0.1 was not aborted');
      meWs.close();
    } else bad('the driven page cannot reach a private address', openedMe);

    /**
     * What must NOT be gated: the UI has to load in order to render a login
     * form. What must not be SERVED: the demo fixtures, which exist to be
     * driven and have no business on a gated runner (GC_DEMO=1 to serve them).
     */
    const ui = await fetch(`${BASE}/app/`);
    if (ui.ok) ok('the UI still loads', `${ui.status} /app/`);
    else bad('the UI still loads', `${ui.status} — a login screen you cannot reach`);
    for (const path of ['/demo.html', '/go/tracked', '/pricing.html']) {
      const r = await fetch(BASE + path, { redirect: 'manual' });
      if (r.status === 404) ok(`the fixtures are not served with auth on`, `${r.status} ${path}`);
      else bad(`the fixtures are not served with auth on`, `${r.status} ${path}`);
    }
    const state = await (await fetch(`${BASE}/api/state`, { headers: auth })).json();
    if (!state.origins.includes(`http://localhost:${PORT}`)) ok('and the runner’s own origin is not seeded as drivable');
    else bad('and the runner’s own origin is not seeded as drivable', state.origins.join(' '));

    // The extension hand-off is under the gate like everything else.
    const rec = await fetch(`${BASE}/api/recording`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flow: 'testcase TD\n  a(("http://evil.example.com/")) --> b' }),
    });
    if (rec.status === 401) ok('POST /api/recording is gated', '401 without a token');
    else bad('POST /api/recording is gated', `${rec.status} — the hand-off is open`);
    const recTok = await fetch(`${BASE}/api/recording`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ flow: 'testcase TD\n  a(("http://evil.example.com/")) --> b' }),
    });
    if (recTok.status === 400) ok('and with a token it is still origin-gated', '400');
    else bad('and with a token it is still origin-gated', `${recTok.status} — expected the origin gate`);

    // The origins allowed above were persisted to .ghostclick/acme/origins.json
    // — the organisation the throwaway token names — which a runner started
    // from this checkout reads for that organisation. Leave it as it was
    // found: a check that leaves an allowed origin behind has quietly
    // widened the gate for the next person to sign in as it.
    for (const origin of ['https://example.com', BASE]) {
      await fetch(`${BASE}/api/origins`, { method: 'DELETE', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ origin }) });
    }
  }
} catch (err) {
  // A crash mid-way is itself the finding: the runner must survive every
  // shape above, and the last lines of its output say what it did not survive.
  bad('the runner survived the gate checks', [err.message, ...out.trim().split(/\r?\n/).slice(-8)].join(' | '));
} finally {
  child.kill('SIGTERM');
  await wait(300);
  child.kill('SIGKILL');
}

console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — forgeries are refused, a token minted in Python verifies in Node,\n'
    + '       the driven page cannot reach inward, and a gated runner turns away\n'
    + '       an API call, a socket with no ticket, a spent ticket, a token in a\n'
    + '       URL and a foreign origin, while still serving the UI.\n');
process.exit(failures ? 1 : 0);
