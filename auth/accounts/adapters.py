"""
Where django-allauth asks this project what it wants.

Most of what allauth does is left alone. The overrides are the rules in
docs/AUTH.md that allauth has no setting for:

  authenticate                  every successful sign-in runs the presented
                                password through Have I Been Pwned; a hit
                                marks the session, and the middleware then
                                allows nothing but a password change
                                [credentials-1]
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
  is_safe_url                   where a Google sign-in may send the browser
                                afterwards: the app's own origin and a path
                                under /app/, never ALLOWED_HOSTS [oauth-4]

And the social adapter, for Google (docs/AUTH.md §6):

  is_open_for_signup            the same policy the password sign-up asks,
                                with the id_token's `hd` for domain mode,
                                and the same sign-up rate limit [oauth-5]
  authenticate_by_email         Google's verified address opens an existing
                                account only when the local address is
                                verified too and no other Google identity is
                                attached [oauth-2]
  pre_social_login              a Google identity that matches an existing
                                address but may not open it is refused —
                                never turned into a second account
  save_user                     a Google sign-up's address is verified on
                                Google's word, so what verification does
                                (the log row, the invitations) happens here
"""
import logging
import secrets
from urllib.parse import urlsplit

from allauth.account.adapter import DefaultAccountAdapter
from allauth.account.models import EmailAddress
from allauth.core import context
from allauth.socialaccount.adapter import DefaultSocialAccountAdapter
from allauth.socialaccount.models import SocialAccount
from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import make_password
from django.core.exceptions import PermissionDenied, ValidationError
from django.db.models import Q
from pwned_passwords_django import api as hibp
from pwned_passwords_django.exceptions import PwnedPasswordsError

from . import google, mailer, policy
from .events import PWNED, client_ip, record
from .models import AuthEvent

log = logging.getLogger(__name__)


def app_url(url):
    """
    Is `url` a page of this app? Scheme and host must equal the app's own
    (GC_APP_URL, which is GC_PUBLIC_URL in production and GC_WEB_ORIGIN on a
    laptop) and the path must be under /app/. Not ALLOWED_HOSTS, and not a
    relative path either [oauth-4]: the URL is where a browser is sent
    after Google has vouched for it, and on a laptop a relative path would
    resolve against this service's port rather than the UI's. With no
    origin configured there is no UI to send anyone to, and nothing passes.
    """
    base = urlsplit(getattr(settings, 'GC_APP_URL', '') or '')
    if not base.scheme or not base.netloc:
        return False
    if not isinstance(url, str) or any(c in url for c in '\\\r\n\t\0'):
        return False
    parts = urlsplit(url)
    if parts.scheme.lower() != base.scheme.lower() or parts.netloc.lower() != base.netloc.lower():
        return False
    return parts.path.startswith(base.path.rstrip('/') + '/')


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
        # address is not known until the form is read. The policy runs in
        # accounts.headless.SignupInput — not in clean_email here, which
        # allauth calls on every address it meets, Google's included.
        return True

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

    def is_safe_url(self, url):
        # allauth's own version admits any host in ALLOWED_HOSTS or the CSRF
        # origins and any relative path. This is the check on the Google
        # flow's callback_url, and the SPA hard-codes that to its own
        # /app/login, so the only URLs that ever need to pass are the app's.
        return app_url(url)


class SocialAccountAdapter(DefaultSocialAccountAdapter):
    """
    Google, and the three rules allauth leaves to the project.

    Every refusal here is answered by the callback (accounts/google.py)
    with the same word, whatever the rule was; the rule and the address go
    to the audit log instead. The browser learns that Google did not work
    and what to do about it, and nothing about whose account it touched.
    """

    # ---------------------------------------------------------------- sign-up

    def is_open_for_signup(self, request, sociallogin):
        """
        May this Google identity make an account? The same question the
        password sign-up asks, of the same policy, so that invite mode
        cannot be walked around by signing in with Google [oauth-5]; and
        the same sign-up rate limit, so a script cannot get twice the
        budget by alternating the two doors. `hd` is read from the
        id_token, never from the address: in domain mode Google's claim
        about the workspace is the fact, and its absence is a refusal.
        """
        email = _email_of(sociallogin)
        hd = (sociallogin.account.extra_data or {}).get('hd') or ''
        if not _consume_signup_limit(request):
            google.refuse(request, 'rate_limited', kind=AuthEvent.Kind.SIGNUP_REFUSED, email=email, method='google')
            return False
        decision = policy.signup_allowed(email, hd=hd)
        if not decision.allowed:
            google.refuse(request, decision.reason, kind=AuthEvent.Kind.SIGNUP_REFUSED, email=email, hd=hd, method='google')
            return False
        return True

    def save_user(self, request, sociallogin, form=None):
        """
        A Google sign-up: allauth makes the account with no usable password
        and, when Google said the address is verified, an EmailAddress row
        already verified — without the email_confirmed signal a code would
        have fired. The two things that signal does for a password sign-up
        happen here instead: the row in the log, and every live invitation
        bound to the address becoming a membership [credentials-6]. An
        address Google did NOT vouch for is left unverified, and the sign-in
        then asks for a code exactly as a password sign-up would.
        """
        user = super().save_user(request, sociallogin, form)
        from tenants import invitations
        for address in EmailAddress.objects.filter(user=user, verified=True):
            record(AuthEvent.Kind.EMAIL_VERIFIED, request, user=user, email=address.email, by='google')
            invitations.accept_pending(user, request, email=address.email)
        return user

    def populate_user(self, request, sociallogin, data):
        # allauth fills first_name and last_name, which this model does not
        # have; it has one display name, and Google's given and family names
        # make one.
        user = super().populate_user(request, sociallogin, data)
        user.name = ' '.join(p for p in (data.get('first_name'), data.get('last_name')) if p)[:200]
        return user

    # ---------------------------------------------------------------- an existing account

    def authenticate_by_email(self, sociallogin):
        """
        Which existing account, if any, this Google identity may open by
        its address [oauth-2]. Three things have to be true at once: Google
        says the address is verified; the local EmailAddress row for it is
        verified too — an address someone merely typed into an account is a
        claim, not a proof, and a claim must not become a login because a
        Google user happens to own the mailbox; and the account has no other
        Google identity attached — an account that already answers to one
        `sub` does not start answering to a second because the addresses
        agree. The first identity was connected by the account's owner; a
        second one is the thing [oauth-2] describes.

        None here means "not by email": the caller then treats the identity
        as new, and pre_social_login refuses it if the address is taken.
        """
        request = context.request
        for address in sociallogin.email_addresses:
            if not address.verified or not address.email:
                continue
            local = EmailAddress.objects.filter(email__iexact=address.email, verified=True).select_related('user').first()
            if local is None:
                continue
            attached = SocialAccount.objects.filter(user=local.user, provider=sociallogin.account.provider)
            if attached.exclude(uid=sociallogin.account.uid).exists():
                google.refuse(request, 'another Google identity already opens this account', email=address.email)
                return None
            return local.user, address.email
        return None

    def pre_social_login(self, request, sociallogin):
        """
        The identity has been looked up: by `sub`, then by address under
        the rule above. What must not happen next is allauth treating a
        refused match as a NEW person and running the sign-up — which
        would either collide with the existing address or, with
        enumeration prevention, mail the existing account a "you already
        have an account" it did not ask for. So: an identity that is not
        existing, whose address (verified by Google or not) belongs to any
        account, is refused here, generically, and the person is told to
        sign in the way they usually do and connect Google from Settings.
        """
        if sociallogin.is_existing:
            return
        emails = [a.email for a in sociallogin.email_addresses if a.email]
        if not emails:
            return
        User = get_user_model()
        # Case-insensitively: allauth stores addresses lower-cased and
        # Google reports them as the person typed them into Google.
        match = Q()
        for email in emails:
            match |= Q(email__iexact=email)
        taken = EmailAddress.objects.filter(match).exists() or User.objects.filter(match).exists()
        if taken:
            google.refuse(request, 'address belongs to an account this identity may not open', email=emails[0])
            raise PermissionDenied('refused')

    # ---------------------------------------------------------------- settings

    def get_connect_redirect_url(self, request, socialaccount):
        # Where a connect lands when the SPA gave no callback_url; it
        # always gives one, and this is the page it gives.
        return f'{settings.GC_APP_URL}/security'


def _email_of(sociallogin):
    addresses = [a.email for a in sociallogin.email_addresses if a.email]
    return (addresses[0] if addresses else getattr(sociallogin.user, 'email', '') or '').lower()


def _consume_signup_limit(request):
    """
    One attempt against ACCOUNT_RATE_LIMITS['signup'], in allauth's own
    bucket, so the password door and the Google door share a budget. The
    internal function rather than allauth.core.ratelimit.consume because
    the callback is a GET and the public one waves every GET through.
    """
    from allauth.account import app_settings as account_settings
    from allauth.core.internal import ratelimit
    return ratelimit.consume(request, config=account_settings.RATE_LIMITS, action='signup', limit_get=True) is not None
