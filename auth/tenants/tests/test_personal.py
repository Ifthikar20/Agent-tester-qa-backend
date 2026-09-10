"""
Every account has a personal organisation, however the account was made.
"""
import io

from django.core.management import call_command
from django.test import TestCase

from ..models import Membership, Organization, Plan, Role
from ..personal import ensure_personal_org
from ..slugs import RESERVED, is_slug, personal_slug
from .support import PASSWORD, User, user


class PersonalOrgTests(TestCase):
    def test_creating_a_user_creates_it_with_the_user_as_owner(self):
        ada = user('ada@acme.example', name='Ada')
        org = ada.personal_organization
        self.assertEqual(org.slug, 'ada')
        self.assertEqual(org.name, 'Ada')
        self.assertEqual(org.plan.slug, 'free')
        self.assertEqual(Membership.objects.get(user=ada).role, Role.OWNER)
        self.assertEqual(Membership.objects.get(user=ada).organization, org)

    def test_a_superuser_gets_one_too(self):
        root = User.objects.create_superuser(email='root@example.com', password='x')
        self.assertIsNotNone(root.personal_organization)

    def test_the_name_falls_back_to_the_local_part(self):
        self.assertEqual(user('grace.hopper@navy.example').personal_organization.name, 'grace.hopper')

    def test_a_slug_already_taken_by_a_plain_organisation_is_stepped_over(self):
        # The candidate is chosen by reading and then writing, so the write
        # has to be able to lose: a name taken between the two is retried
        # rather than raised. (The real race is two sign-ups in the same
        # instant; this is the same code path, made deterministic.)
        Organization.objects.create(slug='ada', name='Ada Ltd', plan=Plan.objects.get(slug='free'))
        made = User.objects.create_user(email='ada@example.com', password=PASSWORD)
        self.assertEqual(made.personal_organization.slug, 'ada-2')

    def test_two_adas_get_two_slugs(self):
        user('ada@acme.example')
        self.assertEqual(user('ada@globex.example').personal_organization.slug, 'ada-2')

    def test_one_per_user_is_enforced_by_the_database(self):
        ada = user('ada@acme.example')
        from django.db import IntegrityError
        with self.assertRaises(IntegrityError):
            Organization.objects.create(slug='ada-again', name='x', plan_id=ada.personal_organization.plan_id, personal_of=ada)

    def test_ensure_is_idempotent(self):
        ada = user('ada@acme.example')
        org, created = ensure_personal_org(ada)
        self.assertFalse(created)
        self.assertEqual(org, ada.personal_organization)
        self.assertEqual(Organization.objects.filter(personal_of=ada).count(), 1)

    def test_ensure_restores_a_deleted_owner_membership(self):
        ada = user('ada@acme.example')
        Membership.objects.filter(user=ada).delete()
        ensure_personal_org(ada)
        self.assertEqual(Membership.objects.get(user=ada).role, Role.OWNER)

    def test_deleting_the_user_deletes_the_personal_organisation(self):
        ada = user('ada@acme.example')
        pk = ada.personal_organization.pk
        ada.delete()
        self.assertFalse(Organization.objects.filter(pk=pk).exists())


class BackfillCommandTests(TestCase):
    def run_it(self):
        out = io.StringIO()
        call_command('personal_orgs', stdout=out)
        return out.getvalue()

    def test_it_creates_what_is_missing_and_only_that(self):
        ada, bob = user('ada@acme.example'), user('bob@acme.example')
        # Simulate accounts from before the rule.
        Organization.objects.filter(personal_of=bob).delete()
        report = self.run_it()
        self.assertIn('bob@acme.example', report)
        self.assertNotIn('ada@acme.example', report)
        self.assertIn('1 personal organisation created', report)
        self.assertEqual(Membership.objects.get(user=bob).role, Role.OWNER)
        self.assertEqual(Organization.objects.count(), 2)

    def test_a_second_run_does_nothing(self):
        user('ada@acme.example')
        self.run_it()
        self.assertIn('nothing to do', self.run_it())


class SlugTests(TestCase):
    def test_the_local_part_becomes_the_slug(self):
        self.assertEqual(personal_slug('Ada.Lovelace+qa@acme.example', set()), 'ada-lovelace-qa')

    def test_a_clash_gets_a_number_not_the_domain(self):
        self.assertEqual(personal_slug('ada@globex.example', {'ada', 'ada-2'}), 'ada-3')

    def test_a_reserved_word_is_avoided(self):
        # 'admin@acme.example' must not become the organisation called admin,
        # which is a route.
        for word in ('admin', 'api', 'auth'):
            got = personal_slug(f'{word}@acme.example', set())
            self.assertTrue(is_slug(got), got)
            self.assertNotIn(got, RESERVED)

    def test_an_unusable_local_part_still_yields_a_slug(self):
        self.assertTrue(is_slug(personal_slug('---@acme.example', set())))
        self.assertTrue(is_slug(personal_slug('日本@acme.example', set())))

    def test_what_a_slug_is(self):
        self.assertTrue(is_slug('acme'))
        self.assertTrue(is_slug('acme-2'))
        self.assertFalse(is_slug('Acme'))
        self.assertFalse(is_slug('-acme'))
        self.assertFalse(is_slug('acme/../etc'))
        self.assertFalse(is_slug('admin'))
        self.assertFalse(is_slug(''))
