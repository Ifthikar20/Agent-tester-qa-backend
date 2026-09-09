"""
The keypair executor tokens are signed with, and the two places it goes.

    python manage.py signing_key --new          generate one; print both halves
    python manage.py signing_key                the public half of the key in use
    python manage.py signing_key --new --json   the same, as one JSON object

The private key goes to the control plane's environment as GC_SIGNING_KEY.
The public key goes to the runner's as GC_AUTH_PUBLIC_KEYS, a JSON object of
{kid: pem}, and that object is the ONLY trust anchor the runner has: it does
not fetch /auth/jwks, so a control plane that has been taken over cannot talk
the runner into a new key (docs/AUTH.md §8 [token-3]).

Both are printed as one-line shell assignments, because that is the shape an
env file can hold: a PEM has newlines and a .env line cannot, so the newlines
are written as a literal backslash-n and turned back on the way in. Single
quotes, so that nothing in a shell or in compose expands anything.

Rotation is `--new`, add the new public key to the runner's set BESIDE the
old one, restart the runner, switch the control plane to the new private
key, and remove the old public key once every token signed with it has
expired — ten minutes, plus the clock skew the runner allows.
"""
import json

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from ...tokens import NoSigningKey, generate, kid_of, load_private, public_pem


def one_line(pem: str) -> str:
    """A PEM on one line, newlines written as the two characters backslash and n."""
    return pem.strip().replace('\n', '\\n')


class Command(BaseCommand):
    help = 'Generate the executor-token signing key, or print the public half of the one in use.'

    def add_arguments(self, parser):
        parser.add_argument('--new', action='store_true', help='generate a fresh Ed25519 keypair')
        parser.add_argument('--json', action='store_true',
                            help='print {kid, private_pem, public_pem, public_keys} for a script to read')

    def handle(self, *args, **opts):
        if opts['new']:
            private, public, kid = generate()
        else:
            try:
                key = load_private(settings.GC_SIGNING_KEY)
            except NoSigningKey as err:
                raise CommandError(f'{err}\n  --new generates one.')
            private, public, kid = None, public_pem(key), kid_of(key)

        public_keys = {kid: public}
        if opts['json']:
            self.stdout.write(json.dumps({
                'kid': kid, 'private_pem': private, 'public_pem': public, 'public_keys': public_keys,
            }))
            return

        self.stdout.write('')
        self.stdout.write(f'  kid  {kid}')
        if private is not None:
            self.stdout.write('')
            self.stdout.write('  # the control plane (auth/.env, or .env.prod). The private key: nowhere else.')
            self.stdout.write(f"  GC_SIGNING_KEY='{one_line(private)}'")
        self.stdout.write('')
        self.stdout.write('  # the runner. Public only; add a second entry beside it while rotating.')
        self.stdout.write(f"  GC_AUTH_PUBLIC_KEYS='{json.dumps(public_keys)}'")
        self.stdout.write('')
