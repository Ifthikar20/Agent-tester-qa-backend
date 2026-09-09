from django.apps import AppConfig


class AccountsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "accounts"

    def ready(self):
        # Connect the audit receivers. Importing is what registers them, and
        # nothing else imports the module, so this is the one place it happens.
        from . import events  # noqa: F401
