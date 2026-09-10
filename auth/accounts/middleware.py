"""
The rules that sit between the edge and every view.

Three come before the session exists, because what they do must hold for
every answer, including the early ones the rules further down give:

RequestContext — every request gets an id and a trace. The id is the caller's
X-Request-Id when it is one worth repeating (8 to 128 characters of a
header-safe alphabet), otherwise a fresh uuid4; it goes back on the response
and into every log line (accounts.logs) and audit row (accounts.events.record)
the request produces, so "the 403 I got at 14:02" leads to the lines that
explain it. The trace is a W3C traceparent's trace id when a well-formed one
arrived, and whether that parent sampled the request decides, under
GC_REQUEST_LOG=sampled, whether this one gets a request log line. First in
MIDDLEWARE, so a 403 from a gate or a 429 from the limit carries the id too.

SecurityHeaders — the headers no response should lack, wherever a view did
not set its own: a Permissions-Policy for the devices this service has no use
for, Cross-Origin-Resource-Policy, and on the JSON API a
Content-Security-Policy that allows nothing, because nothing there is ever a
page, and Cache-Control: no-store. HSTS is not here: TLS ends at the edge, and
so does the header that depends on it.

RequestRateLimit — a budget per client address for everything this service
answers, and a smaller one for GET /auth/csrf, the one anonymous endpoint that
writes a row (it starts a session). Ahead of the session middleware, so a
refused request costs a counter in the cache and nothing else: no session, no
query, bar one audit row per address per window.

Then the rules about a session.

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
import ipaddress
import logging
import re
import secrets
import time
import uuid
from urllib.parse import quote

from django.conf import settings
from django.contrib.auth import SESSION_KEY
from django.http import HttpResponseRedirect, JsonResponse
from django.middleware.csrf import get_token
from django.utils.functional import empty

from tenants.session import ORG_KEY

from . import logs
from .events import LOGIN_AT, client_ip, pwned_for, record
from .models import AuthEvent
from .ratelimit import window
from .refusals import refusal

HEADLESS = '/_allauth/browser/v1/'

# ---------------------------------------------------------------- the request

# What an inbound X-Request-Id must look like to be repeated back: long enough
# to be an id, short enough for a log line, and no character that means
# anything to a header, a log line or a query.
REQUEST_ID = re.compile(r'[A-Za-z0-9._:-]{8,128}')
# W3C traceparent, version 00: trace id, parent id, flags; bit 0 of the flags
# is "the caller sampled this request".
TRACEPARENT = re.compile(r'00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})')
NO_TRACE = '0' * 32
# A path is the client's to write, and it arrives percent-decoded. It is
# quoted again before it is logged, '%' included, so a space cannot forge a
# field and a newline cannot forge a line. Never with its query string: that
# is where a reset key or an OAuth code travels.
PATH_SAFE = "/:@!$&'()*+,;=-._~"
MAX_PATH = 512


def request_id(request):
    """The caller's X-Request-Id when it is one worth repeating, else a new one."""
    given = request.headers.get('X-Request-Id', '').strip()
    return given if REQUEST_ID.fullmatch(given) else str(uuid.uuid4())


def trace_of(request):
    """
    (trace id, sampled) from the traceparent header. A malformed one, or the
    all-zero trace id the spec calls invalid, is no parent at all: a trace of
    this request's own, which nobody asked to be sampled.
    """
    found = TRACEPARENT.fullmatch(request.headers.get('traceparent', '').strip())
    if found and found.group(1) != NO_TRACE:
        return found.group(1), bool(int(found.group(3), 16) & 1)
    return secrets.token_hex(16), False


def logged_path(request):
    return quote(request.path, safe=PATH_SAFE)[:MAX_PATH]


def signed_in_id(request):
    """
    The account's id, when an earlier layer already loaded the account. Never
    the address, and never a query spent on a log line: a lazy user nothing
    has touched is left untouched.
    """
    user = getattr(request, 'user', None)
    user = getattr(user, '_wrapped', user)
    if user is None or user is empty or not getattr(user, 'is_authenticated', False):
        return None
    return user.pk


def selected_org(request):
    """The organisation the session acts for (tenants.session), when the session was read anyway."""
    session = getattr(request, 'session', None)
    if session is None or not session.accessed:
        return None
    return session.get(ORG_KEY) or None


class RequestContext:
    log = logging.getLogger('ghostclick.request')

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        began = time.monotonic()
        request.rid = request_id(request)
        request.trace, request.sampled = trace_of(request)
        token = logs.REQUEST.set({'rid': request.rid, 'trace': request.trace, 'sampled': request.sampled})
        try:
            response = self.get_response(request)
            response['X-Request-Id'] = request.rid
            self.note(request, response, time.monotonic() - began)
            return response
        finally:
            logs.REQUEST.reset(token)

    def note(self, request, response, seconds):
        """
        The request log line, as the request ends. GC_REQUEST_LOG decides who
        gets one: `all`, every request; `sampled` (the default), the requests a
        traceparent said were sampled; `off`, none. INFO for an answer, WARNING
        for a refusal, ERROR for a failure. Method, path, status, time, address,
        and the account and organisation when they are already known — never a
        cookie, a header, a body or a query string.
        """
        wanted = settings.GC_REQUEST_LOG
        if wanted == 'off' or (wanted == 'sampled' and not request.sampled):
            return
        status = response.status_code
        level = logging.ERROR if status >= 500 else logging.WARNING if status >= 400 else logging.INFO
        if not self.log.isEnabledFor(level):
            return
        fields = {
            'rid': request.rid, 'trace': request.trace, 'method': request.method, 'path': logged_path(request),
            'status': status, 'ms': round(seconds * 1000, 1), 'ip': client_ip(request),
            'user': signed_in_id(request), 'org': selected_org(request),
        }
        self.log.log(level, '%s %s %s %sms ip=%s user=%s org=%s',
                     fields['method'], fields['path'], status, fields['ms'],
                     fields['ip'] or '-', fields['user'] or '-', fields['org'] or '-', extra=fields)


class SecurityHeaders:
    EVERYWHERE = {
        # The devices this service never asks for. publickey-credentials-get
        # and -create are left out on purpose: passkeys are a feature, and a
        # policy copied onto a page that runs a ceremony must not break it.
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
        'Cross-Origin-Resource-Policy': 'same-site',
        'X-Permitted-Cross-Domain-Policies': 'none',
        'Origin-Agent-Cluster': '?1',
    }
    # The JSON API is never a page, so its policy allows nothing at all, and
    # an answer about a session is not one for a shared cache to keep.
    API = ('/auth/', '/_allauth/')
    API_POLICY = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
    # The admin draws pages with its own scripts and styles, so where those
    # come from is not restricted here; framing, the base URL, where its forms
    # post and plugins are.
    ADMIN = '/admin/'
    ADMIN_POLICY = "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'"

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        # setdefault throughout: a header a view chose is the view's answer.
        for name, value in self.EVERYWHERE.items():
            response.setdefault(name, value)
        if request.path.startswith(self.API):
            response.setdefault('Content-Security-Policy', self.API_POLICY)
            response.setdefault('Cache-Control', 'no-store')
        elif request.path.startswith(self.ADMIN):
            response.setdefault('Content-Security-Policy', self.ADMIN_POLICY)
        return response


class RequestRateLimit:
    """
    Two budgets per client, spent before any session exists.

    GC_REQUEST_RATE is everything this service answers — /auth/, /_allauth/,
    the Google callback under /accounts/, the admin — and GC_CSRF_RATE is GET
    /auth/csrf on top of it: the one endpoint an anonymous visitor reaches that
    writes a row, because the token lives in a session it starts
    (CSRF_USE_SESSIONS). The SPA asks for one when it boots; sixty a minute is
    a script.

    A client is its address as the edge reports it (accounts.events.client_ip),
    or for IPv6 its /64 (`bucket`). The windows are aligned to the clock
    (accounts.ratelimit.window), so the refusal can say when to come back: 429,
    Retry-After in seconds, {"error": "rate_limited"}, in allauth's shape under
    /_allauth/ (accounts.refusals). The first refusal in a window is written
    down once, as a log line and an audit row; the rest cost the counter and
    nothing else, which is the point of refusing them.
    """
    PREFIXES = ('/auth/', '/_allauth/', '/accounts/', '/admin/')
    CSRF = '/auth/csrf'
    log = logging.getLogger('ghostclick.ratelimit')

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path.startswith(self.PREFIXES) and not self.healthcheck(request):
            key = bucket(client_ip(request))
            refused = self.spend(request, 'request', key, settings.GC_REQUEST_RATE)
            if refused is None and request.method == 'GET' and request.path == self.CSRF:
                refused = self.spend(request, 'csrf', key, settings.GC_CSRF_RATE)
            if refused is not None:
                return refused
        return self.get_response(request)

    def healthcheck(self, request):
        """
        GET /auth/csrf from a loopback address is exempt from both budgets.

        That is the compose healthcheck — python inside the control container,
        every ten seconds — and a healthcheck that is refused even once in a
        while restarts a healthy service. Nothing from outside arrives from
        loopback: behind the edge the address is the X-Forwarded-For hop Caddy
        overwrites, and gunicorn is reachable only through Caddy. On a laptop
        every request is from loopback, so there the endpoint is not counted,
        which costs a laptop nothing.
        """
        if request.method != 'GET' or request.path != self.CSRF:
            return False
        try:
            return ipaddress.ip_address(client_ip(request) or '').is_loopback
        except ValueError:
            return False

    def spend(self, request, name, key, rate):
        """One request against `rate`: None while within it, else the 429 to answer with."""
        past, left = window(name, key, rate)
        if not past:
            return None
        if past == 1:
            # ONE line and ONE row per client per window, as the mint limit
            # writes its refusals (accounts.views.executor_token): a refusal
            # that wrote a row every time would make refusing the expensive path.
            path = logged_path(request)
            self.log.warning('%s limit %s reached by %s at %s %s', name, rate, key, request.method, path)
            record(AuthEvent.Kind.RATE_LIMITED, request, limit=name, rate=rate, client=key, path=path[:200])
        response = refusal(request, 429, 'rate_limited', 'Too many requests. Wait a moment and try again.')
        response['Retry-After'] = str(left)
        return response


def bucket(ip):
    """
    What a request is counted against: the address for IPv4, the /64 for IPv6.
    One subscriber is routinely handed a whole /64, and counting its addresses
    one at a time would count nothing. Unreadable is one shared '-'.
    """
    try:
        address = ipaddress.ip_address(ip or '')
        if address.version == 6:
            if address.ipv4_mapped is not None:
                return str(address.ipv4_mapped)
            return str(ipaddress.ip_network((address, 64), strict=False))
        return str(address)
    except ValueError:
        return '-'


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
    endpoints (so signing out is always possible), EVERY kind of
    reauthentication, and the CSRF token. Nothing that mints, invites, or
    switches organisation.

    Every kind, and not only the password one, because of what
    StrongReauthentication does next: for an account holding an authenticator
    it refuses the forced change with a 401 naming `mfa_reauthenticate`, once
    the sign-in proof is older than the reauthentication window. If the two
    endpoints that could supply that proof are themselves answered
    `password_change_required`, the account is stuck — the [credentials-1]
    change becomes impossible for exactly the people who took the strongest
    precaution, and their only way out is signing out and going through the
    mailbox. A reauthentication proves something and changes nothing, so it
    is safe in a marked session, and it is the one thing the refusal asks
    for.
    """
    ALLOWED = (
        '/_allauth/browser/v1/account/password/change',
        '/_allauth/browser/v1/auth/session',
        '/_allauth/browser/v1/auth/reauthenticate',
        '/_allauth/browser/v1/auth/2fa/reauthenticate',
        '/_allauth/browser/v1/auth/webauthn/reauthenticate',
        '/_allauth/browser/v1/config',
        '/auth/me',
        '/auth/csrf',
        '/auth/config',
    )

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        session = getattr(request, 'session', None)
        # `pwned_for`, not a truthiness test: the mark names the account it
        # was found for, because it is written while the sign-in is still
        # anonymous and login() preserves session data across its key cycle.
        # A sign-in abandoned at the second-factor stage would otherwise
        # leave it behind for whoever used that browser next.
        if (session is not None and SESSION_KEY in session
                and request.user.is_authenticated and pwned_for(session, request.user)):
            if request.path not in self.ALLOWED:
                return JsonResponse({'error': 'password_change_required'}, status=403)
        return self.get_response(request)


class MfaRequired:
    """
    What an account that must enrol may still reach: the enrolment
    endpoints themselves (and listing what it holds), the session endpoints
    (signing out, and the "what is pending" the SPA boots from), every kind
    of reauthentication (enrolment asks for one), the Google callback (a
    sign-in already in flight must be able to finish), "who am I" and the
    two read-only helpers. /admin/ is StaffMFARequired's to answer, in HTML;
    /static/ is not a thing an account does.

    Two things this list used to hold unconditionally and no longer does.

    The password change is now reachable only while PasswordChangeRequired
    has marked the session, which is the one case where a change must come
    before enrolment. Unconditionally it was the whole policy's exit for a
    Google-only account: allauth makes `current_password` optional when the
    account has no usable password, and treats an account with no
    reauthentication flows as having recently authenticated — so a stolen
    cookie could SET a password, sign in with it, and watch `no_password`
    disappear, having enrolled nothing. That is exactly the account
    [oauth-1] and §6.5 were written for. Setting a password can wait until
    there is a factor beside it.

    `auth/provider/redirect` is gone for the same shape of reason: it asks
    for no reauthentication at all, so a blocked account could complete
    `process=connect` and bolt an ADDITIONAL Google identity onto itself on
    nothing but the session cookie — while REMOVING one is gated by
    StrongReauthentication. §5.4 does not list it, and a blocked account has
    no business starting a connect before it enrols.
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
        '/accounts/google/login/callback/',
    )
    #: Reachable only while the session is marked as holding a breached
    #: password, where PasswordChangeRequired is already forcing the change.
    ALLOWED_WHEN_PWNED = (f'{HEADLESS}account/password/change',)
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
            allowed = self.ALLOWED + (self.ALLOWED_WHEN_PWNED if pwned_for(session, request.user) else ())
            if path not in allowed and not path.startswith(self.ALLOWED_PREFIXES):
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
