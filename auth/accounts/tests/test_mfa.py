"""
The second factor (docs/AUTH.md §5, the MFA parts, and §7.2): who must hold
one, enrolling, the challenge at sign-in, passkeys, what a session that has
proved one may do that a session that has not may not, and the claims the
token draws from it.
"""
import time
from unittest import mock

from allauth.mfa.models import Authenticator
from allauth.mfa.recovery_codes.internal.auth import RecoveryCodes
from django.core import mail
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.test import TestCase, override_settings

from tenants.models import Role
from tenants.tests.support import member, org

from .. import mfa
from ..adapters import MFAAdapter
from ..events import AUTH_EVENTS
from ..models import AuthEvent
from ..tokens import STEP_UP_SECONDS
from . import keys
from .softkey import SoftKey
from .support import HEADLESS, PASSWORD, Api, give_authenticator, make_user, prove_strong, totp_code

ORIGIN = 'https://app.example.com'


def stale(api, seconds=1000):
    """Make every proof the session holds look `seconds` old, for allauth and for the token."""
    s = api.session
    for m in s.get('account_authentication_methods', []):
        m['at'] -= seconds
    for e in s.get(AUTH_EVENTS, []):
        e['at'] -= seconds
    s.save()


def flows(r):
    return {f['id']: f for f in r.json()['data']['flows']}


def enrol_totp(api):
    """Enrol an authenticator app through the endpoints. Returns (secret, recovery codes)."""
    r = api.get(f'{HEADLESS}/account/authenticators/totp')
    assert r.status_code == 404, r.content
    secret = r.json()['meta']['secret']
    r = api.post(f'{HEADLESS}/account/authenticators/totp', {'code': totp_code(secret)})
    assert r.status_code == 200, r.content
    codes = api.get(f'{HEADLESS}/account/authenticators/recovery-codes').json()['data']['unused_codes']
    return secret, codes


def reuse_code(secret):
    """
    The current code, usable again. A code is good once per window and the
    marker is a cache entry, so clearing the cache is the next thirty
    seconds arriving — which a test cannot wait for.
    """
    cache.clear()
    return totp_code(secret)


def challenge(api, email, secret, step=0):
    """A full sign-in for an enrolled account: the password, then the code."""
    r = api.try_login(email)
    assert r.status_code == 401 and flows(r)['mfa_authenticate']['is_pending'], r.content
    r = api.post(f'{HEADLESS}/auth/2fa/authenticate', {'code': totp_code(secret, step)})
    assert r.status_code == 200, r.content
    return r


@override_settings(GC_SIGNING_KEY=keys.PRIVATE_PEM)
class PolicyTests(TestCase):
    """docs/AUTH.md §5.4: session-scoped, and it names four kinds of account."""

    def setUp(self):
        cache.clear()
        self.acme = org('acme', plan='team')

    def signed_in(self, email, **extra):
        user = make_user(email, **extra)
        api = Api()
        api.login(email)
        return user, api

    def test_an_unenrolled_admin_cannot_mint_and_cannot_reach_account_email(self):
        user, api = self.signed_in('ada@acme.example')
        member(self.acme, user, Role.ADMIN)
        r = api.post('/auth/executor-token')
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json(), {'error': 'mfa_required'})
        self.assertEqual(api.get(f'{HEADLESS}/account/email').status_code, 403)
        self.assertEqual(api.post('/auth/org', {'org': 'acme'}).status_code, 403)
        self.assertEqual(api.get('/auth/invitations').status_code, 403)

    def test_but_it_can_learn_why_enrol_and_sign_out(self):
        user, api = self.signed_in('ada@acme.example')
        member(self.acme, user, Role.OWNER)
        me = api.get('/auth/me')
        self.assertEqual(me.status_code, 200)
        self.assertEqual(me.json()['mfa'], {'required': True, 'enrolled': False, 'reasons': ['manages_organisation']})
        self.assertEqual(api.get(f'{HEADLESS}/account/authenticators').status_code, 200)
        self.assertEqual(api.get(f'{HEADLESS}/account/authenticators/totp').status_code, 404)   # the secret to enrol with
        self.assertEqual(api.get(f'{HEADLESS}/auth/session').status_code, 200)
        self.assertEqual(api.get('/auth/csrf').status_code, 200)
        self.assertEqual(api.get('/auth/config').status_code, 200)
        self.assertEqual(api.logout().status_code, 401)

    def test_once_enrolled_the_same_session_mints(self):
        user, api = self.signed_in('ada@acme.example')
        member(self.acme, user, Role.ADMIN)
        self.assertEqual(api.post('/auth/executor-token').status_code, 403)
        enrol_totp(api)
        self.assertEqual(api.get('/auth/me').json()['mfa']['enrolled'], True)
        self.assertEqual(api.post('/auth/executor-token').status_code, 200)

    def test_a_member_of_an_organisation_is_not_named(self):
        user, api = self.signed_in('bob@acme.example')
        member(self.acme, user, Role.MEMBER)
        self.assertEqual(api.get('/auth/me').json()['mfa'], {'required': False, 'enrolled': False, 'reasons': []})
        self.assertEqual(api.post('/auth/executor-token').status_code, 200)

    def test_owning_only_the_personal_organisation_is_not_managing_anyone(self):
        # Everybody owns their personal organisation; it has one seat. The
        # rule is about the people a manager's session can act on.
        _, api = self.signed_in('solo@example.com')
        self.assertEqual(api.get('/auth/me').json()['mfa']['required'], False)

    def test_staff_is_named_but_not_said(self):
        # The rule is that the browser cannot LEARN the account is staff, and
        # the absent word is not the rule [authz-tenancy-6]. Removing 'staff'
        # from the list left `required: true` with an empty list, which the
        # other three reasons can never produce — an isStaff flag arrived at
        # by elimination, in one line of JavaScript. So the assertion is that
        # a staff-only account and an account named for a reason the client
        # does not model are BYTE-IDENTICAL here.
        _, api = self.signed_in('ops@example.com', is_staff=True)
        body = api.get('/auth/me')
        self.assertEqual(body.json()['mfa'], {'required': True, 'enrolled': False, 'reasons': ['policy']})
        self.assertNotIn('staff', body.content.decode())
        with mock.patch.object(mfa, 'reasons', return_value=['a reason from a later flow']):
            other = api.get('/auth/me').json()['mfa']
        self.assertEqual(body.json()['mfa'], other)
        self.assertEqual(api.post('/auth/executor-token').json(), {'error': 'mfa_required'})

    def test_a_google_only_account_cannot_set_a_password_instead_of_enrolling(self):
        """
        The policy's exit, closed (docs/AUTH.md §6.5, [oauth-1]).

        `account/password/change` used to be exempt from MfaRequired
        unconditionally, and for an account with no usable password allauth
        makes `current_password` optional and treats "no reauthentication
        flows" as recently authenticated — so a stolen cookie could SET a
        password, sign in with it, watch `no_password` disappear, and have
        enrolled nothing at all. The change is now reachable only while the
        session is marked as holding a breached password, which is the one
        case where it must come first.
        """
        user, api = self.signed_in('google@example.com')
        user.set_unusable_password()
        user.save(update_fields=['password'])
        # Changing the hash would sign this session out; keep it, because
        # what is under test is what a stolen cookie can do with it.
        s = api.session
        s['_auth_user_hash'] = user.get_session_auth_hash()
        s.save()
        self.assertEqual(api.get('/auth/me').json()['mfa'],
                         {'required': True, 'enrolled': False, 'reasons': ['no_password']})
        r = api.post(f'{HEADLESS}/account/password/change', {'new_password': 'a-brand-new-long-password'})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json(), {'error': 'mfa_required'})
        user.refresh_from_db()
        self.assertFalse(user.has_usable_password())
        # Enrolling is what is open, and it is what lifts the block.
        enrol_totp(api)
        self.assertEqual(api.get('/auth/me').json()['mfa']['enrolled'], True)
        self.assertEqual(api.post(f'{HEADLESS}/account/password/change',
                                  {'new_password': 'a-brand-new-long-password'}).status_code, 401)

    def test_a_blocked_account_cannot_bolt_on_another_google_identity(self):
        # `auth/provider/redirect` asks for no reauthentication at all, so
        # leaving it exempt let a blocked account complete process=connect on
        # nothing but the cookie — while REMOVING a provider is gated by
        # StrongReauthentication. §5.4 does not list it.
        user, api = self.signed_in('ops@example.com', is_staff=True)
        r = api.c.post(f'{HEADLESS}/auth/provider/redirect',
                       {'provider': 'google', 'process': 'connect', 'callback_url': '/app/security'},
                       HTTP_X_CSRFTOKEN=api.csrf)
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json(), {'error': 'mfa_required'})

    def test_a_plan_that_says_so_is_named_for_every_member(self):
        enterprise = org('globex', plan='enterprise')
        user, api = self.signed_in('carol@globex.example')
        member(enterprise, user, Role.MEMBER)
        self.assertEqual(api.get('/auth/me').json()['mfa']['reasons'], ['plan'])
        # Whichever organisation the session has selected.
        self.assertEqual(api.post('/auth/executor-token').status_code, 403)

    def test_an_account_with_no_password_is_named(self):
        user = make_user('google@example.com')
        user.set_unusable_password()
        user.save()
        api = Api()
        api.c.force_login(user)
        self.assertEqual(api.get('/auth/me').json()['mfa']['reasons'], ['no_password'])

    def test_a_pending_mfa_session_cannot_mint(self):
        # The password was right; the code has not been entered. There is no
        # signed-in user yet, so there is nobody to mint for.
        user = make_user('ada@example.com')
        give_authenticator(user)
        api = Api()
        r = api.try_login('ada@example.com')
        self.assertEqual(r.status_code, 401)
        self.assertTrue(flows(r)['mfa_authenticate']['is_pending'])
        self.assertEqual(api.post('/auth/executor-token').status_code, 401)
        self.assertEqual(api.get('/auth/me').status_code, 401)


class EnrolmentTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = make_user('ada@example.com')
        self.api = Api()
        self.api.login('ada@example.com')
        mail.outbox.clear()

    def test_an_authenticator_app_is_enrolled_with_a_code_from_its_secret(self):
        r = self.api.get(f'{HEADLESS}/account/authenticators/totp')
        self.assertEqual(r.status_code, 404)
        meta = r.json()['meta']
        self.assertIn('secret', meta)
        self.assertTrue(meta['totp_url'].startswith('otpauth://totp/'))
        self.assertIn('issuer=ghostclick', meta['totp_url'])
        self.assertIn('ada%40example.com', meta['totp_url'])
        self.assertEqual(self.api.post(f'{HEADLESS}/account/authenticators/totp', {'code': '000000'}).status_code, 400)
        r = self.api.post(f'{HEADLESS}/account/authenticators/totp', {'code': totp_code(meta['secret'])})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()['data']['type'], 'totp')
        kinds = sorted(Authenticator.objects.filter(user=self.user).values_list('type', flat=True))
        self.assertEqual(kinds, ['recovery_codes', 'totp'])
        self.assertEqual(self.api.get('/auth/me').json()['mfa']['enrolled'], True)

    def test_the_secret_is_encrypted_at_rest(self):
        secret, _ = enrol_totp(self.api)
        row = Authenticator.objects.get(user=self.user, type='totp')
        self.assertNotIn(secret, str(row.data))
        self.assertTrue(row.data['secret'].startswith('gAAAA'))     # a Fernet token
        self.assertEqual(MFAAdapter().decrypt(row.data['secret']), secret)
        seed = Authenticator.objects.get(user=self.user, type='recovery_codes').data['seed']
        self.assertTrue(seed.startswith('gAAAA'))

    def test_recovery_codes_are_shown_once(self):
        enrol_totp(self.api)
        # enrol_totp read them once; the next read has no codes in it.
        r = self.api.get(f'{HEADLESS}/account/authenticators/recovery-codes')
        self.assertEqual(r.status_code, 200)
        self.assertNotIn('unused_codes', r.json()['data'])
        self.assertEqual(r.json()['data']['unused_code_count'], 10)

    def test_enrolling_is_mailed_and_logged(self):
        enrol_totp(self.api)
        self.assertEqual([m.to for m in mail.outbox], [['ada@example.com']])
        self.assertIn('authenticator', mail.outbox[0].subject.lower())
        self.assertEqual(
            sorted(e.detail['type'] for e in AuthEvent.objects.filter(kind=AuthEvent.Kind.MFA_ENROLLED)),
            ['recovery_codes', 'totp'],
        )

    def test_removing_the_app_needs_the_app_and_is_mailed_and_logged(self):
        secret, _ = enrol_totp(self.api)
        mail.outbox.clear()
        # Enrolling proved the app, but that was a while ago now; and the
        # password, however recent, is not enough any more, because the
        # account has something stronger.
        stale(self.api, 301)
        r = self.api.delete(f'{HEADLESS}/account/authenticators/totp')
        self.assertEqual(r.status_code, 401)
        self.assertTrue(flows(r)['mfa_reauthenticate']['is_pending'])
        self.assertEqual(self.api.post(f'{HEADLESS}/auth/2fa/reauthenticate', {'code': reuse_code(secret)}).status_code, 200)
        self.assertEqual(self.api.delete(f'{HEADLESS}/account/authenticators/totp').status_code, 200)
        self.assertFalse(Authenticator.objects.filter(user=self.user).exists())    # the codes went with it
        self.assertEqual([m.to for m in mail.outbox], [['ada@example.com']])
        self.assertIn('deactivated', mail.outbox[0].subject.lower())
        self.assertEqual(AuthEvent.objects.filter(kind=AuthEvent.Kind.MFA_REMOVED).count(), 2)
        self.assertEqual(self.api.get('/auth/me').json()['mfa']['enrolled'], False)

    def test_regenerating_recovery_codes_needs_the_app_and_is_mailed_and_logged(self):
        secret, before = enrol_totp(self.api)
        mail.outbox.clear()
        stale(self.api, 301)
        self.assertEqual(self.api.post(f'{HEADLESS}/account/authenticators/recovery-codes').status_code, 401)
        prove_strong(self.api)
        r = self.api.post(f'{HEADLESS}/account/authenticators/recovery-codes')
        self.assertEqual(r.status_code, 200, r.content)
        after = r.json()['data']['unused_codes']
        self.assertEqual(len(after), 10)
        self.assertNotEqual(set(after), set(before))
        self.assertIn('recovery codes', mail.outbox[-1].subject.lower())
        self.assertTrue(AuthEvent.objects.filter(kind=AuthEvent.Kind.MFA_RESET).exists())


@override_settings(GC_SIGNING_KEY=keys.PRIVATE_PEM)
class ChallengeTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = make_user('ada@example.com')
        self.secret = give_authenticator(self.user)

    def test_the_password_is_not_a_sign_in_until_the_code_is(self):
        api = Api()
        r = api.try_login('ada@example.com')
        self.assertEqual(r.status_code, 401)
        self.assertEqual(flows(r)['mfa_authenticate']['types'], ['totp'])
        self.assertEqual(api.get('/auth/me').status_code, 401)
        r = api.post(f'{HEADLESS}/auth/2fa/authenticate', {'code': '000000'})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()['errors'][0]['code'], 'incorrect_code')
        self.assertEqual(AuthEvent.objects.filter(kind=AuthEvent.Kind.MFA_FAILED).count(), 1)
        r = api.post(f'{HEADLESS}/auth/2fa/authenticate', {'code': totp_code(self.secret)})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(api.get('/auth/me').status_code, 200)

    def test_the_token_says_which_factors_and_when(self):
        api = Api()
        challenge(api, 'ada@example.com', self.secret)
        events = api.session[AUTH_EVENTS]
        self.assertEqual([e['method'] for e in events], ['password', 'otp'])
        r = api.post('/auth/executor-token')
        self.assertEqual(r.status_code, 200, r.content)
        c = keys.verify(r.json()['token'])
        self.assertEqual(c['amr'], ['otp', 'password'])
        self.assertEqual(c['auth_time'], events[1]['at'])
        self.assertEqual(c['su'], events[1]['at'] + STEP_UP_SECONDS)

    def test_auth_time_is_the_strong_event_not_the_password_and_su_needs_one(self):
        api = Api()
        challenge(api, 'ada@example.com', self.secret)
        s = api.session
        s[AUTH_EVENTS] = [{'method': 'password', 'at': 5_000}, {'method': 'otp', 'at': 4_000}]
        s.save()
        c = keys.verify(api.post('/auth/executor-token').json()['token'])
        self.assertEqual(c['auth_time'], 4_000)
        self.assertEqual(c['su'], 4_000 + STEP_UP_SECONDS)
        # A session that only ever proved the password — enrolled after it
        # signed in — cannot allow an origin until it proves the app.
        s = api.session
        s[AUTH_EVENTS] = [{'method': 'password', 'at': 5_000}]
        s.save()
        c = keys.verify(api.post('/auth/executor-token').json()['token'])
        self.assertEqual((c['amr'], c['auth_time'], c['su']), (['password'], 5_000, 0))

    def test_a_recovery_code_signs_in_once(self):
        api = Api()
        # Codes come from the seed; read them through the account that owns them.
        owner = Api()
        challenge(owner, 'ada@example.com', self.secret)
        prove_strong(owner)
        codes = owner.post(f'{HEADLESS}/account/authenticators/recovery-codes').json()['data']['unused_codes']
        api.try_login('ada@example.com')
        self.assertEqual(api.post(f'{HEADLESS}/auth/2fa/authenticate', {'code': codes[0]}).status_code, 200)
        self.assertIn('recovery', [e['method'] for e in api.session[AUTH_EVENTS]])
        again = Api()
        again.try_login('ada@example.com')
        self.assertEqual(again.post(f'{HEADLESS}/auth/2fa/authenticate', {'code': codes[0]}).status_code, 400)
        self.assertEqual(again.post(f'{HEADLESS}/auth/2fa/authenticate', {'code': codes[1]}).status_code, 200)

    def test_six_wrong_codes_across_two_addresses_are_refused_on_the_sixth(self):
        # docs/AUTH.md §3: 'login_failed' is 10/m/ip AND 5/5m per account.
        # Two addresses stay under the per-address limit; the account does
        # not — and the sixth is refused before any code is checked.
        api = Api()
        api.try_login('ada@example.com')
        for i in range(5):
            r = api.post(f'{HEADLESS}/auth/2fa/authenticate', {'code': '000000'}, REMOTE_ADDR=f'10.0.0.{1 + i % 2}')
            self.assertEqual(r.status_code, 400)
            self.assertEqual(r.json()['errors'][0]['code'], 'incorrect_code')
        r = api.post(f'{HEADLESS}/auth/2fa/authenticate', {'code': totp_code(self.secret)}, REMOTE_ADDR='10.0.0.2')
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json()['errors'][0]['code'], 'too_many_login_attempts')
        self.assertEqual(api.get('/auth/me').status_code, 401)
        self.assertEqual(AuthEvent.objects.filter(kind=AuthEvent.Kind.MFA_FAILED).count(), 5)

    def test_a_code_is_good_for_one_window_and_one_use(self):
        api = Api()
        api.try_login('ada@example.com')
        self.assertEqual(api.post(f'{HEADLESS}/auth/2fa/authenticate', {'code': totp_code(self.secret, -1)}).status_code, 400)
        self.assertEqual(api.post(f'{HEADLESS}/auth/2fa/authenticate', {'code': totp_code(self.secret, 1)}).status_code, 400)
        code = totp_code(self.secret)
        self.assertEqual(api.post(f'{HEADLESS}/auth/2fa/authenticate', {'code': code}).status_code, 200)
        other = Api()
        other.try_login('ada@example.com')
        self.assertEqual(other.post(f'{HEADLESS}/auth/2fa/authenticate', {'code': code}).status_code, 400)


class StrongReauthenticationTests(TestCase):
    """docs/AUTH.md §7.2: an account with an authenticator changes nothing on its password alone."""

    def setUp(self):
        cache.clear()
        self.user = make_user('ada@example.com')
        self.secret = give_authenticator(self.user)
        self.api = Api()
        challenge(self.api, 'ada@example.com', self.secret)

    def test_a_password_reauthentication_is_refused_for_an_enrolled_account(self):
        stale(self.api)
        r = self.api.reauthenticate(PASSWORD)
        self.assertEqual(r.status_code, 401)
        self.assertEqual(list(flows(r)), ['mfa_reauthenticate'])
        self.assertTrue(flows(r)['mfa_reauthenticate']['is_pending'])
        self.assertEqual(flows(r)['mfa_reauthenticate']['types'], ['totp'])
        self.assertTrue(r.json()['meta']['is_authenticated'])
        # Refused before the password was looked at: no reauthentication was recorded.
        self.assertFalse(AuthEvent.objects.filter(kind=AuthEvent.Kind.REAUTHENTICATION).exists())
        self.assertEqual(len(self.api.session[AUTH_EVENTS]), 2)

    def test_but_still_works_for_an_account_with_nothing_stronger(self):
        make_user('bob@example.com')
        api = Api()
        api.login('bob@example.com')
        stale(api)
        self.assertEqual(api.reauthenticate(PASSWORD).status_code, 200)

    def test_the_app_reauthenticates_and_is_recorded(self):
        stale(self.api)
        r = self.api.post(f'{HEADLESS}/auth/2fa/reauthenticate', {'code': reuse_code(self.secret)})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.api.session[AUTH_EVENTS][-1]['method'], 'otp')
        self.assertEqual(AuthEvent.objects.get(kind=AuthEvent.Kind.REAUTHENTICATION).detail['method'], 'otp')

    def test_the_email_change_wants_a_second_factor_within_the_window(self):
        self.assertEqual(self.api.add_email('new@example.com').status_code, 200)
        stale(self.api, 301)
        r = self.api.add_email('newer@example.com')
        self.assertEqual(r.status_code, 401)
        self.assertTrue(flows(r)['mfa_reauthenticate']['is_pending'])
        self.assertEqual(self.api.post(f'{HEADLESS}/auth/2fa/reauthenticate', {'code': reuse_code(self.secret)}).status_code, 200)
        self.assertEqual(self.api.add_email('newer@example.com').status_code, 200)

    def test_the_password_change_and_the_codes_want_it_too(self):
        stale(self.api, 301)
        r = self.api.change_password(PASSWORD, 'a-completely-new-long-password')
        self.assertEqual(r.status_code, 401)
        self.assertTrue(flows(r)['mfa_reauthenticate']['is_pending'])
        self.assertEqual(self.api.get(f'{HEADLESS}/account/authenticators/recovery-codes').status_code, 401)
        self.assertEqual(self.api.get(f'{HEADLESS}/account/authenticators/webauthn').status_code, 401)

    def test_enrolling_counts_as_proving_it(self):
        # The code that enrolled the app came from the app: the recovery
        # codes are readable in the same breath, without a second challenge.
        make_user('bob@example.com')
        api = Api()
        api.login('bob@example.com')
        _, codes = enrol_totp(api)
        self.assertEqual(len(codes), 10)
        self.assertEqual([e['method'] for e in api.session[AUTH_EVENTS]], ['password', 'otp'])

    def test_a_password_proof_from_this_session_is_not_enough_once_enrolled(self):
        # Signed in with the password a moment ago, so the proof is well
        # inside allauth's window. It does not count any more: the thing
        # that gates a change is now the app.
        bob = make_user('bob@example.com')
        api = Api()
        api.login('bob@example.com')
        enrol_totp(api)
        s = api.session
        s[AUTH_EVENTS] = [e for e in s[AUTH_EVENTS] if e['method'] == 'password']
        s.save()
        r = api.change_password(PASSWORD, 'a-completely-new-long-password')
        self.assertEqual(r.status_code, 401)
        self.assertEqual(list(flows(r)), ['mfa_reauthenticate'])
        self.assertTrue(bob.check_password(PASSWORD))


@override_settings(GC_WEBAUTHN_ORIGIN=ORIGIN, GC_SIGNING_KEY=keys.PRIVATE_PEM)
class PasskeyTests(TestCase):
    """docs/AUTH.md §5.7: user verification on every ceremony, and the origin pinned."""

    def setUp(self):
        cache.clear()
        self.user = make_user('ada@example.com')
        self.api = Api()
        self.api.login('ada@example.com')
        self.key = SoftKey(ORIGIN)
        mail.outbox.clear()

    def add_passkey(self, api=None, **how):
        api = api or self.api
        r = api.get(f'{HEADLESS}/account/authenticators/webauthn?passwordless')
        self.assertEqual(r.status_code, 200, r.content)
        options = r.json()['data']['creation_options']
        return api.post(f'{HEADLESS}/account/authenticators/webauthn',
                        {'name': 'Laptop', 'credential': self.key.register(options, **how)})

    def test_registration_names_the_public_host_and_demands_verification(self):
        r = self.api.get(f'{HEADLESS}/account/authenticators/webauthn?passwordless')
        options = r.json()['data']['creation_options']['publicKey']
        self.assertEqual(options['rp'], {'id': 'app.example.com', 'name': 'ghostclick'})
        self.assertEqual(options['authenticatorSelection']['userVerification'], 'required')
        self.assertEqual(options['authenticatorSelection']['residentKey'], 'required')
        # A second-factor key, too: not only the ones that sign in alone.
        r = self.api.get(f'{HEADLESS}/account/authenticators/webauthn')
        self.assertEqual(r.json()['data']['creation_options']['publicKey']['authenticatorSelection']['userVerification'], 'required')

    def test_a_passkey_is_added_mailed_and_logged(self):
        r = self.add_passkey()
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()['data']['type'], r.json()['data']['name']), ('webauthn', 'Laptop'))
        self.assertTrue(r.json()['meta']['recovery_codes_generated'])
        self.assertEqual(self.api.get('/auth/me').json()['mfa']['enrolled'], True)
        self.assertEqual([m.to for m in mail.outbox], [['ada@example.com']])
        self.assertTrue(AuthEvent.objects.filter(kind=AuthEvent.Kind.MFA_ENROLLED, detail__type='webauthn').exists())

    def test_a_registration_without_verification_is_refused(self):
        r = self.add_passkey(uv=False)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertFalse(Authenticator.objects.filter(user=self.user).exists())

    def test_a_registration_from_another_origin_is_refused(self):
        r = self.add_passkey(origin='https://evil.example')
        self.assertEqual(r.status_code, 400, r.content)
        self.assertFalse(Authenticator.objects.filter(user=self.user).exists())

    def passkey_login(self, api, **how):
        r = api.get(f'{HEADLESS}/auth/webauthn/login')
        self.assertEqual(r.status_code, 200, r.content)
        options = r.json()['data']['request_options']
        self.assertEqual(options['publicKey']['userVerification'], 'required')
        self.assertEqual(options['publicKey']['rpId'], 'app.example.com')
        return api.post(f'{HEADLESS}/auth/webauthn/login', {'credential': self.key.assertion(options, **how)})

    def test_a_passkey_signs_in_on_its_own_and_is_the_strongest_factor(self):
        self.assertEqual(self.add_passkey().status_code, 200)
        api = Api()
        r = self.passkey_login(api)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(api.get('/auth/me').status_code, 200)
        events = api.session[AUTH_EVENTS]
        self.assertEqual([e['method'] for e in events], ['webauthn'])
        c = keys.verify(api.post('/auth/executor-token').json()['token'])
        self.assertEqual(c['amr'], ['webauthn'])
        self.assertEqual(c['su'], events[0]['at'] + STEP_UP_SECONDS)

    def test_an_assertion_without_verification_is_refused_and_never_becomes_webauthn(self):
        self.assertEqual(self.add_passkey().status_code, 200)
        api = Api()
        r = self.passkey_login(api, uv=False)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json()['errors'][0]['code'], 'incorrect_code')
        self.assertEqual(api.get('/auth/me').status_code, 401)
        self.assertNotIn('webauthn', [e['method'] for e in api.session.get(AUTH_EVENTS, [])])

    def test_an_assertion_from_another_origin_is_refused(self):
        self.assertEqual(self.add_passkey().status_code, 200)
        api = Api()
        self.assertEqual(self.passkey_login(api, origin='https://evil.example').status_code, 400)
        self.assertEqual(self.passkey_login(api, origin='https://sub.app.example.com').status_code, 400)
        self.assertEqual(api.get('/auth/me').status_code, 401)

    def test_a_passkey_answers_the_challenge_after_a_password(self):
        self.assertEqual(self.add_passkey().status_code, 200)
        api = Api()
        r = api.try_login('ada@example.com')
        self.assertEqual(r.status_code, 401)
        self.assertIn('webauthn', flows(r)['mfa_authenticate']['types'])
        r = api.get(f'{HEADLESS}/auth/webauthn/authenticate')
        self.assertEqual(r.status_code, 200, r.content)
        options = r.json()['data']['request_options']
        self.assertEqual(options['publicKey']['userVerification'], 'required')
        weak = api.post(f'{HEADLESS}/auth/webauthn/authenticate', {'credential': self.key.assertion(options, uv=False)})
        self.assertEqual(weak.status_code, 400)
        options = api.get(f'{HEADLESS}/auth/webauthn/authenticate').json()['data']['request_options']
        r = api.post(f'{HEADLESS}/auth/webauthn/authenticate', {'credential': self.key.assertion(options)})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual([e['method'] for e in api.session[AUTH_EVENTS]], ['password', 'webauthn'])

    def test_a_passkey_reauthenticates(self):
        self.assertEqual(self.add_passkey().status_code, 200)
        stale(self.api)
        self.assertEqual(self.api.reauthenticate(PASSWORD).status_code, 401)
        options = self.api.get(f'{HEADLESS}/auth/webauthn/reauthenticate').json()['data']['request_options']
        self.assertEqual(options['publicKey']['userVerification'], 'required')
        r = self.api.post(f'{HEADLESS}/auth/webauthn/reauthenticate', {'credential': self.key.assertion(options)})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(AuthEvent.objects.get(kind=AuthEvent.Kind.REAUTHENTICATION).detail['method'], 'webauthn')
        # And now the sensitive thing goes through.
        self.assertEqual(self.api.add_email('new@example.com').status_code, 200)

    def test_a_stranger_cannot_spend_a_victim_s_second_factor_budget(self):
        """
        An unauthenticated caller must not be able to lock an account out.

        `auth/webauthn/login` is the one WebAuthn endpoint anonymous callers
        reach, and allauth identifies the account from the CLIENT-supplied
        userHandle and then consumes that account's `mfa-auth-user-<pk>`
        bucket (login_failed, 5/5m/key) BEFORE verifying the assertion. The
        handle is base36 of a sequential primary key. Six bogus assertions
        every five minutes, from nobody, and the victim's own correct TOTP
        code starts answering too_many_login_attempts.
        """
        victim = make_user('victim@example.com')
        secret = give_authenticator(victim)
        self.assertEqual(self.add_passkey().status_code, 200)   # ada's, so the handle differs
        from allauth.account.utils import user_pk_to_url_str
        handle = user_pk_to_url_str(victim)
        cache.clear()
        attacker = Api()
        for _ in range(8):
            options = attacker.get(f'{HEADLESS}/auth/webauthn/login').json()['data']['request_options']
            forged = self.key.assertion(options)
            forged['response']['userHandle'] = handle
            r = attacker.post(f'{HEADLESS}/auth/webauthn/login', {'credential': forged})
            self.assertEqual(r.status_code, 400, r.content)
        # The victim's own challenge still works.
        api = Api()
        r = api.try_login('victim@example.com')
        self.assertEqual(r.status_code, 401)
        r = api.post(f'{HEADLESS}/auth/2fa/authenticate', {'code': reuse_code(secret)})
        self.assertEqual(r.status_code, 200, r.content)

    @override_settings(GC_PASSKEY_LOGIN_RATE='3/m/ip')
    def test_and_the_endpoint_has_a_budget_of_its_own(self):
        # The account's bucket is not the one a stranger spends; this one is.
        self.assertEqual(self.add_passkey().status_code, 200)
        cache.clear()
        attacker = Api()
        codes = []
        for _ in range(5):
            options = attacker.get(f'{HEADLESS}/auth/webauthn/login').json()['data']['request_options']
            codes.append(attacker.post(f'{HEADLESS}/auth/webauthn/login',
                                       {'credential': self.key.assertion(options, uv=False)}).status_code)
        self.assertEqual(set(codes), {400})
        last = attacker.post(f'{HEADLESS}/auth/webauthn/login', {'credential': {'response': {}}})
        self.assertEqual(last.status_code, 400)
        self.assertEqual(last.json()['errors'][0]['code'], 'too_many_login_attempts')

    def test_removing_a_passkey_needs_a_second_factor_and_is_logged(self):
        added = self.add_passkey().json()['data']['id']
        mail.outbox.clear()
        stale(self.api, 301)
        r = self.api.delete(f'{HEADLESS}/account/authenticators/webauthn', {'authenticators': [added]})
        self.assertEqual(r.status_code, 401)
        prove_strong(self.api, 'webauthn')
        r = self.api.delete(f'{HEADLESS}/account/authenticators/webauthn', {'authenticators': [added]})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(Authenticator.objects.filter(user=self.user).exists())
        self.assertIn('removed', mail.outbox[-1].subject.lower())
        self.assertTrue(AuthEvent.objects.filter(kind=AuthEvent.Kind.MFA_REMOVED, detail__type='webauthn').exists())


class SessionsTests(TestCase):
    def setUp(self):
        cache.clear()
        make_user('ada@example.com')
        self.api = Api()
        self.api.login('ada@example.com')
        self.other = Api(HTTP_USER_AGENT='another browser')
        self.other.login('ada@example.com')

    def test_every_session_is_listed_with_where_and_when(self):
        r = self.api.get(f'{HEADLESS}/auth/sessions')
        self.assertEqual(r.status_code, 200)
        rows = r.json()['data']
        self.assertEqual(len(rows), 2)
        self.assertEqual([s['is_current'] for s in rows].count(True), 1)
        self.assertEqual({s['user_agent'] for s in rows}, {'', 'another browser'})
        self.assertTrue(all('last_seen_at' in s and s['ip'] for s in rows))

    def test_the_others_can_be_signed_out_and_it_is_logged(self):
        rows = self.api.get(f'{HEADLESS}/auth/sessions').json()['data']
        theirs = [s['id'] for s in rows if not s['is_current']]
        r = self.api.delete(f'{HEADLESS}/auth/sessions', {'sessions': theirs})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(len(r.json()['data']), 1)
        self.assertEqual(self.other.get('/auth/me').status_code, 401)
        self.assertEqual(self.api.get('/auth/me').status_code, 200)
        row = AuthEvent.objects.get(kind=AuthEvent.Kind.SESSIONS_ENDED)
        self.assertEqual((row.detail['count'], row.detail['current']), (1, False))

    def test_a_session_can_only_end_its_own_account_s_sessions(self):
        make_user('bob@example.com')
        bob = Api()
        bob.login('bob@example.com')
        mine = [s['id'] for s in self.api.get(f'{HEADLESS}/auth/sessions').json()['data']]
        r = bob.delete(f'{HEADLESS}/auth/sessions', {'sessions': mine})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.api.get('/auth/me').status_code, 200)


class EncryptionTests(TestCase):
    OTHER = 'A' * 42 + 'A='

    def test_round_trip_and_rotation(self):
        a = MFAAdapter()
        token = a.encrypt('JBSWY3DPEHPK3PXP')
        self.assertNotIn('JBSWY3DPEHPK3PXP', token)
        self.assertEqual(a.decrypt(token), 'JBSWY3DPEHPK3PXP')
        from django.conf import settings
        with override_settings(GC_MFA_KEY=f'{self.OTHER},{settings.GC_MFA_KEY}'):
            # The old key still opens it; the new key is what writes now.
            self.assertEqual(MFAAdapter().decrypt(token), 'JBSWY3DPEHPK3PXP')
            fresh = MFAAdapter().encrypt('x')
        with override_settings(GC_MFA_KEY=self.OTHER):
            self.assertEqual(MFAAdapter().decrypt(fresh), 'x')
            # A row this key cannot open RAISES. It used to answer '', and an
            # empty secret is a publicly known one.
            with self.assertRaises(ValidationError):
                MFAAdapter().decrypt(token)

    def test_a_secret_under_a_lost_key_refuses_every_code_rather_than_crashing(self):
        user = make_user('ada@example.com')
        secret = give_authenticator(user)
        api = Api()
        api.try_login('ada@example.com')
        with override_settings(GC_MFA_KEY=self.OTHER):
            r = api.post(f'{HEADLESS}/auth/2fa/authenticate', {'code': totp_code(secret)})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(api.get('/auth/me').status_code, 401)

    def test_the_code_for_an_EMPTY_secret_is_refused_too(self):
        """
        The code that actually worked.

        Sending the RIGHT code for the real secret proves nothing about a
        fail-open: with the key rotated away, decrypt() answered '', allauth
        validated against an empty secret, and the six-digit code for an
        empty secret is computable offline by anyone. This sends THAT code,
        which is the one a lost key used to admit.
        """
        user = make_user('ada@example.com')
        give_authenticator(user)
        api = Api()
        api.try_login('ada@example.com')
        with override_settings(GC_MFA_KEY=self.OTHER):
            r = api.post(f'{HEADLESS}/auth/2fa/authenticate', {'code': totp_code('')})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(api.get('/auth/me').status_code, 401)

    def test_a_recovery_code_from_an_empty_seed_is_refused_too(self):
        # Same shape, the other secret: RecoveryCodes.generate_codes() reads
        # the decrypted seed, so '' would have made every code guessable.
        user = make_user('ada@example.com')
        give_authenticator(user)
        RecoveryCodes.activate(user)
        api = Api()
        api.try_login('ada@example.com')
        with override_settings(GC_MFA_KEY=self.OTHER):
            with self.assertRaises(ValidationError):
                RecoveryCodes(Authenticator.objects.get(
                    user=user, type=Authenticator.Type.RECOVERY_CODES)).generate_codes()


class AdduserTests(TestCase):
    def test_staff_and_superuser_are_told_about_the_second_factor(self):
        import io
        from django.core.management import call_command
        for flag in ('--staff', '--superuser'):
            out = io.StringIO()
            call_command('adduser', f'{flag.strip("-")}@example.com', flag, stdout=out)
            self.assertIn('authenticator', out.getvalue())
            self.assertIn('/admin/', out.getvalue())
        out = io.StringIO()
        call_command('adduser', 'plain@example.com', stdout=out)
        self.assertNotIn('authenticator', out.getvalue())
