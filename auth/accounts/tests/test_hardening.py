"""
The edge-facing rules (accounts/middleware.py): the request id and trace, the
request log, the security headers, CORS for the two new headers, the request
limit — and the settings that refuse to start with any of them misread.
"""
import json
import logging
import os
import re
import subprocess
import sys

from django.contrib.sessions.models import Session
from django.core.cache import cache
from django.test import Client, RequestFactory, SimpleTestCase, TestCase, override_settings

from .. import ratelimit
from ..events import PWNED, record
from ..logs import JsonFormatter, RequestId, TextFormatter
from ..middleware import SecurityHeaders, bucket, request_id, trace_of
from ..models import AuthEvent
from .support import HEADLESS, Api, make_user
from .test_profile import AUTH_DIR, OURS, load

UUID4 = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}')
TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'
SAMPLED = f'00-{TRACE}-00f067aa0ba902b7-01'
UNSAMPLED = f'00-{TRACE}-00f067aa0ba902b7-00'
WEB = 'http://localhost:3000'
AWAY = '203.0.113.7'


class RequestIdTests(TestCase):
    def test_one_is_made_when_none_was_sent(self):
        r = Client().get('/auth/csrf')
        self.assertRegex(r['X-Request-Id'], UUID4)
        self.assertNotEqual(r['X-Request-Id'], Client().get('/auth/csrf')['X-Request-Id'])

    def test_a_good_one_is_repeated_back(self):
        r = Client().get('/auth/config', HTTP_X_REQUEST_ID='edge-01.req:7_abc')
        self.assertEqual(r['X-Request-Id'], 'edge-01.req:7_abc')

    def test_anything_else_is_replaced(self):
        for bad in ('short', 'x' * 129, 'has a space in it', 'semi;colon;here', '<script>alert(1)</script>'):
            with self.subTest(bad):
                got = Client().get('/auth/config', HTTP_X_REQUEST_ID=bad)['X-Request-Id']
                self.assertRegex(got, UUID4)

    def test_an_early_refusal_carries_it_too(self):
        # PasswordChangeRequired answers before any view runs.
        user = make_user('qa@example.com')
        api = Api()
        api.login('qa@example.com')
        s = api.session
        s[PWNED] = user.pk
        s.save()
        r = api.get('/auth/members', HTTP_X_REQUEST_ID='gate-refusal-0001')
        self.assertEqual((r.status_code, r.json()), (403, {'error': 'password_change_required'}))
        self.assertEqual(r['X-Request-Id'], 'gate-refusal-0001')
        self.assertEqual(r['Cross-Origin-Resource-Policy'], 'same-site')

    def test_the_audit_row_carries_the_same_id(self):
        make_user('qa@example.com')
        r = Api().post(f'{HEADLESS}/auth/login', {'email': 'qa@example.com', 'password': 'not-the-password-at-all'},
                       HTTP_X_REQUEST_ID='audit-row-0001')
        self.assertEqual((r.status_code, r['X-Request-Id']), (400, 'audit-row-0001'))
        rids = [row.detail.get('rid') for row in AuthEvent.objects.filter(kind=AuthEvent.Kind.LOGIN_FAILED)]
        self.assertEqual(set(rids), {'audit-row-0001'})
        # And a row written outside any request has none to carry.
        self.assertNotIn('rid', record(AuthEvent.Kind.LOGOUT).detail)

    def test_the_parse_on_its_own(self):
        rf = RequestFactory()
        self.assertEqual(request_id(rf.get('/', HTTP_X_REQUEST_ID='  padded-id-0001 ')), 'padded-id-0001')
        self.assertRegex(request_id(rf.get('/')), UUID4)


class TraceparentTests(SimpleTestCase):
    def trace(self, header=None):
        extra = {} if header is None else {'HTTP_TRACEPARENT': header}
        return trace_of(RequestFactory().get('/', **extra))

    def test_a_sampled_parent(self):
        self.assertEqual(self.trace(SAMPLED), (TRACE, True))
        self.assertEqual(self.trace(f'00-{TRACE}-00f067aa0ba902b7-03'), (TRACE, True))

    def test_an_unsampled_parent_keeps_its_trace(self):
        self.assertEqual(self.trace(UNSAMPLED), (TRACE, False))

    def test_malformed_or_all_zero_is_no_parent(self):
        for bad in (None, '', 'garbage', SAMPLED.upper(), f'01-{TRACE}-00f067aa0ba902b7-01',
                    f'00-{TRACE[:-1]}-00f067aa0ba902b7-01', f'{SAMPLED}-extra',
                    f'00-{"0" * 32}-00f067aa0ba902b7-01'):
            with self.subTest(bad):
                trace, sampled = self.trace(bad)
                self.assertRegex(trace, r'^[0-9a-f]{32}$')
                self.assertNotIn(trace, (TRACE, '0' * 32))
                self.assertFalse(sampled)


class RequestLogTests(TestCase):
    SECRETS = ('hunter2', 'secret=', 'cookie-secret-value', 'csrf-secret-value')

    def formatted(self, record):
        RequestId().filter(record)
        return TextFormatter().format(record) + '\n' + JsonFormatter().format(record)

    @override_settings(GC_REQUEST_LOG='sampled')
    def test_sampled_is_logged_without_the_query_the_cookie_or_a_token(self):
        with self.assertLogs('ghostclick.request', 'INFO') as cm:
            r = Client().get('/auth/config', {'secret': 'hunter2'}, HTTP_TRACEPARENT=SAMPLED,
                             HTTP_COOKIE='sessionid=cookie-secret-value', HTTP_X_CSRFTOKEN='csrf-secret-value')
        [line] = cm.records
        self.assertEqual((line.levelno, line.method, line.path, line.status), (logging.INFO, 'GET', '/auth/config', 200))
        self.assertEqual((line.rid, line.trace), (r['X-Request-Id'], TRACE))
        self.assertIsInstance(line.ms, float)
        self.assertEqual(line.ip, '127.0.0.1')
        out = self.formatted(line)
        for secret in self.SECRETS:
            self.assertNotIn(secret, out)

    @override_settings(GC_REQUEST_LOG='sampled')
    def test_unsampled_is_not(self):
        with self.assertNoLogs('ghostclick.request', 'DEBUG'):
            Client().get('/auth/config', HTTP_TRACEPARENT=UNSAMPLED)
            Client().get('/auth/config')

    @override_settings(GC_REQUEST_LOG='off')
    def test_off_is_never(self):
        with self.assertNoLogs('ghostclick.request', 'DEBUG'):
            Client().get('/auth/config', HTTP_TRACEPARENT=SAMPLED)

    @override_settings(GC_REQUEST_LOG='all')
    def test_all_is_always_and_a_refusal_is_a_warning(self):
        with self.assertLogs('ghostclick.request', 'INFO') as cm:
            Client().get('/auth/me')
        self.assertEqual((cm.records[0].status, cm.records[0].levelno), (401, logging.WARNING))

    def test_the_account_is_its_id_and_never_its_address(self):
        user = make_user('qa@example.com')
        api = Api()
        api.login('qa@example.com')
        with self.assertLogs('ghostclick.request', 'INFO') as cm:
            me = api.get('/auth/me', HTTP_TRACEPARENT=SAMPLED).json()
        [line] = cm.records
        self.assertEqual((line.user, line.org), (user.pk, me['org']['slug']))
        self.assertNotIn('qa@example.com', self.formatted(line))

    def test_a_path_cannot_forge_a_line(self):
        with self.assertLogs('ghostclick.request', 'INFO') as cm:
            Client().get('/auth/no%0Asuch%20thing', HTTP_TRACEPARENT=SAMPLED)
        text = TextFormatter().format(cm.records[0])
        self.assertNotIn('\n', text)
        self.assertIn('/auth/no%0Asuch%20thing', text)


class FormatterTests(SimpleTestCase):
    def test_json_is_one_line_with_the_fields_and_no_raw_newline(self):
        record = logging.LogRecord('ghostclick.x', logging.WARNING, __file__, 1, 'two %s', ('lines\nhere é',), None)
        record.path = '/auth/csrf'
        RequestId().filter(record)
        out = JsonFormatter().format(record)
        self.assertNotIn('\n', out)
        got = json.loads(out)
        self.assertEqual((got['level'], got['logger'], got['message'], got['path'], got['rid'], got['trace']),
                         ('WARNING', 'ghostclick.x', 'two lines\nhere é', '/auth/csrf', '-', '-'))

    def test_text_names_the_request(self):
        record = logging.LogRecord('ghostclick.x', logging.INFO, __file__, 1, 'hello', (), None)
        self.assertIn('rid=- trace=- hello', TextFormatter().format(record))


class SecurityHeaderTests(TestCase):
    API_POLICY = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

    def assertEverywhere(self, r):
        self.assertEqual(r['Permissions-Policy'], 'camera=(), microphone=(), geolocation=(), payment=(), usb=()')
        self.assertNotIn('publickey-credentials', r['Permissions-Policy'])
        self.assertEqual(r['Cross-Origin-Resource-Policy'], 'same-site')
        self.assertEqual(r['X-Permitted-Cross-Domain-Policies'], 'none')
        self.assertEqual(r['Origin-Agent-Cluster'], '?1')
        # TLS ends at the edge, and so does HSTS.
        self.assertFalse(r.has_header('Strict-Transport-Security'))

    def test_the_json_api(self):
        for path in ('/auth/csrf', '/auth/me', f'{HEADLESS}/config'):
            with self.subTest(path):
                r = Client().get(path)
                self.assertEverywhere(r)
                self.assertEqual(r['Content-Security-Policy'], self.API_POLICY)
                self.assertIn('no-store', r['Cache-Control'])
        self.assertEqual(Client().get('/auth/me')['Cache-Control'], 'no-store')

    def test_the_admin(self):
        r = Client().get('/admin/login/')
        self.assertEverywhere(r)
        self.assertEqual(r['Content-Security-Policy'],
                         "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'")

    def test_a_header_a_view_chose_is_kept(self):
        from django.http import HttpResponse

        def view(request):
            response = HttpResponse()
            response['Cache-Control'] = 'max-age=60'
            response['Cross-Origin-Resource-Policy'] = 'cross-origin'
            return response
        r = SecurityHeaders(view)(RequestFactory().get('/auth/jwks'))
        self.assertEqual((r['Cache-Control'], r['Cross-Origin-Resource-Policy']), ('max-age=60', 'cross-origin'))


@override_settings(CORS_ALLOWED_ORIGINS=[WEB])
class CorsTests(TestCase):
    def setUp(self):
        cache.clear()

    def test_the_preflight_allows_both_headers(self):
        r = Client().options('/auth/me', HTTP_ORIGIN=WEB, HTTP_ACCESS_CONTROL_REQUEST_METHOD='GET',
                             HTTP_ACCESS_CONTROL_REQUEST_HEADERS='x-request-id, traceparent')
        self.assertEqual(r.status_code, 200)
        allowed = {h.strip() for h in r['Access-Control-Allow-Headers'].split(',')}
        self.assertTrue({'x-request-id', 'traceparent', 'x-csrftoken', 'content-type'} <= allowed, allowed)

    def test_the_request_id_can_be_read(self):
        exposed = {h.strip() for h in Client().get('/auth/csrf', HTTP_ORIGIN=WEB)['Access-Control-Expose-Headers'].split(',')}
        self.assertEqual(exposed, {'X-CSRFToken', 'X-Request-Id', 'Retry-After'})

    @override_settings(GC_REQUEST_RATE='1/h/ip')
    def test_a_preflight_is_not_counted_and_a_429_is_readable_cross_origin(self):
        c = Client(REMOTE_ADDR=AWAY)
        for _ in range(3):
            self.assertEqual(c.options('/auth/config', HTTP_ORIGIN=WEB, HTTP_ACCESS_CONTROL_REQUEST_METHOD='GET').status_code, 200)
        self.assertEqual(c.get('/auth/config', HTTP_ORIGIN=WEB).status_code, 200)
        with self.assertLogs('ghostclick.ratelimit', 'WARNING'):
            r = c.get('/auth/config', HTTP_ORIGIN=WEB)
        self.assertEqual(r.status_code, 429)
        self.assertEqual(r['Access-Control-Allow-Origin'], WEB)


class RequestRateLimitTests(TestCase):
    def setUp(self):
        cache.clear()

    @override_settings(GC_REQUEST_RATE='2/h/ip')
    def test_past_the_budget_is_429_with_retry_after(self):
        c = Client(REMOTE_ADDR=AWAY)
        with self.assertLogs('ghostclick.ratelimit', 'WARNING') as cm:
            codes = [c.get('/auth/config').status_code for _ in range(2)]
            refused = [c.get('/auth/config') for _ in range(3)]
        self.assertEqual(codes, [200, 200])
        r = refused[0]
        self.assertEqual((r.status_code, r.json()), (429, {'error': 'rate_limited'}))
        self.assertTrue(1 <= int(r['Retry-After']) <= 3600, r['Retry-After'])
        self.assertRegex(r['X-Request-Id'], UUID4)
        self.assertEqual(r['Content-Security-Policy'], SecurityHeaderTests.API_POLICY)
        self.assertEqual({x.status_code for x in refused}, {429})
        # One line and one row for the window, however many it refused.
        self.assertEqual(len(cm.records), 1)
        [row] = AuthEvent.objects.filter(kind=AuthEvent.Kind.RATE_LIMITED)
        self.assertEqual((row.ip, row.detail['limit'], row.detail['client'], row.detail['rid']),
                         (AWAY, 'request', AWAY, r['X-Request-Id']))
        # Somebody else's budget is their own.
        self.assertEqual(Client(REMOTE_ADDR='198.51.100.9').get('/auth/config').status_code, 200)

    @override_settings(GC_REQUEST_RATE='1/h/ip')
    def test_under_allauth_the_refusal_is_in_allauth_s_shape(self):
        c = Client(REMOTE_ADDR=AWAY)
        c.get(f'{HEADLESS}/config')
        with self.assertLogs('ghostclick.ratelimit', 'WARNING'):
            body = c.get(f'{HEADLESS}/config').json()
        self.assertEqual((body['status'], body['error'], body['errors'][0]['code']), (429, 'rate_limited', 'rate_limited'))
        self.assertTrue(body['errors'][0]['message'])

    @override_settings(GC_CSRF_RATE='1/h/ip', GC_REQUEST_RATE='100/h/ip')
    def test_a_refused_csrf_request_starts_no_session(self):
        self.assertEqual(Client(REMOTE_ADDR=AWAY).get('/auth/csrf').status_code, 200)
        self.assertEqual(Session.objects.count(), 1)
        # A fresh client, with no cookie: had it been let through, it would
        # have started a second session.
        with self.assertLogs('ghostclick.ratelimit', 'WARNING'):
            r = Client(REMOTE_ADDR=AWAY).get('/auth/csrf')
        self.assertEqual(r.status_code, 429)
        self.assertEqual(Session.objects.count(), 1)
        self.assertFalse(r.cookies)
        self.assertEqual(AuthEvent.objects.get(kind=AuthEvent.Kind.RATE_LIMITED).detail['limit'], 'csrf')
        # The other endpoints still have budget.
        self.assertEqual(Client(REMOTE_ADDR=AWAY).get('/auth/config').status_code, 200)

    @override_settings(GC_CSRF_RATE='1/h/ip', GC_REQUEST_RATE='1/h/ip')
    def test_the_healthcheck_is_never_refused(self):
        # The compose healthcheck: GET /auth/csrf from loopback.
        for _ in range(4):
            self.assertEqual(Client().get('/auth/csrf').status_code, 200)
        # Only that: the same address on another path is counted.
        self.assertEqual(Client().get('/auth/config').status_code, 200)
        with self.assertLogs('ghostclick.ratelimit', 'WARNING'):
            self.assertEqual(Client().get('/auth/config').status_code, 429)

    @override_settings(GC_REQUEST_RATE='1/h/ip')
    def test_paths_that_are_not_this_service_s_are_not_counted(self):
        c = Client(REMOTE_ADDR=AWAY)
        self.assertEqual([c.get('/nowhere').status_code for _ in range(3)], [404, 404, 404])

    def test_ipv6_is_counted_by_its_slash_64(self):
        self.assertEqual(bucket('2001:db8:1:2::1'), bucket('2001:db8:1:2:ffff:ffff:ffff:ffff'))
        self.assertNotEqual(bucket('2001:db8:1:2::1'), bucket('2001:db8:1:3::1'))
        self.assertEqual(bucket('::ffff:192.0.2.1'), '192.0.2.1')
        self.assertEqual(bucket('198.51.100.7'), '198.51.100.7')
        self.assertEqual((bucket('not an address'), bucket(None)), ('-', '-'))

    def test_the_window_is_the_clock_s(self):
        # Two a minute, starting 12.5 seconds past a minute: 48 seconds left,
        # counting down; the last tenth of the minute still says one second;
        # and once the minute turns, a new key and a whole window.
        now = 1_700_000_040 + 12.5
        self.assertEqual([ratelimit.window('t', 'k', '2/m', now=now + n) for n in range(3)],
                         [(0, 48), (0, 47), (1, 46)])
        self.assertEqual(ratelimit.window('t', 'k', '2/m', now=now + 47.4), (2, 1))
        self.assertEqual(ratelimit.window('t', 'k', '2/m', now=now + 48), (0, 60))


def settings_of(env, *names):
    """Import the settings in a subprocess with `env`, as test_profile does, and return `names`."""
    base = {k: v for k, v in os.environ.items() if not k.startswith(OURS)}
    base.update({'DJANGO_SETTINGS_MODULE': 'config.settings', 'PYTHONIOENCODING': 'utf-8'})
    code = ('import json\nfrom django.conf import settings\n'
            f'print(json.dumps({{n: getattr(settings, n, None) for n in {list(names)!r}}}, default=str))\n')
    done = subprocess.run([sys.executable, '-c', code], cwd=AUTH_DIR, env={**base, **env},
                          capture_output=True, text=True, encoding='utf-8', timeout=60)
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


class SettingsTests(SimpleTestCase):
    """What the environment may say about all of this, and what refuses to start."""

    def refuses(self, env, *mentions):
        done = load(env)
        self.assertNotEqual(done.returncode, 0, f'it started:\n{done.stdout}')
        for m in mentions:
            self.assertIn(m, done.stderr)

    def test_the_defaults(self):
        got = settings_of({}, 'GC_SWITCHES_OFF', 'GC_MINT_RATE', 'GC_ACCEPT_RATE', 'GC_INVITE_RATE',
                          'GC_PASSKEY_LOGIN_RATE', 'GC_REQUEST_RATE', 'GC_CSRF_RATE', 'GC_REQUEST_LOG',
                          'GC_LOG_LEVEL', 'GC_LOG_FORMAT', 'MIDDLEWARE', 'LOGGING')
        self.assertEqual(got['GC_SWITCHES_OFF'], [])
        self.assertEqual([got[n] for n in ('GC_MINT_RATE', 'GC_ACCEPT_RATE', 'GC_INVITE_RATE', 'GC_PASSKEY_LOGIN_RATE',
                                           'GC_REQUEST_RATE', 'GC_CSRF_RATE')],
                         ['12/10m', '10/m/ip', '20/h/user', '10/m/ip', '300/m/ip', '60/m/ip'])
        self.assertEqual((got['GC_REQUEST_LOG'], got['GC_LOG_LEVEL'], got['GC_LOG_FORMAT']), ('sampled', 'info', 'text'))
        middleware = got['MIDDLEWARE']
        self.assertEqual(middleware[0], 'accounts.middleware.RequestContext')
        self.assertLess(middleware.index('accounts.middleware.RequestRateLimit'),
                        middleware.index('django.contrib.sessions.middleware.SessionMiddleware'))
        self.assertFalse(got['LOGGING']['disable_existing_loggers'])

    def test_what_the_environment_can_set(self):
        got = settings_of({'GC_SWITCHES_OFF': ' runner , control.google', 'GC_REQUEST_RATE': '100/m/ip',
                           'GC_PASSKEY_LOGIN_RATE': '5/m/ip', 'GC_LOG_FORMAT': 'JSON', 'GC_REQUEST_LOG': 'all',
                           'GC_LOG_LEVEL': 'warn'},
                          'GC_SWITCHES_OFF', 'GC_REQUEST_RATE', 'GC_PASSKEY_LOGIN_RATE', 'GC_REQUEST_LOG', 'LOGGING',
                          'GC_LOG_LEVEL')
        # `warn` is the runner's spelling as well, and the two read one line.
        self.assertEqual((got['GC_LOG_LEVEL'], got['LOGGING']['loggers']['ghostclick']['level']), ('warning', 'WARNING'))
        self.assertEqual(got['GC_SWITCHES_OFF'], ['control.google', 'runner.driving', 'runner.onboarding',
                                                  'runner.origins', 'runner.recording', 'runner.runs'])
        self.assertEqual((got['GC_REQUEST_RATE'], got['GC_PASSKEY_LOGIN_RATE']), ('100/m/ip', '5/m/ip'))
        self.assertEqual(got['GC_REQUEST_LOG'], 'all')
        self.assertEqual(got['LOGGING']['handlers']['console']['formatter'], 'json')

    def test_a_switch_that_does_not_exist_is_refused_by_name(self):
        self.refuses({'GC_SWITCHES_OFF': 'control.google,runner.recordings'},
                     'GC_SWITCHES_OFF', "'runner.recordings'", 'runner.recording', 'control.passkeys')

    def test_an_unreadable_or_empty_rate_is_refused(self):
        for name in ('GC_MINT_RATE', 'GC_ACCEPT_RATE', 'GC_INVITE_RATE', 'GC_PASSKEY_LOGIN_RATE',
                     'GC_REQUEST_RATE', 'GC_CSRF_RATE'):
            with self.subTest(name):
                self.refuses({name: 'ten a minute'}, name)
        self.refuses({'GC_REQUEST_RATE': '0/m/ip'}, 'GC_REQUEST_RATE', 'nothing at all')
        self.refuses({'GC_CSRF_RATE': '10/0m'}, 'GC_CSRF_RATE')

    def test_a_logging_word_that_is_not_one_of_the_choices_is_refused(self):
        self.refuses({'GC_REQUEST_LOG': 'sometimes'}, 'GC_REQUEST_LOG', 'sampled')
        self.refuses({'GC_LOG_FORMAT': 'xml'}, 'GC_LOG_FORMAT')
        self.refuses({'GC_LOG_LEVEL': 'loud'}, 'GC_LOG_LEVEL')
