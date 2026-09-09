"""
Google sign-in: the callback, and the one sentence every refusal gets.

The flow itself is django-allauth's (docs/AUTH.md §6): the SPA POSTs to the
headless redirect endpoint, Google sends the browser back to
/accounts/google/login/callback/ with a code, allauth trades the code for
an id_token over PKCE and hands the result to accounts.adapters
.SocialAccountAdapter, which applies the rules. This module wraps the
callback for one reason. allauth names each failure in the redirect it
answers with — `signup_closed`, `permission_denied`, `connected_other`,
`unknown` — and those names, read off the address bar, say things about
other people's accounts: whether an address exists, whether it is verified,
whether another Google identity already opens it [credentials-3]. So every
refusal leaves here as the same word, the real reason goes to the audit log
with the address it concerned, and the SPA shows one message for all of
them: "We could not sign you in with Google. Sign in the way you usually
do, then connect Google from Settings."

A cancel is not a refusal — the person pressed Back on Google's page — and
keeps its own word, since it says nothing about any account.
"""
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

from allauth.socialaccount.providers.google.views import oauth2_callback
from django.conf import settings
from django.http import Http404

from .events import record
from .models import AuthEvent

# The one word the browser is told. The SPA maps it to the one sentence.
REFUSED = 'refused'
CANCELLED = 'cancelled'
# Where the adapter leaves the real reason for the callback to log.
REASON = '_gc_google_refusal'


def configured():
    """Whether a Google client is set: what /auth/config tells the SPA."""
    return bool(settings.SOCIALACCOUNT_PROVIDERS.get('google', {}).get('APPS'))


def refuse(request, reason, kind=AuthEvent.Kind.GOOGLE_REFUSED, **detail):
    """
    Note why this sign-in is being refused, for the log. The adapter calls
    this and then returns False or raises; the callback below writes the
    row, so one refusal is one row whether the reason came from a rule of
    ours or from allauth's own machinery. The first reason noted wins: a
    rule that refused early is the reason, not the consequence allauth
    draws from it a few frames later.
    """
    if request is not None and getattr(request, REASON, None) is None:
        setattr(request, REASON, {'kind': kind, 'reason': reason, **detail})


def callback(request):
    if not configured():
        # No client, no callback: the URL is not a thing a visitor can
        # reach, rather than a 500 from allauth looking for an app.
        raise Http404
    response = oauth2_callback(request)
    location = response.get('Location') if 300 <= response.status_code < 400 else None
    if not location:
        return response
    parts = urlsplit(location)
    query = parse_qs(parts.query, keep_blank_values=True)
    error = (query.get('error') or [None])[0]
    if error is None:
        return response
    noted = dict(getattr(request, REASON, None) or {})
    kind = noted.pop('kind', AuthEvent.Kind.GOOGLE_REFUSED)
    record(kind, request, email=noted.pop('email', ''), code=error,
           process=(query.get('error_process') or [''])[0], **noted)
    if error != CANCELLED:
        query['error'] = [REFUSED]
    response['Location'] = urlunsplit(parts._replace(query=urlencode(query, doseq=True)))
    return response
