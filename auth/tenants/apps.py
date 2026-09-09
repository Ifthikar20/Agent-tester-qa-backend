from django.apps import AppConfig


class TenantsConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'tenants'
    verbose_name = 'organisations'

    def ready(self):
        # The receiver that gives every new account its personal organisation.
        # Importing is what registers it, and nothing else imports the module.
        from . import personal  # noqa: F401
