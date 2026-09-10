"""
Invitations: hashed, email-bound, a week long, single-use, rate limited and
logged [credentials-6].
"""
import json
from datetime import timedelta

from django.core import mail
from django.core.cache import cache
from django.test import TestCase, override_settings
from django.utils import timezone

from accounts.models import AuthEvent

from .. import invitations
from ..models import Invitation, Membership, Role, hash_token
from .support import PASSWORD, Api, give_authenticator, member, org, token_from_mail, user


def issue(inviter, email, role):
    """Issue, and read the raw token back the only way there is: from the mail."""
    invitation = invitations.issue(inviter, email, role)
    return invitation, token_from_mail()


class IssueTests(TestCase):
    def setUp(self):
        self.acme = org('acme', plan='team')
        self.owner = member(self.acme, user('owner@acme.example'), Role.OWNER)

    def test_the_token_is_stored_hashed_and_found_by_token(self):
        inv, raw = issue(self.owner, 'bob@acme.example', Role.MEMBER)
        self.assertNotIn(raw, inv.token_hash)
        self.assertEqual(inv.token_hash, hash_token(raw))
        self.assertEqual(Invitation.by_token(raw), inv)
        self.assertIsNone(Invitation.by_token(raw[:-1] + ('a' if raw[-1] != 'a' else 'b')))
        self.assertGreaterEqual(len(raw), 40)

    def test_it_lasts_seven_days(self):
        inv, _ = issue(self.owner, 'bob@acme.example', Role.MEMBER)
        self.assertAlmostEqual(inv.expires_at, timezone.now() + timedelta(days=7), delta=timedelta(minutes=1))

    def test_it_is_mailed_to_the_invitee_and_only_there(self):
        inv, raw = issue(self.owner, 'bob@acme.example', Role.MEMBER)
        [msg] = mail.outbox
        self.assertEqual(msg.to, ['bob@acme.example'])
        self.assertIn('/app/invite?token=' + raw, msg.body)
        self.assertIn('/app/signup', msg.body)
        self.assertIn('Acme', msg.body)
        self.assertEqual(Invitation.by_token(raw), inv)

    def test_it_is_logged(self):
        inv, _ = issue(self.owner, 'bob@acme.example', Role.MEMBER)
        ev = AuthEvent.objects.get(kind=AuthEvent.Kind.INVITATION_SENT)
        self.assertEqual(ev.user, self.owner.user)
        self.assertEqual(ev.detail['invitee'], 'bob@acme.example')
        self.assertEqual(ev.detail['org'], 'acme')
        self.assertEqual(ev.detail['invitation'], inv.pk)


class AcceptTests(TestCase):
    def setUp(self):
        self.acme = org('acme', plan='team')
        self.owner = member(self.acme, user('owner@acme.example'), Role.OWNER)
        self.bob = user('bob@acme.example')
        self.inv, self.raw = issue(self.owner, 'bob@acme.example', Role.ADMIN)

    def refused(self, raw, who, reason):
        with self.assertRaises(invitations.Refused) as caught:
            invitations.accept(raw, who)
        self.assertEqual(caught.exception.reason, reason)
        self.assertEqual(AuthEvent.objects.filter(kind=AuthEvent.Kind.INVITATION_REFUSED).latest('at').detail['reason'], reason)

    def test_the_right_person_becomes_a_member_with_the_invited_role(self):
        m = invitations.accept(self.raw, self.bob)
        self.assertEqual((m.organization, m.role), (self.acme, Role.ADMIN))
        self.inv.refresh_from_db()
        self.assertEqual(self.inv.accepted_by, self.bob)
        self.assertEqual(self.inv.state, 'accepted')
        self.assertEqual(AuthEvent.objects.get(kind=AuthEvent.Kind.INVITATION_ACCEPTED).detail['org'], 'acme')

    def test_it_is_single_use(self):
        invitations.accept(self.raw, self.bob)
        # The same person again is a double click (the mailed link opened
        # after verification already consumed it) and gets the membership
        # it made; anyone else is refused.
        self.assertEqual(invitations.accept(self.raw, self.bob).user, self.bob)
        self.assertEqual(Membership.objects.filter(user=self.bob, organization=self.acme).count(), 1)
        carol = user('carol@acme.example')
        self.refused(self.raw, carol, 'already used')

    def test_an_unverified_address_is_refused(self):
        # The address is the whole credential, so an address nobody proved
        # is no credential [credentials-6].
        eve = user('eve@acme.example', verified=False)
        _, raw = issue(self.owner, 'eve@acme.example', Role.MEMBER)
        self.refused(raw, eve, 'address not verified')

    def test_the_email_must_match(self):
        carol = user('carol@acme.example')
        self.refused(self.raw, carol, 'signed in as a different address')
        self.assertFalse(Membership.objects.filter(user=carol, organization=self.acme).exists())
        # And a refusal does not consume it: the right person can still accept.
        invitations.accept(self.raw, self.bob)

    def test_the_email_match_ignores_case(self):
        dave = user('Dave@acme.example')
        _, raw = issue(self.owner, 'dave@ACME.example', Role.MEMBER)
        invitations.accept(raw, dave)

    def test_expired_is_refused(self):
        Invitation.objects.filter(pk=self.inv.pk).update(expires_at=timezone.now() - timedelta(seconds=1))
        self.refused(self.raw, self.bob, 'expired')

    def test_revoked_is_refused(self):
        invitations.revoke(self.inv)
        self.refused(self.raw, self.bob, 'revoked')

    def test_a_token_nobody_issued_is_refused(self):
        self.refused('x' * 43, self.bob, 'no such invitation')

    def test_a_seat_that_vanished_since_issue_is_refused(self):
        self.acme.entitlement_overrides = {'members.max': 1}
        self.acme.save()
        self.refused(self.raw, self.bob, 'no seat left on the plan')

    def test_an_existing_member_is_never_downgraded(self):
        member(self.acme, self.bob, Role.OWNER)
        m = invitations.accept(self.raw, self.bob)     # invited as admin
        self.assertEqual(m.role, Role.OWNER)

    def test_an_existing_member_can_be_raised(self):
        member(self.acme, self.bob, Role.MEMBER)
        self.assertEqual(invitations.accept(self.raw, self.bob).role, Role.ADMIN)


class CapAtAcceptanceTests(TestCase):
    """
    [authz-tenancy-5] holds until the token is spent, not until it is issued.

    Checked only at issue, an outstanding invitation survived the inviter's
    demotion and even their removal — so a taken-over owner who was demoted
    kept minting owners for seven days unless somebody also revoked every
    pending grant by hand. That falsifies this module's own claim that the
    set of people who can manage an organisation grows only by an owner's
    hand.
    """

    def setUp(self):
        self.acme = org('acme', plan='team')
        self.owner = member(self.acme, user('owner@acme.example'), Role.OWNER)
        self.second = member(self.acme, user('second@acme.example'), Role.OWNER)
        self.bob = user('bob@acme.example')

    def test_a_demoted_inviter_s_outstanding_grant_is_refused(self):
        _, raw = issue(self.owner, 'bob@acme.example', Role.OWNER)
        self.owner.role = Role.MEMBER
        self.owner.save(update_fields=['role'])
        with self.assertRaises(invitations.Refused) as caught:
            invitations.accept(raw, self.bob)
        self.assertEqual(caught.exception.reason, 'the inviter may no longer grant this role')
        self.assertFalse(Membership.objects.filter(organization=self.acme, user=self.bob).exists())

    def test_an_inviter_who_has_left_grants_nothing(self):
        _, raw = issue(self.owner, 'bob@acme.example', Role.ADMIN)
        self.owner.delete()
        with self.assertRaises(invitations.Refused) as caught:
            invitations.accept(raw, self.bob)
        self.assertEqual(caught.exception.reason, 'the inviter is no longer in this organisation')

    def test_and_a_deleted_account_is_no_inviter_at_all(self):
        _, raw = issue(self.owner, 'bob@acme.example', Role.ADMIN)
        # SET_NULL on invited_by: there is nobody to ask, so it is refused
        # and has to be issued again by somebody who is still here.
        self.owner.user.delete()
        with self.assertRaises(invitations.Refused) as caught:
            invitations.accept(raw, self.bob)
        self.assertEqual(caught.exception.reason, 'the inviter no longer has an account')

    def test_a_grant_the_inviter_may_still_make_is_untouched(self):
        _, raw = issue(self.owner, 'bob@acme.example', Role.ADMIN)
        self.assertEqual(invitations.accept(raw, self.bob).role, Role.ADMIN)

    def test_demoting_the_inviter_revokes_the_grant_in_the_listing_too(self):
        from .. import members
        inv, _ = issue(self.owner, 'bob@acme.example', Role.OWNER)
        keep, _ = issue(self.owner, 'carol@acme.example', Role.MEMBER)
        members.change_role(self.second, self.owner.user_id, Role.ADMIN)
        inv.refresh_from_db()
        keep.refresh_from_db()
        # An admin may still invite a member, so that one stands.
        self.assertEqual((inv.state, keep.state), ('revoked', 'pending'))


@override_settings(GC_ACCEPT_RATE='3/m/ip')
class AcceptEndpointTests(TestCase):
    def setUp(self):
        cache.clear()
        self.acme = org('acme', plan='team')
        self.owner = member(self.acme, user('owner@acme.example'), Role.OWNER)
        self.bob = user('bob@acme.example')
        self.inv, self.raw = issue(self.owner, 'bob@acme.example', Role.MEMBER)

    def test_accepting_needs_a_session(self):
        r = Api().post('/auth/invitations/accept', {'token': self.raw})
        self.assertEqual(r.status_code, 401)
        self.assertTrue(self.inv.__class__.objects.get(pk=self.inv.pk).is_live)

    def test_accepting_switches_the_session_to_the_new_organisation(self):
        api = Api()
        api.login('bob@acme.example')
        r = api.post('/auth/invitations/accept', {'token': self.raw})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()['org'], {'slug': 'acme', 'name': 'Acme', 'role': 'member', 'personal': False, 'plan': 'team'})
        self.assertEqual([o['slug'] for o in r.json()['orgs']], ['bob', 'acme'])

    def test_every_refusal_reads_the_same(self):
        api = Api()
        api.login('bob@acme.example')
        wrong = api.post('/auth/invitations/accept', {'token': 'x' * 43}).json()
        carol = Api()
        carol.login(user('carol@acme.example').email)
        mismatch = carol.post('/auth/invitations/accept', {'token': self.raw}).json()
        self.assertEqual(wrong, mismatch)
        self.assertEqual(wrong['error'], invitations.REFUSAL)

    @override_settings(GC_ACCEPT_RATE='30/m/ip')
    def test_a_token_outside_the_alphabet_is_the_same_refusal(self):
        # by_token measured the length and then hashed, and hash_token does
        # raw.encode('ascii') — so a non-ASCII string of the right length
        # raised UnicodeEncodeError out of the view: a distinguishable 500
        # (plus, in production, an ADMINS traceback per attempt) from the one
        # endpoint whose every refusal must read the same [credentials-6].
        api = Api()
        api.login('bob@acme.example')
        for token in ['\u00e9' * 30, 'x' * 20 + '!', 'x' * 19, 'x' * 129, 'x y' * 10]:
            r = api.post('/auth/invitations/accept', {'token': token})
            self.assertEqual(r.status_code, 400, token)
            self.assertEqual(r.json()['error'], invitations.REFUSAL, token)

    def test_attempts_are_rate_limited_by_address(self):
        api = Api()
        api.login('bob@acme.example')
        codes = [api.post('/auth/invitations/accept', {'token': 'x' * 43}).status_code for _ in range(4)]
        self.assertEqual(codes, [400, 400, 400, 429])
        # And the limit counts guesses that never signed in, which is the
        # shape a guessing loop actually has.
        self.assertEqual(Api().post('/auth/invitations/accept', {'token': self.raw}).status_code, 429)

    def guess(self, api, token, forwarded=None):
        extra = {'HTTP_X_FORWARDED_FOR': forwarded} if forwarded else {}
        return api.c.post('/auth/invitations/accept', data=json.dumps({'token': token}),
                          content_type='application/json', HTTP_X_CSRFTOKEN=api.csrf, **extra)

    def test_with_no_trusted_proxy_the_forwarded_header_is_ignored(self):
        api = Api()
        api.login('bob@acme.example')
        for _ in range(3):
            api.post('/auth/invitations/accept', {'token': 'x' * 43})
        # A client that could set its own address would reset the counter. On
        # a laptop (no trusted proxy) the header is ignored and the fourth is
        # still refused. That is the DEFAULT branch of client_ip; the
        # production branch is the test below, which this one used to be
        # named after without exercising.
        self.assertEqual(self.guess(api, 'x' * 43, forwarded='1.2.3.4').status_code, 429)

    @override_settings(ALLAUTH_TRUSTED_PROXY_COUNT=1)
    def test_behind_the_edge_the_bucket_follows_the_hop_a_client_cannot_write(self):
        """
        [credentials-2] is about the trusted-proxy case. Caddy REPLACES
        X-Forwarded-For with the peer it accepted, so the LAST hop is the
        client and everything to its left is the client's own writing — and
        moving the left-hand part must not buy a fresh budget.
        """
        api = Api()
        api.login('bob@acme.example')
        for _ in range(3):
            self.assertEqual(self.guess(api, 'x' * 43, forwarded='10.0.0.9, 198.51.100.7').status_code, 400)
        # Same edge hop, a different left-hand hop: the same bucket.
        self.assertEqual(self.guess(api, 'x' * 43, forwarded='9.9.9.9, 198.51.100.7').status_code, 429)
        # And a genuinely different client is not paying for it.
        self.assertEqual(self.guess(api, 'x' * 43, forwarded='203.0.113.4').status_code, 400)


class IssueRateTests(TestCase):
    """
    Issuing is counted (docs/AUTH.md §3).

    members.max bounds how many invitations may be LIVE at once, which is no
    bound at all on how many are SENT: revoke-and-reissue in a loop mails
    arbitrary third-party addresses through this service's mailer, and on a
    plan whose members.max is null even the per-moment cap is gone. §3 gave
    acceptance and minting a budget and left the one endpoint that mails
    strangers without one.
    """

    def setUp(self):
        cache.clear()
        self.acme = org('acme', plan='enterprise')
        self.owner = member(self.acme, user('owner@acme.example'), Role.OWNER)
        give_authenticator(self.owner.user)
        self.api = self.as_('owner@acme.example')

    def as_(self, email):
        api = Api()
        api.login(email)
        self.assertEqual(api.post('/auth/org', {'org': 'acme'}).status_code, 200)
        return api

    @override_settings(GC_INVITE_RATE='2/h/user')
    def test_a_manager_cannot_mail_strangers_without_limit(self):
        codes = [self.api.post('/auth/invitations', {'email': f'p{i}@other.example'}).status_code
                 for i in range(4)]
        self.assertEqual(codes, [201, 201, 429, 429])
        self.assertEqual(len(mail.outbox), 2)
        self.assertEqual(Invitation.objects.count(), 2)

    @override_settings(GC_INVITE_RATE='2/h/user')
    def test_and_revoking_does_not_buy_a_fresh_budget(self):
        first = self.api.post('/auth/invitations', {'email': 'p0@other.example'})
        self.api.delete(f"/auth/invitations/{first.json()['invitation']['id']}")
        self.assertEqual(self.api.post('/auth/invitations', {'email': 'p1@other.example'}).status_code, 201)
        self.assertEqual(self.api.post('/auth/invitations', {'email': 'p2@other.example'}).status_code, 429)

    @override_settings(GC_INVITE_RATE='2/h/user')
    def test_the_budget_is_the_manager_s_own(self):
        other = member(self.acme, user('admin@acme.example'), Role.ADMIN)
        give_authenticator(other.user)
        for i in range(2):
            self.assertEqual(self.api.post('/auth/invitations', {'email': f'p{i}@other.example'}).status_code, 201)
        theirs = self.as_('admin@acme.example')
        self.assertEqual(theirs.post('/auth/invitations', {'email': 'p9@other.example'}).status_code, 201)


class ManageEndpointTests(TestCase):
    def setUp(self):
        self.acme = org('acme', plan='team')
        self.owner = member(self.acme, user('owner@acme.example'), Role.OWNER)
        self.admin = member(self.acme, user('admin@acme.example'), Role.ADMIN)
        self.plain = member(self.acme, user('member@acme.example'), Role.MEMBER)
        # Managers of an organisation hold an authenticator (docs/AUTH.md §5.4).
        give_authenticator(self.owner.user)
        give_authenticator(self.admin.user)

    def as_(self, email):
        api = Api()
        api.login(email)
        self.assertEqual(api.post('/auth/org', {'org': 'acme'}).status_code, 200)
        return api

    def test_an_owner_issues_and_the_token_goes_to_the_invitee(self):
        r = self.as_('owner@acme.example').post('/auth/invitations', {'email': 'bob@acme.example', 'role': 'admin'})
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body['invitation']['role'], 'admin')
        # Not in the answer: an inviter who could read the token back could
        # sign up as the invitee and accept it themselves.
        self.assertNotIn('token', body)
        self.assertEqual(Invitation.by_token(token_from_mail()).pk, body['invitation']['id'])
        self.assertEqual(mail.outbox[-1].to, ['bob@acme.example'])
        # Nor in the list afterwards.
        listed = self.as_('owner@acme.example').get('/auth/invitations').json()
        self.assertNotIn('token', str(listed))
        self.assertEqual(listed['invitations'][0]['state'], 'pending')

    def test_the_organisation_is_the_session_s_not_the_body_s(self):
        globex = org('globex', plan='team')
        api = self.as_('owner@acme.example')
        r = api.post('/auth/invitations', {'email': 'bob@acme.example', 'org': 'globex', 'organization': globex.pk})
        self.assertEqual(r.status_code, 201)
        self.assertEqual(Invitation.objects.get().organization, self.acme)

    def test_an_admin_cannot_issue_admin(self):
        r = self.as_('admin@acme.example').post('/auth/invitations', {'email': 'bob@acme.example', 'role': 'admin'})
        self.assertEqual(r.status_code, 403)
        self.assertFalse(Invitation.objects.exists())

    def test_a_member_sees_nothing_and_issues_nothing(self):
        api = self.as_('member@acme.example')
        self.assertEqual(api.get('/auth/invitations').status_code, 403)
        self.assertEqual(api.post('/auth/invitations', {'email': 'bob@acme.example'}).status_code, 403)

    def test_a_full_plan_is_a_402_naming_the_limit(self):
        self.acme.entitlement_overrides = {'members.max': 3}
        self.acme.save()
        r = self.as_('owner@acme.example').post('/auth/invitations', {'email': 'bob@acme.example'})
        self.assertEqual(r.status_code, 402)
        self.assertEqual(r.json(), {'error': 'entitlement', 'limit': 'members.max', 'plan': 'team'})

    def test_revoking_is_scoped_to_the_selected_organisation(self):
        inv, _ = issue(self.owner, 'bob@acme.example', Role.MEMBER)
        globex = org('globex', plan='team')
        other = member(globex, user('owner@globex.example'), Role.OWNER)
        give_authenticator(other.user)
        stranger = Api()
        stranger.login('owner@globex.example')
        stranger.post('/auth/org', {'org': 'globex'})
        self.assertEqual(stranger.delete(f'/auth/invitations/{inv.pk}').status_code, 404)
        self.assertTrue(Invitation.objects.get(pk=inv.pk).is_live)
        r = self.as_('admin@acme.example').delete(f'/auth/invitations/{inv.pk}')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()['invitation']['state'], 'revoked')

    def test_the_sign_in_password_is_the_test_one(self):
        # Guards the fixture: every test above signs in with PASSWORD.
        self.assertTrue(self.owner.user.check_password(PASSWORD))
