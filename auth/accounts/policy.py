"""
Who may sign up, decided in one place.

The account adapter (a password sign-up) and, in the google flow, the social
adapter (a Google sign-up) both ask here and nowhere else, so the two paths
cannot answer differently for the same address [oauth-5]. Three modes, set
by GC_SIGNUP_MODE and never by editing this file:

  invite   the address must hold a live invitation (tenants.Invitation)
  open     anyone; Turnstile stands in front of it when configured
  domain   the address's domain — or, for Google, the id_token's `hd`, which
           is the workspace's word rather than the string after the @ — must
           be one of GC_SIGNUP_DOMAINS, exactly

A refusal carries a reason for the audit log and a flag saying whether the
reason may be shown. A domain rule is public policy ("sign up with your
@acme.example address"); "nobody invited that address" is not, because said
out loud it lists who was invited, so it is answered exactly like an address
that already has an account [credentials-3].
"""
from dataclasses import dataclass

from django.apps import apps
from django.conf import settings


@dataclass(frozen=True)
class Decision:
    allowed: bool
    reason: str = ''
    # Whether the reason may be said to the client. False means "answer as
    # if the sign-up went ahead, and let the mailbox explain".
    public: bool = True


ALLOWED = Decision(True)


def mode():
    return getattr(settings, 'GC_SIGNUP_MODE', 'invite')


def domains():
    return [d.lower() for d in getattr(settings, 'GC_SIGNUP_DOMAINS', [])]


def has_live_invitation(email):
    Invitation = apps.get_model('tenants', 'Invitation')
    return Invitation.objects.live().filter(email__iexact=email).exists()


def signup_allowed(email, hd=None):
    """
    May `email` sign up? `hd` is Google's hosted-domain claim, present only
    for a Google sign-up; a password sign-up passes None and the domain is
    read from the address.
    """
    email = (email or '').strip().lower()
    if not email or '@' not in email:
        return Decision(False, 'not an email address')
    current = mode()
    if current == 'open':
        return ALLOWED
    if current == 'domain':
        domain = (hd or email.rsplit('@', 1)[1]).lower()
        if domain in domains():
            return ALLOWED
        return Decision(False, f'{domain} is not a sign-up domain', public=True)
    # invite
    if has_live_invitation(email):
        return ALLOWED
    return Decision(False, 'no live invitation for this address', public=False)
