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
            org, role, ent, ent_v            the organisation the session acts
                                             for, the role from its Membership
                                             row, the runner-enforced
                                             entitlements and their version
  signature HMAC-SHA256 over "header.claims", base64url, unpadded

The organisation claims are the only way the runner ever learns which tenant
is calling and what it may do: they are copied from the database into the
signature and never read from anything the client sent (docs/AUTH.md §10).

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


def mint(*, subject, email='', scope='run', secret, ttl=600, now=None,
         org=None, role=None, ent=None, ent_v=None) -> str:
    """
    A signed token for `subject`, good for `ttl` seconds.

    `org`, `role`, `ent` and `ent_v` are the tenancy claims; they are written
    only when an organisation is given, so a token minted for a test of the
    signature alone stays the four-claim shape the runner's checks build.

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
        'iat': issued,
        'exp': issued + int(ttl),
    }
    if org is not None:
        claims.update({'org': str(org), 'role': str(role), 'ent': dict(ent or {}), 'ent_v': int(ent_v or 0)})
    signing_input = f'{_segment(header)}.{_segment(claims)}'
    signature = hmac.new(secret.encode('utf-8'), signing_input.encode('ascii'), hashlib.sha256).digest()
    return f'{signing_input}.{_b64(signature)}'
