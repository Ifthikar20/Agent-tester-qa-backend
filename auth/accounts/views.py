"""
The endpoints that are this project's own, and one of them is the whole point.

  GET  /auth/csrf             hand the SPA a CSRF token it can echo back
  GET  /auth/config           what the sign-up page needs to know: the mode,
                              and the Turnstile site key when there is one
  GET  /auth/me               who am I, and for which organisation
  POST /auth/executor-token   a short-lived token the RUNNER will accept
  GET  /auth/jwks             the public keys that token verifies with

Sign-up, sign-in, sign-out, verification, reset and the password and email
changes are django-allauth's, under /_allauth/browser/v1/ (docs/AUTH.md §4,
§5, §7) — there is no hand-written login view here any more, because a
login view is the thing that forgets a rate limit. The organisation
endpoints (switching, invitations) are in tenants/views.py, mounted under
the same /auth prefix.

Errors come back as {"error": "..."} because that is the shape the UI's `req()`
already unwraps for the executor's API — one error path in the frontend rather
than two, and the words the server chose rather than "Request failed".

Why a separate token instead of forwarding this session cookie to the runner:
the runner is a different service, on a different origin, and it never sees a
cookie — the edge strips them. Handing it a long-lived session cookie would
make every socket a durable credential. A ten-minute token scoped to one
organisation is the smaller thing to leak.
"""
import secrets
import time

from django.conf import settings
from django.http import JsonResponse
from django.middleware.csrf import get_token
from django.views.decorators.http import require_http_methods

from tenants import plans
from tenants.session import describe, selected

from . import google, mfa, turnstile
from .events import LOGIN_AT, auth_events, record
from .models import AuthEvent
from .ratelimit import over
from .tokens import (
    NoSigningKey, STEP_UP_SECONDS, jwk, kid_of, load_private, mint, public_pem, session_id,
)


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
    [authz-tenancy-6].

    The mfa block is accounts/mfa.py's answer — required (and the reasons,
    so the enrolment page can say which of docs/AUTH.md §5.4's four it is)
    and enrolled — computed from the database now, never from the session.
    It is for display: the refusal that enforces it is the middleware's,
    and it asks the same module.
    """
    return {
        'user': _shape(request.user),
        **describe(request),
        'mfa': mfa.describe(request.user),
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


@require_http_methods(['GET'])
def config(request):
    """
    What the sign-up and sign-in pages need before anyone has typed anything.
    The mode decides which words the page shows; the site key is public by
    definition (it is rendered into every visitor's page) and null when
    Turnstile is not configured, which is the SPA's cue not to load it; and
    `google` says whether a "Continue with Google" button has anywhere to go.
    """
    return JsonResponse({
        'signup': settings.GC_SIGNUP_MODE,
        'domains': settings.GC_SIGNUP_DOMAINS if settings.GC_SIGNUP_MODE == 'domain' else [],
        'turnstile': turnstile.site_key(),
        'google': google.configured(),
    })


@require_http_methods(['GET'])
def me(request):
    if not request.user.is_authenticated:
        return JsonResponse({'error': 'Not signed in'}, status=401)
    return JsonResponse(whoami(request))


def step_up(events, has_authenticator, fallback):
    """
    (amr, auth_time, su) from the session's authentication events
    (docs/AUTH.md §8), and the only place the arithmetic lives.

      amr        every method the session actually used, sorted.
      auth_time  the most recent STRONG event when the account holds an
                 authenticator — a password proof is not "when this session
                 last authenticated" for an account whose sign-in needs a
                 second factor — else the most recent event of any kind.
      su         auth_time + 600 when the strongest factor the account has
                 was the one used at auth_time, otherwise 0: an account with
                 an authenticator that has not shown it this session, and a
                 password account signed in through Google alone, cannot
                 allow an origin until they prove the stronger thing
                 [mfa-recovery-2].

    A session with no events at all — one that predates the list — gets
    auth_time = when it began and su = 0, rather than a guess at how it
    was authenticated.
    """
    if not events:
        return [], fallback, 0
    amr = sorted({e['method'] for e in events})
    latest = max(e['at'] for e in events)
    if has_authenticator:
        strong = [e['at'] for e in events if e['method'] in mfa.STRONG]
        if not strong:
            return amr, latest, 0
        auth_time = max(strong)
        return amr, auth_time, auth_time + STEP_UP_SECONDS
    # No authenticator: the password is the strongest factor there is, and
    # the most recent event has to be it — a Google sign-in on a password
    # account is one factor and a weaker one [oauth-6].
    newest = max(events, key=lambda e: e['at'])
    return amr, latest, (latest + STEP_UP_SECONDS if newest['method'] == 'password' else 0)


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

    The rest of the claims come from the session's authentication events
    (docs/AUTH.md §8): `amr` is the set of methods actually used, and
    `auth_time` and `su` — "step-up valid until" — are computed HERE, by
    step_up() below, so the runner's check is nothing more than `now < su`.

    Rate limited per session key and written to the audit log with its jti:
    a token that never appears in the log was not minted here [token-5].
    """
    if not request.user.is_authenticated:
        return JsonResponse({'error': 'Not signed in'}, status=401)
    # Django's own get_user already returns anonymous for an inactive account,
    # so this line is belt and braces — but it is the line the spec names,
    # and a deactivated account must never be one refactor away from a token.
    if not request.user.is_active:
        return JsonResponse({'error': 'Not signed in'}, status=401)
    # "Past MFA policy" (docs/AUTH.md §8.1). The middleware has already
    # refused this request for such an account; the check is repeated here
    # because a token is the one thing that must never be a middleware
    # ordering away from an account the policy names [mfa-recovery-1].
    if mfa.blocked(request.user):
        record(AuthEvent.Kind.MINT_REFUSED, request, user=request.user, reason='mfa_required')
        return JsonResponse({'error': 'mfa_required'}, status=403)

    # The session key is the bucket: a stolen cookie mints against its own
    # limit and nobody else's, and a script minting on every call is stopped
    # without touching the person's other sessions.
    if over('mint', request.session.session_key or '-', settings.GC_MINT_RATE):
        record(AuthEvent.Kind.MINT_REFUSED, request, user=request.user, reason='rate_limited')
        return JsonResponse({'error': 'rate_limited'}, status=429)

    membership = selected(request)
    if membership is None:
        return JsonResponse({'error': 'no_organisation'}, status=403)
    org = membership.organization

    now = int(time.time())
    amr, auth_time, su = step_up(auth_events(request), mfa.enrolled(request.user),
                                 fallback=int(request.session.get(LOGIN_AT) or now))

    jti = secrets.token_urlsafe(16)
    try:
        token = mint(
            subject=request.user.pk,
            email=request.user.email,
            key=settings.GC_SIGNING_KEY,
            ttl=settings.GC_TOKEN_TTL,
            now=now,
            org=org.slug,
            role=membership.role,
            plan=org.plan.slug,
            ent=plans.runner_subset(org.entitlements()),
            ent_v=org.entitlements_version,
            amr=amr,
            auth_time=auth_time,
            su=su,
            sid=session_id(request.session.session_key),
            jti=jti,
        )
    except NoSigningKey as err:
        # 503, not 500: nothing is broken, this service has not been given a
        # signing key. The message names the variable and the command.
        return JsonResponse({'error': str(err)}, status=503)

    record(AuthEvent.Kind.MINT, request, user=request.user, jti=jti, org=org.slug, role=membership.role)
    return JsonResponse({'token': token, 'expiresIn': settings.GC_TOKEN_TTL})


@require_http_methods(['GET'])
def jwks(request):
    """
    The public key set, for humans and tooling.

    The runner does NOT fetch this: its trust anchor arrives in its own
    environment (GC_AUTH_PUBLIC_KEYS), so a control plane that has been taken
    over cannot hand the runner a new key by answering this URL differently
    [token-3]. It exists so an operator can check which key a deployment is
    signing with, and copy the `pem` into the runner's set on rotation.
    """
    try:
        key = load_private(settings.GC_SIGNING_KEY)
    except NoSigningKey:
        return JsonResponse({'keys': []})
    return JsonResponse({'keys': [{
        **jwk(key), 'kid': kid_of(key), 'use': 'sig', 'alg': 'EdDSA', 'pem': public_pem(key),
    }]})
