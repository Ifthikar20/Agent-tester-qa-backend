"""
The whole surface: /auth for the SPA, /_allauth for allauth's JSON API, and
/admin for people management.

There is no /api here. The runner's API stays on the runner — this service
never proxies it, so the screencast never travels through Django and this
process is never in the hot path of a running test.

The edge (docker/Caddyfile) routes exactly /auth/*, /_allauth/*, /admin/* and
the Google callback to this service; a new prefix here is a new line there.
"""
from allauth.account.decorators import secure_admin_login
from allauth.headless.constants import Client
from django.contrib import admin
from django.urls import include, path

from accounts import google, headless

# Django's own admin login form is removed: an anonymous visit to /admin/ is
# sent to the SPA's sign-in (LOGIN_URL), and only a session that came through
# allauth's rate-limited, verified — and, once the mfa step lands,
# MFA-enforcing — flow comes back as staff [credentials-1] [ops-supply-6].
admin.autodiscover()
admin.site.login = secure_admin_login(admin.site.login)

# The three views this project adds a rule to, mounted at allauth's own paths
# AHEAD of allauth's include, so Django resolves the subclass first. Same
# path, same client, same response shapes — accounts/headless.py says what
# each adds.
HEADLESS = '_allauth/browser/v1/'
OURS = [
    path(f'{HEADLESS}auth/login', headless.LoginView.as_api_view(client=Client.BROWSER)),
    path(f'{HEADLESS}auth/signup', headless.SignupView.as_api_view(client=Client.BROWSER)),
    path(f'{HEADLESS}auth/password/request', headless.RequestPasswordResetView.as_api_view(client=Client.BROWSER)),
]

urlpatterns = [
    path('admin/', admin.site.urls),
    path('auth/', include('accounts.urls')),
    # Organisations share the prefix: the edge routes /auth/* to this service
    # as one block (docker/Caddyfile), and a second prefix would be a second
    # line to keep in step there.
    path('auth/', include('tenants.urls')),
    *OURS,
    path('_allauth/', include('allauth.headless.urls')),
    # Google's callback, and ONLY the callback (docs/AUTH.md §6). allauth's
    # provider URLs would also mount /accounts/google/login/ (a sign-in
    # started by a GET) and /accounts/google/login/token/ (One Tap, which is
    # csrf-exempt by design); neither exists here at all, so the edge's
    # exact route for this one path is a second wall and not the only one.
    # The name is the one allauth reverses to build the redirect_uri.
    path('accounts/google/login/callback/', google.callback, name='google_callback'),
]
