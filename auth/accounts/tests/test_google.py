"""
Google sign-in (docs/AUTH.md §6): the flow, who it may sign in, who it may
not, and the one sentence every refusal gets.

Google itself is not on the line. The two steps that talk to it — trading
the code for tokens, and reading the id_token — are stubbed at the
allauth adapter, so a test hands the callback whatever id_token payload it
likes and every rule below is exercised on the real endpoints, the real
session and the real database.
"""
from datetime import timedelta
from unittest import mock
from urllib.parse import parse_qs, urlsplit

from allauth.account.models import EmailAddress
from allauth.socialaccount.models import SocialAccount, SocialToken
from allauth.socialaccount.providers.google.views import GoogleOAuth2Adapter
from django.contrib.auth import get_user_model
from django.core import mail
from django.core.cache import cache
from django.core.management import call_command
from django.test import TestCase, override_settings
from django.utils import timezone

from tenants import invitations
from tenants.models import Membership, Role
from tenants.tests.support import member, org

from .. import google
from ..adapters import app_url
from ..events import AUTH_EVENTS
from ..models import AuthEvent, EmailAddressAdded
from .support import HEADLESS, PASSWORD, Api, give_authenticator, make_user, prove_strong

User = get_user_model()

APP = 'http://testserver/app'
CALLBACK = f'{APP}/login'
GOOGLE = {'google': {
    'APPS': [{'client_id': 'test-client-id', 'secret': 'test-client-secret', 'key': ''}],
    'SCOPE': ['profile', 'email'],
    'AUTH_PARAMS': {'prompt': 'select_account'},
    'OAUTH_PKCE_ENABLED': True,
    'EMAIL_AUTHENTICATION': True,
    'EMAIL_AUTHENTICATION_AUTO_CONNECT': True,
}}
# The sentence the SPA shows for `error=refused`; pinned here so the words
# the spec chose are the words in the build.
GENERIC = 'We could not sign you in with Google. Sign in the way you usually do, then connect Google from Settings.'


def payload(email='ada@example.com', sub='1001', verified=True, hd=None, given='Ada', family='Lovelace'):
    """An id_token payload the way Google's arrives, minus the signature."""
    data = {'sub': sub, 'email': email, 'email_verified': verified, 'given_name': given, 'family_name': family,
            'iss': 'https://accounts.google.com', 'aud': 'test-client-id'}
    if hd is not None:
        data['hd'] = hd
    return data


def query_of(location):
    return {k: v[0] for k, v in parse_qs(urlsplit(location).query).items()}


@override_settings(SOCIALACCOUNT_PROVIDERS=GOOGLE, GC_APP_URL=APP, GC_SIGNUP_MODE='open')
class GoogleCase(TestCase):
    """The flow, driven the way the SPA drives it, with Google stubbed."""

    def setUp(self):
        cache.clear()

    def start(self, api=None, process='login', callback_url=CALLBACK):
        """POST the redirect endpoint the way the SPA's form does; returns (api, response)."""
        api = api or Api()
        r = api.c.post(f'{HEADLESS}/auth/provider/redirect',
                       {'provider': 'google', 'callback_url': callback_url, 'process': process},
                       HTTP_X_CSRFTOKEN=api.csrf)
        return api, r

    def state_of(self, r):
        self.assertEqual(r.status_code, 302, r.content)
        self.assertTrue(r['Location'].startswith('https://accounts.google.com/o/oauth2/v2/auth?'), r['Location'])
        q = query_of(r['Location'])
        self.assertIn('code_challenge', q)          # PKCE
        self.assertEqual(q['prompt'], 'select_account')
        self.assertEqual(q['redirect_uri'], 'http://testserver/accounts/google/login/callback/')
        return q['state']

    def come_back(self, api, state, data, code='4/the-code'):
        """Google sends the browser back; the token exchange and id_token are stubbed to `data`."""
        def complete_login(adapter, request, app, token, **kwargs):
            return adapter.get_provider().sociallogin_from_response(request, data)
        with mock.patch.object(GoogleOAuth2Adapter, 'get_access_token_data',
                               return_value={'access_token': 'at', 'id_token': 'idt', 'expires_in': 3600}), \
             mock.patch.object(GoogleOAuth2Adapter, 'complete_login', complete_login):
            r = api.c.get('/accounts/google/login/callback/', {'state': state, 'code': code})
        # A sign-in rotates the CSRF token, and the callback's answer is a
        # redirect the browser follows to a fresh page load of the SPA,
        # which asks /auth/csrf again; the test client does the same.
        api.csrf = api.c.get('/auth/csrf').json()['csrfToken']
        return r

    def sign_in(self, data, api=None, process='login', callback_url=CALLBACK):
        api, r = self.start(api, process=process, callback_url=callback_url)
        state = self.state_of(r)
        return api, self.come_back(api, state, data)

    def assertRefused(self, r, process='login', to=CALLBACK):
        self.assertEqual(r.status_code, 302, r.content)
        self.assertEqual(urlsplit(r['Location'])._replace(query='').geturl(), to)
        self.assertEqual(query_of(r['Location']), {'error': 'refused', 'error_process': process})

    def assertSignedIn(self, api, email):
        me = api.get('/auth/me')
        self.assertEqual(me.status_code, 200, me.content)
        self.assertEqual(me.json()['user']['email'], email)


class SignInTests(GoogleCase):
    def test_a_new_person_signs_up_and_is_signed_in(self):
        api, r = self.sign_in(payload())
        self.assertEqual(r.status_code, 302)
        self.assertEqual(r['Location'], CALLBACK)
        self.assertSignedIn(api, 'ada@example.com')
        user = User.objects.get(email='ada@example.com')
        self.assertEqual(user.name, 'Ada Lovelace')
        self.assertFalse(user.has_usable_password())
        # Google's word verified the address, and the identity is the sub.
        self.assertTrue(EmailAddress.objects.get(user=user).verified)
        self.assertEqual(SocialAccount.objects.get(user=user).uid, '1001')
        # The personal organisation, and the session's event says google.
        self.assertEqual(api.get('/auth/me').json()['org']['role'], 'owner')
        self.assertEqual([e['method'] for e in api.session[AUTH_EVENTS]], ['google'])
        kinds = list(AuthEvent.objects.filter(user=user).order_by('at').values_list('kind', flat=True))
        for kind in (AuthEvent.Kind.SIGNUP, AuthEvent.Kind.EMAIL_VERIFIED, AuthEvent.Kind.LOGIN):
            self.assertIn(kind, kinds)
        self.assertEqual(AuthEvent.objects.get(kind=AuthEvent.Kind.SIGNUP).detail['method'], 'google')
        self.assertEqual(AuthEvent.objects.get(kind=AuthEvent.Kind.EMAIL_VERIFIED).detail['by'], 'google')

    def test_the_token_carries_google_as_the_method(self):
        from . import keys
        api, _ = self.sign_in(payload())
        # A Google-only account mints nothing until it holds an authenticator
        # (docs/AUTH.md §6.5); with one, Google is still one factor and not
        # the strongest the account has, so su is 0 [oauth-6].
        with override_settings(GC_SIGNING_KEY=keys.PRIVATE_PEM):
            self.assertEqual(api.post('/auth/executor-token').json(), {'error': 'mfa_required'})
            give_authenticator(User.objects.get(email='ada@example.com'))
            r = api.post('/auth/executor-token')
        self.assertEqual(r.status_code, 200, r.content)
        claims = keys.claims_of(r.json()['token'])
        self.assertEqual(claims['amr'], ['google'])
        self.assertEqual(claims['su'], 0)

    def test_google_tokens_are_not_stored(self):
        self.sign_in(payload())
        self.assertFalse(SocialToken.objects.exists())

    def test_a_known_identity_signs_in_by_sub_whatever_the_address(self):
        user = make_user('ada@example.com')
        SocialAccount.objects.create(user=user, provider='google', uid='1001')
        api, r = self.sign_in(payload(email='renamed@example.com', sub='1001'))
        self.assertEqual(r['Location'], CALLBACK)
        self.assertSignedIn(api, 'ada@example.com')
        self.assertEqual(User.objects.count(), 1)

    def test_a_verified_address_on_both_sides_links_and_connects(self):
        # Verified at Google, verified here, no Google identity yet: the
        # account is opened and the identity attached, so from now on it
        # is the sub that matters [oauth-2].
        user = make_user('ada@example.com')
        api, r = self.sign_in(payload(sub='2002'))
        self.assertEqual(r['Location'], CALLBACK)
        self.assertSignedIn(api, 'ada@example.com')
        self.assertEqual(SocialAccount.objects.get(user=user).uid, '2002')
        self.assertTrue(user.has_usable_password())   # linking never wipes a password
        self.assertTrue(AuthEvent.objects.filter(kind=AuthEvent.Kind.GOOGLE_CONNECTED, user=user).exists())

    def test_a_google_only_account_is_flagged_mfa_required(self):
        api, _ = self.sign_in(payload())
        self.assertEqual(api.get('/auth/me').json()['mfa'], {'required': True, 'enrolled': False, 'reasons': ['no_password']})
        # A password account is not, on this ground.
        make_user('bob@example.com')
        bob = Api()
        bob.login('bob@example.com')
        self.assertEqual(bob.get('/auth/me').json()['mfa']['required'], False)

    def test_an_address_google_did_not_verify_still_needs_a_code(self):
        api, r = self.sign_in(payload(email='new@example.com', verified=False))
        self.assertEqual(r['Location'], CALLBACK)
        self.assertEqual(api.get('/auth/me').status_code, 401)
        self.assertFalse(EmailAddress.objects.get(email='new@example.com').verified)
        self.assertEqual(mail.outbox[-1].to, ['new@example.com'])
        r = api.get(f'{HEADLESS}/auth/session')
        self.assertEqual(r.status_code, 401)
        self.assertIn('verify_email', [f['id'] for f in r.json()['data']['flows'] if f.get('is_pending')])


class RefusalTests(GoogleCase):
    """
    Every refusal is the same 302 to the callback with `error=refused`,
    and the reason is in the log and nowhere else [credentials-3].
    """

    def test_a_callback_with_a_foreign_state_is_refused(self):
        # The state was made in one browser and presented from another: a
        # login CSRF, or a replay. The callback answers with the generic
        # refusal at the login page and signs nobody in.
        _, r = self.start()
        state = self.state_of(r)
        other = Api()
        r = self.come_back(other, state, payload())
        self.assertRefused(r, to=CALLBACK)
        self.assertEqual(other.get('/auth/me').status_code, 401)
        self.assertFalse(User.objects.filter(email='ada@example.com').exists())
        self.assertEqual(AuthEvent.objects.get(kind=AuthEvent.Kind.GOOGLE_REFUSED).detail['code'], 'unknown')

    def test_a_made_up_state_is_refused(self):
        api = Api()
        r = self.come_back(api, 'nosuchstate000', payload())
        self.assertRefused(r, to=CALLBACK)
        self.assertEqual(api.get('/auth/me').status_code, 401)

    def test_a_callback_url_on_another_host_is_refused(self):
        for bad in ['https://evil.example/app/login', 'http://testserver.evil.example/app/login',
                    'http://testserver/', 'http://testserver/admin/', '/app/login', '//testserver/app/login',
                    'https://testserver/app/login', 'http://testserver:8000/app/login', 'http://testserver\\@evil.example/app/']:
            _, r = self.start(callback_url=bad)
            self.assertEqual(r.status_code, 302, bad)
            self.assertNotIn('accounts.google.com', r['Location'], bad)
            # allauth answers the redirect endpoint's own refusal at the
            # login page with its own word; no state was made, so nothing
            # can come back through the callback either.
            self.assertTrue(r['Location'].startswith(CALLBACK), (bad, r['Location']))
        self.assertTrue(app_url(CALLBACK))
        self.assertTrue(app_url(f'{APP}/login?next=%2Fsuites'))
        self.assertTrue(app_url(f'{APP}/security'))
        self.assertFalse(app_url(f'{APP}'))              # not under /app/
        self.assertFalse(app_url('http://testserver/apple/'))
        with override_settings(GC_APP_URL='/app'):
            # No origin configured: nothing passes, rather than anything.
            self.assertFalse(app_url(CALLBACK))

    def test_linking_to_an_unverified_local_address_is_refused(self):
        # Someone typed this address into an account and never proved it;
        # Google vouching for the mailbox must not open that account, and
        # must not make a second one either [oauth-2].
        user = make_user('ada@example.com', verified=False)
        api, r = self.sign_in(payload(sub='3003'))
        self.assertRefused(r)
        self.assertEqual(api.get('/auth/me').status_code, 401)
        self.assertFalse(SocialAccount.objects.exists())
        self.assertEqual(User.objects.count(), 1)
        self.assertTrue(user.has_usable_password())
        ev = AuthEvent.objects.get(kind=AuthEvent.Kind.GOOGLE_REFUSED)
        self.assertEqual(ev.email, 'ada@example.com')
        self.assertIn('may not open', ev.detail['reason'])

    def test_a_second_google_identity_for_the_same_address_is_refused(self):
        user = make_user('ada@example.com')
        SocialAccount.objects.create(user=user, provider='google', uid='1001')
        api, r = self.sign_in(payload(sub='9999'))
        self.assertRefused(r)
        self.assertEqual(api.get('/auth/me').status_code, 401)
        self.assertEqual(list(SocialAccount.objects.values_list('uid', flat=True)), ['1001'])
        ev = AuthEvent.objects.get(kind=AuthEvent.Kind.GOOGLE_REFUSED)
        self.assertIn('another Google identity', ev.detail['reason'])

    def test_an_address_google_did_not_verify_cannot_touch_an_existing_account(self):
        make_user('ada@example.com')
        api, r = self.sign_in(payload(sub='3003', verified=False))
        self.assertRefused(r)
        self.assertEqual(User.objects.count(), 1)
        self.assertFalse(SocialAccount.objects.exists())
        # And the existing account was not mailed a "you already exist".
        self.assertEqual(mail.outbox, [])

    def test_an_account_made_by_createsuperuser_is_not_opened_until_verified(self):
        # User.email exists with no EmailAddress row at all.
        User.objects.create_user(email='root@example.com', password=PASSWORD)
        api, r = self.sign_in(payload(email='root@example.com', sub='4004'))
        self.assertRefused(r)
        self.assertEqual(User.objects.count(), 1)

    @override_settings(GC_SIGNUP_MODE='invite')
    def test_invite_mode_refuses_an_uninvited_address_with_the_same_response(self):
        api, r = self.sign_in(payload(email='stranger@example.com'))
        self.assertRefused(r)
        self.assertFalse(User.objects.filter(email='stranger@example.com').exists())
        ev = AuthEvent.objects.get(kind=AuthEvent.Kind.SIGNUP_REFUSED)
        self.assertEqual(ev.email, 'stranger@example.com')
        self.assertEqual(ev.detail['method'], 'google')
        self.assertEqual(ev.detail['code'], 'signup_closed')
        # ...and exactly the same response an unverified-link refusal gets,
        # so the browser cannot tell "not invited" from "exists": same
        # status, same location, same words.
        make_user('ada@example.com', verified=False)
        _, other = self.sign_in(payload(sub='3003'))
        self.assertEqual((r.status_code, r['Location']), (other.status_code, other['Location']))

    @override_settings(GC_SIGNUP_MODE='invite')
    def test_invite_mode_admits_an_invited_address_and_consumes_the_invitation(self):
        owner = make_user('owner@acme.example')
        acme = org('acme', plan='team')
        member(acme, owner, Role.OWNER)
        invitations.issue(Membership.objects.get(user=owner, organization=acme), 'ada@example.com', Role.MEMBER)
        api, r = self.sign_in(payload())
        self.assertEqual(r['Location'], CALLBACK)
        self.assertSignedIn(api, 'ada@example.com')
        self.assertTrue(Membership.objects.filter(organization=acme, user__email='ada@example.com').exists())
        self.assertTrue(AuthEvent.objects.filter(kind=AuthEvent.Kind.INVITATION_ACCEPTED).exists())

    @override_settings(GC_SIGNUP_MODE='domain', GC_SIGNUP_DOMAINS=['acme.example'])
    def test_domain_mode_reads_hd_and_never_the_address(self):
        # The address says acme, the id_token says consumer account: refused.
        api, r = self.sign_in(payload(email='bob@acme.example', sub='5001'))
        self.assertRefused(r)
        self.assertFalse(User.objects.filter(email='bob@acme.example').exists())
        ev = AuthEvent.objects.get(kind=AuthEvent.Kind.SIGNUP_REFUSED)
        self.assertIn('hosted domain', ev.detail['reason'])
        # The id_token says another workspace: refused.
        _, r = self.sign_in(payload(email='bob@acme.example', sub='5002', hd='globex.example'))
        self.assertRefused(r)
        # The id_token says acme: admitted, whatever the address is.
        api, r = self.sign_in(payload(email='bob@personal.example', sub='5003', hd='acme.example'))
        self.assertEqual(r['Location'], CALLBACK)
        self.assertSignedIn(api, 'bob@personal.example')

    @override_settings(ACCOUNT_RATE_LIMITS={'signup': '2/h/ip'})
    def test_a_google_sign_up_consumes_the_signup_rate_limit(self):
        # The password door and the Google door draw on one budget, so
        # alternating them does not double it [oauth-5].
        self.assertEqual(Api().signup('one@example.com', PASSWORD).status_code, 401)
        _, r = self.sign_in(payload(email='two@example.com', sub='6002'))
        self.assertEqual(r['Location'], CALLBACK)
        _, r = self.sign_in(payload(email='three@example.com', sub='6003'))
        self.assertRefused(r)
        self.assertFalse(User.objects.filter(email='three@example.com').exists())
        self.assertEqual(AuthEvent.objects.get(kind=AuthEvent.Kind.SIGNUP_REFUSED).detail['reason'], 'rate_limited')

    def test_a_cancel_keeps_its_own_word(self):
        # The person pressed Back on Google's page. That says nothing about
        # any account, so it is not dressed up as a refusal.
        api, r = self.start()
        state = self.state_of(r)
        r = api.c.get('/accounts/google/login/callback/', {'state': state, 'error': 'access_denied'})
        self.assertEqual(r.status_code, 302)
        self.assertEqual(query_of(r['Location']), {'error': 'cancelled', 'error_process': 'login'})

    def test_the_generic_sentence_is_the_one_the_spec_chose(self):
        # Pinned in the UI's ProviderError component; the words are the
        # spec's and the test says so in the one place both can read.
        from pathlib import Path
        source = Path(__file__).resolve().parents[3] / 'web' / 'src' / 'components' / 'ProviderError.vue'
        if source.exists():
            self.assertIn(GENERIC, source.read_text(encoding='utf8'))

    def test_a_get_cannot_start_a_sign_in_and_one_tap_does_not_exist(self):
        # SOCIALACCOUNT_LOGIN_ON_GET is off and, better, the URLs are not
        # mounted at all: the only way in is the CSRF-protected POST.
        self.assertEqual(Api().c.get('/accounts/google/login/').status_code, 404)
        self.assertEqual(Api().c.post('/accounts/google/login/token/', {'credential': 'x'}).status_code, 404)
        r = Api().c.get(f'{HEADLESS}/auth/provider/redirect', {'provider': 'google', 'callback_url': CALLBACK, 'process': 'login'})
        self.assertNotEqual(r.status_code, 302)

    def test_the_redirect_endpoint_needs_a_csrf_token(self):
        api = Api()
        r = api.c.post(f'{HEADLESS}/auth/provider/redirect',
                       {'provider': 'google', 'callback_url': CALLBACK, 'process': 'login'})
        self.assertEqual(r.status_code, 403)


@override_settings(SOCIALACCOUNT_PROVIDERS={'google': {**GOOGLE['google'], 'APPS': []}})
class UnconfiguredTests(TestCase):
    def test_without_a_client_nothing_is_offered_and_the_callback_is_a_404(self):
        self.assertEqual(Api().get('/auth/config').json()['google'], False)
        self.assertEqual(Api().c.get('/accounts/google/login/callback/', {'state': 'x', 'code': 'y'}).status_code, 404)
        providers = Api().get(f'{HEADLESS}/config').json()['data']['socialaccount']['providers']
        self.assertEqual(providers, [])


class ConnectTests(GoogleCase):
    """Connected accounts in Settings: connect, list, disconnect."""

    def setUp(self):
        super().setUp()
        self.user = make_user('ada@example.com')
        self.api = Api()
        self.api.login('ada@example.com')

    def test_config_says_google_is_offered(self):
        self.assertEqual(self.api.get('/auth/config').json()['google'], True)

    def test_connect_then_list_then_disconnect(self):
        security = f'{APP}/security'
        api, r = self.sign_in(payload(sub='7007'), api=self.api, process='connect', callback_url=security)
        self.assertEqual(r['Location'], security)
        self.assertEqual(SocialAccount.objects.get(user=self.user).uid, '7007')
        self.assertTrue(AuthEvent.objects.filter(kind=AuthEvent.Kind.GOOGLE_CONNECTED, user=self.user).exists())
        # Still the same session, still the same seven-day clock.
        self.assertSignedIn(api, 'ada@example.com')

        listed = api.get(f'{HEADLESS}/account/providers').json()['data']
        self.assertEqual([(a['provider']['id'], a['uid']) for a in listed], [('google', '7007')])

        r = api.delete(f'{HEADLESS}/account/providers', {'provider': 'google', 'account': '7007'})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(SocialAccount.objects.exists())
        self.assertTrue(AuthEvent.objects.filter(kind=AuthEvent.Kind.GOOGLE_DISCONNECTED, user=self.user).exists())

    def test_connecting_an_identity_that_opens_another_account_is_refused(self):
        other = make_user('bob@example.com')
        SocialAccount.objects.create(user=other, provider='google', uid='8008')
        security = f'{APP}/security'
        _, r = self.sign_in(payload(email='bob@example.com', sub='8008'), api=self.api, process='connect', callback_url=security)
        self.assertRefused(r, process='connect', to=security)
        self.assertEqual(SocialAccount.objects.get(uid='8008').user, other)

    def test_a_google_only_account_cannot_disconnect_its_last_identity(self):
        # No password and no other identity: disconnecting would leave an
        # account nothing can open.
        api, _ = self.sign_in(payload(email='solo@example.com', sub='9009'))
        # Enrolled and freshly proven, as the policy wants before anything
        # sensitive (docs/AUTH.md §6.5); the refusal under test is the next one.
        give_authenticator(User.objects.get(email='solo@example.com'))
        prove_strong(api)
        r = api.delete(f'{HEADLESS}/account/providers', {'provider': 'google', 'account': '9009'})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json()['errors'][0]['code'], 'no_password')
        self.assertTrue(SocialAccount.objects.filter(uid='9009').exists())


class PurgeTests(TestCase):
    """docs/AUTH.md §6.6: stale unverified secondary addresses are removed."""

    def test_only_old_unverified_secondary_addresses_go(self):
        user = make_user('ada@example.com')
        old = EmailAddress.objects.create(user=user, email='claim@example.com', verified=False, primary=False)
        EmailAddressAdded.objects.filter(address=old).update(at=timezone.now() - timedelta(minutes=16))
        fresh = EmailAddress.objects.create(user=user, email='fresh@example.com', verified=False, primary=False)
        other = make_user('bob@example.com', verified=False)          # an unverified PRIMARY: a sign-up in progress
        EmailAddressAdded.objects.filter(address__user=other).update(at=timezone.now() - timedelta(hours=2))
        verified_old = make_user('carol@example.com')
        EmailAddressAdded.objects.filter(address__user=verified_old).update(at=timezone.now() - timedelta(days=30))
        # An address from before the stamp existed has no row and counts as old.
        unstamped = EmailAddress.objects.create(user=user, email='ancient@example.com', verified=False, primary=False)
        EmailAddressAdded.objects.filter(address=unstamped).delete()

        call_command('purge_unverified_emails', '--dry-run')
        self.assertTrue(EmailAddress.objects.filter(pk=old.pk).exists())
        call_command('purge_unverified_emails')
        self.assertFalse(EmailAddress.objects.filter(pk=old.pk).exists())
        self.assertFalse(EmailAddress.objects.filter(pk=unstamped.pk).exists())
        self.assertTrue(EmailAddress.objects.filter(pk=fresh.pk).exists())
        self.assertTrue(EmailAddress.objects.filter(user=other, verified=False, primary=True).exists())
        self.assertTrue(EmailAddress.objects.filter(user=verified_old).exists())

    def test_every_address_is_stamped_when_added_and_goes_with_the_row(self):
        # Whoever makes the row — a sign-up, an operator in the admin, an
        # ORM call — the stamp is made by the model's own signal.
        user = make_user('ada@example.com')
        self.assertTrue(EmailAddressAdded.objects.filter(address__user=user).exists())
        row = EmailAddress.objects.create(user=user, email='next@example.com', verified=False, primary=False)
        self.assertTrue(EmailAddressAdded.objects.filter(address=row).exists())
        row.delete()
        self.assertFalse(EmailAddressAdded.objects.filter(address__email='next@example.com').exists())

    def test_the_code_verified_email_change_leaves_no_unverified_row_to_purge(self):
        # Changing the address by code keeps the new address in the session
        # until the code is entered, so in this configuration a stale
        # unverified secondary row is only ever made by hand; the purge is
        # the guard for when that happens, not a routine that finds work.
        make_user('ada@example.com')
        api = Api()
        api.login('ada@example.com')
        self.assertEqual(api.add_email('next@example.com').status_code, 200)
        self.assertFalse(EmailAddress.objects.filter(email='next@example.com').exists())
        call_command('purge_unverified_emails')
        self.assertEqual(EmailAddress.objects.count(), 1)
