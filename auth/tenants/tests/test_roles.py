"""
The role cap [authz-tenancy-5]: an inviter never grants above their own role,
and only an owner grants admin or owner.
"""
from django.test import TestCase

from .. import invitations
from ..models import Membership, Role
from .support import member, org, user


class RoleCapTests(TestCase):
    def setUp(self):
        self.acme = org('acme', plan='team')
        self.owner = member(self.acme, user('owner@acme.example'), Role.OWNER)
        self.admin = member(self.acme, user('admin@acme.example'), Role.ADMIN)
        self.member = member(self.acme, user('member@acme.example'), Role.MEMBER)

    def can(self, inviter, role):
        try:
            invitations.issue(inviter, f'{role}-by-{inviter.role}@example.com', role)
            return True
        except invitations.Refused as err:
            self.assertTrue(err.forbidden, err.reason)
            return False

    def test_an_owner_grants_any_role(self):
        for role in (Role.MEMBER, Role.ADMIN, Role.OWNER):
            self.assertTrue(self.can(self.owner, role), role)

    def test_an_admin_grants_member_only(self):
        self.assertTrue(self.can(self.admin, Role.MEMBER))
        # Not above their own role, and not admin either: that is the rule
        # that stops a taken-over admin account minting more admins.
        self.assertFalse(self.can(self.admin, Role.ADMIN))
        self.assertFalse(self.can(self.admin, Role.OWNER))

    def test_a_member_grants_nothing(self):
        for role in (Role.MEMBER, Role.ADMIN, Role.OWNER):
            self.assertFalse(self.can(self.member, role), role)

    def test_an_unknown_role_is_refused(self):
        with self.assertRaises(invitations.Refused):
            invitations.issue(self.owner, 'x@example.com', 'superuser')

    def test_the_cap_is_checked_before_the_seat_count(self):
        # A refusal for role reads the same however full the organisation is,
        # so the error does not double as a seat counter.
        self.acme.entitlement_overrides = {'members.max': 3}
        self.acme.save()
        with self.assertRaises(invitations.Refused):
            invitations.issue(self.admin, 'x@example.com', Role.ADMIN)


class SeatTests(TestCase):
    def test_a_free_plan_has_no_seat_to_invite_into(self):
        ada = user('ada@acme.example')
        me = Membership.objects.get(user=ada)      # owner of the personal org, plan free
        with self.assertRaises(invitations.Entitlement) as caught:
            invitations.issue(me, 'bob@acme.example', Role.MEMBER)
        self.assertEqual(caught.exception.limit, 'members.max')
        self.assertEqual(caught.exception.plan, 'free')

    def test_pending_invitations_count_as_seats(self):
        acme = org('acme', plan='team', entitlement_overrides={'members.max': 2})
        owner = member(acme, user('owner@acme.example'), Role.OWNER)
        invitations.issue(owner, 'bob@acme.example', Role.MEMBER)
        with self.assertRaises(invitations.Entitlement):
            invitations.issue(owner, 'carol@acme.example', Role.MEMBER)

    def test_a_revoked_invitation_frees_its_seat(self):
        acme = org('acme', plan='team', entitlement_overrides={'members.max': 2})
        owner = member(acme, user('owner@acme.example'), Role.OWNER)
        first = invitations.issue(owner, 'bob@acme.example', Role.MEMBER)
        invitations.revoke(first)
        invitations.issue(owner, 'carol@acme.example', Role.MEMBER)

    def test_unlimited_means_unlimited(self):
        acme = org('acme', plan='enterprise')
        owner = member(acme, user('owner@acme.example'), Role.OWNER)
        for n in range(12):
            invitations.issue(owner, f'p{n}@acme.example', Role.MEMBER)

    def test_an_existing_member_is_not_invited_again(self):
        acme = org('acme', plan='team')
        owner = member(acme, user('owner@acme.example'), Role.OWNER)
        member(acme, user('bob@acme.example'))
        with self.assertRaises(invitations.Refused):
            invitations.issue(owner, 'Bob@acme.example', Role.MEMBER)
