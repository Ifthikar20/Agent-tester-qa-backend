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
  the four WebAuthn views
                         every ceremony demands user verification, and a
                         credential made on any origin but the app's own is
                         refused before allauth reads it (accounts/webauthn.py)
                         [mfa-recovery-5]
  auth/sessions          ending other sessions is a row in the audit log

Everything else — the codes, the rate limits, the session cycling, the
responses the SPA reads — is allauth's own.
"""
from allauth.account.forms import ResetPasswordForm
from allauth.core.internal.httpkit import authenticated_user
from allauth.headless.account import inputs as allauth_inputs
from allauth.headless.account import views as allauth_views
from allauth.headless.internal.restkit import inputs
from allauth.headless.mfa import inputs as mfa_inputs
from allauth.headless.mfa import response as mfa_response
from allauth.headless.mfa import views as mfa_views
from allauth.headless.socialaccount import views as socialaccount_views
from allauth.headless.usersessions import views as usersessions_views
from allauth.mfa.base.forms import ReauthenticateForm
from django.core.exceptions import ValidationError
from django.http import Http404

from . import policy, turnstile, webauthn
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
        # One row per request, for every path through it. Only the rare
        # previous-address case below used to be written down, which left the
        # endpoint that mails ANY address on request
        # (ACCOUNT_EMAIL_UNKNOWN_ACCOUNTS is True) invisible in the audit log
        # while its unusual cousin was not — and §4.6 asks for every one. An
        # address matching nobody gets a row saying so, because a sweep over
        # addresses is exactly the shape worth seeing there.
        for found in self.users:
            record(AuthEvent.Kind.PASSWORD_RESET_REQUESTED, context.request, user=found, email=email, known=True)
        if not self.users:
            record(AuthEvent.Kind.PASSWORD_RESET_REQUESTED, context.request, email=email, known=False)
        # Then the account that held this address until a week ago. The mail
        # still goes to the address typed, so this is the old mailbox
        # resetting the account it lost.
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


# ---------------------------------------------------------------- passkeys
#
# The origin check runs in the field's own clean, which Django runs before
# the form's, so a credential from elsewhere is refused before allauth's
# clean() hands it to fido2 — and with the same "incorrect code" every
# other refusal gets.

class PinnedOrigin:
    def clean_credential(self):
        webauthn.check_origin(self.cleaned_data.get('credential'))
        parent = getattr(super(), 'clean_credential', None)
        return parent() if parent else self.cleaned_data['credential']


class AddWebAuthnInput(PinnedOrigin, mfa_inputs.AddWebAuthnInput):
    pass


class AuthenticateWebAuthnInput(PinnedOrigin, mfa_inputs.AuthenticateWebAuthnInput):
    pass


class ReauthenticateWebAuthnInput(PinnedOrigin, mfa_inputs.ReauthenticateWebAuthnInput):
    pass


class LoginWebAuthnInput(PinnedOrigin, mfa_inputs.LoginWebAuthnInput):
    """
    Passkey sign-in, which is the one WebAuthn endpoint an ANONYMOUS caller
    may reach — and therefore the one whose budget a stranger must not be
    able to spend on somebody else's account.

    allauth identifies the account from the `userHandle` the CLIENT supplied
    and then consumes that account's second-factor bucket
    (`mfa-auth-user-<pk>`, ACCOUNT_RATE_LIMITS['login_failed'], 5/5m/key)
    BEFORE the assertion has been verified; the clear only happens on
    success. The handle is base36 of a sequential primary key, so it is
    guessable — six bogus assertions every five minutes, from nobody, and
    the victim's own correct TOTP code starts answering
    `too_many_login_attempts` at auth/2fa/authenticate. A permanent,
    unauthenticated denial of sign-in for any enrolled account.

    So the budget this endpoint really spends is the caller's own address,
    and the account's bucket is refunded whenever the ceremony fails: an
    unverified assertion is not evidence about the account it names.
    """

    def clean_credential(self):
        from allauth.account import app_settings as account_settings
        from allauth.account.adapter import get_adapter as get_account_adapter
        from allauth.core import context
        from allauth.core.internal import ratelimit as allauth_ratelimit
        from allauth.mfa.webauthn.internal import auth as webauthn_auth
        from django.conf import settings

        from .ratelimit import over

        request = context.request
        if over('passkey-login', client_ip(request) or 'unknown', settings.GC_PASSKEY_LOGIN_RATE):
            raise get_account_adapter().validation_error('too_many_login_attempts')
        # Who the credential CLAIMS to be, read before allauth spends their
        # budget, so the refund below knows whose to give back. A handle that
        # names nobody needs no refund.
        try:
            victim = webauthn_auth.extract_user_from_response(self.cleaned_data.get('credential') or {})
        except ValidationError:
            victim = None
        try:
            return super().clean_credential()
        except ValidationError:
            if victim is not None:
                allauth_ratelimit.clear(
                    request,
                    config=account_settings.RATE_LIMITS,
                    action='login_failed',
                    key=f'mfa-auth-user-{victim.pk}',
                )
            raise


class ManageWebAuthnView(mfa_views.ManageWebAuthnView):
    input_class = {**mfa_views.ManageWebAuthnView.input_class, 'POST': AddWebAuthnInput}

    def get(self, request, *args, **kwargs):
        # allauth's begin_registration, with reauthentication checked the
        # same way, and user verification required whether or not the key
        # will sign in on its own.
        from allauth.account.internal.flows.reauthentication import raise_if_reauthentication_required
        raise_if_reauthentication_required(request)
        options = webauthn.begin_registration(request.user, 'passwordless' in request.GET)
        return mfa_response.AddWebAuthnResponse(request, options)


class AuthenticateWebAuthnView(mfa_views.AuthenticateWebAuthnView):
    input_class = {'POST': AuthenticateWebAuthnInput}

    def get(self, request, *args, **kwargs):
        return mfa_response.WebAuthnRequestOptionsResponse(request, webauthn.begin_authentication(self.stage.login.user))


class ReauthenticateWebAuthnView(mfa_views.ReauthenticateWebAuthnView):
    input_class = {'POST': ReauthenticateWebAuthnInput}

    def get(self, request, *args, **kwargs):
        return mfa_response.WebAuthnRequestOptionsResponse(request, webauthn.begin_authentication(authenticated_user(request)))


class LoginWebAuthnView(mfa_views.LoginWebAuthnView):
    input_class = {'POST': LoginWebAuthnInput}

    def get(self, request, *args, **kwargs):
        return mfa_response.WebAuthnRequestOptionsResponse(request, webauthn.begin_authentication())


# ---------------------------------------------------------------- the app

class ManageTOTPView(mfa_views.ManageTOTPView):
    def get(self, request, *args, **kwargs):
        # allauth answers "not enrolled" with the secret and the otpauth URL;
        # the SPA also needs a picture of it, and the control plane already
        # holds the QR library the adapter uses. Drawn here rather than in
        # the browser so the UI bundles nothing for it — the CSP admits no
        # script from anywhere else.
        response = super().get(request, *args, **kwargs)
        if response.status_code == 404:
            from allauth.mfa.adapter import get_adapter
            import json
            body = json.loads(response.content)
            url = body.get('meta', {}).get('totp_url')
            if url:
                body['meta']['svg'] = get_adapter().build_totp_svg(url)
                response.content = json.dumps(body)
        return response


# ---------------------------------------------------------------- the code, as a reauthentication

class ReauthenticateInput(ReauthenticateForm, inputs.Input):
    pass


class ReauthenticateView(mfa_views.ReauthenticateView):
    # allauth's view validates the code with its sign-in form, whose signal
    # says nothing about this being a reauthentication; the audit row that
    # docs/AUTH.md §7.4 wants ("this cookie proved the app again at 14:02")
    # needs the form that says so.
    input_class = ReauthenticateInput


# ---------------------------------------------------------------- Google

class RedirectToProviderView(socialaccount_views.RedirectToProviderView):
    """
    Starting a Google sign-in, with the refusal written down.

    allauth validates `callback_url` here — through
    accounts.adapters.AccountAdapter.is_safe_url, which is the [oauth-4] pin
    — and answers an unsafe one by redirecting back with `error=unknown`.
    That refusal never reaches accounts/google.py's callback wrapper, which
    is the only writer of a Google refusal row, so the ONE refusal in this
    flow shaped like an attack left no trace at all while "someone pressed
    Back on Google" left one. §4.6 asks for a row for every refusal.
    """

    def post(self, request, *args, **kwargs):
        response = super().post(request, *args, **kwargs)
        location = response.get('Location', '') if 300 <= response.status_code < 400 else ''
        # A started sign-in redirects to Google; anything else is a refusal,
        # and the app's own origin is where allauth sends one back to.
        if location and not location.startswith('https://accounts.google.com'):
            record(AuthEvent.Kind.GOOGLE_REFUSED, request, reason='unsafe callback_url',
                   callback_url=str(request.POST.get('callback_url', ''))[:300],
                   process=str(request.POST.get('process', ''))[:32])
        return response


def absent(request, *args, **kwargs):
    """
    A path allauth mounts and this deployment does not have.

    Mounted ahead of allauth's include so it wins, because allauth's headless
    urls come as one block: there is no setting that leaves out
    `auth/provider/token` — Google's One Tap door, which signs an id_token
    holder straight in with no state and no PKCE — or `auth/provider/signup`.
    Both are outside the one wrapped path this flow's defence is built on
    (accounts/google.py normalises every refusal to one word and writes the
    audit row; neither of these would), and §6.4 and [oauth-3] say One Tap is
    not enabled here. A 404 is what "not enabled" looks like from outside.
    """
    raise Http404


# ---------------------------------------------------------------- sessions

class SessionsView(usersessions_views.SessionsView):
    def delete(self, request, *args, **kwargs):
        # Which sessions, before they are gone: the input has resolved the
        # ids to rows that belong to this user and no other.
        chosen = list(self.input.cleaned_data['sessions'])
        user, own = request.user, request.session.session_key
        response = super().delete(request, *args, **kwargs)
        record(AuthEvent.Kind.SESSIONS_ENDED, request, user=user, count=len(chosen),
               current=any(s.session_key == own for s in chosen))
        return response
