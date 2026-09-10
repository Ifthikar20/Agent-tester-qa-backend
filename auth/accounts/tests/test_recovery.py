"""
Recovery and account changes (docs/AUTH.md §7): the reset link, what a
reset ends, the password change, the email change and the week the old
address keeps.
"""
import time
from datetime import timedelta

from allauth.account.models import EmailAddress
from django.contrib.auth import get_user_model
from django.core import mail
from django.core.cache import cache
from django.test import TestCase, override_settings
from django.utils import timezone

from ..events import AUTH_EVENTS, LOGIN_AT
from ..models import AuthEvent, PreviousEmail
from .support import Api, PASSWORD, code_from_mail, key_from_mail, make_user

User = get_user_model()
NEW_PASSWORD = 'a-completely-new-long-password'


def stale(api, seconds=1000):
    """Make the session's last authentication look `seconds` old, for allauth and for the token."""
    s = api.session
    for m in s.get('account_authentication_methods', []):
        m['at'] -= seconds
    for e in s.get(AUTH_EVENTS, []):
        e['at'] -= seconds
    s.save()


class ResetTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = make_user('qa@example.com')

    def request(self, email='qa@example.com'):
        r = Api().request_reset(email)
        self.assertEqual(r.status_code, 200, r.content)
        return key_from_mail()

    def test_the_mail_links_the_spa_and_the_link_resets_the_password(self):
        key = self.request()
        [msg] = mail.outbox
        self.assertEqual(msg.to, ['qa@example.com'])
        self.assertIn('/app/reset-password?key=', msg.body)
        self.assertIn('one hour', msg.body)
        api = Api()
        r = api.reset(key, NEW_PASSWORD)
        self.assertEqual(r.status_code, 401, r.content)      # not signed in by it
        self.assertEqual(api.get('/auth/me').status_code, 401)
        self.assertTrue(User.objects.get(pk=self.user.pk).check_password(NEW_PASSWORD))
        self.assertEqual(Api().try_login('qa@example.com', NEW_PASSWORD).status_code, 200)

    def test_the_link_is_single_use(self):
        key = self.request()
        self.assertEqual(Api().reset(key, NEW_PASSWORD).status_code, 401)
        r = Api().reset(key, 'another-long-password-entirely')
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()['errors'][0]['param'], 'key')
        self.assertTrue(User.objects.get(pk=self.user.pk).check_password(NEW_PASSWORD))

    @override_settings(PASSWORD_RESET_TIMEOUT=1)
    def test_the_link_expires(self):
        # Django's generator counts whole seconds, so a one-second timeout
        # needs two of them to be sure of having passed.
        key = self.request()
        time.sleep(2.2)
        self.assertEqual(Api().reset(key, NEW_PASSWORD).status_code, 400)

    def test_the_validators_apply_to_the_new_password(self):
        key = self.request()
        r = Api().reset(key, 'short')
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()['errors'][0]['param'], 'password')

    def test_a_reset_ends_every_session_and_says_so(self):
        thief, owner = Api(), Api()
        thief.login('qa@example.com')
        owner.login('qa@example.com')
        mail.outbox.clear()
        key = self.request()
        Api().reset(key, NEW_PASSWORD)
        self.assertEqual(thief.get('/auth/me').status_code, 401)
        self.assertEqual(owner.get('/auth/me').status_code, 401)
        # The account is told, and the log says how many were ended.
        notices = [m for m in mail.outbox if 'reset' in m.subject.lower() and 'reset-password?key=' not in m.body]
        self.assertEqual(len(notices), 1)
        self.assertEqual(AuthEvent.objects.get(kind=AuthEvent.Kind.PASSWORD_RESET).detail['sessions_ended'], 2)

    def test_an_unknown_address_gets_a_mail_and_the_same_answer(self):
        r = Api().request_reset('nobody@example.com')
        self.assertEqual(r.status_code, 200)
        [msg] = mail.outbox
        self.assertEqual(msg.to, ['nobody@example.com'])
        self.assertNotIn('/reset-password?key=', msg.body)

    @override_settings(ACCOUNT_RATE_LIMITS={'reset_password': '20/m/ip,2/m/key'})
    def test_requests_are_limited_per_address(self):
        Api().request_reset('qa@example.com')
        Api().request_reset('qa@example.com')
        self.assertEqual(Api().request_reset('qa@example.com').status_code, 429)


class ChangePasswordTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = make_user('qa@example.com')
        self.api = Api()
        self.api.login('qa@example.com')
        mail.outbox.clear()

    def test_the_current_password_is_the_reauthentication(self):
        r = self.api.change_password('not-it-and-long-enough', NEW_PASSWORD)
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()['errors'][0]['param'], 'current_password')
        self.assertTrue(User.objects.get(pk=self.user.pk).check_password(PASSWORD))

    def test_a_change_ends_this_session_and_every_other_and_is_mailed(self):
        other = Api()
        other.login('qa@example.com')
        r = self.api.change_password(PASSWORD, NEW_PASSWORD)
        self.assertEqual(r.status_code, 401, r.content)
        self.assertEqual(self.api.get('/auth/me').status_code, 401)
        self.assertEqual(other.get('/auth/me').status_code, 401)
        self.assertEqual(Api().try_login('qa@example.com', NEW_PASSWORD).status_code, 200)
        self.assertEqual([m.to for m in mail.outbox], [['qa@example.com']])
        self.assertIn('changed', mail.outbox[0].subject.lower())
        self.assertEqual(AuthEvent.objects.get(kind=AuthEvent.Kind.PASSWORD_CHANGED).user, self.user)

    def test_the_validators_apply(self):
        r = self.api.change_password(PASSWORD, 'short')
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()['errors'][0]['param'], 'new_password')

    @override_settings(ACCOUNT_RATE_LIMITS={'change_password': '2/m/user'})
    def test_attempts_are_limited_per_user(self):
        self.api.change_password('wrong-and-long-enough', NEW_PASSWORD)
        self.api.change_password('wrong-and-long-enough', NEW_PASSWORD)
        self.assertEqual(self.api.change_password('wrong-and-long-enough', NEW_PASSWORD).status_code, 429)


class ChangeEmailTests(TestCase):
    """
    The new address is verified by code, the old one is told, and the old
    one can still reset the password for seven days [mfa-recovery-3].
    """

    def setUp(self):
        cache.clear()
        self.user = make_user('old@example.com')
        self.api = Api()
        self.api.login('old@example.com')
        mail.outbox.clear()

    def change(self, to='new@example.com'):
        r = self.api.add_email(to)
        self.assertEqual(r.status_code, 200, r.content)
        code = code_from_mail([m for m in mail.outbox if m.to == [to]][-1])
        r = self.api.verify(code)
        self.assertEqual(r.status_code, 200, r.content)

    def test_the_change_needs_a_recent_authentication(self):
        stale(self.api)
        r = self.api.add_email('new@example.com')
        self.assertEqual(r.status_code, 401)
        self.assertTrue(any(f['id'] == 'reauthenticate' for f in r.json()['data']['flows']))
        self.assertEqual(self.api.reauthenticate(PASSWORD).status_code, 200)
        self.assertEqual(self.api.add_email('new@example.com').status_code, 200)

    def test_the_new_address_is_verified_by_code_and_the_old_one_is_told(self):
        self.change()
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, 'new@example.com')
        rows = list(EmailAddress.objects.filter(user=self.user))
        self.assertEqual([(r.email, r.verified, r.primary) for r in rows], [('new@example.com', True, True)])
        told = [m for m in mail.outbox if m.to == ['old@example.com']]
        self.assertEqual(len(told), 1)
        self.assertIn('new@example.com', told[0].body)
        self.assertEqual(self.api.get('/auth/me').json()['user']['email'], 'new@example.com')
        ev = AuthEvent.objects.get(kind=AuthEvent.Kind.EMAIL_CHANGED)
        self.assertEqual((ev.detail['previous'], ev.detail['current']), ('old@example.com', 'new@example.com'))

    def test_until_verified_nothing_has_changed(self):
        self.api.add_email('new@example.com')
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, 'old@example.com')
        self.assertFalse(PreviousEmail.objects.exists())
        self.assertEqual(Api().try_login('old@example.com', PASSWORD).status_code, 200)

    def test_the_old_address_can_reset_the_password_for_seven_days(self):
        self.change()
        row = PreviousEmail.objects.get(email='old@example.com')
        self.assertEqual(row.user, self.user)
        self.assertAlmostEqual(row.until, timezone.now() + timedelta(days=7), delta=timedelta(minutes=1))
        mail.outbox.clear()
        # The old mailbox asks. The link goes there, resets THIS account,
        # and the mail names the address the account now signs in with.
        self.assertEqual(Api().request_reset('old@example.com').status_code, 200)
        [msg] = mail.outbox
        self.assertEqual(msg.to, ['old@example.com'])
        self.assertIn('/reset-password?key=', msg.body)
        self.assertIn('new@example.com', msg.body)
        rows = AuthEvent.objects.filter(kind=AuthEvent.Kind.PASSWORD_RESET_REQUESTED)
        # Two rows: the ordinary "nobody holds this address now", and the one
        # that says an account used to.
        self.assertEqual({r.detail.get('via') or r.detail.get('known') for r in rows}, {'previous_email', False})
        key = key_from_mail(msg)
        Api().reset(key, NEW_PASSWORD)
        # The thief's session — this one — is gone, and the new password works.
        self.assertEqual(self.api.get('/auth/me').status_code, 401)
        self.assertEqual(Api().try_login('new@example.com', NEW_PASSWORD).status_code, 200)

    def test_after_seven_days_the_old_address_is_nobody(self):
        self.change()
        PreviousEmail.objects.update(until=timezone.now() - timedelta(seconds=1))
        mail.outbox.clear()
        self.assertEqual(Api().request_reset('old@example.com').status_code, 200)
        [msg] = mail.outbox
        self.assertNotIn('/reset-password?key=', msg.body)

    def test_the_old_address_cannot_sign_in(self):
        self.change()
        self.assertEqual(Api().try_login('old@example.com', PASSWORD).status_code, 400)

    def test_the_list_shows_at_most_the_two_addresses_of_a_change(self):
        self.api.add_email('new@example.com')
        r = self.api.emails()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(sorted(e['email'] for e in r.json()['data']), ['new@example.com', 'old@example.com'])
        self.assertEqual(self.api.add_email('third@example.com').status_code, 200)   # replaces the pending one
        self.assertEqual(sorted(e['email'] for e in self.api.emails().json()['data']), ['old@example.com', 'third@example.com'])


class ReauthenticationEventTests(TestCase):
    def test_every_reauthentication_is_appended_and_recorded(self):
        make_user('qa@example.com')
        api = Api()
        api.login('qa@example.com')
        stale(api)
        api.reauthenticate(PASSWORD)
        api.reauthenticate(PASSWORD)
        self.assertEqual(len(api.session[AUTH_EVENTS]), 3)
        self.assertEqual(AuthEvent.objects.filter(kind=AuthEvent.Kind.REAUTHENTICATION).count(), 2)
        # And the absolute clock did not move.
        self.assertIn(LOGIN_AT, api.session)
