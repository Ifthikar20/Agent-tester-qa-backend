"""
Sign-in (docs/AUTH.md §3 and §5, the password parts): the rate limits and
the address they key on, Turnstile after the limit trips, Have I Been Pwned
on the presented password, the session's authentication events, and the
new-device mail.
"""
from unittest import mock

from django.core import mail
from django.core.cache import cache
from django.test import TestCase, override_settings

from .. import turnstile
from ..events import AUTH_EVENTS, PWNED
from ..models import AuthEvent
from ..testing import hibp
from .support import HEADLESS, PASSWORD, Api, give_authenticator, make_user, totp_code

TOO_MANY = 'too_many_login_attempts'


def code(r):
    return r.json()['errors'][0]['code']


class RateLimitTests(TestCase):
    """
    allauth's limiter, on the real endpoint, keyed on the address the edge
    reports [credentials-2].
    """

    def setUp(self):
        cache.clear()
        make_user('qa@example.com')

    @override_settings(ACCOUNT_RATE_LIMITS={'login': '30/m/ip', 'login_failed': '3/m/ip,5/5m/key'})
    def test_the_per_ip_limit_counts_failures_from_one_address(self):
        # Different accounts, one address: the fourth failure is refused
        # before the hasher runs, and so is a correct password from there.
        for n in range(3):
            self.assertEqual(Api().try_login(f'nobody{n}@example.com', PASSWORD).status_code, 400)
        r = Api().try_login('qa@example.com', PASSWORD)
        self.assertEqual(r.status_code, 400)
        self.assertEqual(code(r), TOO_MANY)

    @override_settings(ACCOUNT_RATE_LIMITS={'login': '30/m/ip', 'login_failed': '10/m/ip,3/5m/key'})
    def test_the_per_account_limit_counts_failures_against_one_address(self):
        for _ in range(3):
            Api().try_login('qa@example.com', 'wrong-and-long-enough')
        r = Api().try_login('qa@example.com', PASSWORD)
        self.assertEqual(code(r), TOO_MANY)
        # Another account from the same address is still fine.
        make_user('other@example.com')
        self.assertEqual(Api().try_login('other@example.com', PASSWORD).status_code, 200)

    @override_settings(ACCOUNT_RATE_LIMITS={'login': '30/m/ip', 'login_failed': '3/m/ip,5/5m/key'},
                       ALLAUTH_TRUSTED_PROXY_COUNT=0)
    def test_with_no_proxy_a_forged_x_forwarded_for_does_not_move_the_bucket(self):
        # On a laptop nobody rewrites the header, so a client that sends its
        # own would otherwise get a fresh limit per forged address.
        for n in range(3):
            Api(HTTP_X_FORWARDED_FOR=f'1.2.3.{n}').try_login(f'nobody{n}@example.com', PASSWORD)
        r = Api(HTTP_X_FORWARDED_FOR='9.9.9.9').try_login('qa@example.com', PASSWORD)
        self.assertEqual(code(r), TOO_MANY)

    @override_settings(ACCOUNT_RATE_LIMITS={'login': '30/m/ip', 'login_failed': '3/m/ip,5/5m/key'},
                       ALLAUTH_TRUSTED_PROXY_COUNT=1)
    def test_behind_the_edge_the_bucket_is_the_last_hop(self):
        # Caddy REPLACES the header with the peer, so the last entry is the
        # client; a client that appended its own is still counted under the
        # edge's entry, and a genuinely different client is a different bucket.
        for n in range(3):
            Api(HTTP_X_FORWARDED_FOR=f'6.6.6.{n}, 198.51.100.7').try_login(f'nobody{n}@example.com', PASSWORD)
        self.assertEqual(code(Api(HTTP_X_FORWARDED_FOR='198.51.100.7').try_login('qa@example.com', PASSWORD)), TOO_MANY)
        self.assertEqual(Api(HTTP_X_FORWARDED_FOR='203.0.113.9').try_login('qa@example.com', PASSWORD).status_code, 200)

    @override_settings(ACCOUNT_RATE_LIMITS={'login': '2/m/ip', 'login_failed': '10/m/ip,5/5m/key'})
    def test_the_login_endpoint_itself_is_limited(self):
        Api().try_login('qa@example.com', PASSWORD)
        Api().try_login('qa@example.com', PASSWORD)
        self.assertEqual(Api().try_login('qa@example.com', PASSWORD).status_code, 429)


@override_settings(GC_TURNSTILE_SECRET='secret', GC_TURNSTILE_SITE_KEY='site',
                   ACCOUNT_RATE_LIMITS={'login': '30/m/ip', 'login_failed': '3/m/ip,20/5m/key'})
class TurnstileTests(TestCase):
    """
    After the per-IP failed-login limit trips, that address presents a
    Turnstile token with every sign-in for an hour [credentials-1].
    """

    def setUp(self):
        cache.clear()
        make_user('qa@example.com')

    def solved(self, token, ip=None):
        return token == 'solved'

    def test_nothing_is_asked_before_the_limit_trips(self):
        with mock.patch.object(turnstile, 'verify', side_effect=self.solved) as verify:
            self.assertEqual(Api().try_login('qa@example.com', PASSWORD).status_code, 200)
            verify.assert_not_called()

    def test_after_the_limit_trips_the_address_must_present_a_token(self):
        with mock.patch.object(turnstile, 'verify', side_effect=self.solved):
            for n in range(3):
                Api().try_login(f'nobody{n}@example.com', PASSWORD)
            self.assertTrue(turnstile.demanded('127.0.0.1'))
            self.assertTrue(AuthEvent.objects.filter(kind=AuthEvent.Kind.TURNSTILE_DEMANDED).exists())
            # Checked before the password: a script cannot spend hasher time
            # to learn whether its guess was right.
            r = Api().try_login('qa@example.com', PASSWORD)
            self.assertEqual(code(r), 'turnstile_required')
            self.assertEqual(r.json()['errors'][0]['param'], 'turnstile')
            r = Api().try_login('qa@example.com', PASSWORD, turnstile='forged')
            self.assertEqual(code(r), 'turnstile_failed')
            # With a solved challenge the request reaches allauth's own
            # limiter, which is what the address tripped.
            r = Api().try_login('qa@example.com', PASSWORD, turnstile='solved')
            self.assertEqual(code(r), TOO_MANY)

    def test_a_demanded_address_with_a_solved_challenge_signs_in(self):
        turnstile.demand('127.0.0.1')
        with mock.patch.object(turnstile, 'verify', side_effect=self.solved) as verify:
            self.assertEqual(code(Api().try_login('qa@example.com', PASSWORD)), 'turnstile_required')
            self.assertEqual(Api().try_login('qa@example.com', PASSWORD, turnstile='solved').status_code, 200)
            verify.assert_called_with('solved', '127.0.0.1')

    def test_the_demand_is_per_address(self):
        turnstile.demand('203.0.113.9')
        self.assertEqual(Api().try_login('qa@example.com', PASSWORD).status_code, 200)

    @override_settings(GC_TURNSTILE_SECRET='', GC_TURNSTILE_SITE_KEY='')
    def test_unconfigured_nothing_is_demanded(self):
        for n in range(3):
            Api().try_login(f'nobody{n}@example.com', PASSWORD)
        self.assertFalse(turnstile.demanded('127.0.0.1'))
        self.assertFalse(AuthEvent.objects.filter(kind=AuthEvent.Kind.TURNSTILE_DEMANDED).exists())

    def test_the_verifier_refuses_on_any_answer_but_yes(self):
        # A network failure is not a reason to let a script in.
        with mock.patch('urllib.request.urlopen', side_effect=OSError('down')):
            self.assertFalse(turnstile.verify('anything', '127.0.0.1'))
        self.assertFalse(turnstile.verify('', '127.0.0.1'))
        self.assertFalse(turnstile.verify('x' * 3000, '127.0.0.1'))


class PwnedAtLoginTests(TestCase):
    """
    Every successful sign-in runs the presented password through Have I
    Been Pwned; a hit forces a change before anything else [credentials-1].
    """

    def setUp(self):
        cache.clear()
        hibp.reset()
        self.user = make_user('qa@example.com')

    def tearDown(self):
        hibp.reset()

    def test_a_clean_password_is_checked_and_nothing_happens(self):
        api = Api()
        api.login('qa@example.com')
        self.assertIn(PASSWORD, hibp.calls)
        self.assertNotIn(PWNED, api.session)
        self.assertEqual(api.post('/auth/executor-token').status_code, 503)   # no signing key here; not 403

    def test_a_breached_password_may_do_one_thing(self):
        hibp.hits = 3
        api = Api()
        self.assertEqual(api.login('qa@example.com').status_code, 200)
        self.assertTrue(api.session[PWNED])
        self.assertEqual(AuthEvent.objects.get(kind=AuthEvent.Kind.PASSWORD_PWNED).detail['breaches'], 3)
        # Everything else is refused with one word the SPA routes on.
        for path in ['/auth/executor-token', '/auth/org', '/auth/invitations']:
            r = api.post(path)
            self.assertEqual(r.status_code, 403, path)
            self.assertEqual(r.json(), {'error': 'password_change_required'})
        # What stays open: who am I, the session, and the change itself.
        self.assertEqual(api.get('/auth/me').status_code, 200)
        self.assertEqual(api.current().status_code, 200)
        hibp.hits = 0
        r = api.change_password(PASSWORD, 'a-brand-new-long-password')
        self.assertEqual(r.status_code, 401, r.content)     # allauth signed the session out
        api = Api()
        self.assertEqual(api.login('qa@example.com', 'a-brand-new-long-password').status_code, 200)
        self.assertNotIn(PWNED, api.session)
        self.assertEqual(api.post('/auth/executor-token').status_code, 503)

    def test_signing_out_is_always_possible(self):
        hibp.hits = 1
        api = Api()
        api.login('qa@example.com')
        self.assertEqual(api.logout().status_code, 401)
        self.assertEqual(api.get('/auth/me').status_code, 401)

    def test_an_enrolled_account_can_prove_the_factor_and_then_change(self):
        """
        The forced change must stay REACHABLE for an enrolled account.

        StrongReauthentication refuses the change with a 401 naming
        `mfa_reauthenticate` once the sign-in proof is older than the
        window — and PasswordChangeRequired used to answer 403 to the two
        endpoints that could supply that proof. Both refusals are correct on
        their own and together they were a dead end: the [credentials-1]
        change became impossible for exactly the accounts holding a second
        factor, recoverable only by signing out and going through the
        mailbox.
        """
        hibp.hits = 2
        secret = give_authenticator(self.user)
        api = Api()
        r = api.try_login('qa@example.com')
        self.assertEqual(r.status_code, 401)
        self.assertEqual(api.post(f'{HEADLESS}/auth/2fa/authenticate', {'code': totp_code(secret)}).status_code, 200)
        self.assertEqual(api.session[PWNED], self.user.pk)
        # Age every proof past ACCOUNT_REAUTHENTICATION_TIMEOUT.
        s = api.session
        for m in s.get('account_authentication_methods', []):
            m['at'] -= 1000
        for e in s.get(AUTH_EVENTS, []):
            e['at'] -= 1000
        s.save()
        hibp.hits = 0
        stalled = api.change_password(PASSWORD, 'a-brand-new-long-password')
        self.assertEqual(stalled.status_code, 401)
        self.assertEqual([f['id'] for f in stalled.json()['data']['flows']], ['mfa_reauthenticate'])
        # The proof it asks for is one a marked session may give.
        cache.clear()
        proved = api.post(f'{HEADLESS}/auth/2fa/reauthenticate', {'code': totp_code(secret)})
        self.assertEqual(proved.status_code, 200, proved.content)
        done = api.change_password(PASSWORD, 'a-brand-new-long-password')
        self.assertEqual(done.status_code, 401, done.content)   # allauth signs the session out
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password('a-brand-new-long-password'))

    def test_the_mark_belongs_to_one_account_not_to_the_browser(self):
        """
        A shared browser must not carry one person's breach to the next.

        The flag is written while the sign-in is still anonymous, and
        django.contrib.auth.login cycles the session key but PRESERVES the
        data — so a breached sign-in abandoned at the second-factor stage
        used to leave a boolean behind, and the next account to sign in on
        that machine was refused everything but a password change it did
        not need.
        """
        hibp.hits = 4
        give_authenticator(self.user)
        api = Api()
        self.assertEqual(api.try_login('qa@example.com').status_code, 401)   # stops at the challenge
        self.assertEqual(api.session[PWNED], self.user.pk)
        # Somebody else, same browser, a password that is not in any corpus.
        hibp.hits = 0
        other = make_user('bob@example.com')
        self.assertEqual(api.login('bob@example.com').status_code, 200)
        self.assertEqual(api.get('/auth/me').status_code, 200)
        r = api.post('/auth/executor-token')
        self.assertNotEqual(r.status_code, 403)
        self.assertNotEqual(r.json().get('error'), 'password_change_required')
        self.assertEqual(other.pk, api.get('/auth/me').json()['user']['id'])

    def test_an_outage_does_not_mark_the_session(self):
        hibp.outage = True
        api = Api()
        self.assertEqual(api.login('qa@example.com').status_code, 200)
        self.assertNotIn(PWNED, api.session)


class AuthenticationEventTests(TestCase):
    """The session's list of factors used (docs/AUTH.md §5.3)."""

    def setUp(self):
        self.user = make_user('qa@example.com')

    def test_a_password_sign_in_is_one_event(self):
        api = Api()
        api.login('qa@example.com')
        events = api.session[AUTH_EVENTS]
        self.assertEqual([e['method'] for e in events], ['password'])

    def test_a_reauthentication_appends_and_is_logged(self):
        api = Api()
        api.login('qa@example.com')
        r = api.reauthenticate(PASSWORD)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual([e['method'] for e in api.session[AUTH_EVENTS]], ['password', 'password'])
        ev = AuthEvent.objects.get(kind=AuthEvent.Kind.REAUTHENTICATION)
        self.assertEqual((ev.user, ev.detail['method']), (self.user, 'password'))

    def test_a_wrong_reauthentication_appends_nothing(self):
        api = Api()
        api.login('qa@example.com')
        self.assertEqual(api.reauthenticate('not-it-and-long-enough').status_code, 400)
        self.assertEqual(len(api.session[AUTH_EVENTS]), 1)

    def test_reauthentication_needs_a_session(self):
        self.assertEqual(Api().reauthenticate(PASSWORD).status_code, 401)


class NewDeviceTests(TestCase):
    """An (address, user agent) pair unseen on the account is mailed about (§5.6)."""

    def setUp(self):
        make_user('qa@example.com')

    def test_the_first_sign_in_ever_is_not_news(self):
        Api(HTTP_USER_AGENT='laptop/1').login('qa@example.com')
        self.assertEqual(mail.outbox, [])

    def test_a_new_pair_is_mailed_and_a_known_one_is_not(self):
        Api(HTTP_USER_AGENT='laptop/1').login('qa@example.com')
        Api(HTTP_USER_AGENT='laptop/1').login('qa@example.com')
        self.assertEqual(mail.outbox, [])
        Api(HTTP_USER_AGENT='phone/2').login('qa@example.com')
        [msg] = mail.outbox
        self.assertEqual(msg.to, ['qa@example.com'])
        self.assertIn('phone/2', msg.body)
        self.assertIn('127.0.0.1', msg.body)
        self.assertEqual(AuthEvent.objects.filter(kind=AuthEvent.Kind.NEW_DEVICE).count(), 1)
        Api(HTTP_USER_AGENT='phone/2').login('qa@example.com')
        self.assertEqual(len(mail.outbox), 1)

    @override_settings(ALLAUTH_TRUSTED_PROXY_COUNT=1)
    def test_the_address_compared_is_the_edge_s(self):
        Api(HTTP_USER_AGENT='laptop/1', HTTP_X_FORWARDED_FOR='198.51.100.7').login('qa@example.com')
        Api(HTTP_USER_AGENT='laptop/1', HTTP_X_FORWARDED_FOR='198.51.100.7').login('qa@example.com')
        self.assertEqual(mail.outbox, [])
        Api(HTTP_USER_AGENT='laptop/1', HTTP_X_FORWARDED_FOR='203.0.113.9').login('qa@example.com')
        self.assertEqual(len(mail.outbox), 1)


class EnumerationTests(TestCase):
    """
    One answer for "no such account" on every endpoint that takes an address
    [credentials-3]: sign-in, sign-up and reset each say the same thing
    whether the address exists or not.
    """

    def setUp(self):
        cache.clear()
        make_user('qa@example.com')

    def test_sign_in(self):
        wrong = Api().try_login('qa@example.com', 'not-it-and-long-enough')
        unknown = Api().try_login('nobody@example.com', 'not-it-and-long-enough')
        self.assertEqual((wrong.status_code, wrong.json()), (unknown.status_code, unknown.json()))

    @override_settings(GC_SIGNUP_MODE='open')
    def test_sign_up(self):
        taken = Api().signup('qa@example.com', PASSWORD)
        fresh = Api().signup('fresh@example.com', PASSWORD)
        self.assertEqual((taken.status_code, taken.json()), (fresh.status_code, fresh.json()))

    def test_sign_up_in_invite_mode(self):
        taken = Api().signup('qa@example.com', PASSWORD)
        uninvited = Api().signup('eve@example.com', PASSWORD)
        self.assertEqual((taken.status_code, taken.json()), (uninvited.status_code, uninvited.json()))

    def test_reset(self):
        known = Api().request_reset('qa@example.com')
        unknown = Api().request_reset('nobody@example.com')
        self.assertEqual(known.status_code, 200)
        self.assertEqual((known.status_code, known.json()), (unknown.status_code, unknown.json()))
        # The difference is in the mailboxes, where only the owner reads it.
        self.assertEqual(sorted(m.to[0] for m in mail.outbox), ['nobody@example.com', 'qa@example.com'])

    def test_the_session_endpoint_names_the_flows_and_nothing_about_accounts(self):
        r = Api().get(f'{HEADLESS}/auth/session')
        self.assertEqual(r.status_code, 401)
        self.assertEqual({f['id'] for f in r.json()['data']['flows']}, {'login', 'signup', 'mfa_login_webauthn'})
