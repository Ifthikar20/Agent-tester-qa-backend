"""
The name an organisation goes by in a token, a URL and a directory.

The runner keeps each organisation's state under `.ghostclick/<slug>/` and
its suites under `suites/<slug>/` (docs/AUTH.md §10), so a slug has to be
something a filesystem and a URL both take without quoting: lowercase ASCII
letters, digits and single hyphens, and never a name a route already owns.

This module is imported by the data migration that backfills personal
organisations as well as by the models, so it stays pure: strings in,
strings out, no models.
"""
import re

SLUG = re.compile(r'^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$')

# Names that are routes, directories or words a slug would be confused with.
RESERVED = frozenset({
    'admin', 'api', 'app', 'auth', 'accounts', 'static', 'ws', 'healthz', 'go',
    'demo', 'org', 'orgs', 'me', 'new', 'null', 'none', 'undefined', 'ghostclick',
})


def is_slug(value):
    return bool(value) and bool(SLUG.match(value)) and value not in RESERVED


def personal_slug(email, taken):
    """
    A slug for the personal organisation of `email`, unlike anything in `taken`.

    The local part of the address, lowercased and reduced to slug characters;
    'ada.lovelace@acme.example' becomes 'ada-lovelace'. A clash — two people
    called ada at different companies — gets a numeric suffix rather than the
    domain, because the domain is the part of an address people do not expect
    to see published.
    """
    local = email.split('@', 1)[0].lower()
    base = re.sub(r'-{2,}', '-', re.sub(r'[^a-z0-9-]+', '-', local)).strip('-')[:40] or 'me'
    if base in RESERVED or not SLUG.match(base):
        base = f'{base}-org'
    candidate, n = base, 1
    while candidate in taken:
        n += 1
        candidate = f'{base}-{n}'
    return candidate
