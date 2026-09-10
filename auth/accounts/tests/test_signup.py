"""
Sign-up (docs/AUTH.md §4): the modes, verification by code, what an
unverified sign-up does not get, and what nobody can learn from the answer.
"""
import statistics
import time
from unittest import mock

from allauth.account.models import EmailAddress
from django.contrib.auth import get_user_model
from django.core import mail
from django.core.cache import cache
from django.test import TestCase, override_settings

from tenants import invitations
from tenants.models import Invitation, Membership, Organization, Role
from tenants.tests.support import member, org

from .. import policy, turnstile
from ..models import AuthEvent
from .support import HEADLESS, PASSWORD, Api, code_from_mail, make_user, signup_and_verify

User = get_user_model()
NEW = 'new-person@example.com'


def pending(r):
    """The pending flow in an allauth 401, or None."""
    return next((f['id'] for f in r.json().get('data', {}).get('flows', []) if f.get('is_pending')), None)


@override_settings(GC_SIGNUP_MODE='open')
class OpenSignupTests(TestCase):
    def setUp(self):
        cache.clear()

    def test_a_sign_up_is_pending_until_the_code_is_entered(self):
        api = Api()
        r = api.signup(NEW, PASSWORD)
        self.assertEqual(r.status_code, 401, r.content)
        self.assertEqual(pending(r), 'verify_email')
        # The account row exists but cannot do anything: not signed in, the
        # address unverified, no session.
        self.assertEqual(api.get('/auth/me').status_code, 401)
        self.assertFalse(EmailAddress.objects.get(email=NEW).verified)
        [msg] = mail.outbox
        self.assertEqual(msg.to, [NEW])
        code = code_from_mail(msg)
        self.assertEqual(len(code), 6)

        r = api.verify(code)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(api.get('/auth/me').json()['user']['email'], NEW)
        self.assertTrue(EmailAddress.objects.get(email=NEW).verified)

    def test_the_session_begins_at_verification_with_a_personal_organisation(self):
        api = signup_and_verify(NEW)
        me = api.get('/auth/me').json()
        self.assertEqual(me['org']['slug'], 'new-person')
        self.assertEqual(me['org']['role'], 'owner')
        self.assertEqual(me['org']['plan'], 'free')
        self.assertTrue(Organization.objects.get(personal_of__email=NEW))

    def test_three_wrong_codes_end_the_attempt(self):
        api = Api()
        api.signup(NEW, PASSWORD)
        for _ in range(3):
            self.assertEqual(api.verify('000000').status_code, 400)
        # The fourth is not "wrong code" but "no verification in progress".
        real = code_from_mail()
        self.assertEqual(api.verify(real).status_code, 409)
        self.assertEqual(api.get('/auth/me').status_code, 401)

    def test_the_code_can_be_resent(self):
        api = Api()
        api.signup(NEW, PASSWORD)
        first = code_from_mail()
        # Asking again inside ten seconds is a 429 (confirm_email, per
        # address); after the window, a new code that works.
        self.assertEqual(api.resend_code().status_code, 429)
        cache.clear()
        r = api.resend_code()
        self.assertEqual(r.status_code, 200, r.content)
        second = code_from_mail()
        self.assertEqual(len(mail.outbox), 2)
        self.assertNotEqual(first, second)
        self.assertEqual(api.verify(second).status_code, 200)

    def test_the_password_validators_decide(self):
        r = Api().signup(NEW, 'short')
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()['errors'][0]['param'], 'password')
        self.assertFalse(User.objects.filter(email=NEW).exists())

    def test_every_sign_up_and_verification_is_logged(self):
        signup_and_verify(NEW)
        self.assertEqual(AuthEvent.objects.get(kind=AuthEvent.Kind.SIGNUP).email, NEW)
        self.assertEqual(AuthEvent.objects.get(kind=AuthEvent.Kind.EMAIL_VERIFIED).email, NEW)
        self.assertEqual(AuthEvent.objects.get(kind=AuthEvent.Kind.LOGIN).email, NEW)

    # -- enumeration [credentials-3] -------------------------------------------

    def test_an_address_that_exists_is_answered_exactly_like_one_that_does_not(self):
        make_user('taken@example.com')
        existing = Api().signup('taken@example.com', PASSWORD)
        fresh = Api().signup(NEW, PASSWORD)
        self.assertEqual(existing.status_code, fresh.status_code)
        self.assertEqual(existing.json(), fresh.json())
        self.assertEqual(pending(existing), 'verify_email')
        # No second account, and the truth went to the mailbox instead.
        self.assertEqual(User.objects.filter(email='taken@example.com').count(), 1)
        told = [m for m in mail.outbox if m.to == ['taken@example.com']]
        self.assertEqual(len(told), 1)
        self.assertIn('already exists', told[0].body)
        # And the audit log has it. §4.6 asks for a row for every refusal,
        # and this branch — the one an enumeration campaign walks — wrote
        # none at all in open and domain mode, because the code branched on
        # the sign-up POLICY rather than on whether the address exists. With
        # a uniform response and a 10/h/ip limit, the log was the only other
        # place it could show up.
        rows = AuthEvent.objects.filter(kind=AuthEvent.Kind.SIGNUP_REFUSED)
        self.assertEqual([(r.email, r.detail['reason']) for r in rows],
                         [('taken@example.com', 'address already has an account')])

    def test_the_two_branches_take_the_same_time(self):
        # The creation branch hashes a password with Argon2id; the "already
        # exists" branch used to make nothing and answer tens of milliseconds
        # sooner, which is a stopwatch's way of asking who has an account.
        # Now it hashes too. Medians, because the first request of a process
        # pays for imports and a garbage collection can land anywhere.
        make_user('taken@example.com')

        def clock(email):
            api = Api()
            # The per-address code limit (confirm_email, 1/10s) would otherwise
            # make the repeated "taken" attempts skip the mail — and the hash
            # with it — which is a different, and equally uniform, answer.
            cache.clear()
            t = time.perf_counter()
            api.signup(email, PASSWORD)
            return time.perf_counter() - t

        for n in range(2):     # warm the code paths before timing them
            clock(f'warm{n}@example.com'); clock('taken@example.com')
        fresh = [clock(f'fresh{n}@example.com') for n in range(7)]
        taken = [clock('taken@example.com') for n in range(7)]
        gap = abs(statistics.median(fresh) - statistics.median(taken))
        self.assertLess(gap, 0.010, f'median fresh {statistics.median(fresh):.4f}s, taken {statistics.median(taken):.4f}s')

    # -- Turnstile [credentials-1] ---------------------------------------------

    def test_without_turnstile_configured_nothing_is_asked(self):
        self.assertEqual(Api().signup(NEW, PASSWORD).status_code, 401)

    @override_settings(GC_TURNSTILE_SECRET='secret', GC_TURNSTILE_SITE_KEY='site')
    def test_open_mode_requires_a_turnstile_token(self):
        with mock.patch.object(turnstile, 'verify', side_effect=lambda token, ip=None: token == 'solved') as verify:
            r = Api().signup(NEW, PASSWORD)
            self.assertEqual(r.status_code, 400)
            self.assertEqual(r.json()['errors'][0]['code'], 'turnstile_required')
            self.assertEqual(r.json()['errors'][0]['param'], 'turnstile')
            r = Api().signup(NEW, PASSWORD, turnstile='forged')
            self.assertEqual(r.json()['errors'][0]['code'], 'turnstile_failed')
            self.assertFalse(User.objects.filter(email=NEW).exists())
            r = Api().signup(NEW, PASSWORD, turnstile='solved')
            self.assertEqual(r.status_code, 401)
            self.assertEqual(pending(r), 'verify_email')
            verify.assert_called_with('solved', '127.0.0.1')
        self.assertEqual(Api().get('/auth/config').json()['turnstile'], 'site')


class InviteSignupTests(TestCase):
    """The default mode: an address signs up only with a live invitation."""

    def setUp(self):
        cache.clear()
        self.acme = org('acme', plan='team')
        self.owner = member(self.acme, make_user('owner@acme.example'), Role.OWNER)

    def invite(self, email, role=Role.MEMBER):
        inv = invitations.issue(self.owner, email, role)
        mail.outbox.clear()
        return inv

    def test_the_mode_is_invite_by_default(self):
        self.assertEqual(policy.mode(), 'invite')
        self.assertEqual(Api().get('/auth/config').json()['signup'], 'invite')

    def test_an_invited_address_signs_up_and_the_membership_appears_at_verification(self):
        inv = self.invite('bob@acme.example', Role.ADMIN)
        api = Api()
        self.assertEqual(api.signup('bob@acme.example', PASSWORD).status_code, 401)
        # Unverified: the invitation is untouched and there is no membership.
        self.assertTrue(Invitation.objects.get(pk=inv.pk).is_live)
        self.assertFalse(Membership.objects.filter(user__email='bob@acme.example', organization=self.acme).exists())

        self.assertEqual(api.verify(code_from_mail()).status_code, 200)
        inv.refresh_from_db()
        self.assertEqual(inv.state, 'accepted')
        self.assertEqual(inv.accepted_by.email, 'bob@acme.example')
        m = Membership.objects.get(user__email='bob@acme.example', organization=self.acme)
        self.assertEqual(m.role, Role.ADMIN)
        # Personal org first, then the one they were invited to.
        self.assertEqual([o['slug'] for o in api.get('/auth/me').json()['orgs']], ['bob', 'acme'])
        ev = AuthEvent.objects.get(kind=AuthEvent.Kind.INVITATION_ACCEPTED)
        self.assertTrue(ev.detail['at_verification'])

    def test_an_unverified_sign_up_neither_burns_the_invitation_nor_gains_a_membership(self):
        inv = self.invite('bob@acme.example')
        api = Api()
        api.signup('bob@acme.example', PASSWORD)
        for _ in range(3):
            api.verify('000000')
        self.assertTrue(Invitation.objects.get(pk=inv.pk).is_live)
        self.assertFalse(Membership.objects.filter(organization=self.acme, user__email='bob@acme.example').exists())
        # The unverified account row SURVIVES the abort, and that is the part
        # worth pinning: a second sign-up for this address is not a second
        # chance at the code. allauth's assess_unique_email reports an
        # unverified row as taken under ACCOUNT_PREVENT_ENUMERATION, so a
        # repeat goes down the "already exists" branch and no code is sent —
        # the invited person's way in is Forgot password on the account they
        # did not finish making, then the code at their next sign-in.
        #
        # This comment used to say somebody could simply sign up again and
        # complete it later, which is not what happens. Nothing about the
        # repeat is asserted here, because what a repeat gets also depends on
        # the sign-up rate limit, and that belongs to PolicyTests.
        self.assertFalse(EmailAddress.objects.get(email='bob@acme.example').verified)
        self.assertEqual(Api().get('/auth/me').status_code, 401)

    def test_an_uninvited_address_is_answered_exactly_like_an_invited_one(self):
        self.invite('bob@acme.example')
        invited = Api().signup('bob@acme.example', PASSWORD)
        uninvited = Api().signup('eve@acme.example', PASSWORD)
        self.assertEqual(invited.status_code, uninvited.status_code)
        self.assertEqual(invited.json(), uninvited.json())
        self.assertEqual(pending(uninvited), 'verify_email')
        # But no account, no code, and the mailbox is told why.
        self.assertFalse(User.objects.filter(email='eve@acme.example').exists())
        told = [m for m in mail.outbox if m.to == ['eve@acme.example']]
        self.assertEqual(len(told), 1)
        self.assertIn('by invitation', told[0].body)
        self.assertNotRegex(told[0].body, r'\b\d{6}\b')
        ev = AuthEvent.objects.get(kind=AuthEvent.Kind.SIGNUP_REFUSED)
        self.assertEqual((ev.email, ev.detail['reason']),
                         ('eve@acme.example', 'no live invitation for this address'))

    def test_a_used_or_revoked_invitation_does_not_admit(self):
        inv = self.invite('bob@acme.example')
        invitations.revoke(inv)
        Api().signup('bob@acme.example', PASSWORD)
        self.assertFalse(User.objects.filter(email='bob@acme.example').exists())

    def test_the_invitation_email_match_ignores_case(self):
        self.invite('Bob@Acme.example')
        api = signup_and_verify('bob@acme.example')
        self.assertTrue(Membership.objects.filter(organization=self.acme, user__email='bob@acme.example').exists())
        self.assertEqual(api.get('/auth/me').status_code, 200)

    def test_a_seat_gone_since_issue_is_logged_and_the_sign_up_still_completes(self):
        self.invite('bob@acme.example')
        self.acme.entitlement_overrides = {'members.max': 1}
        self.acme.save()
        api = signup_and_verify('bob@acme.example')
        self.assertEqual(api.get('/auth/me').status_code, 200)
        self.assertFalse(Membership.objects.filter(organization=self.acme, user__email='bob@acme.example').exists())
        self.assertEqual(AuthEvent.objects.get(kind=AuthEvent.Kind.INVITATION_REFUSED).detail['reason'], 'no seat left on the plan')

    @override_settings(GC_TURNSTILE_SECRET='secret', GC_TURNSTILE_SITE_KEY='site')
    def test_invite_mode_does_not_ask_for_turnstile(self):
        self.invite('bob@acme.example')
        with mock.patch.object(turnstile, 'verify') as verify:
            self.assertEqual(Api().signup('bob@acme.example', PASSWORD).status_code, 401)
            verify.assert_not_called()


@override_settings(GC_SIGNUP_MODE='domain', GC_SIGNUP_DOMAINS=['acme.example'])
class DomainSignupTests(TestCase):
    def test_the_domain_must_match_exactly(self):
        r = Api().signup('eve@notacme.example', PASSWORD)
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()['errors'][0]['param'], 'email')
        self.assertIn('not a sign-up domain', r.json()['errors'][0]['message'])
        self.assertEqual(Api().signup('eve@sub.acme.example', PASSWORD).status_code, 400)
        self.assertEqual(Api().signup('bob@acme.example', PASSWORD).status_code, 401)
        self.assertEqual(AuthEvent.objects.filter(kind=AuthEvent.Kind.SIGNUP_REFUSED).count(), 2)

    def test_the_policy_reads_google_s_hosted_domain_not_the_address(self):
        # For a Google sign-up the workspace's word (hd) decides, never the
        # string after the @ [oauth-5].
        self.assertTrue(policy.signup_allowed('bob@acme.example', hd='acme.example').allowed)
        self.assertFalse(policy.signup_allowed('bob@acme.example', hd='gmail.com').allowed)
        self.assertTrue(policy.signup_allowed('bob@personal.example', hd='acme.example').allowed)
        # A Google account with no hd at all is a consumer account, whatever
        # its address ends in: '' is "Google said nothing", not "use the
        # suffix". Only None (a password sign-up) reads the address.
        self.assertFalse(policy.signup_allowed('bob@acme.example', hd='').allowed)
        self.assertTrue(policy.signup_allowed('bob@acme.example', hd=None).allowed)

    def test_config_names_the_domains(self):
        self.assertEqual(Api().get('/auth/config').json(),
                         {'signup': 'domain', 'domains': ['acme.example'], 'turnstile': None, 'google': False})


class PolicyTests(TestCase):
    def test_one_policy_for_both_adapters(self):
        # The account adapter and (later) the social adapter both call this
        # and nothing else, so the two paths cannot drift [oauth-5].
        from ..adapters import AccountAdapter
        with mock.patch.object(policy, 'signup_allowed', wraps=policy.signup_allowed) as allowed:
            with override_settings(GC_SIGNUP_MODE='domain', GC_SIGNUP_DOMAINS=['acme.example']):
                Api().signup('eve@other.example', PASSWORD)
            allowed.assert_called()
        self.assertTrue(hasattr(AccountAdapter, 'clean_email'))

    @override_settings(ACCOUNT_RATE_LIMITS={'signup': '2/h/ip'})
    def test_the_signup_rate_limit_is_per_address_of_the_caller(self):
        """
        The limit that actually stands in front of sign-up.

        This test asserted nothing at all — its whole body was that
        /config answers 200 — and its name and comment described
        '10/h/ip,3/h/key', which is not what settings.py configures.
        allauth applies the limit before the form is read, so there is no
        email to key on and the per-address half cannot exist here; the
        per-address limit that DOES exist is on the code a sign-up then
        needs, and test_the_code_can_be_resent asserts its 429.
        """
        cache.clear()
        self.assertEqual(Api().signup('one@example.com', PASSWORD).status_code, 401)
        self.assertEqual(Api().signup('two@example.com', PASSWORD).status_code, 401)
        self.assertEqual(Api().signup('three@example.com', PASSWORD).status_code, 429)
        self.assertFalse(User.objects.filter(email='three@example.com').exists())
