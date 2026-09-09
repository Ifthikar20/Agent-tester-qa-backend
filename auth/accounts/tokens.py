"""
Minting the token the executor will check.

An HS256 JWT, built from the standard library. No PyJWT, for the same reason
the executor uses node:crypto rather than a JWT package: signing is
HMAC-SHA256 over two base64url segments, and the half that is genuinely easy to
get wrong is verification — which is on the other side, written out explicitly,
and tested against tokens minted here.

The contract, which auth.js on the executor enforces:

  header    {"alg":"HS256","typ":"JWT"}      alg is pinned there, not read
  claims    sub, email, scope, iat, exp      exp is required, ~10 minutes
  signature HMAC-SHA256 over "header.claims", base64url, unpadded

Short-lived on purpose. The token travels in a WebSocket query string, because
a browser cannot set headers when opening a socket; ten minutes bounds what a
URL that leaks into a log or a referrer is worth.
"""
import base64
import hashlib
import hmac
import json
import time

ALGORITHM = 'HS256'
MIN_SECRET = 32          # must match MIN_SECRET in the executor's auth.js


class NoSigningKey(RuntimeError):
    """Raised rather than falling back to a default nobody would notice."""


def _b64(raw: bytes) -> str:
    """base64url, unpadded — what the JWT wire format specifies."""
    return base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')


def _segment(obj) -> str:
    # Compact and key-sorted so the same claims always produce the same bytes.
    # Nothing depends on that cryptographically; it makes a token diffable when
    # you are staring at two of them wondering why one is refused.
    return _b64(json.dumps(obj, separators=(',', ':'), sort_keys=True).encode('utf-8'))


def mint(*, subject, email='', scope='run', admin=False, secret, ttl=600, now=None) -> str:
    """
    A signed token for `subject`, good for `ttl` seconds.

    Raises NoSigningKey when the shared secret is missing or too short, which
    the view turns into a 503 saying so — an unconfigured service should be
    loud, not quietly issue credentials nobody can verify.
    """
    if not secret or len(secret) < MIN_SECRET:
        raise NoSigningKey(
            f'GC_AUTH_SECRET is missing or shorter than {MIN_SECRET} characters'
        )
    issued = int(now if now is not None else time.time())
    header = {'alg': ALGORITHM, 'typ': 'JWT'}
    claims = {
        'sub': str(subject),
        'email': email,
        'scope': scope,
        # Who may WIDEN THE ORIGIN ALLOWLIST. Not who may run a test — every
        # signed-in account may do that. The allowlist is the gate the rest of
        # the design rests on, so extending it is a staff decision and the
        # executor has to be told, in the token, which kind of account this is.
        'admin': bool(admin),
        'iat': issued,
        'exp': issued + int(ttl),
    }
    signing_input = f'{_segment(header)}.{_segment(claims)}'
    signature = hmac.new(secret.encode('utf-8'), signing_input.encode('ascii'), hashlib.sha256).digest()
    return f'{signing_input}.{_b64(signature)}'
