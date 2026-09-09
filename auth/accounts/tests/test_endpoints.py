"""
The five endpoints, the token, and `adduser`.

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

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import Client, TestCase, override_settings

from ..tokens import ALGORITHM, AUDIENCE, ISSUER, NoSigningKey, kid_of, load_private, mint
from . import keys

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
        self.user = User.objects.create_user(email='qa@example.com', password='a-long-test-password', name='QA')
        # The real middleware, not the test client's lenient default — CSRF is
        # a thing this API depends on and skipping it here would mean the
        # browser hits a rule no test ever exercised.
        self.c = Client(enforce_csrf_checks=True)

    def csrf(self):
        return self.c.get('/auth/csrf').json()['csrfToken']

    def login(self):
        r = self.c.post('/auth/login', data=json.dumps({'email': 'qa@example.com', 'password': 'a-long-test-password'}),
                        content_type='application/json', HTTP_X_CSRFTOKEN=self.csrf())
        self.assertEqual(r.status_code, 200)
        return r.json()['csrfToken']

    def test_me_is_401_when_anonymous(self):
        self.assertEqual(self.c.get('/auth/me').status_code, 401)

    def test_login_then_me(self):
        self.login()
        self.assertEqual(self.c.get('/auth/me').json()['user']['email'], 'qa@example.com')

    def test_login_returns_the_rotated_csrf_token(self):
        # Django rotates the token on login. Without handing back the new one,
        # the SPA's very next POST is a 403 — sign-in appears to work and
        # everything after it fails.
        before = self.csrf()
        after = self.login()
        self.assertNotEqual(before, after)
        self.assertEqual(self.c.post('/auth/executor-token', HTTP_X_CSRFTOKEN=after).status_code, 200)

    def test_a_post_without_csrf_is_refused(self):
        r = self.c.post('/auth/login', data=json.dumps({'email': 'qa@example.com', 'password': 'a-long-test-password'}),
                        content_type='application/json')
        self.assertEqual(r.status_code, 403)

    def test_wrong_password_and_unknown_email_read_the_same(self):
        tok = self.csrf()
        wrong = self.c.post('/auth/login', data=json.dumps({'email': 'qa@example.com', 'password': 'nope'}),
                            content_type='application/json', HTTP_X_CSRFTOKEN=tok)
        unknown = self.c.post('/auth/login', data=json.dumps({'email': 'nobody@example.com', 'password': 'nope'}),
                              content_type='application/json', HTTP_X_CSRFTOKEN=tok)
        self.assertEqual(wrong.status_code, 401)
        self.assertEqual(unknown.status_code, 401)
        # Telling them apart turns this endpoint into a way to find out who has
        # an account here.
        self.assertEqual(wrong.json()['error'], unknown.json()['error'])

    def test_token_requires_a_session(self):
        self.assertEqual(self.c.post('/auth/executor-token', HTTP_X_CSRFTOKEN=self.csrf()).status_code, 401)

    def test_token_is_for_the_session_user_only(self):
        tok = self.login()
        # No parameter names a subject. Passing one must not change who the
        # token is for, or this endpoint mints credentials for anyone.
        r = self.c.post('/auth/executor-token', data=json.dumps({'sub': 999, 'email': 'root@example.com'}),
                        content_type='application/json', HTTP_X_CSRFTOKEN=tok)
        self.assertEqual(r.status_code, 200)
        decoded = keys.claims_of(r.json()['token'])
        self.assertEqual(decoded['sub'], str(self.user.pk))
        self.assertEqual(decoded['email'], 'qa@example.com')

    def test_logout_ends_it(self):
        tok = self.login()
        after = self.c.post('/auth/logout', HTTP_X_CSRFTOKEN=tok).json()['csrfToken']
        self.assertEqual(self.c.get('/auth/me').status_code, 401)
        self.assertEqual(self.c.post('/auth/executor-token', HTTP_X_CSRFTOKEN=after).status_code, 401)

    @override_settings(GC_SIGNING_KEY='')
    def test_unconfigured_says_so_rather_than_failing_obscurely(self):
        tok = self.login()
        r = self.c.post('/auth/executor-token', HTTP_X_CSRFTOKEN=tok)
        # 503, not 500: nothing is broken, it has not been given a key.
        self.assertEqual(r.status_code, 503)
        self.assertIn('GC_SIGNING_KEY', r.json()['error'])


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
        c = Client(enforce_csrf_checks=True)
        token = c.get('/auth/csrf').json()['csrfToken']
        return c.post('/auth/login', data=json.dumps({'email': email, 'password': password}),
                      content_type='application/json', HTTP_X_CSRFTOKEN=token)

    def test_an_account_it_makes_can_sign_in(self):
        password = self.password_from(self.run_adduser('qa@example.com'))
        r = self.sign_in('qa@example.com', password)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()['user']['email'], 'qa@example.com')

    def test_a_piped_password_is_the_one_that_works(self):
        # The case a test suite actually wants: it chooses the password, so it
        # can sign in again tomorrow without having captured any output.
        self.run_adduser('qa@example.com', stdin='a-long-chosen-password\n', password_stdin=True)
        self.assertEqual(self.sign_in('qa@example.com', 'a-long-chosen-password').status_code, 200)

    def test_the_trailing_newline_is_not_part_of_the_password(self):
        # echo adds one. If it were kept, the password that works would be one
        # nobody can type, and the failure would look like a wrong password.
        self.run_adduser('qa@example.com', stdin='a-long-chosen-password\n', password_stdin=True)
        self.assertEqual(self.sign_in('qa@example.com', 'a-long-chosen-password\n').status_code, 401)

    def test_it_makes_an_ordinary_account_by_default(self):
        # There is no RBAC, so signing in is already enough to drive every run.
        # An account that ALSO reaches /admin/ should be something you typed.
        self.run_adduser('qa@example.com')
        user = User.objects.get(email='qa@example.com')
        self.assertFalse(user.is_staff)
        self.assertFalse(user.is_superuser)
        self.assertTrue(user.is_active)

    def test_superuser_is_staff_too(self):
        self.run_adduser('boss@example.com', superuser=True)
        user = User.objects.get(email='boss@example.com')
        self.assertTrue(user.is_staff)
        self.assertTrue(user.is_superuser)

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
        self.assertEqual(self.sign_in('qa@example.com', first).status_code, 401)
        self.assertEqual(self.sign_in('qa@example.com', second).status_code, 200)
        self.assertEqual(User.objects.filter(email='qa@example.com').count(), 1)

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
