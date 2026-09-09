"""
Print a key for GC_MFA_KEY.

    python manage.py mfa_key            # a line to paste into .env.prod
    python manage.py mfa_key --json     # for a script (scripts/app.js)

A Fernet key: 32 random bytes, url-safe base64. It encrypts TOTP secrets and
recovery-code seeds at rest (accounts.adapters.MFAAdapter) and is not
DJANGO_SECRET_KEY on purpose [ops-supply-2]. To rotate, put the new key
FIRST and the old one after it, comma-separated: the first encrypts, every
one decrypts, and the old one can be dropped once every row has been
written again — which happens when an authenticator is re-enrolled, so a
rotation without re-enrolment keeps both keys.
"""
import json

from cryptography.fernet import Fernet
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = 'Print a fresh key for GC_MFA_KEY, the key second-factor secrets are encrypted with.'

    def add_arguments(self, parser):
        parser.add_argument('--json', action='store_true', help='print {"mfa_key": ...} for a script')

    def handle(self, *args, **opts):
        key = Fernet.generate_key().decode('ascii')
        if opts['json']:
            self.stdout.write(json.dumps({'mfa_key': key}))
            return
        self.stdout.write('')
        self.stdout.write('  the key second-factor secrets are encrypted with — the control plane, and nowhere else:')
        self.stdout.write('')
        self.stdout.write(f'GC_MFA_KEY={key}')
        self.stdout.write('')
        self.stdout.write('  To rotate: GC_MFA_KEY=<new>,<old> until every authenticator has been re-enrolled.')
        self.stdout.write('')
