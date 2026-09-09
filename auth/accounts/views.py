"""
Four endpoints, and one of them is the whole point.

  GET  /auth/csrf             hand the SPA a CSRF token it can echo back
  POST /auth/login            email + password -> a session cookie
  POST /auth/logout
  GET  /auth/me               who am I, and for which organisation
  POST /auth/executor-token   a short-lived token the RUNNER will accept

The organisation endpoints (switching, invitations) are in tenants/views.py,
mounted under the same /auth prefix.

Errors come back as {"error": "..."} because that is the shape the UI's `req()`
already unwraps for the executor's API — one error path in the frontend rather
than two, and the words the server chose rather than "Request failed".

Why a separate token instead of forwarding this session cookie to the runner:
the runner is a different service, on a different origin, reached over a
WebSocket that cannot carry custom headers. Handing it a long-lived session
cookie would make every socket URL a durable credential. A ten-minute token
scoped to one job is the smaller thing to leak.
"""
import json

from django.contrib.auth import authenticate, login as django_login, logout as django_logout
from django.conf import settings
from django.http import JsonResponse
from django.middleware.csrf import get_token
from django.views.decorators.http import require_http_methods

from tenants import plans
from tenants.session import describe, selected

from .tokens import NoSigningKey, mint


def _body(request):
    """The JSON body, or {} — a malformed body is a 400 with a real sentence."""
    try:
        return json.loads(request.body or b'{}')
    except ValueError:
        raise ValueError('the request body is not JSON')


def _shape(user):
    return {'id': user.pk, 'email': user.email, 'name': user.name}


def whoami(request):
    """
    The answer to "who am I", for a signed-in request (docs/AUTH.md §10).

      {user: {id, email, name}, org: {slug, name, role}, orgs: [...],
       entitlements: {...}, mfa: {required, enrolled}, flags: {}}

    There is no isStaff and there will not be one. Staff is a control-plane
    fact that opens /admin/, and a flag the browser was shown is a flag the
    browser can show itself; nothing the runner enforces may hang off it
    [authz-tenancy-6]. The mfa block is a placeholder until the mfa flow
    computes it from the authenticators the account holds.
    """
    return {
        'user': _shape(request.user),
        **describe(request),
        'mfa': {'required': False, 'enrolled': False},
        'flags': {},
    }


@require_http_methods(['GET'])
def csrf(request):
    """
    The SPA lives on another origin, so it cannot read Django's csrftoken
    cookie with document.cookie — cookies are not readable across origins. It
    gets the value in a body instead and echoes it in X-CSRFToken, which is the
    part CsrfViewMiddleware actually compares.
    """
    return JsonResponse({'csrfToken': get_token(request)})


@require_http_methods(['POST'])
def login(request):
    try:
        data = _body(request)
    except ValueError as err:
        return JsonResponse({'error': str(err)}, status=400)

    email = str(data.get('email', '')).strip()
    password = data.get('password') or ''
    if not email or not password:
        return JsonResponse({'error': 'Enter an email address and a password'}, status=400)

    user = authenticate(request, username=email, password=password)
    if user is None:
        # One message for "no such account" and "wrong password" on purpose:
        # telling them apart turns this endpoint into a way to enumerate who
        # has an account here.
        return JsonResponse({'error': 'That email and password do not match an account'}, status=401)

    django_login(request, user)
    # django_login rotates the CSRF token — deliberately, so a token captured
    # before sign-in cannot be replayed after it. That means the value the SPA
    # fetched from /auth/csrf a moment ago is now dead, and the NEXT POST it
    # makes would be a 403. Handing back the new one keeps that invisible;
    # without it, signing in works and everything after it fails.
    return JsonResponse({'ok': True, **whoami(request), 'csrfToken': get_token(request)})


@require_http_methods(['POST'])
def logout(request):
    # Same rotation on the way out: the session is flushed, so the caller needs
    # the new token to be able to sign in again without a reload.
    django_logout(request)
    return JsonResponse({'ok': True, 'csrfToken': get_token(request)})


@require_http_methods(['GET'])
def me(request):
    if not request.user.is_authenticated:
        return JsonResponse({'error': 'Not signed in'}, status=401)
    return JsonResponse(whoami(request))


@require_http_methods(['POST'])
def executor_token(request):
    """
    A signed token for the runner, for whoever this session says you are.

    Nothing about the request is trusted for identity — no user id in the body,
    no header naming a subject. The claims come from request.user, which came
    from a signed session cookie. A parameter here would be an endpoint that
    mints a token for anyone you name.

    The same for the organisation: it is the one this session selected, and
    it is written into the token only after the Membership row is found, with
    the role that row holds [authz-tenancy-3]. The entitlements are the
    organisation's resolved plan, cut down to the keys the runner enforces.
    """
    if not request.user.is_authenticated:
        return JsonResponse({'error': 'Not signed in'}, status=401)
    # Django's own get_user already returns anonymous for an inactive account,
    # so this line is belt and braces — but it is the line the spec names,
    # and a deactivated account must never be one refactor away from a token.
    if not request.user.is_active:
        return JsonResponse({'error': 'Not signed in'}, status=401)

    membership = selected(request)
    if membership is None:
        return JsonResponse({'error': 'no_organisation'}, status=403)
    org = membership.organization

    try:
        token = mint(
            subject=request.user.pk,
            email=request.user.email,
            scope='run',
            secret=settings.GC_AUTH_SECRET,
            ttl=settings.GC_TOKEN_TTL,
            org=org.slug,
            role=membership.role,
            ent=plans.runner_subset(org.entitlements()),
            ent_v=org.entitlements_version,
        )
    except NoSigningKey as err:
        # 503, not 500: nothing is broken, this service has not been told the
        # key it shares with the runner. The message names the variable.
        return JsonResponse({'error': str(err)}, status=503)

    return JsonResponse({'token': token, 'expiresIn': settings.GC_TOKEN_TTL})

