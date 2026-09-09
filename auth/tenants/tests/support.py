"""What the tenants tests share: accounts, organisations, a client that signs in."""
import json

from django.contrib.auth import get_user_model
from django.test import Client

from ..models import Membership, Organization, Plan, Role

User = get_user_model()
PASSWORD = 'a-long-test-password'


def user(email, **extra):
    return User.objects.create_user(email=email, password=PASSWORD, **extra)


def org(slug, plan='team', **extra):
    return Organization.objects.create(slug=slug, name=slug.title(), plan=Plan.objects.get(slug=plan), **extra)


def member(organization, who, role=Role.MEMBER):
    return Membership.objects.create(organization=organization, user=who, role=role)


class Api:
    """A CSRF-enforcing client that speaks the SPA's JSON."""

    def __init__(self):
        self.c = Client(enforce_csrf_checks=True)
        self.csrf = self.c.get('/auth/csrf').json()['csrfToken']

    def login(self, email, password=PASSWORD):
        r = self.post('/auth/login', {'email': email, 'password': password})
        assert r.status_code == 200, r.content
        self.csrf = r.json()['csrfToken']
        return r

    def get(self, path):
        return self.c.get(path)

    def post(self, path, body=None):
        return self.c.post(path, data=json.dumps(body or {}), content_type='application/json',
                           HTTP_X_CSRFTOKEN=self.csrf)

    def delete(self, path):
        return self.c.delete(path, HTTP_X_CSRFTOKEN=self.csrf)

    @property
    def session(self):
        return self.c.session
