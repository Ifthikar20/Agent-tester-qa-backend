"""
The test runner, and the two things it changes: the suite never touches the
network, and it is not throttled by the limit it is mostly not testing.

The password validators include a Have I Been Pwned lookup. Left alone, every
test that sets a password would make an HTTPS request, so the suite would be
slow, flaky on a train, and green or red depending on someone else's uptime.
The runner replaces the client's one method with `hibp`, a stub the tests can
steer: how many breaches to report, or an outage to simulate. The default is
"never seen", which is what the real API says about a random password.

The request limit (accounts.middleware.RequestRateLimit) counts per client
address, and every request the test client makes comes from 127.0.0.1 — a
suite that signs in a few thousand times a minute would be refused by it
halfway through. So the suite runs with budgets nobody reaches, and the tests
that are about the limit set their own (accounts/tests/test_hardening.py).
"""
from unittest import mock

from django.test.runner import DiscoverRunner
from django.test.utils import override_settings
from pwned_passwords_django import api, exceptions


class hibp:
    """What the stubbed Pwned Passwords API will answer next."""

    hits = 0            # breaches to report for any password
    outage = False      # raise the client's own error instead of answering
    calls = []          # every password checked, so a test can assert it was

    @classmethod
    def reset(cls):
        cls.hits, cls.outage, cls.calls = 0, False, []

    @classmethod
    def check_password(cls, password):
        cls.calls.append(password)
        if cls.outage:
            raise exceptions.PwnedPasswordsError(
                'simulated outage', code=exceptions.ErrorCode.API_TIMEOUT, params={},
            )
        return cls.hits


class Runner(DiscoverRunner):
    def setup_test_environment(self, **kwargs):
        super().setup_test_environment(**kwargs)
        # The validator instance keeps a reference to api.default_client, so
        # patching the attribute on that object reaches every validator Django
        # constructs, cached or not.
        self._hibp = mock.patch.object(api.default_client, 'check_password', hibp.check_password)
        self._hibp.start()
        # A day-long window, so the whole run is one counter per limit rather
        # than a new cache key every second crowding out the ones under test.
        self._rates = override_settings(GC_REQUEST_RATE='1000000/d', GC_CSRF_RATE='1000000/d')
        self._rates.enable()

    def teardown_test_environment(self, **kwargs):
        self._rates.disable()
        self._hibp.stop()
        super().teardown_test_environment(**kwargs)
