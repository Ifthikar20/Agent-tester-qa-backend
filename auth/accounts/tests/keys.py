"""
A signing key for the tests, made fresh in every process.

Generated rather than pasted: a private key committed to a repository is a
private key, even a test one, and the habit of "it is only a fixture" is how
one ends up in a real environment. Ed25519 generation is microseconds, so
there is no cost to making a new one each run.
"""
import base64
import json

from ..tokens import generate, load_public

PRIVATE_PEM, PUBLIC_PEM, KID = generate()
# The one-line shape an environment file carries, so tests that go through
# settings exercise the unescaping too.
PRIVATE_ONE_LINE = PRIVATE_PEM.strip().replace('\n', '\\n')


def _segment(text):
    return json.loads(base64.urlsafe_b64decode(text + '=' * (-len(text) % 4)))


def header_of(token):
    return _segment(token.split('.')[0])


def claims_of(token):
    return _segment(token.split('.')[1])


def verify(token, public_pem=PUBLIC_PEM):
    """
    Check the signature with the PUBLIC key only, the way the runner does.

    Raises cryptography's InvalidSignature on a forgery. The runner's own
    verifier is in ../../auth.js and is exercised by scripts/check-auth.js;
    this is the Python-side sanity check that what was signed can be checked
    by something that never saw the private key.
    """
    head, body, sig = token.split('.')
    load_public(public_pem).verify(
        base64.urlsafe_b64decode(sig + '=' * (-len(sig) % 4)), f'{head}.{body}'.encode('ascii'),
    )
    return claims_of(token)
