"""
Three of allauth's headless views, with one rule each added.

allauth's JSON API (/_allauth/browser/v1/) is used as it ships, except that
config/urls.py mounts these three ahead of it, at the same paths, so a
request reaches the subclass first:

  auth/login             a Turnstile token is demanded from an address that
                         has tripped the failed-login limit [credentials-1]
  auth/signup            a Turnstile token in open mode; the sign-up policy
                         (accounts/policy.py) for the refusals that may be
                         said out loud; and in invite mode an address nobody
                         invited is sent down the "already exists" branch, so
                         the answer — and its timing — is the one an existing
                         address gets [credentials-3]. The policy is applied
                         HERE rather than in the adapter's clean_email
                         because allauth runs that hook on every address it
                         meets, Google's included, and a Google address is
                         judged by the social adapter with the id_token's
                         hd, never by the string after the @
  auth/password/request  an address the account used until a week ago still
                         identifies it, so an email change can be undone
                         from the old mailbox [mfa-recovery-3]

Everything else — the codes, the rate limits, the session cycling, the
responses the SPA reads — is allauth's own.
"""
from allauth.account.forms import ResetPasswordForm
from allauth.headless.account import inputs as allauth_inputs
from allauth.headless.account import views as allauth_views
from allauth.headless.internal.restkit import inputs
from django.core.exceptions import ValidationError

from . import policy, turnstile
from .events import client_ip, record
from .models import AuthEvent, PreviousEmail


class TurnstileInput(inputs.Input):
    """An optional `turnstile` field, checked before anything that costs."""

    action = ''
    turnstile = inputs.CharField(required=False)

    def check_turnstile(self):
        from allauth.core import context
        request = context.request
        ip = client_ip(request)
        if not turnstile.required_for(self.action, ip):
            return
        token = (self.data or {}).get('turnstile') or ''
        if not token:
            raise ValidationError('Complete the verification challenge to continue.', code='turnstile_required')
        if not turnstile.verify(token, ip):
            raise ValidationError('The verification challenge did not pass. Try it again.', code='turnstile_failed')

    def clean(self):
        # Before the password is ever checked: a script that has to solve a
        # challenge first does not get to spend hasher time finding out
        # whether its guess was right.
        try:
            self.check_turnstile()
        except ValidationError as err:
            self.add_error('turnstile', err)
            return self.cleaned_data
        return super().clean()


class LoginInput(TurnstileInput, allauth_inputs.LoginInput):
    action = 'login'


class SignupInput(TurnstileInput, allauth_inputs.SignupInput):
    action = 'signup'

    def validate_unique_email(self, value):
        email = super().validate_unique_email(value)
        if not self.account_already_exists:
            decision = policy.signup_allowed(email)
            if not decision.allowed and decision.public:
                # A domain rule is policy, not a secret: said out loud.
                from allauth.core import context
                record(AuthEvent.Kind.SIGNUP_REFUSED, context.request, email=email, reason=decision.reason)
                raise ValidationError(f'Sign-up is not open to that address: {decision.reason}.', code='signup_closed')
            if not decision.allowed:
                # Answered exactly as an existing address is: no account, a
                # "check your mail" response, and the adapter's mail says
                # what actually happened (AccountAdapter
                # .send_account_already_exists_mail).
                self.account_already_exists = True
        return email


class RequestPasswordResetInput(ResetPasswordForm, inputs.Input):
    def clean_email(self):
        from allauth.core import context
        email = super().clean_email()
        # allauth found the accounts that hold this address now; add the one
        # that held it until a week ago. The mail still goes to the address
        # typed, so this is the old mailbox resetting the account it lost.
        seen = {u.pk for u in self.users}
        for user in PreviousEmail.users_for(email):
            if user.pk not in seen:
                self.users.append(user)
                seen.add(user.pk)
                record(AuthEvent.Kind.PASSWORD_RESET_REQUESTED, context.request, user=user, email=email,
                       via='previous_email')
        return email


class LoginView(allauth_views.LoginView):
    input_class = LoginInput


class SignupView(allauth_views.SignupView):
    input_class = {'POST': SignupInput}


class RequestPasswordResetView(allauth_views.RequestPasswordResetView):
    input_class = RequestPasswordResetInput
