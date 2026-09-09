"""
Three rules that sit between the session and every view.

AbsoluteSessionLifetime — the clock that does not slide. Django's session
expiry pushes twelve hours past every request, which is right for a person
and wrong for a stolen cookie, which the thief simply keeps using. The
receiver in accounts.events writes the sign-in time into the session once;
this reads it and, past GC_SESSION_ABSOLUTE_SECONDS, flushes the session and
answers 401 so the SPA sends the person back to sign in.

PasswordChangeRequired — a sign-in whose password Have I Been Pwned knows
(AccountAdapter.check_presented_password) may do exactly one thing: change
it. Everything else answers 403 {error: 'password_change_required'} until
the change ends the session [credentials-1].

CsrfTokenHeader — Django rotates the CSRF token on sign-in and sign-out,
which allauth's JSON answers do not mention. On a laptop the SPA is on
another origin and cannot read the cookie, so the value it must echo next
rides back in a header on every answer from this service.
"""
import time

from django.conf import settings
from django.contrib.auth import SESSION_KEY
from django.http import JsonResponse
from django.middleware.csrf import get_token

from .events import LOGIN_AT, PWNED, record
from .models import AuthEvent


class AbsoluteSessionLifetime:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        # The session key, not request.user: touching the lazy user costs a
        # query on every request, and an anonymous session has nothing to
        # expire.
        session = getattr(request, 'session', None)
        if session is not None and SESSION_KEY in session:
            began = session.get(LOGIN_AT)
            now = int(time.time())
            if began is None:
                # A session from before this rule existed. Its start is
                # unknown, so the clock starts now rather than never.
                session[LOGIN_AT] = now
            elif now - int(began) > settings.GC_SESSION_ABSOLUTE_SECONDS:
                record(AuthEvent.Kind.SESSION_EXPIRED, request, user=request.user, began=int(began))
                session.flush()
                return JsonResponse({'error': 'session_expired'}, status=401)
        return self.get_response(request)


class PasswordChangeRequired:
    """
    What a marked session may still reach: the change itself, the answer to
    "who am I" (so the SPA can draw the page that says why), the session
    endpoints (so signing out is always possible), reauthentication (the
    change asks for the current password, not this, but a stale session
    should not be stuck), and the CSRF token. Nothing that mints, invites,
    or switches organisation.
    """
    ALLOWED = (
        '/_allauth/browser/v1/account/password/change',
        '/_allauth/browser/v1/auth/session',
        '/_allauth/browser/v1/auth/reauthenticate',
        '/_allauth/browser/v1/config',
        '/auth/me',
        '/auth/csrf',
        '/auth/config',
    )

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        session = getattr(request, 'session', None)
        if session is not None and SESSION_KEY in session and session.get(PWNED):
            if request.path not in self.ALLOWED:
                return JsonResponse({'error': 'password_change_required'}, status=403)
        return self.get_response(request)


class CsrfTokenHeader:
    PREFIXES = ('/auth/', '/_allauth/')

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        if request.path.startswith(self.PREFIXES) and 'CSRF_COOKIE' in request.META:
            # get_token masks the secret freshly each call, so the header is
            # never byte-equal to the cookie — which is also why the SPA
            # compares nothing and simply echoes it.
            response['X-CSRFToken'] = get_token(request)
        return response
