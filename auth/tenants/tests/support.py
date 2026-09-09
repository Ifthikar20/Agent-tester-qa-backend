"""What the tenants tests share: accounts, organisations, a client that signs in."""
from accounts.tests.support import PASSWORD, Api, User, give_authenticator, make_user, token_from_mail  # noqa: F401

from ..models import Membership, Organization, Plan, Role


def user(email, **extra):
    return make_user(email, **extra)


def org(slug, plan='team', **extra):
    return Organization.objects.create(slug=slug, name=slug.title(), plan=Plan.objects.get(slug=plan), **extra)


def member(organization, who, role=Role.MEMBER):
    return Membership.objects.create(organization=organization, user=who, role=role)
