/**
 * Who is allowed to drive this browser.
 *
 * The executor does not know about users, passwords, sessions or SSO, and that
 * is the point. Django owns identity; this file verifies one short-lived token
 * Django signed, and nothing else. The split matters because the thing on the
 * other side of this check is a real Chromium that will go wherever it is told
 * — so the smaller and more boring the check, the better.
 *
 * VERIFY ONLY. There is deliberately no way to mint a token here. An executor
 * that can sign its own credentials is an executor that can authorise itself,
 * which makes the whole exercise theatre. The signing key exists here solely to
 * recompute a MAC over bytes someone else produced.
 *
 * The token is an HS256 JWT, which is a standard format and also — once you
 * strip the folklore — base64url(header).base64url(payload).HMAC-SHA256 of the
 * first two. It is verified with node:crypto rather than a JWT package, on
 * purpose: this process drives a browser and has four dependencies, and the
 * risky part of JWT is not the arithmetic, it is the three checks below that
 * libraries have historically got wrong. Doing them explicitly beats trusting
 * that a package's defaults are the ones you wanted.
 *
 *   1. The algorithm is PINNED. `alg` is read from the token, which means an
 *      attacker chooses it — "none" and the RS256/HS256 confusion trick are
 *      both that one fact. Nothing here branches on `alg`; it must equal HS256
 *      or the token is refused.
 *   2. The comparison is TIMING-SAFE. A byte-at-a-time `===` on a MAC leaks
 *      how much of a forgery is correct, which is enough to build the rest.
 *   3. `exp` is REQUIRED. A missing expiry read as "no expiry" turns a
 *      ten-minute token into a permanent one.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Tokens live ~10 minutes; a minute of clock drift between two hosts is normal. */
const SKEW_MS = 60_000;

/**
 * Short secrets are the failure this catches: HMAC is only as strong as its
 * key, and "secret" or "changeme" reaching production is the realistic way this
 * ends badly rather than anything cryptographic.
 */
export const MIN_SECRET = 32;

export class AuthError extends Error {
  constructor(message) { super(message); this.name = 'AuthError'; }
}

const b64urlDecode = (s) => Buffer.from(s, 'base64url');

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

/**
 * Verify a token and return its claims, or throw AuthError.
 *
 * @param {string} token   the compact JWT
 * @param {string} secret  GC_AUTH_SECRET, shared with Django
 * @param {number} now     ms since epoch; injectable so expiry is testable
 * @returns {object} the claims
 */
export function verify(token, secret, now = Date.now()) {
  if (!secret || secret.length < MIN_SECRET) {
    // Never fall back to a default. A weak shared secret that still "works" is
    // the failure nobody notices, because everything looks authenticated.
    throw new AuthError(`the signing secret is missing or shorter than ${MIN_SECRET} characters`);
  }
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) throw new AuthError('not a token');
  const [h, p, sig] = parts;
  if (!h || !p || !sig) throw new AuthError('not a token');

  let header;
  try { header = JSON.parse(b64urlDecode(h)); } catch { throw new AuthError('unreadable header'); }

  // (1) Pinned. The token does not get to choose how it is checked.
  if (header?.alg !== 'HS256') throw new AuthError(`unsupported algorithm ${JSON.stringify(header?.alg)}`);
  if (header?.typ != null && header.typ !== 'JWT') throw new AuthError('unexpected token type');

  // (2) Timing-safe. timingSafeEqual throws on differing lengths, and a length
  //     mismatch is already a definitive no, so check it first rather than
  //     letting the exception decide.
  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const given = b64urlDecode(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new AuthError('bad signature');
  }

  let claims;
  try { claims = JSON.parse(b64urlDecode(p)); } catch { throw new AuthError('unreadable claims'); }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new AuthError('unreadable claims');

  // (3) Required, not optional.
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
    throw new AuthError('the token does not say when it expires');
  }
  if (claims.exp * 1000 + SKEW_MS < now) throw new AuthError('the token has expired');

  // A token dated well into the future is either a broken clock or a forgery
  // trying to outlive its window; neither should be honoured.
  if (typeof claims.iat === 'number' && claims.iat * 1000 - SKEW_MS > now) {
    throw new AuthError('the token is dated in the future');
  }
  if (!claims.sub) throw new AuthError('the token names no one');

  return claims;
}
