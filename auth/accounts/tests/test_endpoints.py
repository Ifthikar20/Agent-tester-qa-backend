"""
The endpoints, the token, and `adduser`.

    python manage.py test

What is NOT here: whether the runner accepts what this mints. That crosses a
language boundary and neither project can assert it alone, so it lives in
../scripts/check-auth.js, which mints with this code and verifies with the
runner's. A green run here and a green run there still would not prove they
agree — only the crossing does.
"""
import io
import json
import re
import sys

from allauth.account.models import EmailAddress
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase, override_settings

from ..tokens import ALGORITHM, AUDIENCE, ISSUER, NoSigningKey, kid_of, load_private, mint
from . import keys
from .support import HEADLESS, PASSWORD, Api, make_user

User = get_user_model()


class TokenTests(TestCase):
    def test_claims_are_what_the_runner_expects(self):
        now = 1_700_000_000
        token = mint(subject=7, email='qa@example.com', key=keys.PRIVATE_PEM, ttl=600, now=now,
                     org='acme', role='member')
        header, claims, signature = token.split('.')
        self.assertTrue(header and claims and signature)

        decoded = keys.claims_of(token)
        self.assertEqual(decoded['iss'], ISSUER)
        self.assertEqual(decoded['aud'], AUDIENCE)
        self.assertEqual(decoded['sub'], '7')
        self.assertEqual(decoded['email'], 'qa@example.com')
        self.assertEqual(decoded['org'], 'acme')
        self.assertEqual(decoded['iat'], now)
        self.assertEqual(decoded['exp'], now + 600)
        self.assertTrue(decoded['jti'])

    def test_the_header_is_pinned_and_names_the_key(self):
        # The runner refuses any alg but EdDSA and any kid it was not given,
        # so a token that said anything else here would be a token nothing
        # accepts.
        head = keys.header_of(mint(subject=1, key=keys.PRIVATE_PEM, org='acme', role='member'))
        self.assertEqual(head['alg'], ALGORITHM)
        self.assertEqual(head['typ'], 'JWT')
        self.assertEqual(head['kid'], keys.KID)

    def test_the_public_key_alone_verifies_it(self):
        token = mint(subject=1, key=keys.PRIVATE_PEM, org='acme', role='member')
        self.assertEqual(keys.verify(token)['sub'], '1')

    def test_another_key_does_not(self):
        from cryptography.exceptions import InvalidSignature
        _, other_public, _ = __import__('accounts.tokens', fromlist=['generate']).generate()
        token = mint(subject=1, key=keys.PRIVATE_PEM, org='acme', role='member')
        with self.assertRaises(InvalidSignature):
            keys.verify(token, other_public)

    def test_segments_are_unpadded(self):
        # base64url in a JWT carries no '=' padding. Emitting it produces a
        # token that some verifiers accept and others refuse, which is the
        # worst possible failure: it works until it meets a different library.
        self.assertNotIn('=', mint(subject=1, key=keys.PRIVATE_PEM, org='acme', role='member'))

    def test_no_key_refuses_rather_than_signs(self):
        # The failure that matters: a default would let an unconfigured service
        # issue tokens nobody can verify, and nothing would say so.
        with self.assertRaises(NoSigningKey):
            mint(subject=1, key='', org='acme', role='member')

    def test_a_key_that_is_not_ed25519_is_refused(self):
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        rsa_pem = rsa.generate_private_key(public_exponent=65537, key_size=2048).private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption(),
        ).decode('ascii')
        with self.assertRaises(NoSigningKey):
            mint(subject=1, key=rsa_pem, org='acme', role='member')

    def test_a_one_line_pem_is_read_back(self):
        # An env file cannot hold a newline, so the key travels with literal
        # backslash-n between its lines.
        self.assertEqual(kid_of(load_private(keys.PRIVATE_ONE_LINE)), keys.KID)

    def test_the_lifetime_is_clamped(self):
        now = 1_700_000_000
        long = keys.claims_of(mint(subject=1, key=keys.PRIVATE_PEM, ttl=3600, now=now, org='acme', role='member'))
        short = keys.claims_of(mint(subject=1, key=keys.PRIVATE_PEM, ttl=5, now=now, org='acme', role='member'))
        self.assertEqual(long['exp'] - long['iat'], 600)
        self.assertEqual(short['exp'] - short['iat'], 60)

    def test_an_organisation_is_required(self):
        with self.assertRaises(ValueError):
            mint(subject=1, key=keys.PRIVATE_PEM, org=None, role=None)

    def test_the_subject_is_stringified(self):
        # The runner compares sub as a string; an int here and a str there is
        # the kind of mismatch that only shows up under a permissions check.
        token = mint(subject=42, key=keys.PRIVATE_PEM, org='acme', role='member')
        self.assertIsInstance(keys.claims_of(token)['sub'], str)


@override_settings(GC_SIGNING_KEY=keys.PRIVATE_PEM, GC_TOKEN_TTL=600)
class EndpointTests(TestCase):
    def setUp(self):
        self.user = make_user('qa@example.com', name='QA')
        # The real middleware, not the test client's lenient default — CSRF is
        # a thing this API depends on and skipping it here would mean the
        # browser hits a rule no test ever exercised.
        self.api = Api()
        self.c = self.api.c

    def test_me_is_401_when_anonymous(self):
        self.assertEqual(self.c.get('/auth/me').status_code, 401)

    def test_login_then_me(self):
        self.api.login('qa@example.com')
        self.assertEqual(self.c.get('/auth/me').json()['user']['email'], 'qa@example.com')

    def test_login_hands_back_the_rotated_csrf_token(self):
        # Django rotates the token on login. Without handing back the new one,
        # the SPA's very next POST is a 403 — sign-in appears to work and
        # everything after it fails. allauth's JSON says nothing about it, so
        # it rides in a header on every answer (CsrfTokenHeader).
        before = self.api.csrf
        r = self.api.login('qa@example.com')
        self.assertTrue(r.headers.get('X-CSRFToken'))
        self.assertNotEqual(before, self.api.csrf)
        self.assertEqual(self.api.post('/auth/executor-token').status_code, 200)

    def test_the_old_csrf_token_is_dead_after_login(self):
        stale = self.api.csrf
        self.api.login('qa@example.com')
        r = self.c.post('/auth/executor-token', HTTP_X_CSRFTOKEN=stale)
        self.assertEqual(r.status_code, 403)

    def test_a_post_without_csrf_is_refused(self):
        r = self.c.post(f'{HEADLESS}/auth/login', data=json.dumps({'email': 'qa@example.com', 'password': PASSWORD}),
                        content_type='application/json')
        self.assertEqual(r.status_code, 403)

    def test_wrong_password_and_unknown_email_read_the_same(self):
        wrong = self.api.try_login('qa@example.com', 'nope-not-it-at-all')
        unknown = self.api.try_login('nobody@example.com', 'nope-not-it-at-all')
        self.assertEqual(wrong.status_code, 400)
        self.assertEqual(unknown.status_code, 400)
        # Telling them apart turns this endpoint into a way to find out who has
        # an account here.
        self.assertEqual(wrong.json()['errors'], unknown.json()['errors'])
        self.assertEqual(self.c.get('/auth/me').status_code, 401)

    def test_login_cycles_the_session_key(self):
        self.c.get('/auth/csrf')
        before = self.c.cookies.get('sessionid')
        before = before.value if before else None
        self.api.login('qa@example.com')
        self.assertNotEqual(self.c.cookies['sessionid'].value, before)

    def test_the_session_endpoint_says_who(self):
        self.assertEqual(self.api.current().status_code, 401)
        self.api.login('qa@example.com')
        r = self.api.current()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()['data']['user']['email'], 'qa@example.com')
        self.assertTrue(r.json()['meta']['is_authenticated'])

    def test_token_requires_a_session(self):
        self.assertEqual(self.api.post('/auth/executor-token').status_code, 401)

    def test_token_is_for_the_session_user_only(self):
        self.api.login('qa@example.com')
        # No parameter names a subject. Passing one must not change who the
        # token is for, or this endpoint mints credentials for anyone.
        r = self.api.post('/auth/executor-token', {'sub': 999, 'email': 'root@example.com'})
        self.assertEqual(r.status_code, 200)
        decoded = keys.claims_of(r.json()['token'])
        self.assertEqual(decoded['sub'], str(self.user.pk))
        self.assertEqual(decoded['email'], 'qa@example.com')

    def test_logout_ends_it(self):
        self.api.login('qa@example.com')
        r = self.api.logout()
        self.assertEqual(r.status_code, 401)   # allauth: "and now you are not signed in"
        self.assertTrue(r.headers.get('X-CSRFToken'))
        self.assertEqual(self.c.get('/auth/me').status_code, 401)
        self.assertEqual(self.api.post('/auth/executor-token').status_code, 401)

    def test_config_says_the_mode_and_no_turnstile(self):
        r = self.c.get('/auth/config')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {'signup': 'invite', 'domains': [], 'turnstile': None, 'google': False})

    @override_settings(GC_SIGNING_KEY='')
    def test_unconfigured_says_so_rather_than_failing_obscurely(self):
        self.api.login('qa@example.com')
        r = self.api.post('/auth/executor-token')
        # 503, not 500: nothing is broken, it has not been given a key.
        self.assertEqual(r.status_code, 503)
        self.assertIn('GC_SIGNING_KEY', r.json()['error'])


class AdminLoginTests(TestCase):
    """
    Django's own admin login form is gone [credentials-1] [ops-supply-6]:
    /admin/ authenticates only through allauth, so the rate limits, the
    verified address and — once the mfa step lands — the MFA policy apply
    to staff exactly as to everyone else.
    """

    def test_an_anonymous_visit_is_sent_to_the_spa_sign_in(self):
        # /admin/ sends an anonymous visitor to its own login URL, as Django
        # always has; that URL is now a redirect to the SPA rather than a form.
        r = Api().get('/admin/')
        self.assertEqual(r.status_code, 302)
        self.assertEqual(r['Location'], '/admin/login/?next=/admin/')
        r = Api().get(r['Location'])
        self.assertEqual(r.status_code, 302)
        # The SPA's route (GC_APP_URL: relative here, absolute on a laptop
        # with GC_WEB_ORIGIN, and the same origin deployed).
        self.assertTrue(r['Location'].split('?')[0].endswith('/app/login'), r['Location'])
        self.assertIn('next=', r['Location'])

    def test_there_is_no_admin_login_form(self):
        r = Api().get('/admin/login/')
        self.assertEqual(r.status_code, 302)
        self.assertNotIn(b'csrfmiddlewaretoken', r.content)
        # And nothing to post a password to: the form's action went with it.
        api = Api()
        r = api.c.post('/admin/login/', {'username': 'x@example.com', 'password': 'y', 'csrfmiddlewaretoken': api.csrf},
                       HTTP_X_CSRFTOKEN=api.csrf)
        self.assertEqual(r.status_code, 302)

    def test_a_staff_session_made_through_allauth_gets_in(self):
        make_user('staff@example.com', is_staff=True)
        api = Api()
        api.login('staff@example.com')
        self.assertEqual(api.get('/admin/').status_code, 200)

    def test_a_non_staff_session_is_refused(self):
        make_user('qa@example.com')
        api = Api()
        api.login('qa@example.com')
        self.assertEqual(api.get('/admin/login/?next=/admin/').status_code, 403)


class PasswordTests(TestCase):
    def test_passwords_are_hashed(self):
        u = User.objects.create_user(email='a@example.com', password='a-long-test-password')
        self.assertNotEqual(u.password, 'a-long-test-password')
        self.assertTrue(u.check_password('a-long-test-password'))

    def test_email_is_the_identifier(self):
        User.objects.create_user(email='A@Example.com', password='x')
        # Django normalises the domain half; the local part is case-sensitive
        # by the spec, so this asserts what actually happens rather than what
        # would be convenient.
        self.assertEqual(User.objects.get().email, 'A@example.com')


class AddUserCommandTests(TestCase):
    """
    `manage.py adduser`, checked by the only claim that matters about it: that
    the account it makes can sign in through the real endpoint. Asserting that
    a row appeared in the table would pass just as happily for an account with
    an unusable password, which is exactly the failure this would have.
    """

    def run_adduser(self, *args, stdin=None, **kwargs):
        out, err = io.StringIO(), io.StringIO()
        saved = sys.stdin
        if stdin is not None:
            sys.stdin = io.StringIO(stdin)
        try:
            call_command('adduser', *args, stdout=out, stderr=err, **kwargs)
        finally:
            sys.stdin = saved
        return out.getvalue() + err.getvalue()

    def password_from(self, output):
        found = re.search(r'^\s+password\s+(\S+)$', output, re.MULTILINE)
        self.assertIsNotNone(found, f'no password in:\n{output}')
        return found.group(1)

    def sign_in(self, email, password):
        """The real login, CSRF and all — not authenticate()."""
        return Api().try_login(email, password)

    def test_an_account_it_makes_can_sign_in(self):
        password = self.password_from(self.run_adduser('qa@example.com'))
        r = self.sign_in('qa@example.com', password)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()['data']['user']['email'], 'qa@example.com')

    def test_the_address_is_marked_verified(self):
        # An operator at a terminal is the proof of the address. Without the
        # row, allauth's mandatory verification would ask the first sign-in
        # for a code sent to a mailbox a test account does not have.
        self.run_adduser('qa@example.com')
        row = EmailAddress.objects.get(user__email='qa@example.com')
        self.assertTrue(row.verified)
        self.assertTrue(row.primary)

    def test_a_piped_password_is_the_one_that_works(self):
        # The case a test suite actually wants: it chooses the password, so it
        # can sign in again tomorrow without having captured any output.
        self.run_adduser('qa@example.com', stdin='a-long-chosen-password\n', password_stdin=True)
        self.assertEqual(self.sign_in('qa@example.com', 'a-long-chosen-password').status_code, 200)

    def test_the_trailing_newline_is_not_part_of_the_password(self):
        # echo adds one. If it were kept, the password that works would be one
        # nobody can type, and the failure would look like a wrong password.
        # (allauth's login strips surrounding whitespace from what is typed,
        # so the stored hash is the thing to ask.)
        self.run_adduser('qa@example.com', stdin='a-long-chosen-password\n', password_stdin=True)
        user = User.objects.get(email='qa@example.com')
        self.assertTrue(user.check_password('a-long-chosen-password'))
        self.assertFalse(user.check_password('a-long-chosen-password\n'))

    def test_it_makes_an_ordinary_account_by_default(self):
        # There is no RBAC, so signing in is already enough to drive every run.
        # An account that ALSO reaches /admin/ should be something you typed.
        self.run_adduser('qa@example.com')
        user = User.objects.get(email='qa@example.com')
        self.assertFalse(user.is_staff)
        self.assertFalse(user.is_superuser)
        self.assertTrue(user.is_active)

    def test_superuser_is_staff_too_and_is_told_about_mfa(self):
        out = self.run_adduser('boss@example.com', superuser=True)
        user = User.objects.get(email='boss@example.com')
        self.assertTrue(user.is_staff)
        self.assertTrue(user.is_superuser)
        self.assertIn('authenticator', out)

    def test_an_existing_account_is_left_alone(self):
        first = self.password_from(self.run_adduser('qa@example.com'))
        with self.assertRaises(CommandError):
            self.run_adduser('qa@example.com')
        # The point of refusing: the password someone else is using still works.
        self.assertEqual(self.sign_in('qa@example.com', first).status_code, 200)

    def test_reset_password_replaces_it(self):
        first = self.password_from(self.run_adduser('qa@example.com'))
        second = self.password_from(self.run_adduser('qa@example.com', reset_password=True))
        self.assertNotEqual(first, second)
        self.assertEqual(self.sign_in('qa@example.com', first).status_code, 400)
        self.assertEqual(self.sign_in('qa@example.com', second).status_code, 200)
        self.assertEqual(User.objects.filter(email='qa@example.com').count(), 1)
        self.assertEqual(EmailAddress.objects.filter(user__email='qa@example.com').count(), 1)

    def test_a_weak_password_is_refused_rather_than_stored(self):
        with self.assertRaises(CommandError):
            self.run_adduser('qa@example.com', stdin='password\n', password_stdin=True)
        self.assertFalse(User.objects.filter(email='qa@example.com').exists())

    def test_an_empty_stdin_is_refused_rather_than_becoming_the_password(self):
        # The failure this stops: an empty password stored as usable, and an
        # account anyone can sign into by leaving the field blank.
        with self.assertRaises(CommandError):
            self.run_adduser('qa@example.com', stdin='', password_stdin=True)
        self.assertFalse(User.objects.filter(email='qa@example.com').exists())

    def test_something_that_is_not_an_email_is_refused(self):
        with self.assertRaises(CommandError):
            self.run_adduser('qa')
        self.assertFalse(User.objects.exists())

    def test_a_generated_password_is_not_guessable(self):
        seen = {self.password_from(self.run_adduser(f'qa{n}@example.com')) for n in range(5)}
        self.assertEqual(len(seen), 5)
        self.assertTrue(all(len(p) >= 20 for p in seen), seen)
