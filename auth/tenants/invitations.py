"""
Issuing and accepting invitations, and the rules that make either refuse.

Two rules matter more than the rest, and both come from [authz-tenancy-5]:
an inviter never grants a role above their own, and only an owner grants
`admin` or `owner`. Together they mean an admin can only ever add members,
so an admin account that is taken over cannot mint another admin, and the
set of people who can manage an organisation grows only by an owner's hand.

Acceptance is by a signed-in user whose address is the one invited. The
invitation therefore never creates an account or a session — it only turns
an existing, verified identity into a membership [credentials-6]. Every
refusal names its reason in the audit log and says something uniform to the
client, because "no such invitation" versus "wrong email" is a way to check
which addresses were invited.
"""
from datetime import timedelta

from django.apps import apps
from django.db import transaction
from django.utils import timezone

from accounts.events import record
from accounts.models import AuthEvent

from .models import RANK, Invitation, Membership, Role, hash_token

# One sentence for every refusal the client sees.
REFUSAL = 'That invitation cannot be used with this account'


class Refused(Exception):
    """The reason is for the log; the client gets REFUSAL. `forbidden` marks a role-cap refusal."""

    def __init__(self, reason, forbidden=False):
        super().__init__(reason)
        self.reason = reason
        self.forbidden = forbidden


class Entitlement(Exception):
    """The plan does not allow it. The client gets a 402 naming the limit."""

    def __init__(self, limit, plan):
        super().__init__(f'{limit} on the {plan} plan')
        self.limit, self.plan = limit, plan


def email_verified(user):
    """
    Whether the address an invitation is bound to has been proven.

    allauth's EmailAddress table is the proof once the accounts flow installs
    it; until then there is no sign-up path, every account was made by an
    operator, and the address on the row is the operator's word. The lookup
    is by app registry rather than import so this module does not break the
    settings profile that has no allauth in it.
    """
    if apps.is_installed('allauth.account'):
        EmailAddress = apps.get_model('account', 'EmailAddress')
        return EmailAddress.objects.filter(user=user, email__iexact=user.email, verified=True).exists()
    return True


def _check_cap(inviter, role):
    if not inviter.manages:
        raise Refused('inviter is not an owner or admin', forbidden=True)
    if role not in RANK:
        raise Refused('unknown role')
    if RANK[role] > RANK[inviter.role]:
        raise Refused('role above the inviter’s own', forbidden=True)
    if role != Role.MEMBER and inviter.role != Role.OWNER:
        raise Refused('only an owner grants admin or owner', forbidden=True)


def _check_seats(org):
    cap = org.entitlements().get('members.max')
    if cap is not None and org.seats_taken() >= cap:
        raise Entitlement('members.max', org.plan.slug)


def issue(inviter, email, role, request=None):
    """
    A new invitation to the inviter's organisation. Returns (invitation, raw token).

    The raw token exists only in the return value: the caller shows it once
    (or, when the accounts flow adds mail, sends it once) and it is never
    recoverable from the row.
    """
    org = inviter.organization
    email = (email or '').strip()
    if not email or '@' not in email:
        raise Refused('no email address')
    _check_cap(inviter, role)
    if Membership.objects.filter(organization=org, user__email__iexact=email).exists():
        raise Refused('already a member')
    _check_seats(org)
    raw = Invitation.new_token()
    invitation = Invitation.objects.create(
        organization=org, email=email, role=role, token_hash=hash_token(raw), invited_by=inviter.user,
        expires_at=timezone.now() + timedelta(days=Invitation.LIFETIME_DAYS),
    )
    record(AuthEvent.Kind.INVITATION_SENT, request, user=inviter.user,
           org=org.slug, role=role, invitee=email, invitation=invitation.pk)
    return invitation, raw


def accept(raw, user, request=None):
    """
    Consume `raw` for `user`, who must be signed in as the invited address.

    Returns the membership. Raises Refused with the reason, after writing
    the refusal to the log with the same reason — the log is the only place
    the reason goes.
    """
    try:
        membership = _accept(raw, user)
    except Refused as err:
        record(AuthEvent.Kind.INVITATION_REFUSED, request, user=user, reason=err.reason)
        raise
    record(AuthEvent.Kind.INVITATION_ACCEPTED, request, user=user,
           org=membership.organization.slug, role=membership.role)
    return membership


def _accept(raw, user):
    found = Invitation.by_token(raw)
    if found is None:
        raise Refused('no such invitation')
    with transaction.atomic():
        # Locked for the duration: two acceptances of one token in the same
        # instant must produce one membership and one refusal, not two rows.
        invitation = Invitation.objects.select_for_update().select_related('organization', 'organization__plan').get(pk=found.pk)
        if invitation.accepted_at:
            raise Refused('already used')
        if invitation.revoked_at:
            raise Refused('revoked')
        if invitation.expires_at <= timezone.now():
            raise Refused('expired')
        if invitation.email.lower() != (user.email or '').lower():
            raise Refused('signed in as a different address')
        if not email_verified(user):
            raise Refused('address not verified')
        org = invitation.organization
        existing = Membership.objects.filter(organization=org, user=user).first()
        if existing is None:
            # The cap is re-checked here, not only at issue: the plan may have
            # shrunk in the week between, and a seat the plan no longer has
            # should not appear because a link was clicked late.
            cap = org.entitlements().get('members.max')
            if cap is not None and org.memberships.count() >= cap:
                raise Refused('no seat left on the plan')
            membership = Membership.objects.create(organization=org, user=user, role=invitation.role)
        else:
            # Never a downgrade: a member invited again as a member keeps
            # whatever they held, and an invitation to a higher role raises.
            membership = existing
            if RANK[invitation.role] > RANK[existing.role]:
                existing.role = invitation.role
                existing.save(update_fields=['role'])
        invitation.accepted_at = timezone.now()
        invitation.accepted_by = user
        invitation.save(update_fields=['accepted_at', 'accepted_by'])
    return membership


def revoke(invitation):
    if invitation.is_live:
        invitation.revoked_at = timezone.now()
        invitation.save(update_fields=['revoked_at'])
    return invitation
