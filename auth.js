/**
 * Who is allowed to drive this browser.
 *
 * The executor does not know about users, passwords, sessions or SSO, and that
 * is the point. Django owns identity; this file verifies one short-lived token
 * Django signed, and nothing else. The split matters because the thing on the
 * other side of this check is a real Chromium that will go wherever it is told
 * — so the smaller and more boring the check, the better.
 *
 * VERIFY ONLY. This process holds PUBLIC keys and nothing else. There is no
 * way to mint a token here, and there cannot be one: an executor that can sign
 * its own credentials is an executor that can authorise itself, which makes
 * the whole exercise theatre. A compromised runner can misuse the browser it
 * already owns; it cannot become anybody (docs/AUTH.md §8 [token-1]).
 *
 * The token is an EdDSA JWT over Ed25519: base64url(header).base64url(claims)
 * and a signature over the first two. It is verified with node:crypto rather
 * than a JWT package, on purpose: this process drives a browser and has four
 * dependencies, and the risky part of JWT is not the arithmetic, it is the
 * checks below that libraries have historically got wrong. Doing them
 * explicitly beats trusting that a package's defaults are the ones you wanted.
 *
 *   1. The algorithm is PINNED. `alg` is read from the token, which means an
 *      attacker chooses it — "none" and the key-confusion trick are both that
 *      one fact. Nothing here branches on `alg`: it must equal EdDSA or the
 *      token is refused, and there is no HMAC code path in this file to
 *      confuse it with [token-2].
 *   2. The KEY is chosen by `kid`, from the set this process was started
 *      with. A kid it was not given is a refusal, not a lookup.
 *   3. `exp` is REQUIRED, and so are iss, aud, sub, org and iat. A missing
 *      expiry read as "no expiry" turns a ten-minute token into a permanent
 *      one; a missing audience lets a token meant for something else in.
 *   4. The LIFETIME is bounded. `exp - iat` above 660 seconds is refused even
 *      when the signature is good: the control plane clamps to 600, so a
 *      longer one was not minted by it [token-4].
 */
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

/** Tokens live ~10 minutes; a minute of clock drift between two hosts is normal. */
const SKEW_MS = 60_000;

/** The control plane mints for at most 600 s; the skew allowance is the rest. */
export const MAX_LIFETIME_S = 660;

export const ISSUER = 'ghostclick-control';
export const AUDIENCE = 'ghostclick-runner';

export class AuthError extends Error {
  constructor(message) { super(message); this.name = 'AuthError'; }
}

const b64urlDecode = (s) => Buffer.from(s, 'base64url');

/**
 * The public key set out of GC_AUTH_PUBLIC_KEYS: JSON {kid: pem}.
 *
 * Every entry must be an Ed25519 public key, checked here rather than at the
 * first token: an RSA key in the set would make every token a "bad
 * signature", which reads as a broken login rather than the wrong key.
 *
 * Tolerant of one thing: a PEM whose newlines arrived as real newlines
 * inside the JSON string (an env file read through double quotes turns the
 * `\n` escapes into characters JSON does not allow in a string). Those are
 * re-escaped before parsing, so the quoting style cannot break a deploy.
 *
 * @param {string|undefined} json
 * @returns {Map<string, import('node:crypto').KeyObject>}
 */
export function parseKeys(json) {
  const keys = new Map();
  const text = String(json ?? '').trim();
  if (!text) return keys;
  let set;
  try { set = JSON.parse(text); } catch {
    try { set = JSON.parse(text.replace(/\r?\n/g, '\\n')); } catch {
      throw new AuthError('GC_AUTH_PUBLIC_KEYS is not JSON');
    }
  }
  if (!set || typeof set !== 'object' || Array.isArray(set)) throw new AuthError('GC_AUTH_PUBLIC_KEYS must be a JSON object of {kid: pem}');
  for (const [kid, pem] of Object.entries(set)) {
    if (!kid || typeof pem !== 'string') throw new AuthError(`GC_AUTH_PUBLIC_KEYS: ${JSON.stringify(kid)} is not a kid with a PEM`);
    // Checked on the text, because createPublicKey() will happily DERIVE a
    // public key from a private PEM and report it as public — which would
    // accept a set that put signing material next to the browser.
    if (/PRIVATE KEY/.test(pem)) throw new AuthError(`GC_AUTH_PUBLIC_KEYS: ${kid} is a private key — this process must not hold a signing key`);
    let key;
    try { key = createPublicKey(pem.replace(/\\n/g, '\n')); } catch (err) {
      throw new AuthError(`GC_AUTH_PUBLIC_KEYS: the key ${kid} is not a readable PEM public key (${err.message})`);
    }
    if (key.asymmetricKeyType !== 'ed25519') throw new AuthError(`GC_AUTH_PUBLIC_KEYS: the key ${kid} is ${key.asymmetricKeyType}, not ed25519`);
    if (key.type !== 'public') throw new AuthError(`GC_AUTH_PUBLIC_KEYS: ${kid} is not a public key`);
    keys.set(kid, key);
  }
  return keys;
}

/**
 * The token out of an Authorization header, or null.
 *
 * Case-insensitive scheme because "bearer" is legal and proxies rewrite things.
 * Returning null rather than throwing keeps "no credentials" and "bad
 * credentials" separable — they deserve different messages.
 */
export function bearer(header) {
  const m = /^Bearer[ ]+(\S+)$/i.exec(String(header ?? '').trim());
  return m ? m[1] : null;
}

const isInt = (v) => typeof v === 'number' && Number.isFinite(v);
const nonEmpty = (v) => typeof v === 'string' && v.length > 0;

/**
 * Verify a token and return its claims, or throw AuthError.
 *
 * @param {string} token   the compact JWT
 * @param {Map<string, import('node:crypto').KeyObject>} keys   from parseKeys()
 * @param {number} now     ms since epoch; injectable so expiry is testable
 * @returns {object} the claims
 */
export function verify(token, keys, now = Date.now()) {
  if (!(keys instanceof Map) || keys.size === 0) {
    // Never fall back to "no keys means accept". An empty set is auth OFF,
    // and auth OFF never reaches this function.
    throw new AuthError('no public keys are configured, so no token can be accepted');
  }
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) throw new AuthError('not a token');
  const [h, p, sig] = parts;
  if (!h || !p || !sig) throw new AuthError('not a token');

  let header;
  try { header = JSON.parse(b64urlDecode(h)); } catch { throw new AuthError('unreadable header'); }
  if (!header || typeof header !== 'object') throw new AuthError('unreadable header');

  // (1) Pinned. The token does not get to choose how it is checked.
  if (header.alg !== 'EdDSA') throw new AuthError(`unsupported algorithm ${JSON.stringify(header.alg)}`);
  if (header.typ != null && header.typ !== 'JWT') throw new AuthError('unexpected token type');

  // (2) The key is the one the kid names, from the set this process was
  //     given. Not "try every key": a kid is the rotation mechanism, and a
  //     token that cannot say which key signed it was not minted by us.
  if (!nonEmpty(header.kid)) throw new AuthError('the token names no key (kid)');
  const key = keys.get(header.kid);
  if (!key) throw new AuthError(`unknown key ${header.kid}`);

  let signature;
  try { signature = b64urlDecode(sig); } catch { throw new AuthError('bad signature'); }
  // Ed25519 signatures are exactly 64 bytes; anything else is a definitive no
  // before any arithmetic is done.
  if (signature.length !== 64) throw new AuthError('bad signature');
  let good = false;
  try { good = cryptoVerify(null, Buffer.from(`${h}.${p}`, 'ascii'), key, signature); } catch { good = false; }
  if (!good) throw new AuthError('bad signature');

  let claims;
  try { claims = JSON.parse(b64urlDecode(p)); } catch { throw new AuthError('unreadable claims'); }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new AuthError('unreadable claims');

  // (3) Required, not optional.
  if (claims.iss !== ISSUER) throw new AuthError('the token was not issued by the control plane');
  if (claims.aud !== AUDIENCE) throw new AuthError('the token is not for this runner');
  if (!nonEmpty(claims.sub)) throw new AuthError('the token names no one');
  if (!nonEmpty(claims.org)) throw new AuthError('the token names no organisation');
  if (!isInt(claims.iat)) throw new AuthError('the token does not say when it was issued');
  if (!isInt(claims.exp)) throw new AuthError('the token does not say when it expires');

  // (4) Time, both directions, and the lifetime between them.
  if (claims.exp * 1000 + SKEW_MS < now) throw new AuthError('the token has expired');
  // A token dated well into the future is either a broken clock or a forgery
  // trying to outlive its window; neither should be honoured.
  if (claims.iat * 1000 - SKEW_MS > now) throw new AuthError('the token is dated in the future');
  if (claims.exp - claims.iat > MAX_LIFETIME_S) {
    throw new AuthError(`the token claims to live ${claims.exp - claims.iat}s; the control plane never mints more than ${MAX_LIFETIME_S}`);
  }
  if (claims.nbf != null) {
    if (!isInt(claims.nbf)) throw new AuthError('unreadable nbf');
    if (claims.nbf * 1000 - SKEW_MS > now) throw new AuthError('the token is not valid yet');
  }

  return claims;
}
