"""
Minting (docs/AUTH.md §8): the claims that come from the session, the rate
limit, the audit row, the public key set, and the command that makes keys.

What is NOT here: whether the runner accepts what this mints. That crosses a
language boundary and neither project can assert it alone, so it lives in
../scripts/check-auth.js.
"""
import io
import json
import time

from django.core.cache import cache
from django.core.management import call_command
from django.test import TestCase, override_settings

from ..events import AUTH_EVENTS, LOGIN_AT
from ..models import AuthEvent
from ..tokens import STEP_UP_SECONDS, kid_of, load_public, session_id
from . import keys
from .support import PASSWORD, Api, make_user


@override_settings(GC_SIGNING_KEY=keys.PRIVATE_PEM, GC_TOKEN_TTL=600, GC_MINT_RATE='12/10m')
class MintTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = make_user('qa@example.com')
        self.api = Api()
        self.c = self.api.c

    def login(self):
        self.api.login('qa@example.com')

    def mint(self):
        return self.api.post('/auth/executor-token')

    def claims(self):
        r = self.mint()
        self.assertEqual(r.status_code, 200, r.content)
        return keys.verify(r.json()['token'])

    # -- the claims the session decides ---------------------------------------

    def test_signing_in_records_an_authentication_event(self):
        before = int(time.time())
        self.login()
        events = self.c.session[AUTH_EVENTS]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]['method'], 'password')
        self.assertGreaterEqual(events[0]['at'], before)

    def test_amr_auth_time_and_su_come_from_the_events(self):
        self.login()
        c = self.claims()
        at = self.c.session[AUTH_EVENTS][-1]['at']
        self.assertEqual(c['amr'], ['password'])
        self.assertEqual(c['auth_time'], at)
        # Every account today has a password and nothing stronger, so the
        # strongest factor it has was used at auth_time: step-up holds for
        # ten minutes from there, and the runner checks nothing but now < su.
        self.assertEqual(c['su'], at + STEP_UP_SECONDS)

    def test_the_most_recent_event_is_auth_time(self):
        self.login()
        s = self.c.session
        s[AUTH_EVENTS] = [{'method': 'password', 'at': 1_000}, {'method': 'password', 'at': 2_000}]
        s.save()
        c = self.claims()
        self.assertEqual(c['auth_time'], 2_000)
        self.assertEqual(c['su'], 2_000 + STEP_UP_SECONDS)

    def test_a_session_with_no_events_gets_no_step_up(self):
        # A session from before the events list existed: nobody knows how it
        # was authenticated, so it cannot allow an origin until its owner
        # signs in again. Safer than guessing.
        self.login()
        began = int(time.time()) - 100
        s = self.c.session
        del s[AUTH_EVENTS]
        s[LOGIN_AT] = began
        s.save()
        c = self.claims()
        self.assertEqual(c['amr'], [])
        self.assertEqual(c['auth_time'], began)
        self.assertEqual(c['su'], 0)

    def test_sid_is_a_hash_of_the_session_key_never_the_key(self):
        self.login()
        key = self.c.session.session_key
        c = self.claims()
        self.assertEqual(c['sid'], session_id(key))
        self.assertNotIn(key, json.dumps(c))

    def test_iss_aud_and_a_fresh_jti_every_time(self):
        self.login()
        a, b = self.claims(), self.claims()
        self.assertEqual((a['iss'], a['aud']), ('ghostclick-control', 'ghostclick-runner'))
        self.assertNotEqual(a['jti'], b['jti'])
        self.assertEqual(a['exp'] - a['iat'], 600)

    # -- the audit row and the rate limit --------------------------------------

    def test_every_mint_is_logged_with_its_jti(self):
        self.login()
        c = self.claims()
        row = AuthEvent.objects.get(kind=AuthEvent.Kind.MINT)
        self.assertEqual(row.user, self.user)
        self.assertEqual(row.detail['jti'], c['jti'])
        self.assertEqual(row.detail['org'], c['org'])

    def test_twelve_in_ten_minutes_per_session_then_429(self):
        self.login()
        for _ in range(12):
            self.assertEqual(self.mint().status_code, 200)
        r = self.mint()
        self.assertEqual(r.status_code, 429)
        self.assertEqual(r.json()['error'], 'rate_limited')
        self.assertTrue(AuthEvent.objects.filter(kind=AuthEvent.Kind.MINT_REFUSED).exists())

    def test_the_limit_is_per_session_not_per_account(self):
        self.login()
        for _ in range(12):
            self.mint()
        other = Api()
        other.login('qa@example.com')
        self.assertEqual(other.post('/auth/executor-token').status_code, 200)

    # -- the public key set ----------------------------------------------------

    def test_jwks_publishes_the_public_half_and_only_that(self):
        r = self.c.get('/auth/jwks')
        self.assertEqual(r.status_code, 200)
        [key] = r.json()['keys']
        self.assertEqual((key['kty'], key['crv'], key['alg'], key['use']), ('OKP', 'Ed25519', 'EdDSA', 'sig'))
        self.assertEqual(key['kid'], keys.KID)
        self.assertEqual(kid_of(load_public(key['pem'])), keys.KID)
        self.assertNotIn('PRIVATE', r.content.decode())

    @override_settings(GC_SIGNING_KEY='')
    def test_jwks_is_empty_rather_than_broken_with_no_key(self):
        self.assertEqual(self.c.get('/auth/jwks').json(), {'keys': []})

    def test_the_kid_in_the_token_is_the_kid_in_the_set(self):
        self.login()
        r = self.mint()
        head = keys.header_of(r.json()['token'])
        self.assertEqual(head['kid'], self.c.get('/auth/jwks').json()['keys'][0]['kid'])


class SigningKeyCommandTests(TestCase):
    def run_it(self, *args, **opts):
        out = io.StringIO()
        call_command('signing_key', *args, stdout=out, **opts)
        return out.getvalue()

    def test_new_prints_both_halves_on_one_line_each(self):
        out = self.run_it('--new')
        private = [l for l in out.splitlines() if 'GC_SIGNING_KEY=' in l]
        public = [l for l in out.splitlines() if 'GC_AUTH_PUBLIC_KEYS=' in l]
        self.assertEqual(len(private), 1)
        self.assertEqual(len(public), 1)
        # One line, quoted, newlines as the two characters an env file can hold.
        self.assertIn("GC_SIGNING_KEY='-----BEGIN PRIVATE KEY-----\\n", private[0])
        self.assertNotIn('\n', private[0])
        keyset = json.loads(public[0].split("='", 1)[1].rstrip("'"))
        [(kid, pem)] = keyset.items()
        self.assertEqual(kid_of(load_public(pem)), kid)
        self.assertIn(f'kid  {kid}', out)

    def test_json_is_readable_by_a_script(self):
        got = json.loads(self.run_it('--new', '--json'))
        self.assertEqual(set(got), {'kid', 'private_pem', 'public_pem', 'public_keys'})
        self.assertEqual(kid_of(load_public(got['public_pem'])), got['kid'])
        self.assertEqual(got['public_keys'], {got['kid']: got['public_pem']})

    @override_settings(GC_SIGNING_KEY=keys.PRIVATE_ONE_LINE)
    def test_without_new_it_describes_the_key_in_use(self):
        out = self.run_it()
        self.assertIn(keys.KID, out)
        self.assertNotIn('GC_SIGNING_KEY=', out)
        self.assertIn('GC_AUTH_PUBLIC_KEYS=', out)

    @override_settings(GC_SIGNING_KEY='')
    def test_without_a_key_it_says_how_to_make_one(self):
        from django.core.management.base import CommandError
        with self.assertRaises(CommandError) as caught:
            self.run_it()
        self.assertIn('--new', str(caught.exception))
