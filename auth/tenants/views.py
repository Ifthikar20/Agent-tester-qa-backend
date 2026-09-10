"""
The organisation endpoints, all under /auth.

  POST   /auth/org                     {org: slug}         switch this session's organisation
  GET    /auth/invitations                                 the selected organisation's invitations
  POST   /auth/invitations             {email, role}       issue one; the token is mailed to the invitee
  DELETE /auth/invitations/<id>                            revoke one
  POST   /auth/invitations/accept      {token}             become a member
  GET    /auth/members                                     the selected organisation's members
  PATCH  /auth/members/<user id>       {role}              an owner sets another member's role
  DELETE /auth/members/<user id>                           remove a member, or leave (your own id)

Which organisation an invitation is for is never in the body: it is the one
this session has selected, checked against Membership on the way in. A body
parameter would be an endpoint that invites people to organisations you name.
"""
import json

from django.conf import settings
from django.http import JsonResponse
from django.views.decorators.http import require_http_methods

from accounts.events import client_ip
from accounts.ratelimit import over

from . import invitations, members, session
from .models import Invitation, Role


def _body(request):
    try:
        data = json.loads(request.body or b'{}')
    except ValueError:
        raise ValueError('the request body is not JSON')
    if not isinstance(data, dict):
        raise ValueError('the request body is not a JSON object')
    return data


def _signed_in(request):
    return request.user.is_authenticated and request.user.is_active


def _whoami(request):
    # accounts.views owns the shape; importing here rather than the other
    # way round keeps accounts the module that knows what a user looks like.
    from accounts.views import whoami
    return whoami(request)


@require_http_methods(['POST'])
def switch(request):
    if not _signed_in(request):
        return JsonResponse({'error': 'Not signed in'}, status=401)
    try:
        slug = str(_body(request).get('org', '')).strip()
    except ValueError as err:
        return JsonResponse({'error': str(err)}, status=400)
    # One answer for "no such organisation" and "not yours": the difference
    # is a list of every slug that exists.
    if not slug or session.select(request, slug) is None:
        return JsonResponse({'error': 'not_a_member'}, status=403)
    return JsonResponse(_whoami(request))


@require_http_methods(['GET', 'POST'])
def invitation_list(request):
    if not _signed_in(request):
        return JsonResponse({'error': 'Not signed in'}, status=401)
    me = session.selected(request)
    if me is None or not me.manages:
        return JsonResponse({'error': 'forbidden'}, status=403)

    if request.method == 'GET':
        rows = Invitation.objects.filter(organization=me.organization).select_related('invited_by')
        return JsonResponse({'org': me.organization.slug, 'invitations': [i.to_json() for i in rows]})

    try:
        data = _body(request)
    except ValueError as err:
        return JsonResponse({'error': str(err)}, status=400)
    # Issuing is counted, and keyed on the manager who asked. members.max
    # bounds how many invitations may be LIVE, which is no bound at all on
    # how many are SENT: revoke-and-reissue in a loop mails arbitrary
    # third-party addresses through this service's mailer, and on a plan
    # whose members.max is null even the per-moment cap is gone. §3 counted
    # acceptance and minting and left the one endpoint that mails strangers
    # uncounted.
    if over('invite', str(request.user.pk), settings.GC_INVITE_RATE):
        return JsonResponse({'error': 'rate_limited'}, status=429)
    role = str(data.get('role') or Role.MEMBER)
    try:
        invitation = invitations.issue(me, str(data.get('email', '')), role, request)
    except invitations.Entitlement as err:
        return JsonResponse({'error': 'entitlement', 'limit': err.limit, 'plan': err.plan}, status=402)
    except invitations.Refused as err:
        # The inviter is a manager of this organisation, so the reason is
        # theirs to know — unlike acceptance, where it is not.
        return JsonResponse({'error': err.reason}, status=403 if err.forbidden else 400)
    # No token in the answer: it went to the invitee's mailbox, which is the
    # one place that proves the address, and an inviter who could read it
    # back could accept on someone's behalf by signing up as them.
    return JsonResponse({'ok': True, 'invitation': invitation.to_json()}, status=201)


@require_http_methods(['DELETE'])
def invitation_revoke(request, pk):
    if not _signed_in(request):
        return JsonResponse({'error': 'Not signed in'}, status=401)
    me = session.selected(request)
    if me is None or not me.manages:
        return JsonResponse({'error': 'forbidden'}, status=403)
    # Scoped to the selected organisation, so another organisation's id is a
    # 404 and never a hint that it exists.
    found = Invitation.objects.filter(pk=pk, organization=me.organization).first()
    if found is None:
        return JsonResponse({'error': 'not found'}, status=404)
    invitations.revoke(found)
    return JsonResponse({'ok': True, 'invitation': found.to_json()})


@require_http_methods(['POST'])
def invitation_accept(request):
    # Rate limited before anything else — before the sign-in check, so a
    # guessing loop is counted whether or not it bothered to sign in.
    if over('accept', client_ip(request) or '-', settings.GC_ACCEPT_RATE):
        return JsonResponse({'error': 'rate_limited'}, status=429)
    if not _signed_in(request):
        return JsonResponse({'error': 'Not signed in'}, status=401)
    try:
        raw = str(_body(request).get('token', ''))
    except ValueError as err:
        return JsonResponse({'error': str(err)}, status=400)
    try:
        membership = invitations.accept(raw, request.user, request)
    except invitations.Refused:
        return JsonResponse({'error': invitations.REFUSAL}, status=400)
    session.select(request, membership.organization.slug)
    return JsonResponse({'ok': True, **_whoami(request)})


@require_http_methods(['GET'])
def member_list(request):
    """Any member may see who else is in the organisation they are acting for."""
    if not _signed_in(request):
        return JsonResponse({'error': 'Not signed in'}, status=401)
    me = session.selected(request)
    if me is None:
        return JsonResponse({'error': 'no_organisation'}, status=403)
    return JsonResponse({'org': me.organization.slug, 'members': members.listing(me.organization, me)})


@require_http_methods(['PATCH', 'DELETE'])
def member_change(request, user_id):
    """
    Change a role or remove a member (tenants.members). The organisation is
    the session's, the target is looked up inside it, and every refusal is
    said out loud: the caller is a member and may know why.
    """
    if not _signed_in(request):
        return JsonResponse({'error': 'Not signed in'}, status=401)
    me = session.selected(request)
    if me is None:
        return JsonResponse({'error': 'no_organisation'}, status=403)
    try:
        if request.method == 'PATCH':
            role = str(_body(request).get('role', '')).strip()
            row = members.change_role(me, user_id, role, request)
            return JsonResponse({'ok': True, 'member': members.to_json(row, me)})
        row = members.remove(me, user_id, request)
        # Leaving means the session's selected organisation is gone; whoami
        # falls back to the personal one, and the answer says so.
        return JsonResponse({'ok': True, 'removed': row.user_id, 'left': row.user_id == me.user_id, **_whoami(request)})
    except ValueError as err:
        return JsonResponse({'error': str(err)}, status=400)
    except members.Refused as err:
        return JsonResponse({'error': err.reason}, status=err.status)
