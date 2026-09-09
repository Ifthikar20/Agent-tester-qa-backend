"""
Passkeys, pinned (docs/AUTH.md §5.7).

allauth's WebAuthn flows are used as they ship, except for the two things
they leave open and the design closes:

  user verification   allauth asks the authenticator for it only for a
                      passkey that signs in on its own; a second-factor key
                      may answer with presence alone. Here EVERY ceremony —
                      registration and assertion, sign-in, challenge and
                      reauthentication — demands it, and an assertion whose
                      UV flag is clear is refused by fido2 at completion,
                      because the state it checks against was made with
                      REQUIRED. A key that was merely touched never becomes
                      `webauthn` in amr [mfa-recovery-5].
  the origin          fido2 accepts any https origin whose host is the RP
                      ID or a subdomain of it. The RP ID is pinned to the
                      public host by accounts.adapters.MFAAdapter; the
                      origin the browser wrote into clientDataJSON is
                      additionally required to be exactly GC_WEBAUTHN_ORIGIN
                      before allauth reads the credential at all.

The begin_* functions below are allauth's own, with the requirement set,
and the views in accounts/headless.py call these instead; the completion
side is allauth's unchanged, which is where fido2 enforces the state.
"""
import base64
import json
from urllib.parse import urlsplit

from allauth.mfa.adapter import get_adapter
from allauth.mfa.webauthn.internal import auth
from django.conf import settings
from fido2.webauthn import ResidentKeyRequirement, UserVerificationRequirement


def expected_origin():
    """The one origin a ceremony may have been performed on."""
    return (getattr(settings, 'GC_WEBAUTHN_ORIGIN', '') or '').rstrip('/')


def rp_id():
    """The relying-party identifier: the host of the expected origin."""
    return urlsplit(expected_origin()).hostname or ''


def begin_registration(user, passwordless):
    server = auth.get_server()
    registration_data, state = server.register_begin(
        user=auth.build_user_payload(user),
        credentials=auth.get_credentials(user),
        resident_key_requirement=(
            ResidentKeyRequirement.REQUIRED if passwordless else ResidentKeyRequirement.DISCOURAGED
        ),
        user_verification=UserVerificationRequirement.REQUIRED,
        extensions=auth.EXTENSIONS,
    )
    auth.set_state(state)
    return dict(registration_data)


def begin_authentication(user=None):
    server = auth.get_server()
    request_options, state = server.authenticate_begin(
        credentials=auth.get_credentials(user) if user else [],
        user_verification=UserVerificationRequirement.REQUIRED,
    )
    auth.set_state(state)
    return dict(request_options)


def origin_of(credential):
    """
    The origin the browser recorded in the credential's clientDataJSON, or
    '' for anything that is not a credential. Read here rather than trusted
    to fido2, because the pin is exact and fido2's is a suffix match.
    """
    try:
        raw = credential['response']['clientDataJSON']
        padded = raw + '=' * (-len(raw) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded.encode('ascii')).decode('utf-8'))
        return str(data.get('origin') or '')
    except (KeyError, TypeError, ValueError, AttributeError):
        return ''


def check_origin(credential):
    """Refuse a credential made on any origin but the app's own, with allauth's own error."""
    if not isinstance(credential, dict) or origin_of(credential) != expected_origin():
        raise get_adapter().validation_error('incorrect_code')
