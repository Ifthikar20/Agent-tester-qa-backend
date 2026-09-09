"""
Cloudflare Turnstile, for the two endpoints a script would otherwise hammer.

Per-IP rate limits do not stop credential stuffing: a campaign that makes one
guess per address per minute from ten thousand addresses is under every
limit and still a campaign [credentials-1]. So, once an address has tripped
the failed-login limit, that address has to present a Turnstile token with
every sign-in for an hour; and in open sign-up mode every sign-up does. Both
only when GC_TURNSTILE_SECRET is configured — a laptop has no Cloudflare and
asks for nothing.

The demand is a cache entry keyed on the client address as the edge reports
it (accounts.events.client_ip). It counts in the same shared cache the rate
limits do, so a demand made by one gunicorn worker binds the others.
"""
import json
import logging
import urllib.error
import urllib.parse
import urllib.request

from django.conf import settings
from django.core.cache import cache

from .ratelimit import parse

log = logging.getLogger(__name__)

VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
# Django's own failed-login counter per address, kept beside allauth's
# limiter rather than read from it: allauth's answer is "refused or not",
# and what is needed here is "how many so far".
FAILURES = 'gc:login_failed_ip:{ip}'
DEMAND = 'gc:turnstile:{ip}'


def enabled():
    return bool(getattr(settings, 'GC_TURNSTILE_SECRET', ''))


def site_key():
    """The public half, for the SPA to render the widget with; None when off."""
    return getattr(settings, 'GC_TURNSTILE_SITE_KEY', '') or None


def per_ip_limit():
    """(count, seconds) of the per-IP part of ACCOUNT_RATE_LIMITS['login_failed']."""
    rates = str(settings.ACCOUNT_RATE_LIMITS.get('login_failed', '10/m/ip')).split(',')
    for rate in rates:
        rate = rate.strip()
        if rate.endswith('/ip') or rate.count('/') == 1:
            return parse(rate)
    return parse(rates[0])


def login_failed(ip):
    """
    Count one failed sign-in from `ip`. When the count reaches the per-IP
    limit inside its window, the address is put under Turnstile for an hour.
    Returns True the moment that happens, so the caller can log it.
    """
    if not ip:
        return False
    limit, seconds = per_ip_limit()
    key = FAILURES.format(ip=ip)
    cache.add(key, 0, seconds)
    try:
        n = cache.incr(key)
    except ValueError:
        cache.set(key, 1, seconds)
        n = 1
    if n >= limit and not demanded(ip):
        demand(ip)
        return True
    return False


def demand(ip):
    cache.set(DEMAND.format(ip=ip), 1, getattr(settings, 'GC_TURNSTILE_HOURS', 1) * 3600)


def demanded(ip):
    return bool(ip) and bool(cache.get(DEMAND.format(ip=ip)))


def required_for(action, ip):
    """Must a request from `ip` carry a token for `action` ('login' or 'signup')?"""
    if not enabled():
        return False
    if action == 'signup':
        return getattr(settings, 'GC_SIGNUP_MODE', 'invite') == 'open'
    if action == 'login':
        return demanded(ip)
    return False


def verify(token, ip=None):
    """
    Ask Cloudflare whether `token` is a solved challenge. False on anything
    but a clear yes: a network failure is not a reason to let a script in,
    and the person can try the widget again.
    """
    if not token or not isinstance(token, str) or len(token) > 2048:
        return False
    body = {'secret': settings.GC_TURNSTILE_SECRET, 'response': token}
    if ip:
        body['remoteip'] = ip
    data = urllib.parse.urlencode(body).encode('ascii')
    try:
        with urllib.request.urlopen(urllib.request.Request(VERIFY_URL, data=data), timeout=5) as resp:  # noqa: S310
            answer = json.loads(resp.read().decode('utf-8'))
    except (urllib.error.URLError, ValueError, OSError) as err:
        log.warning('turnstile verification failed: %s', err)
        return False
    return answer.get('success') is True
