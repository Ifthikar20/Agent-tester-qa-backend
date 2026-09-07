"""
The control plane's own checks.

    python3 manage.py test

What is NOT here: whether the runner accepts what this mints. That crosses a
language boundary and neither project can assert it alone, so it lives in
../scripts/check-auth.js, which mints with this code and verifies with the
runner's. A green run here and a green run there still would not prove they
agree — only the crossing does.
"""
import json
import time

from django.contrib.auth import get_user_model
from django.test import Client, TestCase, override_settings

from .tokens import MIN_SECRET, NoSigningKey, mint

SECRET = 'tests-secret-long-enough-for-hmac-0123456789012'
User = get_user_model()


class TokenTests(TestCase):
    def test_claims_are_what_the_runner_expects(self):
        now = 1_700_000_000
        token = mint(subject=7, email='qa@example.com', secret=SECRET, ttl=600, now=now)
        header, claims, signature = token.split('.')
        self.assertTrue(header and claims and signature)

        import base64
        decoded = json.loads(base64.urlsafe_b64decode(claims + '=' * (-len(claims) % 4)))
        self.assertEqual(decoded['sub'], '7')
        self.assertEqual(decoded['email'], 'qa@example.com')
        self.assertEqual(decoded['scope'], 'run')
        self.assertEqual(decoded['iat'], now)
        self.assertEqual(decoded['exp'], now + 600)

    def test_segments_are_unpadded(self):
        # base64url in a JWT carries no '=' padding. Emitting it produces a
        # token that some verifiers accept and others refuse, which is the
        # worst possible failure: it works until it meets a different library.
        self.assertNotIn('=', mint(subject=1, secret=SECRET))

    def test_a_short_secret_refuses_rather_than_signs(self):
        with self.assertRaises(NoSigningKey):
            mint(subject=1, secret='x' * (MIN_SECRET - 1))

    def test_no_secret_refuses_rather_than_signs(self):
        # The failure that matters: a default would let an unconfigured service
        # issue tokens nobody can verify, and nothing would say so.
        with self.assertRaises(NoSigningKey):
            mint(subject=1, secret='')

    def test_the_subject_is_stringified(self):
        # The runner compares sub as a string; an int here and a str there is
        # the kind of mismatch that only shows up under a permissions check.
        token = mint(subject=42, secret=SECRET)
        import base64
        claims = token.split('.')[1]
        decoded = json.loads(base64.urlsafe_b64decode(claims + '=' * (-len(claims) % 4)))
        self.assertIsInstance(decoded['sub'], str)


@override_settings(GC_AUTH_SECRET=SECRET, GC_TOKEN_TTL=600)
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
        import base64
        claims = r.json()['token'].split('.')[1]
        decoded = json.loads(base64.urlsafe_b64decode(claims + '=' * (-len(claims) % 4)))
        self.assertEqual(decoded['sub'], str(self.user.pk))
        self.assertEqual(decoded['email'], 'qa@example.com')

    def test_logout_ends_it(self):
        tok = self.login()
        after = self.c.post('/auth/logout', HTTP_X_CSRFTOKEN=tok).json()['csrfToken']
        self.assertEqual(self.c.get('/auth/me').status_code, 401)
        self.assertEqual(self.c.post('/auth/executor-token', HTTP_X_CSRFTOKEN=after).status_code, 401)

    @override_settings(GC_AUTH_SECRET='')
    def test_unconfigured_says_so_rather_than_failing_obscurely(self):
        tok = self.login()
        r = self.c.post('/auth/executor-token', HTTP_X_CSRFTOKEN=tok)
        # 503, not 500: nothing is broken, it has not been told the key.
        self.assertEqual(r.status_code, 503)
        self.assertIn('GC_AUTH_SECRET', r.json()['error'])


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
