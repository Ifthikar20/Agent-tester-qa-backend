"""
/auth/me, and the organisation a session acts for.
"""
from django.test import TestCase

from ..models import Membership, Role
from ..session import ORG_KEY
from .support import Api, member, org, user


class MeShapeTests(TestCase):
    def setUp(self):
        self.ada = user('ada@acme.example', name='Ada', is_staff=True)
        self.acme = org('acme', plan='team')
        member(self.acme, self.ada, Role.ADMIN)
        self.api = Api()
        self.api.login('ada@acme.example')

    def test_the_shape(self):
        me = self.api.get('/auth/me').json()
        self.assertEqual(set(me), {'user', 'org', 'orgs', 'entitlements', 'mfa', 'flags'})
        self.assertEqual(me['user'], {'id': self.ada.pk, 'email': 'ada@acme.example', 'name': 'Ada'})
        self.assertEqual(me['org']['slug'], 'ada')
        self.assertEqual(me['org']['role'], 'owner')
        self.assertEqual([(o['slug'], o['role']) for o in me['orgs']], [('ada', 'owner'), ('acme', 'admin')])
        self.assertEqual(me['entitlements']['suites.max'], 3)       # the personal org is free
        self.assertEqual(me['mfa'], {'required': False, 'enrolled': False})
        self.assertEqual(me['flags'], {})

    def test_there_is_no_is_staff(self):
        # Staff opens /admin/ and nothing else. A flag shown to the browser is
        # a flag the browser can show itself [authz-tenancy-6].
        body = self.api.get('/auth/me').content.decode()
        self.assertNotIn('isStaff', body)
        self.assertNotIn('is_staff', body)
        self.assertNotIn('staff', body)

    def test_login_says_nothing_about_staff_either(self):
        # allauth's sign-in answer is its own shape; the SPA asks /auth/me
        # for the organisation. Neither says staff.
        r = Api().login('ada@acme.example').json()
        self.assertEqual(r['data']['user']['email'], 'ada@acme.example')
        self.assertNotIn('staff', str(r).lower())

    def test_the_personal_organisation_is_selected_first(self):
        self.assertEqual(self.api.get('/auth/me').json()['org']['personal'], True)


class SwitchTests(TestCase):
    def setUp(self):
        self.ada = user('ada@acme.example')
        self.acme = org('acme', plan='team')
        self.membership = member(self.acme, self.ada, Role.MEMBER)
        org('globex', plan='team')
        self.api = Api()
        self.api.login('ada@acme.example')

    def test_switching_to_a_membership_works_and_sticks(self):
        r = self.api.post('/auth/org', {'org': 'acme'})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()['org']['slug'], 'acme')
        self.assertEqual(r.json()['entitlements']['suites.max'], 25)
        self.assertEqual(self.api.session[ORG_KEY], 'acme')
        self.assertEqual(self.api.get('/auth/me').json()['org']['slug'], 'acme')

    def test_switching_to_an_organisation_you_are_not_in_is_refused(self):
        r = self.api.post('/auth/org', {'org': 'globex'})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.api.get('/auth/me').json()['org']['slug'], 'ada')

    def test_a_missing_organisation_reads_the_same_as_a_foreign_one(self):
        foreign = self.api.post('/auth/org', {'org': 'globex'}).json()
        missing = self.api.post('/auth/org', {'org': 'nope'}).json()
        self.assertEqual(foreign, missing)

    def test_a_membership_removed_later_stops_working(self):
        self.api.post('/auth/org', {'org': 'acme'})
        self.membership.delete()
        me = self.api.get('/auth/me').json()
        self.assertEqual(me['org']['slug'], 'ada')
        self.assertEqual(self.api.session[ORG_KEY], 'ada')

    def test_a_session_cannot_be_talked_into_an_organisation_by_editing_it(self):
        # The stored slug is re-checked against Membership on every use.
        s = self.api.session
        s[ORG_KEY] = 'globex'
        s.save()
        self.assertEqual(self.api.get('/auth/me').json()['org']['slug'], 'ada')

    def test_anonymous_is_401(self):
        self.assertEqual(Api().post('/auth/org', {'org': 'acme'}).status_code, 401)

    def test_a_user_with_no_membership_at_all_has_no_org(self):
        Membership.objects.filter(user=self.ada).delete()
        me = self.api.get('/auth/me').json()
        self.assertIsNone(me['org'])
        self.assertEqual(me['orgs'], [])
        self.assertEqual(me['entitlements'], {})
