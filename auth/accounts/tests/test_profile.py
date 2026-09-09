"""
The production profile, derived from one URL — and the refusals.

These import config.settings in a SUBPROCESS with a chosen environment and
print what came out, because the settings module is imported once per
process and the rules under test are the ones that raise at import. A test
that could not exercise "this configuration refuses to start" would be
testing the easy half.
"""
import json
import os
import subprocess
import sys

from django.test import SimpleTestCase

from . import keys

AUTH_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Everything the settings module reads. Stripped from the inherited
# environment so the test decides each one, then re-added per case.
OURS = ('DJANGO_', 'GC_', 'DATABASE_URL', 'EMAIL_', 'DEFAULT_FROM_EMAIL')

KEYS = [
    'DEBUG', 'ALLOWED_HOSTS', 'CSRF_TRUSTED_ORIGINS', 'CORS_ALLOWED_ORIGINS',
    'SECURE_PROXY_SSL_HEADER', 'USE_X_FORWARDED_HOST',
    'SESSION_COOKIE_SECURE', 'CSRF_COOKIE_SECURE', 'SESSION_COOKIE_NAME', 'CSRF_COOKIE_NAME',
    'SESSION_COOKIE_SAMESITE', 'CSRF_COOKIE_SAMESITE', 'SESSION_COOKIE_HTTPONLY',
    'SESSION_COOKIE_AGE', 'SESSION_SAVE_EVERY_REQUEST', 'SESSION_ENGINE', 'GC_SESSION_ABSOLUTE_SECONDS',
    'SECURE_REFERRER_POLICY', 'SECURE_HSTS_SECONDS', 'SECURE_SSL_REDIRECT',
    'ALLAUTH_TRUSTED_PROXY_COUNT', 'EMAIL_BACKEND', 'EMAIL_HOST', 'PASSWORD_HASHERS', 'MFA_TOTP_TOLERANCE',
    'GC_TOKEN_TTL', 'GC_SIGNING_KEY',
    'GC_APP_URL', 'LOGIN_URL', 'HEADLESS_ONLY', 'HEADLESS_FRONTEND_URLS', 'HEADLESS_CLIENTS',
    'ACCOUNT_EMAIL_VERIFICATION', 'ACCOUNT_EMAIL_VERIFICATION_BY_CODE_ENABLED', 'ACCOUNT_PREVENT_ENUMERATION',
    'ACCOUNT_LOGOUT_ON_PASSWORD_CHANGE', 'ACCOUNT_LOGIN_ON_PASSWORD_RESET', 'PASSWORD_RESET_TIMEOUT',
    'ACCOUNT_REAUTHENTICATION_TIMEOUT', 'MFA_TRUST_ENABLED', 'GC_SIGNUP_MODE', 'GC_SIGNUP_DOMAINS',
    'GC_TURNSTILE_SECRET', 'GC_TURNSTILE_SITE_KEY', 'AUTHENTICATION_BACKENDS',
    'MFA_SUPPORTED_TYPES', 'MFA_PASSKEY_LOGIN_ENABLED', 'MFA_RECOVERY_CODES_SHOW_ONCE', 'MFA_ADAPTER',
    'GC_WEBAUTHN_ORIGIN', 'USERSESSIONS_TRACK_ACTIVITY', 'GC_MFA_KEY',
]

# A Fernet key: 32 url-safe base64 bytes. Fixed, so the tests can say which one.
MFA_KEY = 'x8m2Xz4c3l4p9RxwXOSczw1vGi6Rq0Tlpi7GRUq0-rQ='

PRODUCTION = {
    'DJANGO_DEBUG': '0',
    'DJANGO_SECRET_KEY': 'a-test-secret-key-that-is-long-enough-0123456789',
    'GC_PUBLIC_URL': 'https://app.example.com',
    'DATABASE_URL': 'postgres://ghostclick:pw@postgres:5432/ghostclick',
    'GC_REDIS_URL': 'redis://:pw@redis:6379/0',
    'EMAIL_HOST': 'smtp.example.com',
    # As an env file carries it: one line, backslash-n between the PEM lines.
    'GC_SIGNING_KEY': keys.PRIVATE_ONE_LINE,
    'GC_MFA_KEY': MFA_KEY,
}


def load(env):
    """Import the settings with exactly `env` on top of a scrubbed environment."""
    base = {k: v for k, v in os.environ.items() if not k.startswith(OURS)}
    base['DJANGO_SETTINGS_MODULE'] = 'config.settings'
    base['PYTHONIOENCODING'] = 'utf-8'
    code = (
        'import json\n'
        'from django.conf import settings\n'
        f'print(json.dumps({{k: getattr(settings, k, None) for k in {KEYS!r}}}, default=str))\n'
    )
    done = subprocess.run([sys.executable, '-c', code], cwd=AUTH_DIR, env={**base, **env},
                          capture_output=True, text=True, encoding='utf-8', timeout=60)
    return done


class ProductionProfileTests(SimpleTestCase):
    def test_everything_derives_from_the_public_url(self):
        done = load(PRODUCTION)
        self.assertEqual(done.returncode, 0, done.stderr)
        got = json.loads(done.stdout)
        self.assertEqual(got['ALLOWED_HOSTS'], ['app.example.com'])
        self.assertEqual(got['CSRF_TRUSTED_ORIGINS'], ['https://app.example.com'])
        self.assertEqual(got['SECURE_PROXY_SSL_HEADER'], ['HTTP_X_FORWARDED_PROTO', 'https'])
        self.assertFalse(got['USE_X_FORWARDED_HOST'])
        self.assertTrue(got['SESSION_COOKIE_SECURE'])
        self.assertTrue(got['CSRF_COOKIE_SECURE'])
        self.assertEqual(got['SESSION_COOKIE_NAME'], '__Host-sessionid')
        self.assertEqual(got['CSRF_COOKIE_NAME'], '__Host-csrftoken')
        # Strict would arrive at the Google callback with no session.
        self.assertEqual(got['SESSION_COOKIE_SAMESITE'], 'Lax')
        self.assertEqual(got['CSRF_COOKIE_SAMESITE'], 'Lax')
        self.assertTrue(got['SESSION_COOKIE_HTTPONLY'])
        self.assertEqual(got['SESSION_COOKIE_AGE'], 12 * 3600)
        self.assertTrue(got['SESSION_SAVE_EVERY_REQUEST'])
        self.assertEqual(got['GC_SESSION_ABSOLUTE_SECONDS'], 7 * 24 * 3600)
        self.assertEqual(got['SESSION_ENGINE'], 'django.contrib.sessions.backends.db')
        self.assertEqual(got['SECURE_REFERRER_POLICY'], 'strict-origin-when-cross-origin')
        self.assertEqual(got['ALLAUTH_TRUSTED_PROXY_COUNT'], 1)
        self.assertTrue(got['EMAIL_BACKEND'].endswith('smtp.EmailBackend'))
        self.assertEqual(got['MFA_TOTP_TOLERANCE'], 0)

    def test_the_spa_s_routes_derive_from_the_public_url_too(self):
        # Every link in a mail, and the admin's redirect, land on the SPA at
        # the one origin there is.
        got = json.loads(load(PRODUCTION).stdout)
        self.assertEqual(got['GC_APP_URL'], 'https://app.example.com/app')
        self.assertEqual(got['LOGIN_URL'], 'https://app.example.com/app/login')
        self.assertEqual(got['HEADLESS_FRONTEND_URLS']['account_reset_password_from_key'],
                         'https://app.example.com/app/reset-password/{key}')
        self.assertTrue(got['HEADLESS_ONLY'])
        self.assertEqual(got['HEADLESS_CLIENTS'], ['browser'])

    def test_the_account_rules_are_the_spec_s(self):
        got = json.loads(load(PRODUCTION).stdout)
        self.assertEqual(got['ACCOUNT_EMAIL_VERIFICATION'], 'mandatory')
        self.assertTrue(got['ACCOUNT_EMAIL_VERIFICATION_BY_CODE_ENABLED'])
        self.assertTrue(got['ACCOUNT_PREVENT_ENUMERATION'])
        self.assertTrue(got['ACCOUNT_LOGOUT_ON_PASSWORD_CHANGE'])
        self.assertFalse(got['ACCOUNT_LOGIN_ON_PASSWORD_RESET'])
        self.assertEqual(got['PASSWORD_RESET_TIMEOUT'], 3600)
        self.assertEqual(got['ACCOUNT_REAUTHENTICATION_TIMEOUT'], 300)
        self.assertFalse(got['MFA_TRUST_ENABLED'])
        self.assertEqual(got['GC_SIGNUP_MODE'], 'invite')
        self.assertEqual(got['AUTHENTICATION_BACKENDS'], ['allauth.account.auth_backends.AuthenticationBackend'])

    def test_the_sign_up_mode_is_configuration(self):
        got = json.loads(load({**PRODUCTION, 'GC_SIGNUP_MODE': 'domain', 'GC_SIGNUP_DOMAINS': 'Acme.example, @globex.example'}).stdout)
        self.assertEqual(got['GC_SIGNUP_MODE'], 'domain')
        self.assertEqual(got['GC_SIGNUP_DOMAINS'], ['acme.example', 'globex.example'])
        got = json.loads(load({**PRODUCTION, 'GC_TURNSTILE_SECRET': 's', 'GC_TURNSTILE_SITE_KEY': 'k'}).stdout)
        self.assertEqual((got['GC_TURNSTILE_SECRET'], got['GC_TURNSTILE_SITE_KEY']), ('s', 'k'))

    def test_hsts_is_the_edge_s_job(self):
        # TLS ends at Caddy, which emits HSTS. A second copy here would be a
        # second place for the value to be wrong.
        got = json.loads(load(PRODUCTION).stdout)
        self.assertEqual(got['SECURE_HSTS_SECONDS'], 0)
        self.assertFalse(got['SECURE_SSL_REDIRECT'])

    def test_an_http_demo_still_signs_in(self):
        # Secure cookies are simply not sent over http, so a demo on a bare IP
        # would sign in and stay signed out. The scheme decides.
        got = json.loads(load({**PRODUCTION, 'GC_PUBLIC_URL': 'http://203.0.113.10'}).stdout)
        self.assertEqual(got['ALLOWED_HOSTS'], ['203.0.113.10'])
        self.assertFalse(got['SESSION_COOKIE_SECURE'])
        self.assertEqual(got['SESSION_COOKIE_NAME'], 'sessionid')
        self.assertEqual(got['CSRF_COOKIE_NAME'], 'csrftoken')

    def test_a_trailing_slash_does_not_break_the_origin(self):
        got = json.loads(load({**PRODUCTION, 'GC_PUBLIC_URL': 'https://app.example.com/'}).stdout)
        self.assertEqual(got['CSRF_TRUSTED_ORIGINS'], ['https://app.example.com'])

    def test_the_legacy_hosts_variable_is_ignored_once_the_url_is_set(self):
        # Two sources of truth is the bug this profile exists to remove.
        got = json.loads(load({**PRODUCTION, 'DJANGO_ALLOWED_HOSTS': 'other.example.com'}).stdout)
        self.assertEqual(got['ALLOWED_HOSTS'], ['app.example.com'])


class RefusalTests(SimpleTestCase):
    """Configurations that would come up healthy and be wrong do not come up."""

    def refuses(self, env, *mentions):
        done = load(env)
        self.assertNotEqual(done.returncode, 0, f'it started:\n{done.stdout}')
        for m in mentions:
            self.assertIn(m, done.stderr)

    def test_wildcard_hosts_are_refused_when_debug_is_off(self):
        self.refuses({**PRODUCTION, 'GC_PUBLIC_URL': '', 'DJANGO_ALLOWED_HOSTS': '*'}, "'*'", 'GC_PUBLIC_URL')

    def test_wildcard_hosts_are_fine_on_a_laptop(self):
        done = load({'DJANGO_DEBUG': '1', 'DJANGO_ALLOWED_HOSTS': '*'})
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_an_in_process_cache_is_refused_when_debug_is_off(self):
        # Five attempts per worker, reset on restart, is not a rate limit.
        self.refuses({**PRODUCTION, 'GC_REDIS_URL': ''}, 'LocMemCache', 'GC_REDIS_URL')

    def test_sqlite_is_refused_when_debug_is_off(self):
        self.refuses({**PRODUCTION, 'DATABASE_URL': ''}, 'DATABASE_URL')

    def test_smtp_without_a_host_is_refused(self):
        self.refuses({**PRODUCTION, 'EMAIL_HOST': ''}, 'EMAIL_HOST')

    def test_but_a_backend_named_on_purpose_is_allowed(self):
        done = load({**PRODUCTION, 'EMAIL_HOST': '',
                     'DJANGO_EMAIL_BACKEND': 'django.core.mail.backends.console.EmailBackend'})
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_a_public_url_without_a_scheme_is_refused(self):
        self.refuses({**PRODUCTION, 'GC_PUBLIC_URL': 'app.example.com'}, 'GC_PUBLIC_URL')

    def test_a_missing_secret_key_is_refused(self):
        self.refuses({**PRODUCTION, 'DJANGO_SECRET_KEY': ''}, 'DJANGO_SECRET_KEY')

    def test_a_missing_signing_key_is_refused(self):
        # A control plane nobody can mint from would come up healthy and
        # answer 503 to every token request; the refusal names the command.
        self.refuses({**PRODUCTION, 'GC_SIGNING_KEY': ''}, 'GC_SIGNING_KEY', 'signing_key --new')

    def test_something_that_is_not_a_pem_is_refused_even_on_a_laptop(self):
        self.refuses({'DJANGO_DEBUG': '1', 'GC_SIGNING_KEY': 'not-a-real-secret-just-for-tests'}, 'GC_SIGNING_KEY')

    def test_a_missing_mfa_key_is_refused(self):
        # Without it every TOTP secret would be stored in the clear, which
        # is the row a database dump would then carry [ops-supply-2].
        self.refuses({**PRODUCTION, 'GC_MFA_KEY': ''}, 'GC_MFA_KEY', 'mfa_key')

    def test_something_that_is_not_a_fernet_key_is_refused_even_on_a_laptop(self):
        self.refuses({'DJANGO_DEBUG': '1', 'GC_MFA_KEY': 'not-a-fernet-key'}, 'GC_MFA_KEY')
        # And a rotation set is every key checked, not just the first.
        self.refuses({'DJANGO_DEBUG': '1', 'GC_MFA_KEY': f'{MFA_KEY},short'}, 'GC_MFA_KEY')

    def test_the_mfa_rules_are_the_spec_s(self):
        got = json.loads(load(PRODUCTION).stdout)
        self.assertEqual(got['MFA_SUPPORTED_TYPES'], ['totp', 'recovery_codes', 'webauthn'])
        self.assertTrue(got['MFA_PASSKEY_LOGIN_ENABLED'])
        self.assertTrue(got['MFA_RECOVERY_CODES_SHOW_ONCE'])
        self.assertFalse(got['MFA_TRUST_ENABLED'])
        self.assertEqual(got['MFA_TOTP_TOLERANCE'], 0)
        self.assertEqual(got['MFA_ADAPTER'], 'accounts.adapters.MFAAdapter')
        self.assertTrue(got['USERSESSIONS_TRACK_ACTIVITY'])
        # The passkey origin is the public URL, so the RP ID is its host.
        self.assertEqual(got['GC_WEBAUTHN_ORIGIN'], 'https://app.example.com')
        self.assertEqual(got['GC_MFA_KEY'], MFA_KEY)

    def test_on_a_laptop_the_mfa_key_is_derived_and_stable(self):
        # Nothing set: the same key every start, so an authenticator enrolled
        # yesterday still decrypts today, and never the empty string.
        a = json.loads(load({'DJANGO_DEBUG': '1'}).stdout)['GC_MFA_KEY']
        b = json.loads(load({'DJANGO_DEBUG': '1'}).stdout)['GC_MFA_KEY']
        self.assertEqual(a, b)
        self.assertEqual(len(a), 44)
        self.assertEqual(json.loads(load({'DJANGO_DEBUG': '1', 'GC_WEB_ORIGIN': 'http://localhost:3000'}).stdout)['GC_WEBAUTHN_ORIGIN'],
                         'http://localhost:3000')

    def test_a_sign_up_mode_that_is_not_one_of_the_three_is_refused(self):
        self.refuses({**PRODUCTION, 'GC_SIGNUP_MODE': 'anyone'}, 'GC_SIGNUP_MODE')

    def test_domain_mode_without_domains_is_refused(self):
        # It would admit nobody and look like a working sign-up page.
        self.refuses({**PRODUCTION, 'GC_SIGNUP_MODE': 'domain'}, 'GC_SIGNUP_DOMAINS')

    def test_half_a_turnstile_is_refused(self):
        # A secret with no site key asks every visitor for a token the page
        # cannot render; a site key with no secret renders a widget nothing
        # checks.
        self.refuses({**PRODUCTION, 'GC_TURNSTILE_SECRET': 's'}, 'GC_TURNSTILE_SITE_KEY')
        self.refuses({**PRODUCTION, 'GC_TURNSTILE_SITE_KEY': 'k'}, 'GC_TURNSTILE_SECRET')

    def test_the_token_lifetime_is_clamped(self):
        # Ten minutes is the ceiling on what a leaked token is worth; the
        # runner refuses anything longer, so a bigger value here would only
        # mint tokens nothing accepts [token-4].
        self.assertEqual(json.loads(load({**PRODUCTION, 'GC_TOKEN_TTL': '86400'}).stdout)['GC_TOKEN_TTL'], 600)
        self.assertEqual(json.loads(load({**PRODUCTION, 'GC_TOKEN_TTL': '5'}).stdout)['GC_TOKEN_TTL'], 60)
        self.assertEqual(json.loads(load({**PRODUCTION, 'GC_TOKEN_TTL': '300'}).stdout)['GC_TOKEN_TTL'], 300)


class LaptopProfileTests(SimpleTestCase):
    def test_nothing_set_is_the_laptop(self):
        done = load({})
        self.assertEqual(done.returncode, 0, done.stderr)
        got = json.loads(done.stdout)
        self.assertTrue(got['DEBUG'])
        # No key is fine on a laptop: the mint endpoint says so when asked.
        self.assertEqual(got['GC_SIGNING_KEY'], '')
        self.assertEqual(got['ALLOWED_HOSTS'], ['localhost', '127.0.0.1', '[::1]'])
        self.assertIsNone(got['SECURE_PROXY_SSL_HEADER'])
        self.assertFalse(got['SESSION_COOKIE_SECURE'])
        self.assertEqual(got['SESSION_COOKIE_NAME'], 'sessionid')
        # No edge, so no proxy is trusted and the peer is the client.
        self.assertEqual(got['ALLAUTH_TRUSTED_PROXY_COUNT'], 0)
        self.assertTrue(got['EMAIL_BACKEND'].endswith('console.EmailBackend'))
        # The clocks apply on a laptop too; they are not a production feature.
        self.assertEqual(got['SESSION_COOKIE_AGE'], 12 * 3600)
        self.assertEqual(got['GC_SESSION_ABSOLUTE_SECONDS'], 7 * 24 * 3600)

    def test_argon2_is_first_and_pbkdf2_is_kept_for_old_hashes(self):
        got = json.loads(load({}).stdout)
        self.assertTrue(got['PASSWORD_HASHERS'][0].endswith('Argon2PasswordHasher'))
        self.assertTrue(got['PASSWORD_HASHERS'][1].endswith('PBKDF2PasswordHasher'))
        self.assertEqual(len(got['PASSWORD_HASHERS']), 2)
