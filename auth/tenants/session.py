"""
Which organisation this session is acting for.

The session holds a slug and nothing else; the membership row is looked up
on every use. That is the whole of the rule in docs/AUTH.md §10 — no
endpoint takes an organisation from the client for authorisation — applied
to the one place the client's choice is kept: the choice is remembered, and
re-checked against the table each time before anything is done with it, so
a membership removed an hour ago is a membership that stopped working an
hour ago.
"""
from .models import Membership

ORG_KEY = 'gc_org'


def memberships(user):
    """Every organisation the user may act in, personal first, then by name."""
    rows = Membership.objects.filter(user=user).select_related('organization', 'organization__plan')
    return sorted(rows, key=lambda m: (m.organization.personal_of_id != user.pk, m.organization.name.lower()))


def selected(request, rows=None):
    """
    The membership this session acts under, or None for a user with none.

    Falls back — to the personal organisation, then to any — when the
    remembered slug is not one of the user's memberships any more, and
    writes the fallback back into the session so the next request agrees.
    """
    user = request.user
    if not user.is_authenticated:
        return None
    rows = memberships(user) if rows is None else rows
    if not rows:
        return None
    slug = request.session.get(ORG_KEY)
    found = next((m for m in rows if m.organization.slug == slug), None)
    if found is None:
        found = rows[0]
        request.session[ORG_KEY] = found.organization.slug
    return found


def select(request, slug):
    """Switch to `slug` if the user is a member of it. The membership, or None."""
    rows = memberships(request.user)
    found = next((m for m in rows if m.organization.slug == slug), None)
    if found is not None:
        request.session[ORG_KEY] = found.organization.slug
    return found


def describe(request):
    """The organisation half of /auth/me: {org, orgs, entitlements}."""
    rows = memberships(request.user)
    current = selected(request, rows)
    return {
        'org': _brief(current) if current else None,
        'orgs': [_brief(m) for m in rows],
        'entitlements': current.organization.entitlements() if current else {},
    }


def _brief(membership):
    org = membership.organization
    return {'slug': org.slug, 'name': org.name, 'role': membership.role, 'personal': org.is_personal, 'plan': org.plan.slug}
