"""
Delete audit rows older than ninety days.

    python manage.py purge_auth_events
    python manage.py purge_auth_events --days 30
    python manage.py purge_auth_events --dry-run

docs/AUTH.md §12. The audit log exists so that a compromise is detected by
the rows it could not avoid writing (§13), and ninety days is long enough
to notice one and to answer "who signed in from where" for a quarter. Past
that a row is a record of an address and a user agent that no longer
tells anyone anything, and a table that grows forever is a backup that
grows forever. Every kind of row goes at the same age — a mint, a refusal,
a sign-up, an invitation, a Google or authenticator event — because a
retention rule with exceptions is one whose exceptions nobody remembers.

Nothing is deleted younger than the cutoff, whatever the kind, and the
command is idempotent: run twice, the second run deletes nothing. Meant to
run daily (accounts.management.commands.housekeeping schedules it); running
it more often changes only how close to ninety days the oldest row is.
"""
from datetime import timedelta

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from accounts.models import AuthEvent

RETENTION_DAYS = 90


def stale(days=RETENTION_DAYS, now=None):
    """The rows older than `days`, as a queryset."""
    cutoff = (now or timezone.now()) - timedelta(days=days)
    return AuthEvent.objects.filter(at__lt=cutoff)


class Command(BaseCommand):
    help = f'Delete audit-log rows older than {RETENTION_DAYS} days (docs/AUTH.md §12).'

    def add_arguments(self, parser):
        parser.add_argument('--days', type=int, default=RETENTION_DAYS,
                            help=f'keep this many days (default {RETENTION_DAYS})')
        parser.add_argument('--dry-run', action='store_true', help='say how many would go, and delete nothing')

    def handle(self, *args, days=RETENTION_DAYS, dry_run=False, **options):
        # A retention of zero would delete the row a sign-in wrote a second
        # ago; nobody means that, and a typo should not empty the log.
        if days < 1:
            raise CommandError('--days must be at least 1')
        rows = stale(days)
        n = rows.count()
        noun = f'audit row{"" if n == 1 else "s"} older than {days} day{"" if days == 1 else "s"}'
        if dry_run:
            self.stdout.write(f'{n} {noun}; nothing deleted (--dry-run)')
            return
        rows.delete()
        self.stdout.write(f'deleted {n} {noun}')
