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

Environment (see .env.example):

  DJANGO_SECRET_KEY   session and CSRF signing. Required when DEBUG is off.
  DJANGO_DEBUG        1 while developing; 0 anywhere real.
  DJANGO_ALLOWED_HOSTS
  GC_AUTH_SECRET      shared with the executor. Without it, tokens cannot be
                      minted and /auth/executor-token says so plainly.
  GC_WEB_ORIGIN       where the UI is served from, for CORS and CSRF.
  GC_TOKEN_TTL        seconds an executor token is good for (default 600).
  GC_ADMIN_PATH       where the admin answers (default 'admin'). Set it to
                      something unguessable on anything internet-facing.
"""
from pathlib import Path
import os

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
        raise RuntimeError('DJANGO_SECRET_KEY must be set when DJANGO_DEBUG is off')
    SECRET_KEY = 'dev-only-insecure-key-do-not-use-outside-your-laptop'

ALLOWED_HOSTS = env_list('DJANGO_ALLOWED_HOSTS', 'localhost,127.0.0.1,[::1]')

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

# SQLite because this is a PoC and the schema is four columns. Postgres is a
# DATABASES change and a migration, not a rewrite — which is the point of
# putting identity in Django rather than in JSON files beside the runner.
DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.sqlite3',
        'NAME': os.environ.get('DJANGO_DB_PATH') or (BASE_DIR / 'db.sqlite3'),
    }
}

# Email is the login. Set before the first migration, because changing
# AUTH_USER_MODEL afterwards is the one Django migration that is genuinely
# painful — hence a custom model on day one, even though it looks empty.
AUTH_USER_MODEL = 'accounts.User'

AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]

LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'UTC'
USE_I18N = True
USE_TZ = True

STATIC_URL = 'static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

# ---------------------------------------------------------------- the browser
#
# The UI is served by something else — the executor today, a static host later —
# so every call here is cross-origin and carries a session cookie. Both halves
# have to be named explicitly: a browser refuses a credentialed request answered
# with `*`, and Django refuses a POST from an origin it was not told about.
WEB_ORIGIN = os.environ.get('GC_WEB_ORIGIN', '').rstrip('/')
CORS_ALLOWED_ORIGINS = [WEB_ORIGIN] if WEB_ORIGIN else []
CORS_ALLOW_CREDENTIALS = True
CSRF_TRUSTED_ORIGINS = [WEB_ORIGIN] if WEB_ORIGIN else []

# Lax is right whenever the UI and this share a registrable domain — including
# localhost:3000 and localhost:8000, since ports do not make a site. A UI on a
# genuinely different site (a vercel.app in front of your own API) needs
# 'None', and 'None' without Secure is silently dropped by every browser, so
# the two move together.
SESSION_COOKIE_SAMESITE = os.environ.get('GC_COOKIE_SAMESITE', 'Lax')
CSRF_COOKIE_SAMESITE = SESSION_COOKIE_SAMESITE
SESSION_COOKIE_SECURE = env_bool('GC_COOKIE_SECURE', False) or SESSION_COOKIE_SAMESITE == 'None'
CSRF_COOKIE_SECURE = SESSION_COOKIE_SECURE
SESSION_COOKIE_HTTPONLY = True

# ---------------------------------------------------------------- the executor
#
# The key this service signs executor tokens with, shared with the runner. There
# is deliberately no default: a fallback secret is one that reaches production
# unnoticed, because everything keeps working. Missing means tokens cannot be
# minted, and the endpoint says exactly that.
GC_AUTH_SECRET = os.environ.get('GC_AUTH_SECRET', '')
GC_TOKEN_TTL = int(os.environ.get('GC_TOKEN_TTL', '600'))

# Where the Django admin answers.
#
# On a box whose port 80 is open to the internet with no TLS, /admin/ is a login
# form anyone can find and sit in front of — there is no lockout here and no
# django-axes in requirements.txt. Moving it somewhere unguessable is not a
# control, it is obscurity, and it is worth having anyway because it costs
# nothing and removes the box from every scan that walks the well-known paths.
#
# Normalised to exactly one trailing slash and no leading one, because Django's
# path() and nginx's location need the two halves spelled differently and a
# mismatch is a 404 that looks like a broken deploy.
GC_ADMIN_PATH = os.environ.get('GC_ADMIN_PATH', 'admin').strip('/') + '/'
