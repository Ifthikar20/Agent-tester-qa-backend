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
  GC_AUTH_SECRET      shared with the executor. Without it, tokens cannot be
                      minted and /auth/executor-token says so plainly.
  GC_WEB_ORIGIN       laptop only: where the UI is served from, for CORS and
                      CSRF. In production the UI is the same origin as this.
  GC_TOKEN_TTL        seconds an executor token is good for (default 600).
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
    'accounts',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    # Ahead of CommonMiddleware, as django-cors-headers requires, so that a
    # preflight is answered rather than redirected.
    'corsheaders.middleware.CorsMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    # Directly after authentication and before any view: a session past its
    # absolute lifetime must never reach code that trusts request.user.
    'accounts.middleware.AbsoluteSessionLifetime',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'config.urls'

TEMPLATES = [{
    'BACKEND': 'django.template.backends.django.DjangoTemplates',
    'DIRS': [],
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
CSRF_TRUSTED_ORIGINS = [PUBLIC_URL] if PUBLIC_URL else ([WEB_ORIGIN] if WEB_ORIGIN else [])

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
# Read by django-allauth once the accounts flow installs it; defined here so
# the numbers live beside the cache they depend on. Per-IP keys use the client
# address as the edge reports it (ALLAUTH_TRUSTED_PROXY_COUNT above). The
# 'login_failed' entry is the per-account lockout — five in five minutes — and
# is what allauth 65 uses in place of the older ACCOUNT_LOGIN_ATTEMPTS_* pair.
ACCOUNT_RATE_LIMITS = {
    'login': '30/m/ip',
    'login_failed': '10/m/ip,5/5m/key',
    'signup': '10/h/ip,3/h/key',
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
GC_MINT_RATE = '12/10m'       # per session key, on POST /auth/executor-token
GC_ACCEPT_RATE = '10/m/ip'    # invitation acceptance

# ---------------------------------------------------------------- the executor
#
# The key this service signs executor tokens with, shared with the runner. There
# is deliberately no default: a fallback secret is one that reaches production
# unnoticed, because everything keeps working. Missing means tokens cannot be
# minted, and the endpoint says exactly that.
GC_AUTH_SECRET = os.environ.get('GC_AUTH_SECRET', '')
GC_TOKEN_TTL = int(os.environ.get('GC_TOKEN_TTL', '600'))

# ---------------------------------------------------------------- tests
#
# The runner that keeps the suite off the network: see accounts/testing.py.
TEST_RUNNER = 'accounts.testing.Runner'
