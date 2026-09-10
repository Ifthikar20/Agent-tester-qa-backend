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
# allauth's rate-limited, verified, MFA-enforcing flow comes back as staff —
# and accounts.middleware.StaffMFARequired sends staff with no authenticator
# to enrol one first [credentials-1] [ops-supply-6].
admin.autodiscover()
admin.site.login = secure_admin_login(admin.site.login)

# The views this project adds a rule to, mounted at allauth's own paths
# AHEAD of allauth's include, so Django resolves the subclass first. Same
# path, same client, same response shapes — accounts/headless.py says what
# each adds.
HEADLESS = '_allauth/browser/v1/'
OURS = [
    path(f'{HEADLESS}auth/login', headless.LoginView.as_api_view(client=Client.BROWSER)),
    path(f'{HEADLESS}auth/signup', headless.SignupView.as_api_view(client=Client.BROWSER)),
    path(f'{HEADLESS}auth/password/request', headless.RequestPasswordResetView.as_api_view(client=Client.BROWSER)),
    # Passkeys: user verification on every ceremony and the origin pinned
    # (docs/AUTH.md §5.7), on the four views that begin one.
    path(f'{HEADLESS}auth/webauthn/authenticate', headless.AuthenticateWebAuthnView.as_api_view(client=Client.BROWSER)),
    path(f'{HEADLESS}auth/webauthn/reauthenticate', headless.ReauthenticateWebAuthnView.as_api_view(client=Client.BROWSER)),
    path(f'{HEADLESS}auth/webauthn/login', headless.LoginWebAuthnView.as_api_view(client=Client.BROWSER)),
    path(f'{HEADLESS}auth/2fa/reauthenticate', headless.ReauthenticateView.as_api_view(client=Client.BROWSER)),
    path(f'{HEADLESS}account/authenticators/webauthn', headless.ManageWebAuthnView.as_api_view(client=Client.BROWSER)),
    path(f'{HEADLESS}account/authenticators/totp', headless.ManageTOTPView.as_api_view(client=Client.BROWSER)),
    path(f'{HEADLESS}auth/sessions', headless.SessionsView.as_api_view(client=Client.BROWSER)),
    # Starting a Google sign-in, so an unsafe callback_url is audited rather
    # than only redirected away from ([oauth-4], §4.6).
    path(f'{HEADLESS}auth/provider/redirect', headless.RedirectToProviderView.as_api_view(client=Client.BROWSER)),
    # And the two headless socialaccount endpoints this deployment does not
    # have. allauth's headless urls mount as one block with no setting to
    # leave them out, so they are shadowed here: `auth/provider/token` is
    # One Tap's door, which §6.4 and [oauth-3] say is not enabled, and
    # `auth/provider/signup` is the other way into a social sign-up that
    # would skip accounts/google.py's wrapper — the one place a refusal is
    # normalised to a single word and written to the audit log.
    path(f'{HEADLESS}auth/provider/token', headless.absent),
    path(f'{HEADLESS}auth/provider/signup', headless.absent),
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
