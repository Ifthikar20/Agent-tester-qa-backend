"""
What every test that signs in shares: an account with a verified address,
and a client that speaks allauth's JSON and echoes the CSRF token.

The address is marked verified here for the same reason `adduser` marks it:
a test account has no mailbox, and without the row allauth's mandatory
verification would answer the first sign-in with "check your mail".
"""
import json
import re
import time

from allauth.account.models import EmailAddress
from django.contrib.auth import get_user_model
from django.core import mail
from django.test import Client

from ..events import AUTH_EVENTS

User = get_user_model()
PASSWORD = 'a-long-test-password'
HEADLESS = '/_allauth/browser/v1'


def make_user(email, password=PASSWORD, verified=True, **extra):
    user = User.objects.create_user(email=email, password=password, **extra)
    EmailAddress.objects.create(user=user, email=email.lower(), primary=True, verified=verified)
    return user


# -- the second factor, for tests that are about something else ---------------
#
# Staff and organisation managers must hold an authenticator (docs/AUTH.md
# §5.4), so a test about the admin or about invitations needs one on its
# account without being a test of enrolment. These put one there directly;
# test_mfa.py is where the enrolment endpoints themselves are exercised.

def give_authenticator(user, secret=None):
    """An authenticator app on the account, straight into the table. Returns its secret."""
    from allauth.mfa.totp.internal.auth import TOTP, generate_totp_secret
    secret = secret or generate_totp_secret()
    TOTP.activate(user, secret)
    return secret


def totp_code(secret, step=0):
    """The code the app would show now (or `step` periods away)."""
    from allauth.mfa import app_settings
    from allauth.mfa.totp.internal.auth import format_hotp_value, hotp_value
    counter = int(time.time()) // app_settings.TOTP_PERIOD + step
    return format_hotp_value(hotp_value(secret, counter))


def app_code(email):
    """
    The code the account's authenticator app shows right now, read the way
    only a test can: the secret out of the row, decrypted. The replay marker
    for the code is cleared first, so two sign-ins of the same enrolled
    account inside one thirty-second window both work.
    """
    from allauth.mfa.models import Authenticator
    from django.core.cache import cache
    from ..adapters import MFAAdapter
    row = Authenticator.objects.get(user__email__iexact=email, type=Authenticator.Type.TOTP)
    code = totp_code(MFAAdapter().decrypt(row.data['secret']))
    cache.delete(f'allauth.mfa.totp.used?user={row.user_id}&code={code}')
    return code


def prove_strong(api, method='otp', ago=0):
    """
    Write a second-factor event into the session, as a real challenge
    would — into this project's list, which the strong-reauthentication
    gate reads, and into allauth's, which its own gate reads.
    """
    s = api.session
    at = time.time() - ago
    events = [e for e in s.get(AUTH_EVENTS, [])]
    events.append({'method': method, 'at': int(at)})
    s[AUTH_EVENTS] = events
    theirs = [m for m in s.get('account_authentication_methods', [])]
    theirs.append({'method': 'mfa', 'at': at, 'type': {'otp': 'totp', 'recovery': 'recovery_codes'}.get(method, method),
                   'reauthenticated': True})
    s['account_authentication_methods'] = theirs
    s.save()


def last_mail():
    return mail.outbox[-1] if mail.outbox else None


def code_from_mail(message=None):
    """The six-digit verification code in the newest mail."""
    body = (message or last_mail()).body
    found = re.search(r'\b(\d{6})\b', body)
    assert found, body
    return found.group(1)


def token_from_mail(message=None, param='token'):
    """The value of `?token=` (or another parameter) in the newest mail's link."""
    body = (message or last_mail()).body
    found = re.search(rf'[?&]{param}=([A-Za-z0-9_\-]+)', body)
    assert found, body
    return found.group(1)


def key_from_mail(message=None):
    """The password-reset key in the newest mail: the link's `key` parameter."""
    body = (message or last_mail()).body
    found = re.search(r'/reset-password\?key=([^\s&]+)', body)
    assert found, body
    return found.group(1)


class Api:
    """
    A CSRF-enforcing client. Every answer from the control plane carries the
    CSRF token to echo next in X-CSRFToken (accounts.middleware
    .CsrfTokenHeader), and this client reads it the way the SPA does.
    """

    def __init__(self, **defaults):
        self.c = Client(enforce_csrf_checks=True, **defaults)
        self.csrf = self.c.get('/auth/csrf').json()['csrfToken']

    def _took(self, r):
        if r.headers.get('X-CSRFToken'):
            self.csrf = r.headers['X-CSRFToken']
        return r

    def get(self, path, **extra):
        return self._took(self.c.get(path, **extra))

    def post(self, path, body=None, **extra):
        return self._took(self.c.post(path, data=json.dumps(body if body is not None else {}),
                                      content_type='application/json', HTTP_X_CSRFTOKEN=self.csrf, **extra))

    def put(self, path, body=None, **extra):
        return self._took(self.c.put(path, data=json.dumps(body or {}), content_type='application/json',
                                     HTTP_X_CSRFTOKEN=self.csrf, **extra))

    def patch(self, path, body=None, **extra):
        return self._took(self.c.patch(path, data=json.dumps(body or {}), content_type='application/json',
                                       HTTP_X_CSRFTOKEN=self.csrf, **extra))

    def delete(self, path, body=None, **extra):
        kwargs = {'HTTP_X_CSRFTOKEN': self.csrf, **extra}
        if body is not None:
            kwargs.update(data=json.dumps(body), content_type='application/json')
        return self._took(self.c.delete(path, **kwargs))

    # -- allauth's endpoints, by name ------------------------------------------

    def try_login(self, email, password=PASSWORD, **fields):
        return self.post(f'{HEADLESS}/auth/login', {'email': email, 'password': password, **fields})

    def login(self, email, password=PASSWORD, **fields):
        """
        A complete sign-in. For an account holding an authenticator app the
        password is answered with the challenge, and this answers it the way
        the person would — with the code the app shows — so a test about
        something else does not have to know the account was enrolled.
        """
        r = self.try_login(email, password, **fields)
        if r.status_code == 401 and any(
            f.get('id') == 'mfa_authenticate' and f.get('is_pending') for f in r.json().get('data', {}).get('flows', [])
        ):
            r = self.post(f'{HEADLESS}/auth/2fa/authenticate', {'code': app_code(email)})
        assert r.status_code == 200, r.content
        return r

    def logout(self):
        return self.delete(f'{HEADLESS}/auth/session')

    def current(self):
        return self.get(f'{HEADLESS}/auth/session')

    def signup(self, email, password=PASSWORD, **fields):
        return self.post(f'{HEADLESS}/auth/signup', {'email': email, 'password': password, **fields})

    def verify(self, code):
        return self.post(f'{HEADLESS}/auth/email/verify', {'key': code})

    def resend_code(self):
        return self.post(f'{HEADLESS}/auth/email/verify/resend')

    def request_reset(self, email):
        return self.post(f'{HEADLESS}/auth/password/request', {'email': email})

    def reset(self, key, password):
        return self.post(f'{HEADLESS}/auth/password/reset', {'key': key, 'password': password})

    def change_password(self, current, new):
        return self.post(f'{HEADLESS}/account/password/change', {'current_password': current, 'new_password': new})

    def reauthenticate(self, password=PASSWORD):
        return self.post(f'{HEADLESS}/auth/reauthenticate', {'password': password})

    def add_email(self, email):
        return self.post(f'{HEADLESS}/account/email', {'email': email})

    def emails(self):
        return self.get(f'{HEADLESS}/account/email')

    @property
    def session(self):
        return self.c.session


def signup_and_verify(email, password=PASSWORD, api=None):
    """A complete sign-up: the form, then the code from the mail. Returns the signed-in Api."""
    api = api or Api()
    r = api.signup(email, password)
    assert r.status_code == 401, r.content
    r = api.verify(code_from_mail())
    assert r.status_code == 200, r.content
    return api
