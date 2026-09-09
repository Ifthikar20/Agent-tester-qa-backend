"""
A WebAuthn authenticator in software, for the tests.

Enough of the spec to complete a registration and an assertion the way a
browser would relay them — ES256 over P-256, attestation format "none", the
authenticator data laid out byte by byte — and, deliberately, the ability to
do it WRONG: an assertion with the user-verification flag clear, or one made
on another origin, is exactly what docs/AUTH.md §5.7 says must be refused,
and only a fake key can produce those on demand [mfa-recovery-5].

The dictionaries it returns are the JSON a browser's `credential.toJSON()`
gives (base64url for every byte string), which is what the SPA posts and
what fido2 reads with its JSON mapping on.
"""
import base64
import hashlib
import json
import os
import struct

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from fido2 import cbor

UP, UV, AT = 0x01, 0x04, 0x40


def b64u(raw):
    return base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')


class SoftKey:
    def __init__(self, origin):
        self.origin = origin
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.credential_id = os.urandom(16)
        self.user_handle = None
        self.counter = 0

    # -- the pieces --------------------------------------------------------

    def _cose_public_key(self):
        n = self.key.public_key().public_numbers()
        # kty EC2, alg ES256, crv P-256, then x and y.
        return cbor.encode({1: 2, 3: -7, -1: 1, -2: n.x.to_bytes(32, 'big'), -3: n.y.to_bytes(32, 'big')})

    def _client_data(self, kind, challenge, origin):
        return json.dumps({
            'type': kind, 'challenge': challenge, 'origin': origin or self.origin, 'crossOrigin': False,
        }).encode('utf-8')

    # -- the two ceremonies -----------------------------------------------

    def register(self, creation_options, uv=True, origin=None):
        pk = creation_options['publicKey']
        self.user_handle = pk['user']['id']
        rp_hash = hashlib.sha256(pk['rp']['id'].encode('utf-8')).digest()
        flags = UP | AT | (UV if uv else 0)
        credential = bytes(16) + struct.pack('>H', len(self.credential_id)) + self.credential_id + self._cose_public_key()
        auth_data = rp_hash + bytes([flags]) + struct.pack('>I', self.counter) + credential
        attestation = cbor.encode({'fmt': 'none', 'attStmt': {}, 'authData': auth_data})
        client_data = self._client_data('webauthn.create', pk['challenge'], origin)
        return {
            'id': b64u(self.credential_id), 'rawId': b64u(self.credential_id), 'type': 'public-key',
            'authenticatorAttachment': 'platform',
            'response': {'clientDataJSON': b64u(client_data), 'attestationObject': b64u(attestation)},
            'clientExtensionResults': {'credProps': {'rk': True}},
        }

    def assertion(self, request_options, uv=True, origin=None):
        pk = request_options['publicKey']
        rp_hash = hashlib.sha256(pk['rpId'].encode('utf-8')).digest()
        self.counter += 1
        flags = UP | (UV if uv else 0)
        auth_data = rp_hash + bytes([flags]) + struct.pack('>I', self.counter)
        client_data = self._client_data('webauthn.get', pk['challenge'], origin)
        signature = self.key.sign(auth_data + hashlib.sha256(client_data).digest(), ec.ECDSA(hashes.SHA256()))
        return {
            'id': b64u(self.credential_id), 'rawId': b64u(self.credential_id), 'type': 'public-key',
            'authenticatorAttachment': 'platform',
            'response': {
                'clientDataJSON': b64u(client_data), 'authenticatorData': b64u(auth_data),
                'signature': b64u(signature), 'userHandle': self.user_handle,
            },
            'clientExtensionResults': {},
        }
