"""
Invitations: hashed, email-bound, a week long, single-use, rate limited and
logged [credentials-6].
"""
from datetime import timedelta

from django.core.cache import cache
from django.test import TestCase, override_settings
from django.utils import timezone

from accounts.models import AuthEvent

from .. import invitations
from ..models import Invitation, Membership, Role, hash_token
from .support import PASSWORD, Api, member, org, user


class IssueTests(TestCase):
    def setUp(self):
        self.acme = org('acme', plan='team')
        self.owner = member(self.acme, user('owner@acme.example'), Role.OWNER)

    def test_the_token_is_stored_hashed_and_found_by_token(self):
        inv, raw = invitations.issue(self.owner, 'bob@acme.example', Role.MEMBER)
        self.assertNotIn(raw, inv.token_hash)
        self.assertEqual(inv.token_hash, hash_token(raw))
        self.assertEqual(Invitation.by_token(raw), inv)
        self.assertIsNone(Invitation.by_token(raw[:-1] + ('a' if raw[-1] != 'a' else 'b')))
        self.assertGreaterEqual(len(raw), 40)

    def test_it_lasts_seven_days(self):
        inv, _ = invitations.issue(self.owner, 'bob@acme.example', Role.MEMBER)
        self.assertAlmostEqual(inv.expires_at, timezone.now() + timedelta(days=7), delta=timedelta(minutes=1))

    def test_it_is_logged(self):
        inv, _ = invitations.issue(self.owner, 'bob@acme.example', Role.MEMBER)
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
        self.inv, self.raw = invitations.issue(self.owner, 'bob@acme.example', Role.ADMIN)

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
        self.refused(self.raw, self.bob, 'already used')
        self.assertEqual(Membership.objects.filter(user=self.bob, organization=self.acme).count(), 1)

    def test_the_email_must_match(self):
        carol = user('carol@acme.example')
        self.refused(self.raw, carol, 'signed in as a different address')
        self.assertFalse(Membership.objects.filter(user=carol, organization=self.acme).exists())
        # And a refusal does not consume it: the right person can still accept.
        invitations.accept(self.raw, self.bob)

    def test_the_email_match_ignores_case(self):
        dave = user('Dave@acme.example')
        _, raw = invitations.issue(self.owner, 'dave@ACME.example', Role.MEMBER)
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


@override_settings(GC_ACCEPT_RATE='3/m/ip')
class AcceptEndpointTests(TestCase):
    def setUp(self):
        cache.clear()
        self.acme = org('acme', plan='team')
        self.owner = member(self.acme, user('owner@acme.example'), Role.OWNER)
        self.bob = user('bob@acme.example')
        self.inv, self.raw = invitations.issue(self.owner, 'bob@acme.example', Role.MEMBER)

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

    def test_attempts_are_rate_limited_by_address(self):
        api = Api()
        api.login('bob@acme.example')
        codes = [api.post('/auth/invitations/accept', {'token': 'x' * 43}).status_code for _ in range(4)]
        self.assertEqual(codes, [400, 400, 400, 429])
        # And the limit counts guesses that never signed in, which is the
        # shape a guessing loop actually has.
        self.assertEqual(Api().post('/auth/invitations/accept', {'token': self.raw}).status_code, 429)

    def test_the_rate_limit_is_keyed_on_the_edge_s_address(self):
        api = Api()
        api.login('bob@acme.example')
        for _ in range(3):
            api.post('/auth/invitations/accept', {'token': 'x' * 43})
        # A client that could set its own address would reset the counter. On
        # a laptop (no trusted proxy) the header is ignored and the fourth is
        # still refused.
        r = api.c.post('/auth/invitations/accept', data='{"token": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}',
                       content_type='application/json', HTTP_X_CSRFTOKEN=api.csrf, HTTP_X_FORWARDED_FOR='1.2.3.4')
        self.assertEqual(r.status_code, 429)


class ManageEndpointTests(TestCase):
    def setUp(self):
        self.acme = org('acme', plan='team')
        self.owner = member(self.acme, user('owner@acme.example'), Role.OWNER)
        self.admin = member(self.acme, user('admin@acme.example'), Role.ADMIN)
        self.plain = member(self.acme, user('member@acme.example'), Role.MEMBER)

    def as_(self, email):
        api = Api()
        api.login(email)
        self.assertEqual(api.post('/auth/org', {'org': 'acme'}).status_code, 200)
        return api

    def test_an_owner_issues_and_gets_the_token_once(self):
        r = self.as_('owner@acme.example').post('/auth/invitations', {'email': 'bob@acme.example', 'role': 'admin'})
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body['invitation']['role'], 'admin')
        self.assertEqual(Invitation.by_token(body['token']).pk, body['invitation']['id'])
        # The token is not in the list, or anywhere else, afterwards.
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
        inv, _ = invitations.issue(self.owner, 'bob@acme.example', Role.MEMBER)
        globex = org('globex', plan='team')
        other = member(globex, user('owner@globex.example'), Role.OWNER)
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
