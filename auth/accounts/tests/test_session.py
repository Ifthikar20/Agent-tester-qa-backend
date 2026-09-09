"""
The absolute session lifetime (docs/AUTH.md §1).

Seven days from the FIRST sign-in of a session, whatever happens in between.
"""
import time

from django.test import TestCase, override_settings

from ..events import LOGIN_AT
from ..models import AuthEvent
from .support import Api, make_user


class AbsoluteLifetimeTests(TestCase):
    def setUp(self):
        self.user = make_user('qa@example.com')
        self.api = Api()
        self.c = self.api.c

    def login(self):
        self.api.login('qa@example.com')

    def backdate(self, seconds):
        s = self.c.session
        s[LOGIN_AT] = int(time.time()) - seconds
        s.save()

    def test_signing_in_stamps_the_start(self):
        before = int(time.time())
        self.login()
        self.assertGreaterEqual(self.c.session[LOGIN_AT], before)

    def test_signing_in_again_does_not_restart_the_clock(self):
        # A reauthentication proves the password again inside the same
        # session, and a Google "connect" fires user_logged_in again. If
        # either reset the stamp, "absolute" would mean "until you next prove
        # who you are", which is the sliding clock again.
        self.login()
        self.backdate(1000)
        was = self.c.session[LOGIN_AT]
        self.assertEqual(self.api.reauthenticate().status_code, 200)
        self.assertEqual(self.c.session[LOGIN_AT], was)
        self.c.force_login(self.user)     # user_logged_in once more, same session
        self.assertEqual(self.c.session[LOGIN_AT], was)

    def test_a_session_within_the_lifetime_keeps_working(self):
        self.login()
        self.backdate(6 * 24 * 3600)
        self.assertEqual(self.c.get('/auth/me').status_code, 200)

    def test_past_the_lifetime_the_session_is_gone(self):
        self.login()
        self.backdate(7 * 24 * 3600 + 1)
        r = self.c.get('/auth/me')
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json(), {'error': 'session_expired'})
        # Flushed, not merely refused: the next request has no session at all.
        self.assertEqual(self.c.get('/auth/me').status_code, 401)
        self.assertEqual(self.c.get('/auth/me').json()['error'], 'Not signed in')
        self.assertEqual(AuthEvent.objects.get(kind=AuthEvent.Kind.SESSION_EXPIRED).user, self.user)

    @override_settings(GC_SESSION_ABSOLUTE_SECONDS=60)
    def test_the_limit_is_the_setting(self):
        self.login()
        self.backdate(61)
        self.assertEqual(self.c.get('/auth/me').status_code, 401)

    def test_a_session_from_before_the_rule_gets_a_clock(self):
        # Unknown start: stamp it now rather than let it live forever.
        self.login()
        s = self.c.session
        del s[LOGIN_AT]
        s.save()
        self.assertEqual(self.c.get('/auth/me').status_code, 200)
        self.assertIn(LOGIN_AT, self.c.session)

    def test_an_anonymous_session_is_left_alone(self):
        self.assertEqual(self.c.get('/auth/csrf').status_code, 200)
        self.assertNotIn(LOGIN_AT, self.c.session)
