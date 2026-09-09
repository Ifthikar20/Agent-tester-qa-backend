"""
What an organisation may do: plan defaults, overrides, and the version that
tells the runner something changed (docs/AUTH.md §10).
"""
from django.core.exceptions import ValidationError
from django.test import TestCase

from .. import plans
from ..models import Organization, Plan
from .support import org


class SeedTests(TestCase):
    def test_the_three_plans_exist_with_the_catalogue_s_numbers(self):
        # The migration copied the numbers rather than importing them; this is
        # what keeps the copy honest. A number changed in plans.py without a
        # new migration fails here.
        for slug, spec in plans.PLANS.items():
            row = Plan.objects.get(slug=slug)
            self.assertEqual(row.name, spec['name'])
            self.assertEqual(row.entitlements, spec['entitlements'])

    def test_every_plan_says_something_about_every_key(self):
        for row in Plan.objects.all():
            self.assertEqual(set(row.entitlements), set(plans.KEYS), row.slug)

    def test_the_free_plan_is_one_person(self):
        self.assertEqual(Plan.objects.get(slug='free').entitlements['members.max'], 1)

    def test_enterprise_is_unlimited_where_it_says_so(self):
        ent = Plan.objects.get(slug='enterprise').entitlements
        self.assertIsNone(ent['suites.max'])
        self.assertIsNone(ent['members.max'])
        self.assertTrue(ent['mfa.required'])


class ResolutionTests(TestCase):
    def test_defaults_come_from_the_plan(self):
        acme = org('acme', plan='team')
        self.assertEqual(acme.entitlements(), plans.PLANS['team']['entitlements'])

    def test_overrides_win_key_by_key(self):
        acme = org('acme', plan='free', entitlement_overrides={'suites.max': 10, 'vault.enabled': True})
        ent = acme.entitlements()
        self.assertEqual(ent['suites.max'], 10)
        self.assertTrue(ent['vault.enabled'])
        self.assertEqual(ent['runs.per_day'], 20)     # untouched

    def test_an_override_to_unlimited_is_null_not_a_sentinel(self):
        acme = org('acme', plan='free', entitlement_overrides={'runs.per_day': None})
        self.assertIsNone(acme.entitlements()['runs.per_day'])

    def test_only_the_runner_s_subset_goes_in_a_token(self):
        acme = org('acme', plan='enterprise')
        subset = plans.runner_subset(acme.entitlements())
        self.assertEqual(set(subset), set(plans.RUNNER_ENFORCED))
        self.assertNotIn('members.max', subset)
        self.assertNotIn('mfa.required', subset)


class ValidationTests(TestCase):
    def test_an_unknown_key_is_refused(self):
        with self.assertRaises(ValidationError):
            plans.validate_entitlements({'suite.max': 3})

    def test_a_string_where_a_count_belongs_is_refused(self):
        with self.assertRaises(ValidationError):
            plans.validate_entitlements({'suites.max': '3'})

    def test_a_bool_for_a_count_is_refused(self):
        # bool is an int in Python; it is not a limit.
        with self.assertRaises(ValidationError):
            plans.validate_entitlements({'suites.max': True})

    def test_a_number_for_a_flag_is_refused(self):
        with self.assertRaises(ValidationError):
            plans.validate_entitlements({'vault.enabled': 1})

    def test_a_plan_must_be_complete(self):
        with self.assertRaises(ValidationError):
            plans.validate_entitlements({'suites.max': 3}, complete=True)

    def test_the_admin_form_path_runs_it(self):
        acme = org('acme')
        acme.entitlement_overrides = {'nope': 1}
        with self.assertRaises(ValidationError):
            acme.full_clean()

    def test_a_reserved_slug_is_refused(self):
        acme = org('acme')
        acme.slug = 'admin'
        with self.assertRaises(ValidationError):
            acme.full_clean()


class VersionTests(TestCase):
    """
    entitlements_version is what a downgrade looks like to the runner, which
    otherwise trusts the numbers in a token until it expires.
    """

    def test_starts_at_one(self):
        self.assertEqual(org('acme').entitlements_version, 1)

    def test_changing_an_override_bumps_it(self):
        acme = org('acme')
        acme = Organization.objects.get(pk=acme.pk)
        acme.entitlement_overrides = {'suites.max': 1}
        acme.save()
        self.assertEqual(acme.entitlements_version, 2)
        self.assertEqual(Organization.objects.get(pk=acme.pk).entitlements_version, 2)

    def test_saving_without_a_change_does_not(self):
        acme = Organization.objects.get(pk=org('acme').pk)
        acme.name = 'Acme Ltd'
        acme.save()
        self.assertEqual(acme.entitlements_version, 1)

    def test_changing_the_plan_bumps_it(self):
        acme = Organization.objects.get(pk=org('acme', plan='team').pk)
        acme.plan = Plan.objects.get(slug='free')
        acme.save()
        self.assertEqual(acme.entitlements_version, 2)

    def test_editing_a_plan_bumps_every_organisation_on_it(self):
        acme, globex = org('acme', plan='team'), org('globex', plan='team')
        alone = org('alone', plan='free')
        team = Plan.objects.get(slug='team')
        team.entitlements = {**team.entitlements, 'suites.max': 5}
        team.save()
        self.assertEqual(Organization.objects.get(pk=acme.pk).entitlements_version, 2)
        self.assertEqual(Organization.objects.get(pk=globex.pk).entitlements_version, 2)
        self.assertEqual(Organization.objects.get(pk=alone.pk).entitlements_version, 1)

    def test_renaming_a_plan_does_not(self):
        acme = org('acme', plan='team')
        team = Plan.objects.get(slug='team')
        team.name = 'Team (renamed)'
        team.save()
        self.assertEqual(Organization.objects.get(pk=acme.pk).entitlements_version, 1)
