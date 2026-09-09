"""
A counter in the shared cache, which is what a rate limit is.

Written here because django-allauth, whose limiter the accounts flow will
use for its own endpoints, is not installed yet and the invitation endpoint
needs one now. The rate syntax is allauth's — '10/m/ip', '12/10m' — so the
numbers in settings read the same whichever limiter enforces them. The
scope suffix ('ip', 'key') is documentation for the caller, who chooses the
key; nothing here reads it.

It counts in CACHES['default'], which in production is Redis and refused to
be anything else (config/settings.py): a per-process counter is a rate limit
per gunicorn worker, which is to say none.
"""
import re

from django.core.cache import cache

UNITS = {'s': 1, 'm': 60, 'h': 3600, 'd': 86400}
RATE = re.compile(r'^(\d+)/(\d*)([smhd])(?:/\w+)?$')


def parse(rate):
    """'10/m/ip' -> (10, 60). '12/10m' -> (12, 600)."""
    m = RATE.match(str(rate).strip())
    if not m:
        raise ValueError(f'unreadable rate {rate!r}; expected e.g. 10/m/ip or 12/10m')
    count, n, unit = m.groups()
    return int(count), int(n or 1) * UNITS[unit]


def over(name, key, rate):
    """
    Count one attempt against `key` and say whether it went past `rate`.

    Fixed windows: the count starts when the first attempt in a window is
    made and resets when the window ends. That lets a burst of 2N straddle a
    boundary, which is fine for what this protects — a guess at an invitation
    token is worth one in 2^256 either way — and costs one cache call.
    """
    limit, seconds = parse(rate)
    ck = f'gc:rl:{name}:{key}'
    cache.add(ck, 0, seconds)
    try:
        n = cache.incr(ck)
    except ValueError:
        # The key expired between add and incr; this attempt opens a window.
        cache.set(ck, 1, seconds)
        n = 1
    return n > limit
