"""
The whole surface: /auth for the SPA, /admin for people management.

There is no /api here. The runner's API stays on the runner — this service
never proxies it, so the screencast never travels through Django and this
process is never in the hot path of a running test.
"""
from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path('admin/', admin.site.urls),
    path('auth/', include('accounts.urls')),
    # Organisations share the prefix: the edge routes /auth/* to this service
    # as one block (docker/Caddyfile), and a second prefix would be a second
    # line to keep in step there.
    path('auth/', include('tenants.urls')),
]
