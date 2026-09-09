"""
Every account has a personal organisation.

Created by a receiver on the user model's post_save, so it cannot depend on
which code path made the account — createsuperuser, adduser, the admin, or
the sign-up flow that does not exist yet all fire the same signal. The
function is idempotent so the backfill command (`manage.py personal_orgs`)
can run it over accounts that predate the rule, and run it again.
"""
from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models.signals import post_save
from django.dispatch import receiver

from .models import Membership, Organization, Plan, Role
from .slugs import personal_slug


def ensure_personal_org(user):
    """The user's personal organisation, made if missing. Returns (org, created)."""
    existing = Organization.objects.filter(personal_of=user).first()
    if existing is not None:
        # A personal organisation without its owner's membership is a row
        # somebody edited; put the membership back rather than leave a user
        # who owns an organisation they cannot act in.
        Membership.objects.get_or_create(organization=existing, user=user, defaults={'role': Role.OWNER})
        return existing, False
    with transaction.atomic():
        taken = set(Organization.objects.values_list('slug', flat=True))
        org = Organization.objects.create(
            slug=personal_slug(user.email, taken),
            name=user.name or user.email.split('@', 1)[0],
            plan=Plan.default(),
            personal_of=user,
        )
        Membership.objects.create(organization=org, user=user, role=Role.OWNER)
    return org, True


@receiver(post_save, sender=get_user_model())
def on_user_created(sender, instance, created, raw=False, **kwargs):
    # `raw` is loaddata restoring rows; the fixture carries its own
    # organisations, and a receiver creating more would collide with them.
    if created and not raw:
        ensure_personal_org(instance)
