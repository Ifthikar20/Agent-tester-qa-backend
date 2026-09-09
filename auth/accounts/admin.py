from allauth.socialaccount.models import SocialApp, SocialToken
from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from django.contrib.auth.forms import AdminPasswordChangeForm

from .models import AuthEvent, EmailAddressAdded, PreviousEmail, User

# The Google client is configured from the environment (config/settings.py
# SOCIALACCOUNT_PROVIDERS) and nowhere else. allauth also lets an admin add
# one as a row, and would then refuse to choose between the two; a form that
# takes a client secret is also a second place for that secret to live. No
# tokens are stored (SOCIALACCOUNT_STORE_TOKENS), so that table is empty and
# a screen for it would only invite the question. SocialAccount stays: which
# Google identity opens which account is exactly what an operator looks up.
admin.site.unregister(SocialApp)
admin.site.unregister(SocialToken)


@admin.register(User)
class UserAdmin(BaseUserAdmin):
    """
    Django's admin, which is most of why this service is Django at all: adding
    a colleague is a form, not a script someone has to write.
    """
    change_password_form = AdminPasswordChangeForm
    ordering = ['email']
    list_display = ['email', 'name', 'is_active', 'is_staff', 'date_joined']
    list_filter = ['is_active', 'is_staff', 'is_superuser']
    search_fields = ['email', 'name']
    fieldsets = [
        (None, {'fields': ['email', 'password']}),
        ('Personal', {'fields': ['name']}),
        ('Permissions', {'fields': ['is_active', 'is_staff', 'is_superuser', 'groups', 'user_permissions']}),
        ('Dates', {'fields': ['last_login', 'date_joined']}),
    ]
    add_fieldsets = [
        (None, {'classes': ['wide'], 'fields': ['email', 'name', 'password1', 'password2']}),
    ]

    # The two fields that make an account able to do anything in this admin
    # are editable only by an account that already can do everything. A staff
    # user with change permission on User could otherwise tick is_superuser on
    # their own row, and "staff" would mean "superuser after one click"
    # [authz-tenancy-6]. Read-only fields are dropped from the form, so a
    # posted value is ignored rather than merely hidden.
    SUPERUSER_ONLY = ['is_superuser', 'user_permissions']

    def get_readonly_fields(self, request, obj=None):
        fields = list(super().get_readonly_fields(request, obj))
        if not request.user.is_superuser:
            fields += self.SUPERUSER_ONLY
        return fields


@admin.register(AuthEvent)
class AuthEventAdmin(admin.ModelAdmin):
    """
    Readable, searchable, and not editable: an audit log that an admin can
    correct is an audit log that an attacker holding an admin session can tidy.
    """
    list_display = ['at', 'kind', 'user', 'email', 'ip']
    list_filter = ['kind']
    search_fields = ['email', 'ip', 'user__email']
    date_hierarchy = 'at'
    readonly_fields = ['at', 'kind', 'user', 'email', 'ip', 'user_agent', 'detail']

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(PreviousEmail)
class PreviousEmailAdmin(admin.ModelAdmin):
    """
    Readable so an operator can see which address may still reset which
    account this week; editable only by deletion, which is the one thing an
    operator would legitimately do (the owner confirms the change was theirs
    and asks for the window to close early).
    """
    list_display = ['email', 'user', 'replaced_by', 'replaced_at', 'until']
    search_fields = ['email', 'replaced_by', 'user__email']
    readonly_fields = ['user', 'email', 'replaced_by', 'replaced_at', 'until']

    def has_add_permission(self, request):
        return False


@admin.register(EmailAddressAdded)
class EmailAddressAddedAdmin(admin.ModelAdmin):
    """
    Read-only: the stamp says when a claim on an address was made, and the
    purge command is what acts on it. An operator who wants a claim gone
    now deletes the address itself under allauth's Email addresses.
    """
    list_display = ['address', 'at']
    search_fields = ['address__email', 'address__user__email']
    readonly_fields = ['address', 'at']

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False
