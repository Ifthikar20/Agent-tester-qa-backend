from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from django.contrib.auth.forms import AdminPasswordChangeForm

from .models import AuthEvent, User


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
