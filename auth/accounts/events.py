"""
The audit trail, written by Django's own signals.

Every sign-in, sign-out and refused password lands in AuthEvent whether it came
through /auth/login, the admin, or a flow that has not been written yet: the
receivers hang off django.contrib.auth's signals, which every login path in
Django fires, so a new view cannot forget to log. The same receiver also
starts the absolute session clock — see `started`.
"""
import time

from django.conf import settings
from django.contrib.auth.signals import user_logged_in, user_logged_out, user_login_failed
from django.dispatch import receiver

from .models import AuthEvent

# The session key under which the sign-in time is kept. Read by
# accounts.middleware.AbsoluteSessionLifetime.
LOGIN_AT = 'gc_login_at'
# The session key under which the authentication events are kept: a list of
# {method, at}, appended by the receivers below (docs/AUTH.md §5.3). The
# token's amr, auth_time and su are computed from this list and from nothing
# else — never from a flag a view set, because a flag is a thing a later view
# can forget to clear [mfa-recovery-2].
AUTH_EVENTS = 'gc_auth_events'
# Enough to hold a working day of reauthentications; the token only ever
# needs the most recent of each kind.
MAX_EVENTS = 20


def client_ip(request):
    """
    The client's address as the edge reports it.

    X-Forwarded-For is only meaningful for the entries a trusted proxy wrote.
    Caddy REPLACES the header with the address it accepted the connection
    from, so with ALLAUTH_TRUSTED_PROXY_COUNT = 1 the last entry is the client
    and a client that sends its own X-Forwarded-For cannot move it — its
    forgery is overwritten before this process sees it. With no proxy the
    header is a lie by definition and the peer address is the client.

    Same arithmetic as django-allauth's, so the address a rate limit is keyed
    on and the address the audit row records are the same address.
    """
    trusted = getattr(settings, 'ALLAUTH_TRUSTED_PROXY_COUNT', 0)
    forwarded = request.META.get('HTTP_X_FORWARDED_FOR', '')
    if trusted > 0 and forwarded:
        hops = [h.strip() for h in forwarded.split(',')]
        if len(hops) >= trusted:
            return hops[-trusted] or None
    return request.META.get('REMOTE_ADDR') or None


def record(kind, request=None, *, user=None, email='', **detail):
    """Write one AuthEvent for `kind`, with whatever the request can say about who."""
    return AuthEvent.objects.create(
        kind=kind,
        user=user if (user is not None and getattr(user, 'pk', None)) else None,
        email=(email or getattr(user, 'email', '') or '')[:254],
        ip=client_ip(request) if request is not None else None,
        user_agent=(request.META.get('HTTP_USER_AGENT', '') if request is not None else '')[:512],
        detail=detail,
    )


@receiver(user_logged_in)
def started(sender, request, user, **kwargs):
    """
    Stamp when this session began — once.

    setdefault, not assignment: Django's login() keeps the session data when
    the same user signs in again, and a later "connect Google" or a
    reauthentication also fires this signal. If any of those reset the stamp,
    the seven-day absolute lifetime would restart every time the user proved
    who they were, which is to say it would not be absolute.
    """
    if request is not None and hasattr(request, 'session'):
        request.session.setdefault(LOGIN_AT, int(time.time()))
        # Every login path that exists today is a password. When allauth
        # arrives, its own signals say which method was used (otp, recovery,
        # webauthn, google) and the mfa flow appends those; this receiver
        # stays the one that records a plain password sign-in.
        note(request, 'password')
    record(AuthEvent.Kind.LOGIN, request, user=user)


def note(request, method):
    """Append one authentication event to the session, newest last."""
    events = [e for e in request.session.get(AUTH_EVENTS, []) if isinstance(e, dict)]
    events.append({'method': str(method), 'at': int(time.time())})
    request.session[AUTH_EVENTS] = events[-MAX_EVENTS:]


def auth_events(request):
    """The session's authentication events, oldest first, as {method, at}."""
    session = getattr(request, 'session', None)
    if session is None:
        return []
    out = []
    for e in session.get(AUTH_EVENTS, []):
        if isinstance(e, dict) and e.get('method') and isinstance(e.get('at'), int):
            out.append({'method': str(e['method']), 'at': e['at']})
    return out


@receiver(user_logged_out)
def ended(sender, request, user, **kwargs):
    record(AuthEvent.Kind.LOGOUT, request, user=user)


@receiver(user_login_failed)
def refused(sender, credentials, request, **kwargs):
    # The address as typed, and no lookup of whether it exists: the row is for
    # counting attempts against an account, and the table should not need a
    # join to say which one.
    typed = credentials.get('username') or credentials.get('email') or ''
    record(AuthEvent.Kind.LOGIN_FAILED, request, email=str(typed))
