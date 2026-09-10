"""
Every account has a personal organisation.

Created by a receiver on the user model's post_save, so it cannot depend on
which code path made the account — createsuperuser, adduser, the admin, or
the sign-up flow that does not exist yet all fire the same signal. The
function is idempotent so the backfill command (`manage.py personal_orgs`)
can run it over accounts that predate the rule, and run it again.
"""
import secrets

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
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
    # Only the slugs that could actually clash, not every slug in the table:
    # the old query read the whole column on EVERY account creation, which is
    # an O(rows) read per sign-up for an answer about one prefix.
    base = personal_slug(user.email, set())
    taken = set(Organization.objects.filter(slug__startswith=base).values_list('slug', flat=True))
    # And a retry, because choosing a name by reading and then writing is a
    # race: two people called ada signing up in the same instant computed the
    # same candidate, and the loser's INSERT hit the unique constraint inside
    # the user's post_save — so their sign-up 500'd instead of their
    # organisation being called ada-2. Each attempt is its own savepoint, so
    # a failed INSERT does not poison the transaction around it.
    for _ in range(4):
        candidate = personal_slug(user.email, taken)
        try:
            with transaction.atomic():
                org = Organization.objects.create(
                    slug=candidate,
                    name=user.name or user.email.split('@', 1)[0],
                    plan=Plan.default(),
                    personal_of=user,
                )
                Membership.objects.create(organization=org, user=user, role=Role.OWNER)
            return org, True
        except IntegrityError:
            taken.add(candidate)
    # Four collisions is not contention any more; end it with a name nothing
    # is going to have chosen.
    with transaction.atomic():
        org = Organization.objects.create(
            slug=f'{base}-{secrets.token_hex(3)}',
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
