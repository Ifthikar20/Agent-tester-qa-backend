"""
Delete unverified secondary addresses older than fifteen minutes.

    python manage.py purge_unverified_emails
    python manage.py purge_unverified_emails --dry-run

docs/AUTH.md §6.6 [oauth-2]. Adding an address to an account is a claim on
it that nothing has proven: the row blocks the address's real owner from
signing up (addresses are unique), and it is the row that a Google sign-in
matching that address would have linked to, were linking not restricted to
verified addresses. The code that would prove the claim lives for fifteen
minutes (ACCOUNT_EMAIL_VERIFICATION_BY_CODE_TIMEOUT), so after fifteen
minutes an unverified claim can never become anything else and is removed.

Secondary addresses only. A sign-up's own primary address is unverified
until the code is entered, and deleting it would delete the sign-up out
from under someone still reading their mail; that row is harmless in the
meantime because a second sign-up with the same address is answered like
an existing account and told by mail. An address from before the stamp
existed (accounts.EmailAddressAdded) has no timestamp and counts as old.

Meant to run every few minutes (docs/DEPLOY.md); running it more or less
often changes only how stale a claim can get, never what it does.
"""
from datetime import timedelta

from allauth.account.models import EmailAddress
from django.core.management.base import BaseCommand
from django.db.models import Q
from django.utils import timezone

from accounts.models import EmailAddressAdded


def stale(now=None):
    """The unverified secondary addresses the purge would delete, as a queryset."""
    cutoff = (now or timezone.now()) - timedelta(minutes=EmailAddressAdded.GRACE_MINUTES)
    return EmailAddress.objects.filter(verified=False, primary=False).filter(
        Q(added__at__lt=cutoff) | Q(added__isnull=True)
    )


class Command(BaseCommand):
    help = 'Delete unverified secondary email addresses older than fifteen minutes (docs/AUTH.md §6.6).'

    def add_arguments(self, parser):
        parser.add_argument('--dry-run', action='store_true', help='say what would go, and delete nothing')

    def handle(self, *args, dry_run=False, **options):
        rows = stale()
        n = rows.count()
        if dry_run:
            for row in rows.select_related('user'):
                self.stdout.write(f'  would delete {row.email} (on {row.user.email})')
            self.stdout.write(f'{n} stale unverified address{"" if n == 1 else "es"}; nothing deleted (--dry-run)')
            return
        rows.delete()
        self.stdout.write(f'deleted {n} stale unverified address{"" if n == 1 else "es"}')
