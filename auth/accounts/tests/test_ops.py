"""
The ops rules (docs/AUTH.md §12): the audit-log purge, the schedule that
runs it, and the extension's way to a token.
"""
import io
import json
from datetime import timedelta
from unittest import mock

from django.core.cache import cache
from django.core.management import CommandError, call_command
from django.test import SimpleTestCase, TestCase, override_settings
from django.utils import timezone

from ..management.commands import housekeeping
from ..management.commands.purge_auth_events import RETENTION_DAYS, stale
from ..models import AuthEvent
from . import keys
from .support import Api, make_user
from .test_profile import PRODUCTION, load


def row(kind, days_ago, **detail):
    return AuthEvent.objects.create(kind=kind, at=timezone.now() - timedelta(days=days_ago), detail=detail)


class PurgeAuthEventsTests(TestCase):
    def test_rows_older_than_ninety_days_go_and_younger_ones_stay(self):
        old = row(AuthEvent.Kind.LOGIN, RETENTION_DAYS + 1)
        edge = row(AuthEvent.Kind.LOGIN, RETENTION_DAYS - 1)
        young = row(AuthEvent.Kind.LOGIN, 1)
        out = io.StringIO()
        call_command('purge_auth_events', stdout=out)
        self.assertIn('deleted 1 audit row older than 90 days', out.getvalue())
        self.assertFalse(AuthEvent.objects.filter(pk=old.pk).exists())
        self.assertTrue(AuthEvent.objects.filter(pk=edge.pk).exists())
        self.assertTrue(AuthEvent.objects.filter(pk=young.pk).exists())

    def test_every_kind_is_in_scope(self):
        # A retention rule with exceptions is one whose exceptions nobody
        # remembers: a mint, a refusal, an invitation, a Google or MFA event
        # all go at the same age.
        for kind in AuthEvent.Kind:
            row(kind, RETENTION_DAYS + 30, jti='x')
        self.assertEqual(stale().count(), len(AuthEvent.Kind))
        call_command('purge_auth_events', stdout=io.StringIO())
        self.assertEqual(AuthEvent.objects.count(), 0)

    def test_dry_run_deletes_nothing(self):
        row(AuthEvent.Kind.MINT, RETENTION_DAYS + 5)
        out = io.StringIO()
        call_command('purge_auth_events', '--dry-run', stdout=out)
        self.assertIn('1 audit row older than 90 days; nothing deleted', out.getvalue())
        self.assertEqual(AuthEvent.objects.count(), 1)

    def test_days_can_be_shortened_but_never_to_nothing(self):
        row(AuthEvent.Kind.LOGIN, 10)
        call_command('purge_auth_events', '--days', '7', stdout=io.StringIO())
        self.assertEqual(AuthEvent.objects.count(), 0)
        with self.assertRaises(CommandError):
            call_command('purge_auth_events', '--days', '0', stdout=io.StringIO())

    def test_idempotent(self):
        row(AuthEvent.Kind.LOGIN, RETENTION_DAYS + 5)
        call_command('purge_auth_events', stdout=io.StringIO())
        out = io.StringIO()
        call_command('purge_auth_events', stdout=out)
        self.assertIn('deleted 0 audit rows', out.getvalue())


class HousekeepingTests(TestCase):
    def test_the_first_tick_runs_everything(self):
        self.assertEqual(housekeeping.due(now=1000.0, last={}),
                         ['purge_unverified_emails', 'clearsessions', 'purge_auth_events'])

    def test_each_task_waits_out_its_own_period(self):
        last = {name: 0.0 for name, _ in housekeeping.TASKS}
        self.assertEqual(housekeeping.due(now=299.0, last=last), [])
        self.assertEqual(housekeeping.due(now=300.0, last=last), ['purge_unverified_emails'])
        self.assertEqual(housekeeping.due(now=24 * 3600.0, last=last),
                         ['purge_unverified_emails', 'clearsessions', 'purge_auth_events'])

    def test_once_runs_all_three_against_the_database(self):
        row(AuthEvent.Kind.LOGIN, RETENTION_DAYS + 1)
        out = io.StringIO()
        call_command('housekeeping', '--once', stdout=out, stderr=io.StringIO())
        text = out.getvalue()
        for name, _ in housekeeping.TASKS:
            self.assertIn(f'housekeeping: {name} done', text)
        self.assertEqual(AuthEvent.objects.count(), 0)

    def test_a_failing_task_is_logged_and_the_others_still_run(self):
        real = housekeeping.call_command

        def flaky(name, *args, **kwargs):
            if name == 'clearsessions':
                raise RuntimeError('the database is restarting')
            return real(name, *args, **kwargs)

        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(housekeeping, 'call_command', flaky):
            call_command('housekeeping', '--once', stdout=out, stderr=err)
        self.assertIn('housekeeping: clearsessions failed', err.getvalue())
        self.assertIn('the database is restarting', err.getvalue())
        self.assertIn('housekeeping: purge_auth_events done', out.getvalue())
        self.assertIn('housekeeping: purge_unverified_emails done', out.getvalue())

    def test_list_names_the_schedule(self):
        out = io.StringIO()
        call_command('housekeeping', '--list', stdout=out)
        self.assertIn('purge_unverified_emails', out.getvalue())
        self.assertIn('every 5 minutes', out.getvalue())
        self.assertIn('every 24 hours', out.getvalue())


EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
OTHER = 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba'


@override_settings(
    GC_SIGNING_KEY=keys.PRIVATE_PEM,
    CSRF_TRUSTED_ORIGINS=['http://localhost:3000', EXT],
    CORS_ALLOWED_ORIGINS=['http://localhost:3000', EXT],
)
class ExtensionTokenTests(TestCase):
    """
    The extension's background worker does what the SPA does — GET
    /auth/csrf, POST /auth/executor-token with the session cookie and the
    token echoed — from its own origin. That origin passes CSRF only when
    the operator listed it, and no other extension's does [browser-side-2].
    """

    def setUp(self):
        cache.clear()
        make_user('qa@example.com')
        self.api = Api()
        self.api.login('qa@example.com')

    def test_a_listed_extension_origin_is_handed_a_token(self):
        r = self.api.post('/auth/executor-token', HTTP_ORIGIN=EXT)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(keys.verify(r.json()['token'])['email'], 'qa@example.com')
        self.assertEqual(r['Access-Control-Allow-Origin'], EXT)
        self.assertEqual(r['Access-Control-Allow-Credentials'], 'true')

    def test_an_unlisted_extension_is_refused_by_csrf(self):
        r = self.api.post('/auth/executor-token', HTTP_ORIGIN=OTHER)
        self.assertEqual(r.status_code, 403)
        self.assertFalse(r.has_header('Access-Control-Allow-Origin'))

    def test_the_csrf_token_is_readable_from_the_extension(self):
        r = self.api.get('/auth/csrf', HTTP_ORIGIN=EXT)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r['Access-Control-Allow-Origin'], EXT)
        self.assertIn('X-CSRFToken', r['Access-Control-Expose-Headers'])


class ExtensionOriginsSettingTests(SimpleTestCase):
    def test_the_origins_reach_cors_and_csrf(self):
        done = load({**PRODUCTION, 'GC_EXTENSION_ORIGINS': f'{EXT}, {OTHER}/'})
        self.assertEqual(done.returncode, 0, done.stderr)
        got = json.loads(done.stdout)
        self.assertEqual(got['CORS_ALLOWED_ORIGINS'], ['https://app.example.com', EXT, OTHER])
        self.assertEqual(got['CSRF_TRUSTED_ORIGINS'], ['https://app.example.com', EXT, OTHER])

    def test_a_web_origin_is_refused(self):
        # The list trusts its entries for CSRF; a web origin typed here would
        # let a page on it forge every POST.
        for bad in ('https://evil.example', 'http://localhost:3000', 'abcdefgh', 'chrome-extension://', f'{EXT}/panel.html'):
            done = load({**PRODUCTION, 'GC_EXTENSION_ORIGINS': bad})
            self.assertNotEqual(done.returncode, 0, bad)
            self.assertIn('GC_EXTENSION_ORIGINS', done.stderr)

    def test_unset_means_no_extension(self):
        done = load(PRODUCTION)
        got = json.loads(done.stdout)
        self.assertEqual(got['CORS_ALLOWED_ORIGINS'], ['https://app.example.com'])
