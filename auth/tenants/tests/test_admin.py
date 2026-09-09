"""
The admin: plans and organisations are there, and the two fields that make
an account a superuser are read-only to anyone who is not one
[authz-tenancy-6].
"""
from django.contrib import admin
from django.contrib.auth.models import Permission
from django.test import Client, RequestFactory, TestCase

from accounts.admin import UserAdmin

from ..models import Organization, Plan
from .support import PASSWORD, User, user


class RegistrationTests(TestCase):
    def test_plans_and_organisations_are_in_the_admin(self):
        self.assertIn(Plan, admin.site._registry)
        self.assertIn(Organization, admin.site._registry)

    def test_the_version_is_not_hand_editable(self):
        self.assertIn('entitlements_version', admin.site._registry[Organization].readonly_fields)


class SuperuserFieldTests(TestCase):
    def setUp(self):
        self.root = User.objects.create_superuser(email='root@example.com', password=PASSWORD)
        self.staff = user('staff@example.com', is_staff=True)
        self.staff.user_permissions.add(*Permission.objects.filter(content_type__app_label='accounts'))
        self.model_admin = UserAdmin(User, admin.site)

    def as_(self, who):
        rf = RequestFactory().get('/admin/accounts/user/')
        rf.user = who
        return rf

    def test_read_only_for_staff(self):
        fields = self.model_admin.get_readonly_fields(self.as_(self.staff), self.staff)
        self.assertIn('is_superuser', fields)
        self.assertIn('user_permissions', fields)

    def test_editable_for_a_superuser(self):
        fields = self.model_admin.get_readonly_fields(self.as_(self.root), self.staff)
        self.assertNotIn('is_superuser', fields)
        self.assertNotIn('user_permissions', fields)

    def test_a_staff_user_cannot_post_themselves_to_superuser(self):
        c = Client()
        c.force_login(self.staff)
        url = f'/admin/accounts/user/{self.staff.pk}/change/'
        page = c.get(url)
        self.assertEqual(page.status_code, 200)
        # The form the page renders has no is_superuser input at all; posting
        # one anyway must be ignored, not honoured.
        self.assertNotIn('name="is_superuser"', page.content.decode())
        r = c.post(url, {
            'email': 'staff@example.com', 'name': '', 'is_active': 'on', 'is_staff': 'on',
            'is_superuser': 'on', 'user_permissions': [Permission.objects.first().pk],
            'date_joined_0': '2026-01-01', 'date_joined_1': '00:00:00', '_save': 'Save',
        })
        self.assertIn(r.status_code, (200, 302))
        self.staff.refresh_from_db()
        self.assertFalse(self.staff.is_superuser)

    def test_a_superuser_still_can(self):
        c = Client()
        c.force_login(self.root)
        page = c.get(f'/admin/accounts/user/{self.staff.pk}/change/')
        self.assertIn('name="is_superuser"', page.content.decode())
