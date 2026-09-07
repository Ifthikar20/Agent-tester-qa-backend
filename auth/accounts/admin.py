from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from django.contrib.auth.forms import AdminPasswordChangeForm

from .models import User


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
