"""
Issuing and accepting invitations, and the rules that make either refuse.

Two rules matter more than the rest, and both come from [authz-tenancy-5]:
an inviter never grants a role above their own, and only an owner grants
`admin` or `owner`. Together they mean an admin can only ever add members,
so an admin account that is taken over cannot mint another admin, and the
set of people who can manage an organisation grows only by an owner's hand.

Acceptance is by a signed-in user whose address is the one invited — either
presenting the token (an existing account, POST /auth/invitations/accept) or
by verifying that address at sign-up, at which moment every live invitation
bound to it is consumed (accept_pending, called from the email_confirmed
receiver in accounts.events). The invitation therefore never creates an
account or a session — it only turns an existing, verified identity into a
membership [credentials-6]. Every refusal names its reason in the audit log
and says something uniform to the client, because "no such invitation"
versus "wrong email" is a way to check which addresses were invited.

The token is mailed to the invited address, once, at issue; it appears in
no response. The link it carries is the SPA's /app/invite route.
"""
from datetime import timedelta

from django.apps import apps
from django.conf import settings
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

    allauth's EmailAddress table is the proof: a sign-up's code, or an
    operator's word (adduser marks the row verified). The lookup is by app
    registry rather than import so this module does not depend on allauth
    being installed to import.
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


def _check_cap_still_holds(invitation, org):
    """
    The same cap, asked again at ACCEPTANCE.

    Checked only at issue, [authz-tenancy-5] holds for a moment and then
    stops: an outstanding invitation survives the inviter's demotion and even
    their removal from the organisation, so a taken-over owner who is demoted
    keeps minting owners for seven days unless somebody also notices and
    revokes every pending grant by hand. That falsifies the sentence at the
    top of this module — that the set of people who can manage an
    organisation grows only by an owner's hand.

    A deleted account is SET_NULL on invited_by, so there is no live inviter
    to ask: such an invitation is refused and has to be issued again by
    somebody who is still here.
    """
    if invitation.invited_by_id is None:
        raise Refused('the inviter no longer has an account', forbidden=True)
    inviter = Membership.objects.filter(organization=org, user_id=invitation.invited_by_id).first()
    if inviter is None:
        raise Refused('the inviter is no longer in this organisation', forbidden=True)
    try:
        _check_cap(inviter, invitation.role)
    except Refused:
        raise Refused('the inviter may no longer grant this role', forbidden=True) from None


def _check_seats(org):
    cap = org.entitlements().get('members.max')
    if cap is not None and org.seats_taken() >= cap:
        raise Entitlement('members.max', org.plan.slug)


def issue(inviter, email, role, request=None):
    """
    A new invitation to the inviter's organisation, mailed to `email`.
    Returns the invitation row.

    The raw token exists in the mail and nowhere else: it is not returned,
    not in the row (only its hash), and not recoverable afterwards. An
    inviter who needs to send it again revokes and issues a new one.
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
    mail(invitation, raw, request)
    record(AuthEvent.Kind.INVITATION_SENT, request, user=inviter.user,
           org=org.slug, role=role, invitee=email, invitation=invitation.pk)
    return invitation


def mail(invitation, raw, request=None):
    """The one place the raw token is written down: the invitee's mailbox."""
    from accounts import mailer
    app = settings.GC_APP_URL
    mailer.send('tenants/email/invitation', invitation.email, {
        'email': invitation.email,
        'org_name': invitation.organization.name,
        'role': invitation.role,
        'inviter': getattr(invitation.invited_by, 'email', 'An administrator'),
        'accept_url': f'{app}/invite?token={raw}',
        'signup_url': f'{app}/signup',
        'days': Invitation.LIFETIME_DAYS,
    })


def accept(raw, user, request=None):
    """
    Consume `raw` for `user`, who must be signed in as the invited address.

    Returns the membership. Raises Refused with the reason, after writing
    the refusal to the log with the same reason — the log is the only place
    the reason goes.
    """
    found = Invitation.by_token(raw)
    try:
        if found is None:
            raise Refused('no such invitation')
        membership = _consume(found.pk, user)
    except Refused as err:
        record(AuthEvent.Kind.INVITATION_REFUSED, request, user=user, reason=err.reason)
        raise
    record(AuthEvent.Kind.INVITATION_ACCEPTED, request, user=user,
           org=membership.organization.slug, role=membership.role)
    return membership


def accept_pending(user, request=None, email=None):
    """
    Every live invitation bound to `email` (the user's own address by
    default) becomes a membership. Called when that address has just been
    verified: this is the sign-up half of [credentials-6] — the invitation
    is consumed at verification and not a moment sooner. Returns the
    memberships made or confirmed; a refusal (a seat gone since issue) is
    logged and skipped rather than raised, because the verification that
    called this has already succeeded and must not be undone by a plan.
    """
    email = (email or user.email or '').strip()
    made = []
    live = Invitation.objects.live().filter(email__iexact=email).order_by('created_at')
    for invitation in live:
        try:
            membership = _consume(invitation.pk, user)
        except Refused as err:
            record(AuthEvent.Kind.INVITATION_REFUSED, request, user=user, reason=err.reason, invitation=invitation.pk)
            continue
        record(AuthEvent.Kind.INVITATION_ACCEPTED, request, user=user,
               org=membership.organization.slug, role=membership.role, at_verification=True)
        made.append(membership)
    return made


def _consume(pk, user):
    with transaction.atomic():
        # Locked for the duration: two acceptances of one token in the same
        # instant must produce one membership and one refusal, not two rows.
        invitation = Invitation.objects.select_for_update().select_related('organization', 'organization__plan').get(pk=pk)
        if invitation.accepted_at:
            # The same person presenting a token they already used — the
            # mailed link opened after verification consumed it — is a
            # double click, not an attack, and gets the membership it made.
            existing = Membership.objects.filter(organization=invitation.organization, user=user).first()
            if invitation.accepted_by_id == user.pk and existing is not None:
                return existing
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
        # The role cap, re-asked now rather than trusted from a week ago.
        _check_cap_still_holds(invitation, org)
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


def revoke_ungrantable(org, user):
    """
    Revoke every live invitation `user` issued to `org` that they could no
    longer issue today.

    Called when their role changes or they leave (tenants.members). The
    re-check at acceptance already refuses these, so this is the tidy half:
    an invitation that can never be accepted should not sit in the listing
    looking pending, and its seat should not keep counting against
    members.max.
    """
    live = Invitation.objects.live().filter(organization=org, invited_by=user)
    inviter = Membership.objects.filter(organization=org, user=user).first()
    doomed = []
    for invitation in live:
        if inviter is None:
            doomed.append(invitation.pk)
            continue
        try:
            _check_cap(inviter, invitation.role)
        except Refused:
            doomed.append(invitation.pk)
    if doomed:
        Invitation.objects.filter(pk__in=doomed).update(revoked_at=timezone.now())
    return len(doomed)
