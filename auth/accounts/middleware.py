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

MfaRequired — the second-factor policy, applied to the session and not to
the mint (docs/AUTH.md §5.4) [mfa-recovery-1]. An account the policy names
(accounts/mfa.py: staff, owner or admin of an organisation, a plan that
says mfa.required, or no usable password) that holds no authenticator may
reach the enrolment endpoints, the session endpoints, reauthentication and
"who am I", and nothing else: 403 {error: 'mfa_required'}.

StaffMFARequired — the same rule for /admin/, which is HTML: a staff
session without an authenticator is redirected to the SPA's enrolment page
rather than answered with JSON it cannot draw.

StrongReauthentication — an account that holds an authenticator changes
nothing sensitive on the strength of its password alone (§7.2): the
password change, the email change, every authenticator change and the
recovery codes want a second-factor proof within the reauthentication
window, and a password reauthentication is refused outright with the
mfa_reauthenticate flow pending — so the password can never become the
proof that removes the second factor [mfa-recovery-2].

CsrfTokenHeader — Django rotates the CSRF token on sign-in and sign-out,
which allauth's JSON answers do not mention. On a laptop the SPA is on
another origin and cannot read the cookie, so the value it must echo next
rides back in a header on every answer from this service.
"""
import time

from django.conf import settings
from django.contrib.auth import SESSION_KEY
from django.http import HttpResponseRedirect, JsonResponse
from django.middleware.csrf import get_token

from .events import LOGIN_AT, PWNED, record
from .models import AuthEvent

HEADLESS = '/_allauth/browser/v1/'


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


class MfaRequired:
    """
    What an account that must enrol may still reach: the enrolment
    endpoints themselves (and listing what it holds), the session endpoints
    (signing out, and the "what is pending" the SPA boots from), every kind
    of reauthentication (enrolment asks for one), the password change (a
    breached password is changed first, and the password is this account's
    strongest factor until it enrols), the Google callback and redirect (a
    Google-only account arrives through them and must be able to finish),
    "who am I" and the two read-only helpers. /admin/ is StaffMFARequired's
    to answer, in HTML; /static/ is not a thing an account does.
    """
    ALLOWED = (
        '/auth/me',
        '/auth/csrf',
        '/auth/config',
        '/auth/jwks',
        f'{HEADLESS}config',
        f'{HEADLESS}auth/session',
        f'{HEADLESS}auth/reauthenticate',
        f'{HEADLESS}auth/2fa/reauthenticate',
        f'{HEADLESS}auth/webauthn/reauthenticate',
        f'{HEADLESS}auth/provider/redirect',
        f'{HEADLESS}account/password/change',
        '/accounts/google/login/callback/',
    )
    ALLOWED_PREFIXES = (
        f'{HEADLESS}account/authenticators',
        '/admin/',
        '/static/',
    )

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        session = getattr(request, 'session', None)
        if session is not None and SESSION_KEY in session and request.user.is_authenticated:
            path = request.path
            if path not in self.ALLOWED and not path.startswith(self.ALLOWED_PREFIXES):
                from . import mfa
                if mfa.blocked(request.user):
                    return JsonResponse({'error': 'mfa_required'}, status=403)
        return self.get_response(request)


class StaffMFARequired:
    """
    /admin/ for a staff account with no authenticator is the SPA's
    enrolment page. The admin is the one HTML surface this service has,
    and a 302 to where the person can fix it beats a JSON 403 the browser
    would print as text. A non-staff session is left to the admin itself,
    which sends it to the app's sign-in like any other visitor.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path.startswith('/admin/') and request.user.is_authenticated and request.user.is_staff:
            from . import mfa
            if not mfa.enrolled(request.user):
                return HttpResponseRedirect(f'{settings.GC_APP_URL}/security/mfa')
        return self.get_response(request)


class StrongReauthentication:
    """
    The changes that want a fresh proof, and for an account holding an
    authenticator the proof has to be the authenticator. allauth checks
    "did anything prove this session recently"; this runs first and asks
    "did a second factor". A password proof is refused before the password
    is even checked, so the answer is the same however many times it is
    tried and no hasher time is spent finding out.

    The refusal is allauth's own 401 shape with the mfa_reauthenticate
    flow marked pending — and only that flow, because for this account the
    password flow is not one that would work.
    """
    SENSITIVE = {
        f'{HEADLESS}account/password/change': ('POST',),
        f'{HEADLESS}account/email': ('POST', 'PUT', 'PATCH', 'DELETE'),
        f'{HEADLESS}account/providers': ('DELETE',),
        f'{HEADLESS}account/authenticators/totp': ('GET', 'POST', 'DELETE'),
        f'{HEADLESS}account/authenticators/recovery-codes': ('GET', 'POST'),
        f'{HEADLESS}account/authenticators/webauthn': ('GET', 'POST', 'PUT', 'DELETE'),
    }
    PASSWORD_REAUTH = f'{HEADLESS}auth/reauthenticate'

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        session = getattr(request, 'session', None)
        if session is not None and SESSION_KEY in session and request.user.is_authenticated:
            path, method = request.path, request.method
            wanted = method in self.SENSITIVE.get(path, ()) or (path == self.PASSWORD_REAUTH and method == 'POST')
            if wanted:
                from . import mfa
                if mfa.enrolled(request.user) and (path == self.PASSWORD_REAUTH or not mfa.recently_strong(request)):
                    return self.refuse(request)
        return self.get_response(request)

    @staticmethod
    def refuse(request):
        # allauth's own {status, data, meta} shape, written out here rather
        # than through its response class: that class reads the headless
        # client off the request, which the view has not marked yet.
        from allauth.mfa.models import Authenticator
        types = [str(t) for t in Authenticator.Type if Authenticator.objects.filter(user=request.user, type=t).exists()]
        return JsonResponse({
            'status': 401,
            'data': {'flows': [{'id': 'mfa_reauthenticate', 'types': types, 'is_pending': True}]},
            'meta': {'is_authenticated': True},
        }, status=401)


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
