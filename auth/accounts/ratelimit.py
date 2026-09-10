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

Every counter is a Redis key that expires with its window, so the number of
keys is the number of clients seen in the last window times the limits they
touched — and the request limit (accounts.middleware.RequestRateLimit) touches
one or two for EVERY client, so a flood from many addresses is, precisely,
many keys. The short windows are what keep that set small. What happens when
it is not small anyway is Redis's `maxmemory-policy`: under `noeviction`, its
default, a full Redis refuses writes and every request that counts fails with
it; under `allkeys-lru` it forgets the least recently used counters, which is
a limit briefly forgiven. The latter is the one to run, and `volatile-lru` is
not a substitute: Django's incr is EXISTS then INCR, and a key that expires
between the two comes back from INCR with no expiry at all, which only an
allkeys policy will ever evict.
"""
import math
import re
import time

from django.core.cache import cache

UNITS = {'s': 1, 'm': 60, 'h': 3600, 'd': 86400}
RATE = re.compile(r'^(\d+)/(\d*)([smhd])(?:/\w+)?$')
# How long a clock-aligned counter outlives its window: enough for gunicorn
# workers whose clocks disagree by a second or two to count in the same key.
SLACK = 5


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


def window(name, key, rate, now=None):
    """
    The same count in a window the CLOCK starts, as (past, left): how far past
    the rate this attempt went, as `count` says it, and how many whole seconds
    the window has left, at least one.

    `count`'s window begins with its first attempt, a moment nothing writes
    down, so nobody can say when it ends. The request limit has to: its 429
    carries Retry-After, which is a promise about exactly that. A window
    aligned to the clock ends at the next multiple of its length, which is
    arithmetic rather than a second key per client. The key names its window,
    so it is never reset, only left to expire a little after the window has.
    """
    limit, seconds = parse(rate)
    now = time.time() if now is None else now
    index = int(now // seconds)
    left = max(1, math.ceil((index + 1) * seconds - now))
    ck = f'gc:rl:{name}:{key}:{index}'
    cache.add(ck, 0, left + SLACK)
    try:
        n = cache.incr(ck)
    except ValueError:
        cache.set(ck, 1, left + SLACK)
        n = 1
    return max(0, n - limit), left
