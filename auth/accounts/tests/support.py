"""
What every test that signs in shares: an account with a verified address,
and a client that speaks allauth's JSON and echoes the CSRF token.

The address is marked verified here for the same reason `adduser` marks it:
a test account has no mailbox, and without the row allauth's mandatory
verification would answer the first sign-in with "check your mail".
"""
import json
import re

from allauth.account.models import EmailAddress
from django.contrib.auth import get_user_model
from django.core import mail
from django.test import Client

User = get_user_model()
PASSWORD = 'a-long-test-password'
HEADLESS = '/_allauth/browser/v1'


def make_user(email, password=PASSWORD, verified=True, **extra):
    user = User.objects.create_user(email=email, password=password, **extra)
    EmailAddress.objects.create(user=user, email=email.lower(), primary=True, verified=verified)
    return user


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
    """The password-reset key in the newest mail: the last path segment of the link."""
    body = (message or last_mail()).body
    found = re.search(r'/reset-password/([^\s/]+)', body)
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
        r = self.try_login(email, password, **fields)
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
