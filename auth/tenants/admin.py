from django.contrib import admin

from . import switches
from .models import Invitation, Membership, Organization, Plan, Switch


@admin.register(Plan)
class PlanAdmin(admin.ModelAdmin):
    list_display = ['slug', 'name', 'entitlements']
    # Editing a plan re-versions every organisation on it (Plan.save), which
    # the runner reads as "fetch a new token before the old one runs out".
    # The admin form runs clean(), so a plan that forgets a key is refused
    # rather than stored.


class MembershipInline(admin.TabularInline):
    model = Membership
    extra = 0
    autocomplete_fields = ['user']
    readonly_fields = ['created_at']


class InvitationInline(admin.TabularInline):
    """
    Visible so an admin can see who was invited and revoke; not creatable
    here, because a row made in a form has no token — the raw token exists
    only in the return value of tenants.invitations.issue, which also
    applies the role cap that a form would not.
    """
    model = Invitation
    extra = 0
    fields = ['email', 'role', 'invited_by', 'expires_at', 'accepted_at', 'accepted_by', 'revoked_at']
    readonly_fields = ['email', 'role', 'invited_by', 'expires_at', 'accepted_at', 'accepted_by']

    def has_add_permission(self, request, obj=None):
        return False


@admin.register(Organization)
class OrganizationAdmin(admin.ModelAdmin):
    list_display = ['slug', 'name', 'plan', 'entitlements_version', 'personal_of']
    list_filter = ['plan']
    search_fields = ['slug', 'name', 'personal_of__email']
    # Bumped by save(); a hand-set value would be a version the runner has
    # possibly already seen.
    readonly_fields = ['entitlements_version', 'created_at']
    autocomplete_fields = ['personal_of']
    inlines = [MembershipInline, InvitationInline]


@admin.register(Switch)
class SwitchAdmin(admin.ModelAdmin):
    """
    The half of tenants/switches.py that changes without a restart. A row with
    `enabled` unticked turns its feature off for everybody; ticking it, or
    deleting the row, turns it back on — unless GC_SWITCHES_OFF names the key,
    which no row overrides, and the environment column says when that is so.
    Saving or deleting re-versions every organisation (tenants.models), which
    is how a runner switch reaches a runner that never reads this table.
    """
    list_display = ['key', 'enabled', 'environment', 'reason', 'updated_at']
    fields = ['key', 'enabled', 'reason', 'updated_at']
    readonly_fields = ['updated_at']

    @admin.display(description='GC_SWITCHES_OFF')
    def environment(self, obj):
        return 'off, whatever this row says' if obj.key in switches.env_off() else '-'
