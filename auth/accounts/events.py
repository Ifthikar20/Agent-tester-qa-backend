"""
The audit trail, written by Django's and allauth's own signals.

Every sign-in, sign-out and refused password lands in AuthEvent whether it
came through the SPA, the admin, or a flow that has not been written yet:
the receivers hang off django.contrib.auth's signals, which every login path
in Django fires, so a new view cannot forget to log. allauth's signals do
the same for the account's own life — sign-up, verification, the password
and email changes, reauthentication — and each of those carries the rule
docs/AUTH.md attaches to it: a verification consumes the invitation, a reset
ends every session, an email change keeps the old address as a reset
identifier for a week.

The same receivers keep the session's list of authentication events, which
is what the executor token's amr, auth_time and su are computed from — never
from a flag a view set [mfa-recovery-2].
"""
import time
from datetime import timedelta

from allauth.account import signals as allauth_signals
from django.conf import settings
from django.contrib.auth.signals import user_logged_in, user_logged_out, user_login_failed
from django.dispatch import receiver
from django.utils import timezone

from .models import AuthEvent, PreviousEmail

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
# Set on the session when the password that signed it in is in a breach
# corpus; read by accounts.middleware.PasswordChangeRequired.
PWNED = 'gc_password_pwned'

# allauth's names for how someone proved who they were, in the vocabulary
# the token uses (docs/AUTH.md §5.3). A method with no entry is not a
# factor and is not written down.
METHODS = {
    'password': 'password',
    'totp': 'otp',
    'recovery_codes': 'recovery',
    'webauthn': 'webauthn',
    'socialaccount': 'google',
}


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


def user_agent(request):
    return (request.META.get('HTTP_USER_AGENT', '') if request is not None else '')[:512]


def record(kind, request=None, *, user=None, email='', **detail):
    """Write one AuthEvent for `kind`, with whatever the request can say about who."""
    return AuthEvent.objects.create(
        kind=kind,
        user=user if (user is not None and getattr(user, 'pk', None)) else None,
        email=(email or getattr(user, 'email', '') or '')[:254],
        ip=client_ip(request) if request is not None else None,
        user_agent=user_agent(request),
        detail=detail,
    )


# ---------------------------------------------------------------- the session's events

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


@receiver(allauth_signals.authentication_step_completed)
def proved(sender, request, user, method, **kwargs):
    """
    One factor was used — at sign-in or at a reauthentication; allauth fires
    the same signal for both, which is exactly why it is the one listened
    to. The method is written in the token's vocabulary; a reauthentication
    is also a row in the log, because "this cookie proved the password again
    at 14:02" is the sentence a later audit needs [mfa-recovery-2].
    """
    if request is None or not hasattr(request, 'session'):
        return
    name = METHODS.get(kwargs.get('type') or method)
    if name is None:
        return
    note(request, name)
    if kwargs.get('reauthenticated'):
        record(AuthEvent.Kind.REAUTHENTICATION, request, user=user, method=name)


# ---------------------------------------------------------------- sign-in and out

@receiver(user_logged_in)
def started(sender, request, user, **kwargs):
    """
    Stamp when this session began — once — and notice an unfamiliar device.

    setdefault, not assignment: Django's login() keeps the session data when
    the same user signs in again, and a later "connect Google" or a
    reauthentication also fires this signal. If any of those reset the stamp,
    the seven-day absolute lifetime would restart every time the user proved
    who they were, which is to say it would not be absolute.
    """
    if request is not None and hasattr(request, 'session'):
        request.session.setdefault(LOGIN_AT, int(time.time()))
        new_device(request, user)
    record(AuthEvent.Kind.LOGIN, request, user=user)


def new_device(request, user):
    """
    Mail the account when the (address, user agent) pair has not signed in
    before (docs/AUTH.md §5.6). Not on the account's first sign-in ever: the
    person has just verified the address, or just been handed the password
    by an operator, and "a new device signed in" is news to nobody.
    """
    ip, agent = client_ip(request), user_agent(request)
    seen = AuthEvent.objects.filter(kind=AuthEvent.Kind.LOGIN, user=user)
    if not seen.exists() or seen.filter(ip=ip, user_agent=agent).exists():
        return
    from . import mailer
    mailer.send('account/email/new_device', user.email, {
        'user': user, 'ip': ip or 'unknown', 'user_agent': agent or 'unknown', 'timestamp': timezone.now(),
    })
    record(AuthEvent.Kind.NEW_DEVICE, request, user=user)


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
    if request is not None:
        from . import turnstile
        ip = client_ip(request)
        if turnstile.enabled() and turnstile.login_failed(ip):
            record(AuthEvent.Kind.TURNSTILE_DEMANDED, request, email=str(typed))


# ---------------------------------------------------------------- the account's life

@receiver(allauth_signals.user_signed_up)
def signed_up(sender, request, user, **kwargs):
    record(AuthEvent.Kind.SIGNUP, request, user=user, mode=getattr(settings, 'GC_SIGNUP_MODE', 'invite'))


@receiver(allauth_signals.email_confirmed)
def verified(sender, request, email_address, **kwargs):
    """
    The address is proven. Now — and not before — an invitation bound to it
    becomes a membership [credentials-6]; an unverified sign-up neither burned
    the invitation nor gained anything. The personal organisation already
    exists (tenants.personal makes one for every account row), so this is
    the only thing verification has to add.
    """
    user = email_address.user
    record(AuthEvent.Kind.EMAIL_VERIFIED, request, user=user, email=email_address.email)
    from tenants import invitations
    invitations.accept_pending(user, request, email=email_address.email)


@receiver(allauth_signals.password_changed)
def password_changed(sender, request, user, **kwargs):
    from .sessions import flush_all
    # allauth ends the session that made the change (LOGOUT_ON_PASSWORD_CHANGE);
    # the others go here. A stolen cookie does not survive its owner
    # noticing.
    gone = flush_all(user)
    record(AuthEvent.Kind.PASSWORD_CHANGED, request, user=user, sessions_ended=gone)


@receiver(allauth_signals.password_reset)
def password_reset(sender, request, user, **kwargs):
    from .sessions import flush_all
    # Every session, including whichever one the thief is holding; the
    # reset itself did not sign anyone in (LOGIN_ON_PASSWORD_RESET is off),
    # and authenticators survive, so the mailbox alone still is not enough
    # to get in [mfa-recovery-3].
    gone = flush_all(user)
    record(AuthEvent.Kind.PASSWORD_RESET, request, user=user, sessions_ended=gone)


@receiver(allauth_signals.email_changed)
def email_changed(sender, request, user, from_email_address, to_email_address, **kwargs):
    """
    allauth has already mailed the old address (EMAIL_NOTIFICATIONS). What
    it does not do is remember the old address, and for seven days that
    address must still be able to ask for a password reset for this account,
    or an email change is the last thing a thief needs [mfa-recovery-3].
    """
    if from_email_address is None or from_email_address.email.lower() == to_email_address.email.lower():
        return
    PreviousEmail.objects.create(
        user=user, email=from_email_address.email, replaced_by=to_email_address.email,
        until=timezone.now() + timedelta(days=PreviousEmail.GRACE_DAYS),
    )
    record(AuthEvent.Kind.EMAIL_CHANGED, request, user=user,
           previous=from_email_address.email, current=to_email_address.email)
