"""
ghostclick's control plane: identity, and nothing else.

This project knows about people. It does not know what a test case is, it has
never heard of an origin allowlist, and it holds no secret values — the executor
owns all of that and re-checks it locally, so that compromising this service
cannot turn into driving someone's browser at a page of your choosing.

Django is here for exactly one reason: SSO. Everything below is ordinary
username-and-password today, but django-allauth or djangosaml2 slot in behind
the same four endpoints without changing a line on the executor side, and that
is the whole argument for a batteries-included framework over hand-rolling
sessions.

Two profiles, switched by configuration and never by editing this file:

  laptop      no GC_PUBLIC_URL. SQLite, an in-process cache, mail to the
              console, plain cookies on localhost. `npm run app --auth`.
  production  GC_PUBLIC_URL is set. Every host, origin and cookie rule is
              DERIVED from that one URL so the values that used to have to
              agree cannot disagree; Postgres and Redis are required; the
              module refuses to import with anything that only looks safe.

Environment (see .env.example):

  DJANGO_SECRET_KEY   session and CSRF signing. Required when DEBUG is off.
  DJANGO_DEBUG        1 while developing; 0 anywhere real.
  GC_PUBLIC_URL       how the browser reaches the edge, e.g. https://app.example.com.
                      Setting it is what turns the production profile on.
  DJANGO_ALLOWED_HOSTS  laptop only; ignored once GC_PUBLIC_URL is set. Never '*'.
  DATABASE_URL        postgres://… in production. Absent, SQLite (laptop only).
  GC_REDIS_URL        redis://… for the cache the rate limits live in.
                      Absent, an in-process cache (laptop only).
  DJANGO_EMAIL_BACKEND, EMAIL_HOST, EMAIL_PORT, EMAIL_HOST_USER,
  EMAIL_HOST_PASSWORD, EMAIL_USE_TLS, DEFAULT_FROM_EMAIL
                      where mail goes. The console while developing; SMTP
                      when DEBUG is off, and then EMAIL_HOST is required.
  GC_SIGNING_KEY      the Ed25519 private key executor tokens are signed with,
                      as a one-line PEM. `manage.py signing_key --new` prints
                      it and the public half the runner is given. Without it
                      tokens cannot be minted and /auth/executor-token says so.
  GC_WEB_ORIGIN       laptop only: where the UI is served from, for CORS and
                      CSRF. In production the UI is the same origin as this.
  GC_TOKEN_TTL        seconds an executor token is good for (default 600).
  GC_SIGNUP_MODE      who may sign up: invite (default), open, or domain.
  GC_SIGNUP_DOMAINS   for domain mode, the email domains allowed, comma-separated.
  GC_TURNSTILE_SECRET, GC_TURNSTILE_SITE_KEY
                      Cloudflare Turnstile. Set both and sign-up in open mode,
                      and sign-in from an address that has tripped the failed
                      login limit, require a widget token. Unset, nothing
                      asks for one.
"""
from pathlib import Path
from urllib.parse import urlsplit
import os

import dj_database_url
from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent.parent


def env_bool(name, default=False):
    return os.environ.get(name, '1' if default else '0').strip().lower() in {'1', 'true', 'yes', 'on'}


def env_list(name, default=''):
    return [v.strip() for v in os.environ.get(name, default).split(',') if v.strip()]


DEBUG = env_bool('DJANGO_DEBUG', True)

# A generated-and-forgotten key silently invalidates every session on restart,
# which reads as "the login is broken" rather than "the key moved". So: explicit
# in production, and a fixed, obviously-fake one while developing.
SECRET_KEY = os.environ.get('DJANGO_SECRET_KEY') or ''
if not SECRET_KEY:
    if not DEBUG:
        raise ImproperlyConfigured('DJANGO_SECRET_KEY must be set when DJANGO_DEBUG is off')
    SECRET_KEY = 'dev-only-insecure-key-do-not-use-outside-your-laptop'

# ---------------------------------------------------------------- the address
#
# One URL, and everything about hosts, origins and cookies is computed from it.
# The previous shape had four values (allowed hosts, the CSRF origin, the CORS
# origin, the cookie flags) that all had to agree with how the box was reached,
# and a deployment where they did not agree failed with a 403 that read like a
# bug. Now they cannot disagree, because there is only one of them to set.
PUBLIC_URL = os.environ.get('GC_PUBLIC_URL', '').strip().rstrip('/')
PUBLIC_HOST = urlsplit(PUBLIC_URL).hostname if PUBLIC_URL else None
IS_HTTPS = PUBLIC_URL.startswith('https://')
if PUBLIC_URL and (not PUBLIC_HOST or not PUBLIC_URL.startswith(('http://', 'https://'))):
    raise ImproperlyConfigured(f'GC_PUBLIC_URL must look like https://host, not {PUBLIC_URL!r}')

if PUBLIC_URL:
    ALLOWED_HOSTS = [PUBLIC_HOST]
else:
    ALLOWED_HOSTS = env_list('DJANGO_ALLOWED_HOSTS', 'localhost,127.0.0.1,[::1]')

# '*' passes every Host header, and the Host header is what password-reset
# links and absolute redirects are built from. Behind an edge that already
# pins the host it is only ever a way to be lied to, so it is refused outright
# rather than warned about — a warning at boot is read by nobody.
if not DEBUG and '*' in ALLOWED_HOSTS:
    raise ImproperlyConfigured(
        "DJANGO_ALLOWED_HOSTS='*' is refused when DJANGO_DEBUG is off. Set GC_PUBLIC_URL "
        'and the host is derived from it.'
    )

INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'corsheaders',
    # django-allauth owns sign-up, sign-in, verification, reset and the email
    # and password changes, reached by the SPA through its headless JSON API
    # under /_allauth/. Nothing here re-implements a login form.
    'allauth',
    'allauth.account',
    'allauth.headless',
    'accounts',
    'tenants',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    # Ahead of CommonMiddleware, as django-cors-headers requires, so that a
    # preflight is answered rather than redirected.
    'corsheaders.middleware.CorsMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    # After the CSRF middleware, so its response phase runs after Django has
    # rotated the token: the SPA reads the fresh value from a header.
    'accounts.middleware.CsrfTokenHeader',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'allauth.account.middleware.AccountMiddleware',
    # Directly after authentication and before any view: a session past its
    # absolute lifetime must never reach code that trusts request.user.
    'accounts.middleware.AbsoluteSessionLifetime',
    # And a session whose password Have I Been Pwned knows may do one thing:
    # change it.
    'accounts.middleware.PasswordChangeRequired',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

# allauth's backend and only allauth's: it extends Django's ModelBackend, so
# the admin's permission checks still work, and it is the one that looks a
# person up by the email addresses it verified. Listing ModelBackend beside
# it would run the hasher twice on every wrong password.
AUTHENTICATION_BACKENDS = ['allauth.account.auth_backends.AuthenticationBackend']

ROOT_URLCONF = 'config.urls'

TEMPLATES = [{
    'BACKEND': 'django.template.backends.django.DjangoTemplates',
    # The project's templates first: the mails under templates/ override
    # allauth's of the same name (its base greets "Hello from <site>!"; this
    # product has a name), and app directories are searched after.
    'DIRS': [BASE_DIR / 'templates'],
    'APP_DIRS': True,
    'OPTIONS': {'context_processors': [
        'django.template.context_processors.request',
        'django.contrib.auth.context_processors.auth',
        'django.contrib.messages.context_processors.messages',
    ]},
}]

WSGI_APPLICATION = 'config.wsgi.application'
ASGI_APPLICATION = 'config.asgi.application'

# ---------------------------------------------------------------- the database
#
# Postgres in production, named by DATABASE_URL. SQLite is still the laptop
# default because `npm run app --auth` should not need a database server, but
# it is refused when DEBUG is off: the failure it prevents is a deploy whose
# Postgres variable went missing, which would then create an empty SQLite file
# inside the container, come up healthy, and have no accounts in it.
DATABASE_URL = os.environ.get('DATABASE_URL', '').strip()
if DATABASE_URL:
    DATABASES = {'default': dj_database_url.parse(DATABASE_URL, conn_max_age=60, conn_health_checks=True)}
else:
    if not DEBUG:
        raise ImproperlyConfigured('DATABASE_URL (postgres://…) is required when DJANGO_DEBUG is off')
    DATABASES = {
        'default': {
            'ENGINE': 'django.db.backends.sqlite3',
            'NAME': os.environ.get('DJANGO_DB_PATH') or (BASE_DIR / 'db.sqlite3'),
        }
    }

# ---------------------------------------------------------------- the cache
#
# Rate limits are counters in this cache. An in-process cache gives each
# gunicorn worker its own counters, so a limit of five attempts is really five
# per worker, and a restart resets all of them — which is a rate limit in the
# settings file and not in the world. Redis is shared and survives, so it is
# the only backend the production profile accepts.
REDIS_URL = os.environ.get('GC_REDIS_URL', '').strip()
if REDIS_URL:
    CACHES = {'default': {
        'BACKEND': 'django.core.cache.backends.redis.RedisCache',
        'LOCATION': REDIS_URL,
    }}
else:
    CACHES = {'default': {'BACKEND': 'django.core.cache.backends.locmem.LocMemCache'}}
if not DEBUG and CACHES['default']['BACKEND'].endswith('LocMemCache'):
    raise ImproperlyConfigured(
        'the cache is LocMemCache and DJANGO_DEBUG is off: rate limits would be per-process '
        'and reset on restart. Set GC_REDIS_URL.'
    )

# ---------------------------------------------------------------- mail
#
# Verification codes and reset links go through here, so an unconfigured mail
# backend is a sign-up nobody can complete. The console while developing; SMTP
# otherwise, and then a missing EMAIL_HOST is refused at import rather than
# discovered by the first person who tries to reset a password. An operator
# who genuinely wants mail in the container log for a demo says so by naming
# the console backend explicitly.
EMAIL_BACKEND = os.environ.get('DJANGO_EMAIL_BACKEND', '').strip() or (
    'django.core.mail.backends.console.EmailBackend' if DEBUG
    else 'django.core.mail.backends.smtp.EmailBackend'
)
EMAIL_HOST = os.environ.get('EMAIL_HOST', '').strip()
EMAIL_PORT = int(os.environ.get('EMAIL_PORT', '587'))
EMAIL_HOST_USER = os.environ.get('EMAIL_HOST_USER', '')
EMAIL_HOST_PASSWORD = os.environ.get('EMAIL_HOST_PASSWORD', '')
EMAIL_USE_TLS = env_bool('EMAIL_USE_TLS', True)
EMAIL_USE_SSL = env_bool('EMAIL_USE_SSL', False)
EMAIL_TIMEOUT = 10
DEFAULT_FROM_EMAIL = os.environ.get('DEFAULT_FROM_EMAIL', '').strip() or f'ghostclick <no-reply@{PUBLIC_HOST or "localhost"}>'
SERVER_EMAIL = DEFAULT_FROM_EMAIL
if EMAIL_BACKEND.endswith('smtp.EmailBackend') and not EMAIL_HOST:
    raise ImproperlyConfigured(
        'the mail backend is SMTP but EMAIL_HOST is empty. Set EMAIL_HOST (and EMAIL_HOST_USER, '
        'EMAIL_HOST_PASSWORD), or name a different DJANGO_EMAIL_BACKEND on purpose.'
    )

# Email is the login. Set before the first migration, because changing
# AUTH_USER_MODEL afterwards is the one Django migration that is genuinely
# painful — hence a custom model on day one, even though it looks empty.
AUTH_USER_MODEL = 'accounts.User'

# ---------------------------------------------------------------- passwords
#
# Argon2id for everything stored from now on. PBKDF2 stays listed so a hash
# made before this change still verifies; Django rehashes it with the first
# entry the next time that password is checked, so the list is an upgrade
# path and not a choice.
PASSWORD_HASHERS = [
    'django.contrib.auth.hashers.Argon2PasswordHasher',
    'django.contrib.auth.hashers.PBKDF2PasswordHasher',
]

# Length and a breach check, and no composition rules: "one digit and one
# symbol" produces Password1! and forbids a five-word passphrase. The same
# list runs for the admin form, `adduser --password-stdin` and sign-up, so
# there is one definition of an acceptable password rather than three.
AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator', 'OPTIONS': {'min_length': 15}},
    {'NAME': 'accounts.validators.MaximumLengthValidator', 'OPTIONS': {'max_length': 128}},
    # Have I Been Pwned by k-anonymity: five characters of the SHA-1 leave
    # here, never the password. When the API is unreachable the validator
    # falls back to Django's common-password list and logs it; it never
    # blocks a sign-up on someone else's outage.
    {'NAME': 'pwned_passwords_django.validators.PwnedPasswordsValidator'},
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
]
PWNED_PASSWORDS = {'API_TIMEOUT': 3.0}

LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'UTC'
USE_I18N = True
USE_TZ = True

STATIC_URL = 'static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

# ---------------------------------------------------------------- the browser
#
# In production the UI is served by the same edge as this service, so nothing
# is cross-origin and CSRF trusts exactly the public URL. On a laptop the UI is
# on the runner's port and every call here is cross-origin with a cookie, so
# both halves have to be named: a browser refuses a credentialed request
# answered with `*`, and Django refuses a POST from an origin it was not told
# about.
WEB_ORIGIN = os.environ.get('GC_WEB_ORIGIN', '').rstrip('/') or PUBLIC_URL
CORS_ALLOWED_ORIGINS = [WEB_ORIGIN] if WEB_ORIGIN else []
CORS_ALLOW_CREDENTIALS = True
# The rotated CSRF token rides back in this header (accounts.middleware
# .CsrfTokenHeader); cross-origin, a browser hides every header the server
# did not expose by name.
CORS_EXPOSE_HEADERS = ['X-CSRFToken']
CSRF_TRUSTED_ORIGINS = [PUBLIC_URL] if PUBLIC_URL else ([WEB_ORIGIN] if WEB_ORIGIN else [])
# Where the SPA is: every link in an email, and every redirect allauth or
# the admin would make, lands on one of its routes. Empty on a laptop with no
# GC_WEB_ORIGIN at all, which is a laptop with no UI to sign in from.
GC_APP_URL = f'{WEB_ORIGIN}/app' if WEB_ORIGIN else '/app'

# ---------------------------------------------------------------- transport
#
# Behind the edge, the scheme is whatever Caddy says it is: it terminates TLS
# and overwrites X-Forwarded-Proto on every request, and it is the only thing
# that can reach gunicorn. Without GC_PUBLIC_URL there is no edge, so the
# header is not trusted — a client that could set it would otherwise be able
# to talk Django into believing plain http was secure.
SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https') if PUBLIC_URL else None
USE_X_FORWARDED_HOST = False
SECURE_REFERRER_POLICY = 'strict-origin-when-cross-origin'
# HSTS is emitted by the edge, which is where TLS ends; a second copy here
# would be a second place to get the value wrong. SECURE_SSL_REDIRECT likewise:
# Caddy answers http with a redirect before this process ever sees it.
SECURE_HSTS_SECONDS = 0
SECURE_SSL_REDIRECT = False

# The number of proxies whose X-Forwarded-For entry is honest. One: Caddy
# REPLACES the header with the address it accepted the connection from, so the
# last entry is the client and nothing a client sends can move it. Zero on a
# laptop, where there is no proxy and the peer is the client.
ALLAUTH_TRUSTED_PROXY_COUNT = 1 if PUBLIC_URL else 0

# ---------------------------------------------------------------- cookies
if PUBLIC_URL:
    # Secure follows the scheme rather than a flag, so an http:// demo still
    # signs in and an https:// site never sends the cookie in the clear. The
    # __Host- prefix is the browser's own guarantee that the cookie was set
    # over https, from this host, with no Domain — a subdomain cannot plant
    # one. Both prefixes are refused by browsers over http, hence the switch.
    SESSION_COOKIE_SECURE = CSRF_COOKIE_SECURE = IS_HTTPS
    SESSION_COOKIE_NAME = '__Host-sessionid' if IS_HTTPS else 'sessionid'
    CSRF_COOKIE_NAME = '__Host-csrftoken' if IS_HTTPS else 'csrftoken'
    # Lax, not Strict: the Google sign-in callback is a top-level navigation
    # from another site, and Strict would arrive at it with no session.
    SESSION_COOKIE_SAMESITE = CSRF_COOKIE_SAMESITE = 'Lax'
else:
    # Lax is right whenever the UI and this share a registrable domain —
    # including localhost:3000 and localhost:8000, since ports do not make a
    # site. A UI on a genuinely different site (a vercel.app in front of your
    # own API) needs 'None', and 'None' without Secure is silently dropped by
    # every browser, so the two move together.
    SESSION_COOKIE_SAMESITE = os.environ.get('GC_COOKIE_SAMESITE', 'Lax')
    CSRF_COOKIE_SAMESITE = SESSION_COOKIE_SAMESITE
    SESSION_COOKIE_SECURE = env_bool('GC_COOKIE_SECURE', False) or SESSION_COOKIE_SAMESITE == 'None'
    CSRF_COOKIE_SECURE = SESSION_COOKIE_SECURE
SESSION_COOKIE_HTTPONLY = True

# ---------------------------------------------------------------- sessions
#
# Two clocks. The idle one is Django's: twelve hours since the last request,
# sliding, because SESSION_SAVE_EVERY_REQUEST re-stamps the expiry each time.
# A sliding window alone never ends for a session that keeps being used — a
# stolen cookie stays good as long as the thief keeps using it — so there is
# also an absolute one, seven days from sign-in, enforced by
# accounts.middleware.AbsoluteSessionLifetime from a stamp the login receiver
# writes exactly once.
SESSION_ENGINE = 'django.contrib.sessions.backends.db'
SESSION_COOKIE_AGE = 12 * 3600
SESSION_SAVE_EVERY_REQUEST = True
GC_SESSION_ABSOLUTE_SECONDS = 7 * 24 * 3600

# ---------------------------------------------------------------- rate limits
#
# Read by django-allauth's limiter; defined here so the numbers live beside
# the cache they depend on. Per-IP keys use the client
# address as the edge reports it (ALLAUTH_TRUSTED_PROXY_COUNT above). The
# 'login_failed' entry is the per-account lockout — five in five minutes — and
# is what allauth 65 uses in place of the older ACCOUNT_LOGIN_ATTEMPTS_* pair.
# 'signup' is per address only: allauth applies it before the form is read,
# so there is no email to key on (a "/key" part raises at request time); the
# per-address limit on the code that a sign-up then needs is 'confirm_email'.
ACCOUNT_RATE_LIMITS = {
    'login': '30/m/ip',
    'login_failed': '10/m/ip,5/5m/key',
    'signup': '10/h/ip',
    'reset_password': '20/m/ip,3/m/key',
    'reset_password_from_key': '20/m/ip',
    'confirm_email': '1/10s/key',
    'reauthenticate': '10/m/ip',
    'change_password': '5/m/user',
    'manage_email': '10/m/user',
}
# A TOTP code is good for its thirty seconds and no neighbouring window: the
# tolerance exists for clock drift, and the drift a phone has is zero.
MFA_TOTP_TOLERANCE = 0
# A trusted-device cookie is the one allauth feature that skips the
# second-factor stage, so it is off by name and stays off [mfa-recovery-6].
MFA_TRUST_ENABLED = False
GC_MINT_RATE = '12/10m'       # per session key, on POST /auth/executor-token
GC_ACCEPT_RATE = '10/m/ip'    # invitation acceptance

# ---------------------------------------------------------------- accounts
#
# django-allauth, headless: the SPA talks JSON to /_allauth/browser/v1/ and
# no HTML view of allauth's exists (HEADLESS_ONLY). The rules are docs/AUTH.md
# §4, §5 and §7; each setting below is one of them.
ACCOUNT_ADAPTER = 'accounts.adapters.AccountAdapter'
# Email is the login and there is no username field on the model at all.
ACCOUNT_USER_MODEL_USERNAME_FIELD = None
ACCOUNT_LOGIN_METHODS = {'email'}
ACCOUNT_SIGNUP_FIELDS = ['email*', 'password1*']
ACCOUNT_UNIQUE_EMAIL = True
# A sign-up is an unverified address until a six-digit code proves it, and
# nothing — no session, no membership, no consumed invitation — happens
# before that [credentials-6]. Three wrong codes end the attempt.
ACCOUNT_EMAIL_VERIFICATION = 'mandatory'
ACCOUNT_EMAIL_VERIFICATION_BY_CODE_ENABLED = True
ACCOUNT_EMAIL_VERIFICATION_BY_CODE_MAX_ATTEMPTS = 3
# Six digits, no dashes: the code is read off a phone and typed into a
# field, and digits are the one alphabet that survives that in every
# keyboard and locale. A mail that did not arrive can be asked for again,
# a few times, each one rate limited per address (confirm_email below).
ACCOUNT_EMAIL_VERIFICATION_BY_CODE_FORMAT = {'length': 6, 'numeric': True, 'dashed': False}
ACCOUNT_EMAIL_VERIFICATION_SUPPORTS_RESEND = 3
# "That address already has an account" is never said to the browser: the
# existing-account branch answers exactly like the new-account branch and
# the difference goes to the mailbox instead [credentials-3].
ACCOUNT_PREVENT_ENUMERATION = True
ACCOUNT_EMAIL_UNKNOWN_ACCOUNTS = True
# A password change, a reset and an email change each mail the account.
ACCOUNT_EMAIL_NOTIFICATIONS = True
ACCOUNT_EMAIL_SUBJECT_PREFIX = '[ghostclick] '
# Changing the address is: add the new one, verify it by code, and the old
# one is replaced — two addresses at most, and only during the change.
ACCOUNT_CHANGE_EMAIL = True
ACCOUNT_MAX_EMAIL_ADDRESSES = 2
# Recovery (docs/AUTH.md §7). A reset link is good for an hour and, because
# the token is derived from the password hash, for one use; it does not sign
# you in, so a mailbox thief still has to meet whatever factor the account
# has [mfa-recovery-3]. Changing the password ends the session that changed
# it (and accounts.events flushes the others), so a thief holding a cookie
# does not ride out a password change.
PASSWORD_RESET_TIMEOUT = 3600
ACCOUNT_LOGIN_ON_PASSWORD_RESET = False
ACCOUNT_LOGOUT_ON_PASSWORD_CHANGE = True
ACCOUNT_REAUTHENTICATION_REQUIRED = True
ACCOUNT_REAUTHENTICATION_TIMEOUT = 300
ACCOUNT_LOGIN_BY_CODE_ENABLED = False
ACCOUNT_PASSWORD_RESET_BY_CODE_ENABLED = False

HEADLESS_ONLY = True
HEADLESS_CLIENTS = ('browser',)
# Every link allauth puts in an email points at the SPA, not at a view of
# its own, because there is no view of its own.
HEADLESS_FRONTEND_URLS = {
    'account_login': f'{GC_APP_URL}/login',
    'account_signup': f'{GC_APP_URL}/signup',
    'account_confirm_email': f'{GC_APP_URL}/verify',
    'account_reset_password': f'{GC_APP_URL}/forgot-password',
    'account_reset_password_from_key': f'{GC_APP_URL}/reset-password/{{key}}',
    'socialaccount_login_error': f'{GC_APP_URL}/login',
}
# Django's own admin login form is gone: /admin/ sends an anonymous visitor
# to the SPA's sign-in, and comes back only to a staff session that went
# through the rate-limited, verified, MFA-enforcing flow [ops-supply-6].
LOGIN_URL = HEADLESS_FRONTEND_URLS['account_login']

# Who may sign up (docs/AUTH.md §4). One policy, accounts/policy.py, read by
# the account adapter and, later, the social one, so the two paths cannot
# drift [oauth-5]:
#   invite   only an address with a live invitation
#   open     anyone, behind Turnstile when it is configured
#   domain   only addresses on GC_SIGNUP_DOMAINS (Google: the id_token's hd)
GC_SIGNUP_MODE = os.environ.get('GC_SIGNUP_MODE', 'invite').strip().lower() or 'invite'
if GC_SIGNUP_MODE not in ('invite', 'open', 'domain'):
    raise ImproperlyConfigured(f'GC_SIGNUP_MODE must be invite, open or domain, not {GC_SIGNUP_MODE!r}')
GC_SIGNUP_DOMAINS = [d.lower().lstrip('@') for d in env_list('GC_SIGNUP_DOMAINS')]
if GC_SIGNUP_MODE == 'domain' and not GC_SIGNUP_DOMAINS:
    raise ImproperlyConfigured('GC_SIGNUP_MODE=domain needs GC_SIGNUP_DOMAINS (comma-separated)')

# Cloudflare Turnstile [credentials-1]. With both halves set, open-mode
# sign-up always presents a token and sign-in does so for an hour from any
# address that tripped the failed-login limit. The site key is public and
# the SPA reads it from GET /auth/config; the secret verifies tokens here
# and nowhere else. Unset, neither endpoint asks.
GC_TURNSTILE_SECRET = os.environ.get('GC_TURNSTILE_SECRET', '').strip()
GC_TURNSTILE_SITE_KEY = os.environ.get('GC_TURNSTILE_SITE_KEY', '').strip()
if bool(GC_TURNSTILE_SECRET) != bool(GC_TURNSTILE_SITE_KEY):
    raise ImproperlyConfigured('GC_TURNSTILE_SECRET and GC_TURNSTILE_SITE_KEY are set together or not at all')
GC_TURNSTILE_HOURS = 1

# ---------------------------------------------------------------- the executor
#
# The Ed25519 private key this service signs executor tokens with. The runner
# holds only the public half (GC_AUTH_PUBLIC_KEYS), so nothing outside this
# process can produce a signature. `manage.py signing_key --new` prints both
# halves. There is deliberately no default and no generated-and-forgotten
# key: a fallback would reach production unnoticed, and a key regenerated on
# restart would refuse every token the runner still trusts. Missing on a
# laptop means /auth/executor-token answers 503 and says so; missing with
# DEBUG off is refused at import, because a control plane nobody can mint
# from would otherwise come up healthy.
#
# The PEM arrives on one line with literal "\n" between its lines (an env
# file cannot hold a newline); accounts.tokens.unescape turns those back.
GC_SIGNING_KEY = os.environ.get('GC_SIGNING_KEY', '')
if GC_SIGNING_KEY and 'PRIVATE KEY' not in GC_SIGNING_KEY:
    raise ImproperlyConfigured(
        'GC_SIGNING_KEY does not look like a PEM private key. It is the output of '
        '`manage.py signing_key --new`, on one line, with \\n between the PEM lines.'
    )
if not DEBUG and not GC_SIGNING_KEY:
    raise ImproperlyConfigured(
        'GC_SIGNING_KEY is required when DJANGO_DEBUG is off: without it no executor token '
        'can be minted. `manage.py signing_key --new` prints one, and the public half for the runner.'
    )
# Clamped to 60–600 rather than trusted: ten minutes is the ceiling on what a
# leaked token is worth, and the runner refuses anything longer anyway, so a
# larger value here would only produce tokens nothing accepts [token-4].
GC_TOKEN_TTL = max(60, min(600, int(os.environ.get('GC_TOKEN_TTL', '600') or 600)))

# ---------------------------------------------------------------- tests
#
# The runner that keeps the suite off the network: see accounts/testing.py.
TEST_RUNNER = 'accounts.testing.Runner'
