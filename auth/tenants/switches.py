"""
What can be switched off, and whether it is.

A switch turns one feature off for everybody at once: sign-up closed tonight,
recording stopped while a runner bug is chased, without shipping a build. It
is not an entitlement. A plan says what one organisation may do; a switch
says what this deployment does at all, and a feature that is switched off is
off on every plan.

The catalogue is shared with the runner, which keeps the same nine keys in
../switches.js and enforces the `runner.*` half itself. A test reads that file
and fails when the two lists differ, because a key one side knows and the
other does not is a switch that does nothing where it matters.

Two places turn a switch off, and either is enough:

  GC_SWITCHES_OFF   the environment, which both services read from the same
                    line: keys, the service names `runner` and `control`, or
                    `*` for every switch there is. Anything else refuses to
                    start (config/settings.py): a typo that silently left a
                    feature on is the one failure an off-switch must not have.
  tenants.Switch    a row per key, from the admin, for the change that cannot
                    wait for a restart. No row is on. The runner never reads
                    this database, so the `runner.*` rows reach it in the
                    executor token's `off` claim, and saving or deleting a row
                    re-versions every organisation so that tokens minted
                    before the change go stale (tenants.models).

The environment wins. A row cannot turn back on what GC_SWITCHES_OFF turned
off, because the environment is where an operator who cannot reach the admin,
or does not trust it, says so.

Signing in with a password, signing out, the second factor and the admin are
not in the catalogue and never will be: they are how an operator gets in to
turn a switch back on.

No model is imported at the top, so config/settings.py can parse
GC_SWITCHES_OFF with this module before any app is loaded.
"""
from accounts import logs

CATALOGUE = {
    'runner.recording': 'teach mode (recording a flow)',
    'runner.runs': 'running scripts and suites',
    'runner.onboarding': 'creating suites, pages and page scans',
    'runner.origins': 'allowing or removing origins',
    'runner.driving': 'opening URLs and driving the page from the console',
    'control.signup': 'self-service sign-up (including sign-up through Google)',
    'control.invitations': 'issuing and accepting invitations',
    'control.google': 'Google sign-in',
    'control.passkeys': 'passkey (WebAuthn) sign-in',
}
KEYS = tuple(CATALOGUE)
SERVICES = ('runner', 'control')
EVERY = '*'

# Where one request keeps the Switch rows it read (accounts.logs.REQUEST), so
# the four answers /auth/config gives cannot disagree with each other, and a
# request pays for the table once however many switches it asks about.
MEMO = 'switches_off'

HELP = (
    'What each key guards — '
    + '; '.join(f'{key}: {what}' for key, what in CATALOGUE.items())
    + '. A key named in GC_SWITCHES_OFF is off whatever its row says: the environment wins.'
)


def choices():
    return [(key, f'{key} — {what}') for key, what in CATALOGUE.items()]


def sentence(key):
    """The words a refusal says: 'Google sign-in is switched off.'"""
    what = CATALOGUE[key]
    return f'{what[0].upper()}{what[1:]} is switched off.'


def parse(value):
    """
    GC_SWITCHES_OFF, as the sorted list of keys it turns off.

    Entries are separated by commas and trimmed, and an empty one is nothing
    (a trailing comma is not a typo worth refusing a start over). Every other
    entry must be a key, a service name or `*`, exactly: ValueError names the
    entry and every word that would have been accepted.
    """
    off = set()
    for raw in str(value or '').split(','):
        entry = raw.strip()
        if not entry:
            continue
        if entry == EVERY:
            off.update(KEYS)
        elif entry in SERVICES:
            off.update(key for key in KEYS if key.startswith(f'{entry}.'))
        elif entry in CATALOGUE:
            off.add(entry)
        else:
            raise ValueError(
                f'GC_SWITCHES_OFF holds {entry!r}, which is not a switch. It takes, comma-separated, '
                f'any of: {", ".join((EVERY, *SERVICES, *KEYS))}.'
            )
    return sorted(off)


def env_off():
    """The keys the environment turned off (settings.GC_SWITCHES_OFF, parsed at import)."""
    from django.conf import settings
    return frozenset(getattr(settings, 'GC_SWITCHES_OFF', ()))


def db_off():
    """
    The keys a Switch row turns off, read once per request.

    Per request and not for a few seconds per process: a process-wide copy
    outlives the transaction it was read in, so a row saved and rolled back —
    or a test's row, undone between tests — would go on switching a feature
    off for whoever came next. Outside a request (a shell, a command) there is
    nothing to keep it in, and every call reads the table.
    """
    context = logs.current()
    if context is not None and MEMO in context:
        return context[MEMO]
    from django.apps import apps
    rows = apps.get_model('tenants', 'Switch').objects.filter(enabled=False)
    off = frozenset(rows.values_list('key', flat=True))
    if context is not None:
        context[MEMO] = off
    return off


def forget():
    """Drop this request's copy of the rows, after one of them changed."""
    context = logs.current()
    if context is not None:
        context.pop(MEMO, None)


def off_keys():
    """Every key that is off, from either place, sorted. A row for a key the catalogue no longer has is ignored."""
    return sorted((env_off() | db_off()) & frozenset(KEYS))


def is_on(key):
    """Is `key` on? A key the catalogue does not have is a programming error, not a feature that is on."""
    if key not in CATALOGUE:
        raise KeyError(f'{key!r} is not a switch; the catalogue is {", ".join(KEYS)}')
    return key not in off_keys()


def runner_off():
    """The `runner.*` keys that are off: the executor token's `off` claim."""
    return [key for key in off_keys() if key.startswith('runner.')]


def flags():
    """Every key, and whether it is on: the `flags` of /auth/me."""
    off = frozenset(off_keys())
    return {key: key not in off for key in KEYS}
