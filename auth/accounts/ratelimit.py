"""
A counter in the shared cache, which is what a rate limit is.

django-allauth's own limiter guards allauth's endpoints; this one guards
ours (minting, invitation acceptance) and the Turnstile failure count, and
it stays small on purpose — allauth's needs a request marked as headless to
answer a 429 in the right shape, and ours are plain JSON views. The rate
syntax is allauth's — '10/m/ip', '12/10m' — so the numbers in settings read
the same whichever limiter enforces them. The scope suffix ('ip', 'key') is
documentation for the caller, who chooses the key; nothing here reads it.

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
    return count(name, key, rate) > 0


def count(name, key, rate):
    """
    The same count, as a number: 0 while within the rate, and 1 for the FIRST
    attempt past it, 2 for the second, and so on.

    `over` cannot tell those apart, and a caller that writes an audit row on
    every refusal therefore does unbounded work past the limit — which is the
    opposite of what a limiter is for. A caller that wants one row per window
    asks for the first.
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
    return max(0, n - limit)
