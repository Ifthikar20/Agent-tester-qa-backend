"""
Minting the token the executor will check.

An EdDSA JWT over Ed25519. The control plane holds the private key
(GC_SIGNING_KEY, a PEM in its environment) and the runner holds only the
public half (GC_AUTH_PUBLIC_KEYS, JSON {kid: pem}), which is the whole point
of the move away from a shared HMAC secret: a compromised runner can misuse
the browser it already owns, but it cannot become anybody, because nothing in
its environment can produce a signature (docs/AUTH.md §8 [token-1] [token-2]).

There is still no JWT library on either side. Signing is one Ed25519
signature over "base64url(header).base64url(claims)", and the half that is
genuinely easy to get wrong is verification — which is on the other side,
written out explicitly in ../auth.js, and tested against tokens minted here
by ../scripts/check-auth.js.

The contract:

  header    {"alg":"EdDSA","typ":"JWT","kid":"<thumbprint>"}
            alg is pinned on the runner, never read; kid names the key in
            the runner's set, so a rotation is "add the new public key,
            restart, remove the old one later"
  claims    iss, aud, sub, email, org, role, plan, amr, auth_time, su, ent,
            ent_v, sid, iat, exp, jti — every one copied from the database or
            the session, none from anything the client sent. `plan` is the
            plan's slug, for display: the runner names it in a 402 refusal
            ({error: 'entitlement', limit, plan}) and decides nothing by it —
            what the plan allows is `ent`, key by key.
  signature Ed25519 over the two segments, base64url, unpadded

`kid` is the RFC 7638 JWK thumbprint of the public key: SHA-256 over the
canonical {"crv","kty","x"} JSON, base64url. Deriving it rather than naming
it means two operators generating keys independently cannot collide, and a
kid can be recomputed from the public key alone — by openssl in a shell, if
it comes to that (scripts/aws-up.sh does exactly this).

Short-lived on purpose: `exp - iat` is at most 600 seconds and the runner
refuses anything longer. The token never rides in a URL any more — the
socket opens with a 30-second single-use ticket derived from it — but ten
minutes still bounds what a stolen Bearer header is worth.
"""
import base64
import hashlib
import json
import secrets
import time

from cryptography.exceptions import UnsupportedAlgorithm
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519

ALGORITHM = 'EdDSA'
ISSUER = 'ghostclick-control'
AUDIENCE = 'ghostclick-runner'
# Sixty seconds is the floor because the UI renews a token with a minute still
# on it; below that every call would mint. Ten minutes is the ceiling on what a
# leaked token is worth [token-4].
TTL_MIN, TTL_MAX = 60, 600
# How long a fresh authentication counts as step-up for the actions that
# demand one (allowing an origin). Computed here, checked on the runner as
# `now < su` and nothing more [mfa-recovery-2].
STEP_UP_SECONDS = 600


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


def unescape(pem: str) -> str:
    """
    A PEM as it arrives from an environment file.

    A .env line cannot hold a newline, so the key is written on one line with
    literal backslash-n between the PEM lines; compose keeps those literal in
    single quotes and turns them into newlines in double quotes. Accepting
    both means the quoting style cannot be the thing that breaks a deploy.
    """
    text = str(pem or '').replace('\\n', '\n').strip()
    return f'{text}\n' if text else ''


def load_private(pem):
    """
    The signing key from GC_SIGNING_KEY, or NoSigningKey with a sentence that
    names the variable and the command that makes one.
    """
    if isinstance(pem, ed25519.Ed25519PrivateKey):
        return pem
    text = unescape(pem)
    if not text:
        raise NoSigningKey('GC_SIGNING_KEY is not set; `manage.py signing_key --new` prints one')
    try:
        key = serialization.load_pem_private_key(text.encode('ascii'), password=None)
    except (ValueError, TypeError, UnsupportedAlgorithm, UnicodeEncodeError) as err:
        raise NoSigningKey(f'GC_SIGNING_KEY is not a readable PEM private key ({err})')
    if not isinstance(key, ed25519.Ed25519PrivateKey):
        # An RSA or EC key would sign happily with a different algorithm, and
        # the runner is pinned to EdDSA, so every token would be refused with
        # a message about signatures rather than about the key.
        raise NoSigningKey('GC_SIGNING_KEY must be an Ed25519 key, not ' + type(key).__name__)
    return key


def load_public(pem):
    text = unescape(pem)
    key = serialization.load_pem_public_key(text.encode('ascii'))
    if not isinstance(key, ed25519.Ed25519PublicKey):
        raise ValueError('not an Ed25519 public key')
    return key


def public_pem(key) -> str:
    """The public half, as the runner's environment carries it."""
    public = key.public_key() if isinstance(key, ed25519.Ed25519PrivateKey) else key
    return public.public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode('ascii')


def private_pem(key) -> str:
    return key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption(),
    ).decode('ascii')


def jwk(key) -> dict:
    """The public key as a JWK, the shape GET /auth/jwks publishes."""
    public = key.public_key() if isinstance(key, ed25519.Ed25519PrivateKey) else key
    raw = public.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return {'kty': 'OKP', 'crv': 'Ed25519', 'x': _b64(raw)}


def kid_of(key) -> str:
    """RFC 7638: SHA-256 of the required members, in lexicographic order, no whitespace."""
    members = jwk(key)
    canonical = json.dumps({k: members[k] for k in ('crv', 'kty', 'x')}, separators=(',', ':'), sort_keys=True)
    return _b64(hashlib.sha256(canonical.encode('ascii')).digest())


def generate():
    """A fresh keypair: (private PEM, public PEM, kid)."""
    key = ed25519.Ed25519PrivateKey.generate()
    return private_pem(key), public_pem(key), kid_of(key)


def public_set(pem) -> dict:
    """{kid: public PEM} for the runner's GC_AUTH_PUBLIC_KEYS, from a private key."""
    key = load_private(pem)
    return {kid_of(key): public_pem(key)}


def clamp_ttl(ttl) -> int:
    """GC_TOKEN_TTL, held to 60–600 whatever the environment said [token-4]."""
    try:
        n = int(ttl)
    except (TypeError, ValueError):
        n = TTL_MAX
    return max(TTL_MIN, min(TTL_MAX, n))


def mint(*, subject, email='', key, kid=None, ttl=TTL_MAX, now=None,
         org, role, plan='', ent=None, ent_v=0,
         amr=(), auth_time=None, su=0, sid='', jti=None) -> str:
    """
    A signed token for `subject`, acting for `org`, good for `ttl` seconds.

    `key` is the private key or its PEM. `org` is required: the runner refuses
    a token without one, because every store it keeps is keyed by it, and a
    token that could reach the runner with no organisation would be a token
    that reaches nothing or everything.

    Raises NoSigningKey when there is no usable key, which the view turns into
    a 503 saying so — an unconfigured service should be loud, not quietly
    issue credentials nobody can verify.
    """
    private = load_private(key)
    if org is None or str(org) == '':
        raise ValueError('a token names an organisation; there is no organisation-less token')
    issued = int(now if now is not None else time.time())
    header = {'alg': ALGORITHM, 'typ': 'JWT', 'kid': kid or kid_of(private)}
    claims = {
        'iss': ISSUER,
        'aud': AUDIENCE,
        'sub': str(subject),
        'email': email,
        'org': str(org),
        'role': str(role),
        'plan': str(plan or ''),
        'amr': list(amr),
        'auth_time': int(auth_time if auth_time is not None else issued),
        'su': int(su or 0),
        'ent': dict(ent or {}),
        'ent_v': int(ent_v or 0),
        'sid': str(sid or ''),
        'iat': issued,
        'exp': issued + clamp_ttl(ttl),
        'jti': jti or secrets.token_urlsafe(16),
    }
    signing_input = f'{_segment(header)}.{_segment(claims)}'
    signature = private.sign(signing_input.encode('ascii'))
    return f'{signing_input}.{_b64(signature)}'


def session_id(session_key) -> str:
    """
    `sid`: a hash of the session key, never the key itself.

    The runner uses it to tell one session's tokens from another's (and to
    drop the sockets of a session that ended); the session key is a
    credential and must not travel. Half a SHA-256 is plenty to match on.
    """
    return hashlib.sha256(str(session_key or '').encode('utf-8')).hexdigest()[:32]
