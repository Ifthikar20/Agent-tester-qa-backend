"""
Switches (tenants/switches.py): the catalogue, how GC_SWITCHES_OFF reads, the
rows, the version they move, and every door in the control plane each one
shuts — switched off from the environment and from the database alike.
"""
import re
from contextlib import contextmanager
from pathlib import Path

from django.conf import settings
from django.contrib import admin
from django.core import mail
from django.core.cache import cache
from django.test import SimpleTestCase, TestCase, override_settings

from accounts.models import AuthEvent
from accounts.tests import keys
from accounts.tests.support import HEADLESS, code_from_mail
from accounts.tests.test_google import CALLBACK, GoogleCase, payload

from .. import invitations, switches
from ..models import Invitation, Membership, Organization, Role, Switch
from .support import Api, User, give_authenticator, member, org, user

RUNNER = sorted(key for key in switches.KEYS if key.startswith('runner.'))
# The two places a switch is turned off, and every door test runs both.
WAYS = ('env', 'db')


@contextmanager
def switched_off(how, key):
    """`key` off for the length of the block, from the environment or from a row."""
    if how == 'env':
        with override_settings(GC_SWITCHES_OFF=[key]):
            yield
        return
    row = Switch.objects.create(key=key, enabled=False)
    try:
        yield
    finally:
        Switch.objects.filter(pk=row.pk).delete()


class ParseTests(SimpleTestCase):
    def test_keys_services_and_every(self):
        self.assertEqual(switches.parse(''), [])
        self.assertEqual(switches.parse('control.google'), ['control.google'])
        self.assertEqual(switches.parse('runner'), RUNNER)
        self.assertEqual(switches.parse('control'), sorted(k for k in switches.KEYS if k.startswith('control.')))
        self.assertEqual(switches.parse('*'), sorted(switches.KEYS))
        # Trimmed, de-duplicated, and an empty entry is nothing.
        self.assertEqual(switches.parse(' runner.runs , runner.runs,,control.signup, '),
                         ['control.signup', 'runner.runs'])

    def test_anything_else_is_refused_by_name_with_the_words_that_would_do(self):
        # A typo must not leave a feature on, so nothing near a key passes:
        # not a plural, not another case, not a prefix.
        for bad in ('runner.recordings', 'Runner', 'control.', 'signup', 'all', 'runner.*'):
            with self.subTest(bad), self.assertRaises(ValueError) as caught:
                switches.parse(f'control.google,{bad}')
            self.assertIn(repr(bad), str(caught.exception))
            for word in ('*', 'runner', 'control', *switches.KEYS):
                self.assertIn(word, str(caught.exception))


class CatalogueTests(SimpleTestCase):
    def test_the_ten_keys(self):
        self.assertEqual(set(switches.KEYS), {
            'runner.recording', 'runner.runs', 'runner.onboarding', 'runner.origins', 'runner.driving', 'runner.heal',
            'control.signup', 'control.invitations', 'control.google', 'control.passkeys',
        })

    def test_a_key_nobody_defined_is_a_programming_error(self):
        with self.assertRaises(KeyError):
            switches.is_on('control.signups')

    def test_the_runner_keeps_the_same_catalogue(self):
        """
        ../switches.js is the runner's copy. A key one side has and the other
        does not is a switch that does nothing on the side that lacks it —
        and nothing else would notice.
        """
        path = Path(settings.BASE_DIR).parent / 'switches.js'
        if not path.exists():
            self.skipTest(f'{path} does not exist yet')
        found = set(re.findall(r'''['"`]((?:runner|control)\.[a-z][a-z_]*)['"`]''', path.read_text(encoding='utf-8')))
        self.assertEqual(found, set(switches.KEYS))


class ResolutionTests(TestCase):
    def test_no_row_is_on(self):
        self.assertEqual(switches.off_keys(), [])
        self.assertTrue(all(switches.flags().values()))
        self.assertEqual(switches.runner_off(), [])

    def test_a_row_turns_a_key_off_and_ticking_it_turns_it_back_on(self):
        row = Switch.objects.create(key='runner.origins', enabled=False, reason='chasing a bug')
        self.assertFalse(switches.is_on('runner.origins'))
        self.assertEqual(switches.runner_off(), ['runner.origins'])
        row.enabled = True
        row.save()
        self.assertTrue(switches.is_on('runner.origins'))

    @override_settings(GC_SWITCHES_OFF=['control.google'])
    def test_the_environment_wins_over_a_row(self):
        Switch.objects.create(key='control.google', enabled=True)
        self.assertFalse(switches.is_on('control.google'))
        self.assertEqual(switches.off_keys(), ['control.google'])

    def test_both_places_add_up_sorted(self):
        Switch.objects.create(key='runner.runs', enabled=False)
        with override_settings(GC_SWITCHES_OFF=['control.signup', 'runner.driving']):
            self.assertEqual(switches.off_keys(), ['control.signup', 'runner.driving', 'runner.runs'])
            self.assertEqual(switches.runner_off(), ['runner.driving', 'runner.runs'])

    def test_a_row_for_a_key_the_catalogue_no_longer_has_is_ignored(self):
        Switch.objects.create(key='runner.retired', enabled=False)
        self.assertEqual(switches.off_keys(), [])


class VersionTests(TestCase):
    """A switch reaches the runner only in a token, so a change must retire the tokens minted before it."""

    def versions(self):
        return dict(Organization.objects.values_list('slug', 'entitlements_version'))

    def test_saving_and_deleting_bump_every_organisation(self):
        org('acme', plan='team')
        org('globex', plan='enterprise')
        user('ada@example.com')
        before = self.versions()
        row = Switch.objects.create(key='runner.runs', enabled=False)
        self.assertEqual(self.versions(), {slug: v + 1 for slug, v in before.items()})
        row.reason = 'still off'
        row.save()
        self.assertEqual(self.versions(), {slug: v + 2 for slug, v in before.items()})
        row.delete()
        self.assertEqual(self.versions(), {slug: v + 3 for slug, v in before.items()})
        # And a queryset delete — the admin's "delete selected" — as well.
        Switch.objects.create(key='runner.origins', enabled=False)
        Switch.objects.all().delete()
        self.assertEqual(self.versions(), {slug: v + 5 for slug, v in before.items()})

    def test_the_switch_is_in_the_admin_and_says_what_each_key_guards(self):
        self.assertIn(Switch, admin.site._registry)
        help_text = str(Switch._meta.get_field('key').help_text)
        self.assertIn('GC_SWITCHES_OFF', help_text)
        for key in switches.KEYS:
            self.assertIn(key, help_text)


class Off:
    """What every switched-off refusal says, in whichever shape its path takes."""

    def assertSwitchedOff(self, r, key, allauth=True):
        self.assertEqual(r.status_code, 403, r.content)
        body = r.json()
        self.assertEqual((body['error'], body['switch']), ('switched_off', key))
        if allauth:
            self.assertEqual(body['status'], 403)
            self.assertEqual((body['errors'][0]['code'], body['errors'][0]['switch']), ('switched_off', key))
            self.assertTrue(body['errors'][0]['message'])
        else:
            self.assertEqual(body, {'error': 'switched_off', 'switch': key})


@override_settings(GC_SIGNUP_MODE='open', GC_WEBAUTHN_ORIGIN='https://app.example.com')
class DoorTests(Off, TestCase):
    def setUp(self):
        cache.clear()

    def test_sign_up(self):
        for how in WAYS:
            with self.subTest(how=how), switched_off(how, 'control.signup'):
                self.assertSwitchedOff(Api().signup('new@example.com'), 'control.signup')
                self.assertFalse(User.objects.filter(email='new@example.com').exists())
        # And back on, the same call signs up.
        self.assertEqual(Api().signup('new@example.com').status_code, 401)

    def test_passkey_sign_in_both_halves(self):
        for how in WAYS:
            with self.subTest(how=how), switched_off(how, 'control.passkeys'):
                api = Api()
                self.assertSwitchedOff(api.get(f'{HEADLESS}/auth/webauthn/login'), 'control.passkeys')
                self.assertSwitchedOff(api.post(f'{HEADLESS}/auth/webauthn/login', {'credential': {}}), 'control.passkeys')
        self.assertEqual(Api().get(f'{HEADLESS}/auth/webauthn/login').status_code, 200)

    def test_config_and_flags_say_so(self):
        user('ada@example.com')
        for how in WAYS:
            with self.subTest(how=how), switched_off(how, 'control.passkeys'):
                config = Api().get('/auth/config').json()
                self.assertEqual((config['passkeys'], config['invitations'], config['signupOff']), (False, True, False))
                api = Api()
                api.login('ada@example.com')
                flags = api.get('/auth/me').json()['flags']
                self.assertEqual(flags, {key: key != 'control.passkeys' for key in switches.KEYS})

    @override_settings(GC_SWITCHES_OFF=switches.parse('control'))
    def test_the_whole_control_service(self):
        config = Api().get('/auth/config').json()
        self.assertEqual((config['signupOff'], config['google'], config['passkeys'], config['invitations']),
                         (True, False, False, False))
        # The mode is still the configured one: there is no "nobody" mode to report.
        self.assertEqual(config['signup'], 'open')


@override_settings(GC_SIGNING_KEY=keys.PRIVATE_PEM)
class TokenTests(TestCase):
    def setUp(self):
        user('ada@example.com')
        self.api = Api()
        self.api.login('ada@example.com')

    def claims(self):
        r = self.api.post('/auth/executor-token')
        self.assertEqual(r.status_code, 200, r.content)
        return keys.claims_of(r.json()['token'])

    def test_nothing_off_is_an_empty_list(self):
        self.assertEqual(self.claims()['off'], [])

    def test_the_runner_half_from_either_place(self):
        with override_settings(GC_SWITCHES_OFF=switches.parse('runner,control.google')):
            self.assertEqual(self.claims()['off'], RUNNER)
        Switch.objects.create(key='runner.origins', enabled=False)
        Switch.objects.create(key='control.signup', enabled=False)
        self.assertEqual(self.claims()['off'], ['runner.origins'])

    def test_the_version_in_the_token_moves_with_a_switch(self):
        before = self.claims()['ent_v']
        Switch.objects.create(key='runner.runs', enabled=False)
        after = self.claims()
        self.assertEqual((after['ent_v'], after['off']), (before + 1, ['runner.runs']))


class GoogleTests(Off, GoogleCase):
    def test_the_redirect_and_the_callback(self):
        for how in WAYS:
            with self.subTest(how=how), switched_off(how, 'control.google'):
                _, r = self.start()
                self.assertSwitchedOff(r, 'control.google')
                r = Api().c.get('/accounts/google/login/callback/', {'state': 'x', 'code': 'y'})
                self.assertSwitchedOff(r, 'control.google', allauth=False)
                self.assertFalse(Api().get('/auth/config').json()['google'])
        self.assertTrue(Api().get('/auth/config').json()['google'])

    def test_sign_up_off_shuts_the_google_door_with_the_generic_word(self):
        from allauth.socialaccount.models import SocialAccount
        known = user('known@example.com')
        SocialAccount.objects.create(user=known, provider='google', uid='1001')
        for how in WAYS:
            with self.subTest(how=how), switched_off(how, 'control.signup'):
                AuthEvent.objects.all().delete()
                _, r = self.sign_in(payload(email='new@example.com', sub='2002'))
                self.assertRefused(r)
                self.assertFalse(User.objects.filter(email='new@example.com').exists())
                row = AuthEvent.objects.get(kind=AuthEvent.Kind.SIGNUP_REFUSED)
                self.assertEqual((row.detail['reason'], row.detail['switch']), ('switched_off', 'control.signup'))
                # Signing IN through Google is not sign-up, and still works.
                api, r = self.sign_in(payload(email='known@example.com', sub='1001'))
                self.assertEqual(r['Location'], CALLBACK)
                self.assertSignedIn(api, 'known@example.com')


class InvitationTests(Off, TestCase):
    def setUp(self):
        cache.clear()
        self.acme = org('acme', plan='team')
        self.owner = member(self.acme, user('owner@acme.example'), Role.OWNER)
        give_authenticator(self.owner.user)
        self.api = Api()
        self.api.login('owner@acme.example')
        self.assertEqual(self.api.post('/auth/org', {'org': 'acme'}).status_code, 200)

    def test_issuing_and_accepting_but_not_listing_or_revoking(self):
        pending = invitations.issue(self.owner, 'bob@acme.example', Role.MEMBER)
        bob = Api()
        bob.login(user('bob@acme.example').email)
        for how in WAYS:
            with self.subTest(how=how), switched_off(how, 'control.invitations'):
                r = self.api.post('/auth/invitations', {'email': 'carol@acme.example'})
                self.assertSwitchedOff(r, 'control.invitations', allauth=False)
                r = bob.post('/auth/invitations/accept', {'token': 'x' * 43})
                self.assertSwitchedOff(r, 'control.invitations', allauth=False)
                self.assertEqual(self.api.get('/auth/invitations').status_code, 200)
                self.assertFalse(Api().get('/auth/config').json()['invitations'])
        self.assertEqual(Invitation.objects.count(), 1)
        # A manager can still withdraw what is outstanding.
        with switched_off('db', 'control.invitations'):
            self.assertEqual(self.api.delete(f'/auth/invitations/{pending.pk}').status_code, 200)

    @override_settings(GC_SIGNUP_MODE='invite')
    def test_verification_does_not_accept_one_either(self):
        inv = invitations.issue(self.owner, 'dan@acme.example', Role.MEMBER)
        mail.outbox.clear()
        with switched_off('db', 'control.invitations'):
            api = Api()
            self.assertEqual(api.signup('dan@acme.example').status_code, 401)
            self.assertEqual(api.verify(code_from_mail()).status_code, 200)
        # Signed up and in, on the personal organisation only; the invitation
        # waits, live, and the refusal is written down.
        self.assertFalse(Membership.objects.filter(organization=self.acme, user__email='dan@acme.example').exists())
        self.assertTrue(Invitation.objects.get(pk=inv.pk).is_live)
        row = AuthEvent.objects.get(kind=AuthEvent.Kind.INVITATION_REFUSED)
        self.assertEqual((row.detail['reason'], row.detail['invitation']), ('switched_off', inv.pk))
