"""
The executor token carries the organisation, and only from the database.
"""
from django.test import TestCase, override_settings

from accounts.tests import keys
from accounts.tests.keys import claims_of

from ..models import Membership, Organization, Role
from .support import Api, member, org, user


@override_settings(GC_SIGNING_KEY=keys.PRIVATE_PEM, GC_TOKEN_TTL=600)
class TokenClaimsTests(TestCase):
    def setUp(self):
        self.ada = user('ada@acme.example')
        self.acme = org('acme', plan='team', entitlement_overrides={'suites.max': 30})
        member(self.acme, self.ada, Role.ADMIN)
        self.api = Api()
        self.api.login('ada@acme.example')

    def mint(self, body=None):
        r = self.api.post('/auth/executor-token', body)
        self.assertEqual(r.status_code, 200, r.content)
        return claims_of(r.json()['token'])

    def test_the_selected_organisation_and_its_role_are_in_the_token(self):
        c = self.mint()
        self.assertEqual((c['org'], c['role']), ('ada', 'owner'))
        self.api.post('/auth/org', {'org': 'acme'})
        c = self.mint()
        self.assertEqual((c['org'], c['role']), ('acme', 'admin'))
        self.assertEqual(c['ent_v'], 1)

    def test_the_entitlements_are_the_runner_s_subset_resolved(self):
        self.api.post('/auth/org', {'org': 'acme'})
        ent = self.mint()['ent']
        self.assertEqual(ent, {
            'suites.max': 30, 'runs.per_day': 500, 'origins.max': 20, 'vault.enabled': True,
            'history.retention_days': 90,
        })

    def test_the_body_cannot_choose_the_organisation_or_role(self):
        c = self.mint({'org': 'acme', 'role': 'owner', 'ent': {'suites.max': None}})
        self.assertEqual((c['org'], c['role']), ('ada', 'owner'))
        self.assertEqual(c['ent']['suites.max'], 3)

    def test_the_version_follows_the_organisation(self):
        self.api.post('/auth/org', {'org': 'acme'})
        acme = Organization.objects.get(slug='acme')
        acme.entitlement_overrides = {'suites.max': 1}
        acme.save()
        c = self.mint()
        self.assertEqual(c['ent_v'], 2)
        self.assertEqual(c['ent']['suites.max'], 1)

    def test_a_removed_membership_means_a_token_for_the_personal_org_not_acme(self):
        self.api.post('/auth/org', {'org': 'acme'})
        Membership.objects.filter(user=self.ada, organization=self.acme).delete()
        self.assertEqual(self.mint()['org'], 'ada')

    def test_no_membership_anywhere_is_refused(self):
        Membership.objects.filter(user=self.ada).delete()
        r = self.api.post('/auth/executor-token')
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()['error'], 'no_organisation')

    def test_a_deactivated_account_gets_nothing(self):
        self.ada.is_active = False
        self.ada.save()
        self.assertEqual(self.api.post('/auth/executor-token').status_code, 401)
