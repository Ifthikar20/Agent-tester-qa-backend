"""
Make an account that can sign in, without a prompt.

    python manage.py adduser qa@example.com                  # generates one, prints it once
    printf '%s' "$PASS" | python manage.py adduser qa@example.com --password-stdin
    python manage.py adduser qa@example.com --reset-password
    python manage.py adduser --list

`createsuperuser` is still the right way to make a *person's* login: it asks, so
the password is chosen by whoever will type it and exists nowhere else. It is
the wrong way to make a *test* login, and not for a policy reason — it prompts,
a prompt needs a terminal, and over ssh there is not one. It dies on "the input
device is not a TTY" before it asks anything.

This is the non-interactive half. Three things it deliberately will not do:

  - Take the password as an argument. argv is readable by every account on the
    host through `ps`, and on your own machine it goes into shell history.
    Either this generates one and prints it once, or it reads one from stdin.
  - Make an admin by default. There is no RBAC yet — being able to sign in is
    already enough to drive every run — so a test account has no reason to also
    reach /admin/. `--staff` exists, and it is a thing you have to type.
  - Touch an account that already exists. `--reset-password` overwrites the
    password, and nothing else does. A script that silently rewrites a
    colleague's password is how a shared box locks out the person who set it up.

What has not changed: nothing runs this for you. `npm run app` still only says
that you have no account, for the reason in SETUP.md — a login on your machine
that you did not choose and do not know about is worse than no login at all.
"""
import secrets
import sys

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.core.validators import validate_email

User = get_user_model()

# 15 bytes of urandom as base64url: 20 characters, ~120 bits. Long enough that
# "is this password good enough" is not a question anyone has to weigh, short
# enough to retype off a terminal on the occasion that it has to be.
PASSWORD_BYTES = 15


class Command(BaseCommand):
    help = 'Create an account without prompting - for test users, and for hosts with no terminal.'

    def add_arguments(self, parser):
        parser.add_argument('email', nargs='?', help='the login; this model has no username')
        parser.add_argument('--name', default='', help='display name, shown in the UI')
        parser.add_argument('--password-stdin', action='store_true',
                            help='read the password from stdin instead of generating one')
        parser.add_argument('--reset-password', action='store_true',
                            help='the account may exist already; give it a new password')
        parser.add_argument('--staff', action='store_true', help='may also reach /admin/')
        parser.add_argument('--superuser', action='store_true', help='implies --staff')
        parser.add_argument('--list', action='store_true', help='print who has an account, and exit')

    def handle(self, *args, **opts):
        if opts['list']:
            return self.list_accounts()

        email = self.clean_email(opts['email'])
        password, generated = self.read_password(opts['password_stdin'], email)

        # Exact, not iexact: authenticate() looks the login up exactly, so an
        # account differing only in case is a different login, not this one.
        existing = User.objects.filter(email=email).first()
        if existing and not opts['reset_password']:
            raise CommandError(
                f'{email} already has an account, and nothing was changed.\n'
                f'  To give that account a new password:  --reset-password'
            )

        if existing:
            existing.set_password(password)
            existing.save(update_fields=['password'])
            user, made = existing, 'new password for'
        else:
            self.warn_about_near_duplicates(email)
            extra = {'name': opts['name']}
            if opts['superuser']:
                user = User.objects.create_superuser(email=email, password=password, **extra)
            else:
                if opts['staff']:
                    extra['is_staff'] = True
                user = User.objects.create_user(email=email, password=password, **extra)
            made = 'created'

        self.report(made, user, password, generated)

    # -- the parts ------------------------------------------------------------

    def clean_email(self, raw):
        if not raw:
            raise CommandError('which email? `manage.py adduser you@example.com` - email is the login here')
        email = User.objects.normalize_email((raw or '').strip())
        try:
            validate_email(email)
        except ValidationError:
            raise CommandError(f'{raw!r} is not an email address, and email is the login here')
        return email

    def read_password(self, from_stdin, email):
        if not from_stdin:
            return secrets.token_urlsafe(PASSWORD_BYTES), True

        # readline, not read: the newline `echo` adds is not part of the
        # password, and neither is anything after the first line.
        password = sys.stdin.readline().rstrip('\r\n')
        if not password:
            raise CommandError('--password-stdin was given, but nothing arrived on stdin')

        # An unsaved User so UserAttributeSimilarityValidator can compare the
        # password against the email it is about to belong to.
        try:
            validate_password(password, User(email=email))
        except ValidationError as err:
            raise CommandError(
                "that password does not pass this project's validators:\n"
                + '\n'.join(f'    - {m}' for m in err.messages)
                + '\n  Drop --password-stdin and a strong one will be generated instead.'
            )
        return password, False

    def warn_about_near_duplicates(self, email):
        # normalize_email lowercases the domain and leaves the local part alone,
        # because the spec says the local part is case-sensitive - and
        # authenticate() matches exactly. So Ada@x.com and ada@x.com are two
        # accounts with two passwords, which on a shared box reads to whoever
        # hits it as "my password stopped working".
        clash = User.objects.filter(email__iexact=email).exclude(email=email).first()
        if clash:
            self.stderr.write(
                f'  ! {clash.email} already exists and differs only in case.\n'
                f'    These are two separate logins with two separate passwords.'
            )

    def report(self, made, user, password, generated):
        self.stdout.write('')
        self.stdout.write(f'  {made} {user.email}')
        if generated:
            self.stdout.write(f'    password   {password}')
            self.stdout.write('               shown once - only a hash is stored, so nothing can print it again')
        else:
            self.stdout.write('    password   the one you piped in')
        self.stdout.write(f'    admin      {"yes - /admin/ is open to it" if user.is_staff else "no"}')
        self.stdout.write("    sign in    with that email on the app's login page")
        self.stdout.write('')

    def list_accounts(self):
        users = list(User.objects.all())
        if not users:
            self.stdout.write('\n  no accounts yet - `manage.py adduser you@example.com` makes one\n')
            return
        self.stdout.write('')
        for u in users:
            flags = ' '.join(f for f, on in [
                ('staff', u.is_staff), ('superuser', u.is_superuser), ('INACTIVE', not u.is_active),
            ] if on)
            self.stdout.write(f'  {u.email:<36} {flags}'.rstrip())
        self.stdout.write(f'\n  {len(users)} account{"" if len(users) == 1 else "s"}\n')
