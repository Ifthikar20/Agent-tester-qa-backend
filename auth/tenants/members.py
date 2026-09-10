"""
Who is in an organisation, and changing that (docs/AUTH.md §10).

Two rules carry over from invitations, because a role change is a grant by
another name [authz-tenancy-5]: only an owner changes a role, and nobody
changes their own — an admin who could make themselves owner would be an
owner, and an owner who could demote themselves by accident would leave an
organisation that nobody can manage. The last owner cannot be demoted or
removed for the same reason; a personal organisation cannot lose its owner
at all, because it IS that person.

Removal is the one act a member may do to themselves: leaving. An admin may
remove members; an owner may remove anyone but the last owner. Every change
is an AuthEvent naming who did what to whom, and a change to a role takes
effect on the next executor token (the session re-reads Membership at every
mint) rather than on the next sign-in.
"""
from django.db import transaction

from accounts.events import record
from accounts.models import AuthEvent

from . import invitations
from .models import RANK, Membership, Role


class Refused(Exception):
    """The reason, said out loud: the caller is a member of the organisation and may know."""

    def __init__(self, reason, status=403):
        super().__init__(reason)
        self.reason = reason
        self.status = status


def listing(org, me):
    """Every membership, the caller marked, owners first then by email."""
    rows = Membership.objects.filter(organization=org).select_related('user')
    rows = sorted(rows, key=lambda m: (-RANK[m.role], m.user.email.lower()))
    return [to_json(m, me) for m in rows]


def to_json(membership, me=None):
    u = membership.user
    return {
        'id': u.pk, 'email': u.email, 'name': u.name, 'role': membership.role,
        'joinedAt': membership.created_at.isoformat(),
        'you': me is not None and u.pk == me.user_id,
    }


def _owners(org):
    return Membership.objects.filter(organization=org, role=Role.OWNER).count()


def _target(org, user_id):
    found = Membership.objects.filter(organization=org, user_id=user_id).select_related('user').first()
    if found is None:
        # Scoped to this organisation: another organisation's member is "not
        # found" here, never a hint that the account exists.
        raise Refused('not found', status=404)
    return found


@transaction.atomic
def change_role(me, user_id, role, request=None):
    """`me` (a Membership) sets another member's role. Returns the row."""
    if role not in RANK:
        raise Refused('unknown role', status=400)
    if me.role != Role.OWNER:
        raise Refused('only an owner changes roles')
    target = _target(me.organization, user_id)
    if target.user_id == me.user_id:
        raise Refused('you cannot change your own role')
    if target.role == role:
        return target
    if target.role == Role.OWNER and _owners(me.organization) <= 1:
        raise Refused('an organisation keeps at least one owner')
    if me.organization.is_personal and target.role == Role.OWNER:
        raise Refused('a personal organisation keeps its owner')
    was = target.role
    target.role = role
    target.save(update_fields=['role'])
    # A grant they can no longer make must not survive as a pending
    # invitation: a demoted owner's outstanding `owner` invitations would
    # otherwise keep landing for the rest of the week [authz-tenancy-5].
    # Acceptance re-checks the cap too; this is so the listing agrees.
    invitations.revoke_ungrantable(me.organization, target.user)
    record(AuthEvent.Kind.MEMBER_ROLE_CHANGED, request, user=me.user,
           org=me.organization.slug, member=target.user_id, was=was, now=role)
    return target


@transaction.atomic
def remove(me, user_id, request=None):
    """`me` removes a member — or leaves, when the id is their own."""
    target = _target(me.organization, user_id)
    leaving = target.user_id == me.user_id
    if target.role == Role.OWNER:
        if me.organization.is_personal:
            raise Refused('a personal organisation keeps its owner')
        if _owners(me.organization) <= 1:
            raise Refused('an organisation keeps at least one owner')
    if not leaving:
        if me.role == Role.MEMBER:
            raise Refused('a member removes nobody')
        if me.role == Role.ADMIN and target.role != Role.MEMBER:
            raise Refused('an admin removes members only')
    target.delete()
    # After the delete, so the check sees an inviter who is no longer here:
    # every grant they had outstanding is one nobody can make now.
    invitations.revoke_ungrantable(me.organization, target.user)
    record(AuthEvent.Kind.MEMBER_REMOVED, request, user=me.user,
           org=me.organization.slug, member=target.user_id, role=target.role, left=leaving)
    return target
