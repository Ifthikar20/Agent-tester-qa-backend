"""
Where django-allauth asks this project what it wants.

Most of what allauth does is left alone. The overrides are the rules in
docs/AUTH.md that allauth has no setting for:

  authenticate                  every successful sign-in runs the presented
                                password through Have I Been Pwned; a hit
                                marks the session, and the middleware then
                                allows nothing but a password change
                                [credentials-1]
  clean_email                   the sign-up policy (accounts/policy.py) for
                                the refusals that may be said out loud
  send_account_already_exists_mail
                                the "that address exists" branch of sign-up
                                pays the same Argon2id cost as the branch
                                that creates an account, so the two cannot
                                be told apart by the clock [credentials-3];
                                and an uninvited address, which is sent down
                                this branch on purpose, is told by mail
  send_password_reset_mail      a reset asked for through a previous address
                                names the address the account signs in with
                                now, so its owner can undo an email change
                                [mfa-recovery-3]
"""
import logging
import secrets

from allauth.account.adapter import DefaultAccountAdapter
from django.contrib.auth.hashers import make_password
from django.core.exceptions import ValidationError
from pwned_passwords_django import api as hibp
from pwned_passwords_django.exceptions import PwnedPasswordsError

from . import mailer, policy
from .events import PWNED, client_ip, record
from .models import AuthEvent

log = logging.getLogger(__name__)


class AccountAdapter(DefaultAccountAdapter):
    error_messages = {
        **DefaultAccountAdapter.error_messages,
        'turnstile_required': 'Complete the verification challenge to continue.',
        'turnstile_failed': 'The verification challenge did not pass. Try it again.',
    }

    # ---------------------------------------------------------------- sign-in

    def authenticate(self, request, **credentials):
        user = super().authenticate(request, **credentials)
        if user is not None:
            self.check_presented_password(request, user, credentials.get('password') or '')
        return user

    def check_presented_password(self, request, user, password):
        """
        The password was right; is it also in a breach corpus?

        The validator catches a pwned password at the moment it is set.
        This catches the ones that were fine when set and have been breached
        since, and the ones an operator set before the validator existed.
        The session is marked rather than the sign-in refused: refusing would
        lock the person out of the one thing they must do, which is change it.
        On an outage nothing is marked, the same way the validator lets a
        sign-up through — a Cloudflare incident is not a reason to nag.
        """
        if not password or request is None or not hasattr(request, 'session'):
            return
        try:
            hits = hibp.default_client.check_password(password)
        except PwnedPasswordsError as err:
            log.warning('Have I Been Pwned unreachable at sign-in; not checked: %s', err)
            return
        if hits:
            request.session[PWNED] = True
            record(AuthEvent.Kind.PASSWORD_PWNED, request, user=user, breaches=int(hits))

    # ---------------------------------------------------------------- sign-up

    def is_open_for_signup(self, request):
        # Every mode is "open" at the door: the address decides, and the
        # address is not known until the form is read (clean_email).
        return True

    def clean_email(self, email):
        email = super().clean_email(email)
        decision = policy.signup_allowed(email)
        if not decision.allowed and decision.public:
            record(AuthEvent.Kind.SIGNUP_REFUSED, self.request, email=email, reason=decision.reason)
            raise ValidationError(f'Sign-up is not open to that address: {decision.reason}.', code='signup_closed')
        return email

    def send_account_already_exists_mail(self, email):
        # Hash something. The branch that makes an account hashes the new
        # password; this branch, which makes nothing, would otherwise answer
        # tens of milliseconds sooner and say so to anyone with a stopwatch.
        # The discarded password is not passed this far, and Argon2id costs
        # the same for any input, so a random one pays the same bill.
        make_password(secrets.token_urlsafe(24))
        if policy.signup_allowed(email).allowed:
            # A real "you already have an account" — the address exists.
            return super().send_account_already_exists_mail(email)
        # Nobody invited this address, and the browser was told the same
        # thing it is told for an address that exists: check your mail.
        # The mail is the one place the truth can go.
        record(AuthEvent.Kind.SIGNUP_REFUSED, self.request, email=email, reason='no live invitation')
        mailer.send('account/email/not_invited', email)

    # ---------------------------------------------------------------- recovery

    def send_password_reset_mail(self, user, email, context):
        # `email` is the address that asked, which for seven days after an
        # email change may be the previous one. Say which address signs in
        # now, so the person who reads this can see the change and undo it.
        context = {**context, 'login_email': user.email, 'asked_via_previous': user.email.lower() != email.lower()}
        return super().send_password_reset_mail(user, email, context)

    # ---------------------------------------------------------------- the client

    def get_client_ip(self, request):
        # The same arithmetic the audit log uses, so a rate-limit bucket and
        # the row that explains it name the same address.
        return client_ip(request) or ''
