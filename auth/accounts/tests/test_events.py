"""
The audit trail, and which address it records.

Written by receivers on Django's own auth signals, so the assertion is made
through the real endpoint: a view that signs someone in without a row here
would be a view that bypassed the framework, and there is not one.
"""
from django.contrib.auth import get_user_model
from django.test import RequestFactory, TestCase, override_settings

from ..events import client_ip
from ..models import AuthEvent
from .support import PASSWORD, Api, make_user

User = get_user_model()


class AuthEventTests(TestCase):
    def setUp(self):
        self.user = make_user('qa@example.com')
        self.api = Api(HTTP_USER_AGENT='check/1.0')

    def test_a_sign_in_is_recorded_with_who_and_from_where(self):
        self.api.login('qa@example.com')
        ev = AuthEvent.objects.get(kind=AuthEvent.Kind.LOGIN)
        self.assertEqual(ev.user, self.user)
        self.assertEqual(ev.email, 'qa@example.com')
        self.assertEqual(ev.ip, '127.0.0.1')
        self.assertEqual(ev.user_agent, 'check/1.0')

    def test_a_refused_sign_in_is_recorded_as_typed_with_no_user(self):
        self.assertEqual(self.api.try_login('nobody@example.com', PASSWORD).status_code, 400)
        ev = AuthEvent.objects.get(kind=AuthEvent.Kind.LOGIN_FAILED)
        self.assertIsNone(ev.user)
        self.assertEqual(ev.email, 'nobody@example.com')
        self.assertEqual(ev.ip, '127.0.0.1')

    def test_a_wrong_password_against_a_real_account_is_recorded_too(self):
        self.api.try_login('qa@example.com', 'not-it-and-long-enough')
        self.assertEqual(AuthEvent.objects.filter(kind=AuthEvent.Kind.LOGIN_FAILED, email='qa@example.com').count(), 1)
        self.assertFalse(AuthEvent.objects.filter(kind=AuthEvent.Kind.LOGIN).exists())

    def test_a_sign_out_is_recorded(self):
        self.api.login('qa@example.com')
        self.api.logout()
        self.assertEqual(AuthEvent.objects.get(kind=AuthEvent.Kind.LOGOUT).user, self.user)

    def test_the_log_cannot_be_edited_in_the_admin(self):
        from django.contrib import admin
        from ..admin import AuthEventAdmin
        model_admin = AuthEventAdmin(AuthEvent, admin.site)
        rf = RequestFactory().get('/admin/')
        rf.user = User.objects.create_superuser(email='root@example.com', password=PASSWORD)
        self.assertFalse(model_admin.has_add_permission(rf))
        self.assertFalse(model_admin.has_change_permission(rf))
        self.assertFalse(model_admin.has_delete_permission(rf))


class ClientIpTests(TestCase):
    """
    The address behind a rate limit and in the log is the one the edge saw.
    """

    def request(self, **meta):
        return RequestFactory().get('/auth/me', REMOTE_ADDR='10.0.0.2', **meta)

    @override_settings(ALLAUTH_TRUSTED_PROXY_COUNT=0)
    def test_with_no_proxy_the_header_is_ignored(self):
        # On a laptop nothing rewrites X-Forwarded-For, so anything in it was
        # put there by the client and is worth exactly nothing.
        self.assertEqual(client_ip(self.request(HTTP_X_FORWARDED_FOR='1.2.3.4')), '10.0.0.2')

    @override_settings(ALLAUTH_TRUSTED_PROXY_COUNT=1)
    def test_behind_the_edge_the_last_entry_is_the_client(self):
        # Caddy overwrites the header with the peer it accepted, so what
        # arrives is one entry — and if a client had sent its own, the edge's
        # is still the last one and still wins.
        self.assertEqual(client_ip(self.request(HTTP_X_FORWARDED_FOR='198.51.100.7')), '198.51.100.7')
        self.assertEqual(client_ip(self.request(HTTP_X_FORWARDED_FOR='1.2.3.4, 198.51.100.7')), '198.51.100.7')

    @override_settings(ALLAUTH_TRUSTED_PROXY_COUNT=1)
    def test_behind_the_edge_with_no_header_is_the_peer(self):
        # Only the edge can reach gunicorn, so a request with no header came
        # from it — or from the network the edge is on, which is the same trust.
        self.assertEqual(client_ip(self.request()), '10.0.0.2')

    @override_settings(ALLAUTH_TRUSTED_PROXY_COUNT=1)
    def test_the_recorded_address_is_the_edge_s_not_the_spoof(self):
        api = Api(HTTP_X_FORWARDED_FOR='1.2.3.4, 198.51.100.7')
        api.try_login('x@example.com', 'a-long-test-password')
        self.assertEqual(AuthEvent.objects.get(kind=AuthEvent.Kind.LOGIN_FAILED).ip, '198.51.100.7')
