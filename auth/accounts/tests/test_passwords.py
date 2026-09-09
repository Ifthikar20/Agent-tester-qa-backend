"""
Hashing and the validators (docs/AUTH.md §2).

The Have I Been Pwned lookup is stubbed by accounts.testing so these say what
the validator does with an answer, not whether the API is up.
"""
from django.contrib.auth import authenticate, get_user_model
from django.contrib.auth.hashers import make_password
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.test import TestCase

from ..testing import hibp

User = get_user_model()


class HashingTests(TestCase):
    def test_new_passwords_are_argon2(self):
        u = User.objects.create_user(email='a@example.com', password='a-long-test-password')
        self.assertTrue(u.password.startswith('argon2'), u.password[:20])
        self.assertTrue(u.check_password('a-long-test-password'))

    def test_an_old_pbkdf2_hash_still_signs_in_and_is_upgraded(self):
        # The upgrade path: a hash from before Argon2 verifies, and the next
        # successful check rewrites it, so nobody has to reset anything.
        u = User.objects.create_user(email='a@example.com', password='a-long-test-password')
        u.password = make_password('a-long-test-password', hasher='pbkdf2_sha256')
        u.save(update_fields=['password'])
        self.assertTrue(u.password.startswith('pbkdf2_sha256$'))

        self.assertIsNotNone(authenticate(username='a@example.com', password='a-long-test-password'))
        u.refresh_from_db()
        self.assertTrue(u.password.startswith('argon2'), u.password[:20])
        self.assertTrue(u.check_password('a-long-test-password'))


class ValidatorTests(TestCase):
    def setUp(self):
        hibp.reset()
        self.user = User(email='ada@example.com', name='Ada Lovelace')

    def codes(self, password):
        try:
            validate_password(password, self.user)
        except ValidationError as err:
            return sorted(e.code for e in err.error_list)
        return []

    def test_fifteen_characters_is_the_floor(self):
        self.assertIn('password_too_short', self.codes('x' * 14))
        self.assertEqual(self.codes('correct-horse-x'), [])

    def test_a_passphrase_with_spaces_is_fine(self):
        # No composition rules: the words are the strength.
        self.assertEqual(self.codes('correct horse battery staple'), [])

    def test_128_characters_is_the_ceiling(self):
        self.assertEqual(self.codes('x' * 128), [])
        self.assertEqual(self.codes('x' * 129), ['password_too_long'])

    def test_a_breached_password_is_refused(self):
        hibp.hits = 3
        self.assertIn('password_compromised', self.codes('a-perfectly-long-password'))
        self.assertIn('a-perfectly-long-password', hibp.calls)

    def test_an_outage_falls_back_to_the_common_list_and_says_so(self):
        # Never block sign-up on someone else's downtime — but never go
        # silent about it either: the fallback is weaker and must be visible.
        hibp.outage = True
        with self.assertLogs('pwned_passwords_django.validators', level='ERROR'):
            self.assertEqual(self.codes('a-perfectly-long-password'), [])
        with self.assertLogs('pwned_passwords_django.validators', level='ERROR'):
            # Long enough for the floor, and on Django's common list.
            self.assertIn('password_too_common', self.codes('123456789987654321'))

    def test_something_like_your_own_email_is_refused(self):
        self.assertIn('password_too_similar', self.codes('ada@example.com!'))

    def test_adduser_and_the_validators_agree(self):
        # The same list runs for every way a password is set; adduser is the
        # one this project scripts, so it is the one to prove.
        from django.core.management import call_command
        from django.core.management.base import CommandError
        import io, sys
        saved, sys.stdin = sys.stdin, io.StringIO('x' * 14 + '\n')
        try:
            with self.assertRaises(CommandError) as caught:
                call_command('adduser', 'qa@example.com', password_stdin=True, stdout=io.StringIO())
        finally:
            sys.stdin = saved
        self.assertIn('15', str(caught.exception))
