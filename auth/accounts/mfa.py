"""
Who must hold a second factor, who does, and which proofs count as strong.

The policy (docs/AUTH.md §5.4) is a fact about the ACCOUNT, computed from
the database every time it is asked, never from a flag the session was
given: a session is a long-lived thing and the facts it would cache — is
this person staff, do they run an organisation, did the plan change — are
not [mfa-recovery-1]. accounts.middleware.MfaRequired asks on every request
and refuses everything but enrolment while the answer is "required and not
enrolled"; /auth/me reports the same answer so the SPA can say why.

"Enrolled" means a TOTP app or a passkey. Recovery codes alone are not an
authenticator — they are made beside one and deleted with it — so an
account holding only those (which allauth never leaves behind, but a
database edit could) has not met the policy.

"Strong" is the vocabulary of gc_auth_events (accounts.events): the three
methods that are a second factor. A password is not; neither is Google,
which is one factor however many Google itself asked for [oauth-6].
"""
import time

from allauth.mfa.models import Authenticator
from django.conf import settings

from .events import auth_events

# The methods in gc_auth_events that are a second factor.
STRONG = frozenset({'otp', 'recovery', 'webauthn'})
# The authenticator types that satisfy the policy.
FACTORS = (Authenticator.Type.TOTP, Authenticator.Type.WEBAUTHN)


def enrolled(user):
    """Does the account hold an authenticator app or a passkey?"""
    if user is None or not getattr(user, 'is_authenticated', False):
        return False
    return Authenticator.objects.filter(user_id=user.pk, type__in=FACTORS).exists()


def reasons(user):
    """
    Why the policy applies to this account, as short words the SPA can
    show, in the order docs/AUTH.md §5.4 lists them. Empty means it does
    not apply.
    """
    if user is None or not getattr(user, 'is_authenticated', False):
        return []
    from tenants.models import Membership
    why = []
    if user.is_staff:
        why.append('staff')
    rows = Membership.objects.filter(user=user).select_related('organization', 'organization__plan')
    # Owner or admin of an organisation that is not the account's own
    # personal one. Everybody owns their personal organisation, and it has
    # one seat: the rule exists because a manager's session can invite,
    # remove and re-plan OTHER people, and a personal organisation has no
    # other people in it. Read literally the rule would make the second
    # factor universal, which is a different policy than the one written.
    if any(m.manages and not m.organization.is_personal for m in rows):
        why.append('manages_organisation')
    # Any organisation the account belongs to, not just the selected one:
    # switching organisations must not be a way around a plan's rule.
    if any(m.organization.entitlements().get('mfa.required') for m in rows):
        why.append('plan')
    if not user.has_usable_password():
        why.append('no_password')
    return why


def required(user):
    return bool(reasons(user))


def blocked(user):
    """The one question the middleware asks: must this account enrol before doing anything else?"""
    return required(user) and not enrolled(user)


def describe(user):
    """
    The `mfa` block of /auth/me. `reasons` leaves out 'staff': there is no
    isStaff in what the browser is told and a reason that spells it is one
    in disguise [authz-tenancy-6]. A staff account with no other reason
    sees `required` and an empty list, and the enrolment page says the
    policy names the account without saying why.
    """
    return {
        'required': required(user),
        'enrolled': enrolled(user),
        'reasons': [r for r in reasons(user) if r != 'staff'],
    }


def latest_strong(request):
    """When this session last proved a second factor, as a unix time, or None."""
    times = [e['at'] for e in auth_events(request) if e['method'] in STRONG]
    return max(times) if times else None


def recently_strong(request, within=None):
    """
    Has this session proved a second factor within the reauthentication
    window (docs/AUTH.md §7.2)? The window is allauth's own, so a strong
    proof is good for exactly as long as a password proof would be for an
    account that has nothing stronger.
    """
    within = settings.ACCOUNT_REAUTHENTICATION_TIMEOUT if within is None else within
    at = latest_strong(request)
    return at is not None and time.time() - at < within
