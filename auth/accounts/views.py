"""
Four endpoints, and one of them is the whole point.

  GET  /auth/csrf             hand the SPA a CSRF token it can echo back
  POST /auth/login            email + password -> a session cookie
  POST /auth/logout
  GET  /auth/me               who am I
  POST /auth/executor-token   a short-lived token the RUNNER will accept

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

from .tokens import NoSigningKey, mint


def _body(request):
    """The JSON body, or {} — a malformed body is a 400 with a real sentence."""
    try:
        return json.loads(request.body or b'{}')
    except ValueError:
        raise ValueError('the request body is not JSON')


def _shape(user):
    return {'id': user.pk, 'email': user.email, 'name': user.name, 'isStaff': user.is_staff}


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
    return JsonResponse({'ok': True, 'user': _shape(user), 'csrfToken': get_token(request)})


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
    return JsonResponse({'user': _shape(request.user)})


@require_http_methods(['POST'])
def executor_token(request):
    """
    A signed token for the runner, for whoever this session says you are.

    Nothing about the request is trusted for identity — no user id in the body,
    no header naming a subject. The claims come from request.user, which came
    from a signed session cookie. A parameter here would be an endpoint that
    mints a token for anyone you name.
    """
    if not request.user.is_authenticated:
        return JsonResponse({'error': 'Not signed in'}, status=401)

    try:
        token = mint(
            subject=request.user.pk,
            email=request.user.email,
            scope='run',
            admin=request.user.is_staff,
            secret=settings.GC_AUTH_SECRET,
            ttl=settings.GC_TOKEN_TTL,
        )
    except NoSigningKey as err:
        # 503, not 500: nothing is broken, this service has not been told the
        # key it shares with the runner. The message names the variable.
        return JsonResponse({'error': str(err)}, status=503)

    return JsonResponse({'token': token, 'expiresIn': settings.GC_TOKEN_TTL})

