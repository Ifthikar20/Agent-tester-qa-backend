"""
Members: who may see the list, who may change a role, who may remove whom,
and the two invariants — an organisation keeps an owner, a personal
organisation keeps its person [authz-tenancy-5].
"""
from django.core.cache import cache
from django.test import TestCase

from accounts.models import AuthEvent

from ..models import Membership, Role
from .support import Api, give_authenticator, member, org, user


class MembersTests(TestCase):
    def setUp(self):
        # Every test signs in several accounts; the per-address sign-in
        # limit must not carry from one test into the next.
        cache.clear()
        self.acme = org('acme', plan='team')
        self.owner = member(self.acme, user('owner@acme.example'), Role.OWNER)
        self.admin = member(self.acme, user('admin@acme.example'), Role.ADMIN)
        self.member = member(self.acme, user('member@acme.example'), Role.MEMBER)
        # Managers must hold an authenticator to act at all (docs/AUTH.md §5.4).
        give_authenticator(self.owner.user)
        give_authenticator(self.admin.user)

    def api_as(self, email):
        api = Api()
        api.login(email)
        api.post('/auth/org', {'org': 'acme'})
        return api

    def test_any_member_sees_the_list_owners_first_and_themselves_marked(self):
        r = self.api_as('member@acme.example').get('/auth/members')
        self.assertEqual(r.status_code, 200)
        rows = r.json()['members']
        self.assertEqual([m['role'] for m in rows], ['owner', 'admin', 'member'])
        self.assertEqual([m['you'] for m in rows], [False, False, True])
        self.assertEqual(set(rows[0]), {'id', 'email', 'name', 'role', 'joinedAt', 'you'})

    def test_the_list_is_the_selected_organisation_s(self):
        # Ada's personal organisation is the default selection: one row, herself.
        api = Api()
        api.login('member@acme.example')
        rows = api.get('/auth/members').json()['members']
        self.assertEqual([m['email'] for m in rows], ['member@acme.example'])

    def test_an_owner_promotes_and_demotes(self):
        api = self.api_as('owner@acme.example')
        r = api.patch(f'/auth/members/{self.member.user_id}', {'role': 'admin'})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(Membership.objects.get(pk=self.member.pk).role, 'admin')
        r = api.patch(f'/auth/members/{self.admin.user_id}', {'role': 'member'})
        self.assertEqual(r.status_code, 200)
        ev = AuthEvent.objects.filter(kind=AuthEvent.Kind.MEMBER_ROLE_CHANGED).first()
        self.assertEqual((ev.user, ev.detail['org'], ev.detail['now']), (self.owner.user, 'acme', 'member'))

    def test_an_admin_changes_no_role(self):
        r = self.api_as('admin@acme.example').patch(f'/auth/members/{self.member.user_id}', {'role': 'admin'})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(Membership.objects.get(pk=self.member.pk).role, 'member')

    def test_nobody_changes_their_own_role(self):
        r = self.api_as('owner@acme.example').patch(f'/auth/members/{self.owner.user_id}', {'role': 'member'})
        self.assertEqual(r.status_code, 403)

    def test_the_last_owner_is_kept(self):
        second = member(self.acme, user('two@acme.example'), Role.OWNER)
        give_authenticator(second.user)
        api = self.api_as('two@acme.example')
        # Two owners: demoting one is fine; demoting the remaining one is not.
        self.assertEqual(api.patch(f'/auth/members/{self.owner.user_id}', {'role': 'admin'}).status_code, 200)
        api2 = self.api_as('owner@acme.example')   # now an admin
        self.assertEqual(api2.patch(f'/auth/members/{second.user_id}', {'role': 'member'}).status_code, 403)
        self.assertEqual(api.delete(f'/auth/members/{second.user_id}').status_code, 403)

    def test_an_unknown_role_is_a_400_and_another_org_s_member_a_404(self):
        api = self.api_as('owner@acme.example')
        self.assertEqual(api.patch(f'/auth/members/{self.member.user_id}', {'role': 'god'}).status_code, 400)
        stranger = user('stranger@globex.example')
        self.assertEqual(api.patch(f'/auth/members/{stranger.pk}', {'role': 'member'}).status_code, 404)
        self.assertEqual(api.delete(f'/auth/members/{stranger.pk}').status_code, 404)

    def test_removal_follows_the_role(self):
        # A member removes nobody but themselves; an admin removes members;
        # an owner removes anyone but the last owner.
        self.assertEqual(self.api_as('member@acme.example').delete(f'/auth/members/{self.admin.user_id}').status_code, 403)
        self.assertEqual(self.api_as('admin@acme.example').delete(f'/auth/members/{self.owner.user_id}').status_code, 403)
        r = self.api_as('admin@acme.example').delete(f'/auth/members/{self.member.user_id}')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(Membership.objects.filter(pk=self.member.pk).exists())
        r = self.api_as('owner@acme.example').delete(f'/auth/members/{self.admin.user_id}')
        self.assertEqual(r.status_code, 200)
        ev = AuthEvent.objects.filter(kind=AuthEvent.Kind.MEMBER_REMOVED).order_by('at').first()
        self.assertEqual((ev.user, ev.detail['member'], ev.detail['left']), (self.admin.user, self.member.user_id, False))

    def test_leaving_selects_the_personal_organisation(self):
        api = self.api_as('member@acme.example')
        r = api.delete(f'/auth/members/{self.member.user_id}')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()['left'])
        self.assertEqual(r.json()['org']['slug'], 'member')
        self.assertFalse(Membership.objects.filter(pk=self.member.pk).exists())

    def test_a_personal_organisation_keeps_its_person(self):
        api = Api()
        api.login('member@acme.example')     # the personal org is selected
        me = self.member.user
        self.assertEqual(api.delete(f'/auth/members/{me.pk}').status_code, 403)
        self.assertTrue(Membership.objects.filter(user=me, organization__personal_of=me).exists())

    def tearDown(self):
        cache.clear()
