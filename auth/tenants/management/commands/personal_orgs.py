"""
Give every account that lacks one a personal organisation.

    python manage.py personal_orgs

The migration that introduced organisations did this once for the accounts
that existed then, and a receiver does it for every account made since, so
on a healthy database this prints "nothing to do". It exists for the other
databases: one restored from a dump taken before the rule, or one where a
personal organisation was deleted in the admin. Safe to run any number of
times — it only ever adds what is missing.
"""
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand

from ...personal import ensure_personal_org


class Command(BaseCommand):
    help = 'Create a personal organisation for every account without one.'

    def handle(self, *args, **opts):
        made = 0
        for user in get_user_model().objects.order_by('pk').iterator():
            org, created = ensure_personal_org(user)
            if created:
                made += 1
                self.stdout.write(f'  {user.email:<36} -> {org.slug}')
        self.stdout.write(f'\n  {made} personal organisation{"" if made == 1 else "s"} created' if made
                          else '\n  nothing to do - every account has one')
