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
]
