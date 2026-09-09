"""
The organisation endpoints, all under /auth.

  POST   /auth/org                     {org: slug}         switch this session's organisation
  GET    /auth/invitations                                 the selected organisation's invitations
  POST   /auth/invitations             {email, role}       issue one; the token is in the answer, once
  DELETE /auth/invitations/<id>                            revoke one
  POST   /auth/invitations/accept      {token}             become a member

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

from . import invitations, session
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
    role = str(data.get('role') or Role.MEMBER)
    try:
        invitation, raw = invitations.issue(me, str(data.get('email', '')), role, request)
    except invitations.Entitlement as err:
        return JsonResponse({'error': 'entitlement', 'limit': err.limit, 'plan': err.plan}, status=402)
    except invitations.Refused as err:
        # The inviter is a manager of this organisation, so the reason is
        # theirs to know — unlike acceptance, where it is not.
        return JsonResponse({'error': err.reason}, status=403 if err.forbidden else 400)
    return JsonResponse({'ok': True, 'invitation': invitation.to_json(), 'token': raw}, status=201)


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
