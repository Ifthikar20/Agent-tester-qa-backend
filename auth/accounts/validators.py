"""
The one password rule Django does not ship.

Django has a minimum length and no maximum. Argon2 hashes a password of any
length in about the same time, so the cap is not about cost — it is about the
other end of the pipeline: a 10 kB "password" sits in the request body, the
log of a failed attempt and the similarity validator's comparison, and the
limit is where those stop being asked to cope. 128 is long enough for any
passphrase a person will type and short enough that nothing has to.
"""
from django.core.exceptions import ValidationError
from django.utils.translation import gettext as _


class MaximumLengthValidator:
    def __init__(self, max_length=128):
        self.max_length = max_length

    def validate(self, password, user=None):
        if len(password) > self.max_length:
            raise ValidationError(
                _('This password is longer than %(max_length)d characters.'),
                code='password_too_long',
                params={'max_length': self.max_length},
            )

    def get_help_text(self):
        return _('Your password may be at most %(max_length)d characters.') % {'max_length': self.max_length}
