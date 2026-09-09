"""
The whole surface: /auth for the SPA, and the admin for people management.

There is no /api here. The runner's API stays on the runner — this service
never proxies it, so the screencast never travels through Django and this
process is never in the hot path of a running test.

The admin's path comes from GC_ADMIN_PATH and defaults to 'admin' for local
development. In production it is set to something unguessable and nginx proxies
only that path, returning 404 for /admin/ — see docker/nginx.conf.template.
"""
from django.conf import settings
from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path(settings.GC_ADMIN_PATH, admin.site.urls),
    path('auth/', include('accounts.urls')),
]
