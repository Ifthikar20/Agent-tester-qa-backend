"""
A person who may drive the runner.

Deliberately thin. Everything about *what* they may drive — suites, cases, the
origin allowlist, the vault — lives on the executor, and putting any of it here
would mean two services with an opinion about the same rule, which is how a
hard gate becomes advisory.

The model exists on day one for one unglamorous reason: AUTH_USER_MODEL cannot
be changed after the first migration without hand-writing a data migration
across every table that points at it. An empty custom model now is free; the
retrofit is not.
"""
from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin
from django.db import models
from django.utils import timezone


class UserManager(BaseUserManager):
    """Email is the identifier, so the manager normalises it rather than a username."""

    use_in_migrations = True

    def _create(self, email, password, **extra):
        if not email:
            raise ValueError('an email address is required')
        user = self.model(email=self.normalize_email(email), **extra)
        # set_password hashes; assigning to .password would store it in the
        # clear, which is a one-line mistake with a very long tail.
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_user(self, email, password=None, **extra):
        extra.setdefault('is_staff', False)
        extra.setdefault('is_superuser', False)
        return self._create(email, password, **extra)

    def create_superuser(self, email, password=None, **extra):
        extra.setdefault('is_staff', True)
        extra.setdefault('is_superuser', True)
        if not extra['is_staff'] or not extra['is_superuser']:
            raise ValueError('a superuser is staff and superuser')
        return self._create(email, password, **extra)


class User(AbstractBaseUser, PermissionsMixin):
    email = models.EmailField('email address', unique=True)
    name = models.CharField('display name', max_length=200, blank=True)
    is_active = models.BooleanField(default=True)
    is_staff = models.BooleanField(default=False)
    date_joined = models.DateTimeField(default=timezone.now)

    USERNAME_FIELD = 'email'
    REQUIRED_FIELDS = []

    objects = UserManager()

    class Meta:
        ordering = ['email']

    def __str__(self):
        return self.email


class AuthEvent(models.Model):
    """
    One row per thing that happened to an account: a sign-in, a sign-out, a
    refused password, a session that ran out. Append-only, and the reason it
    exists is the paragraph in docs/AUTH.md §13 about what cannot be
    survived: a compromised control plane or operator is detected by the log
    they cannot avoid writing to, so the log has to be written by the framework's
    own signals rather than by whichever view remembered to.

    The email is stored as typed, separately from the user row, because the
    interesting failed attempts are the ones against addresses that have no
    row. The IP is the client as the edge reports it (accounts.events.client_ip),
    never the header a client can set.
    """

    class Kind(models.TextChoices):
        LOGIN = 'login', 'signed in'
        LOGOUT = 'logout', 'signed out'
        LOGIN_FAILED = 'login_failed', 'sign-in refused'
        SESSION_EXPIRED = 'session_expired', 'session past its absolute lifetime'
        INVITATION_SENT = 'invitation_sent', 'invitation issued'
        INVITATION_ACCEPTED = 'invitation_accepted', 'invitation accepted'
        INVITATION_REFUSED = 'invitation_refused', 'invitation refused'
        # One row per executor token, with its jti in `detail`: a token that
        # never appears here was not minted here [token-5].
        MINT = 'mint', 'executor token minted'
        MINT_REFUSED = 'mint_refused', 'executor token refused'
        # The account's own life (docs/AUTH.md §4 and §7): every sign-up,
        # verification and refusal, and every change to what signs it in.
        SIGNUP = 'signup', 'signed up'
        SIGNUP_REFUSED = 'signup_refused', 'sign-up refused'
        EMAIL_VERIFIED = 'email_verified', 'email address verified'
        REAUTHENTICATION = 'reauthentication', 'reauthenticated'
        PASSWORD_CHANGED = 'password_changed', 'password changed'
        PASSWORD_RESET_REQUESTED = 'password_reset_requested', 'password reset requested'
        PASSWORD_RESET = 'password_reset', 'password reset'
        PASSWORD_PWNED = 'password_pwned', 'password known to Have I Been Pwned'
        EMAIL_CHANGED = 'email_changed', 'email address changed'
        NEW_DEVICE = 'new_device', 'signed in from an unseen device'
        TURNSTILE_DEMANDED = 'turnstile_demanded', 'address must now solve Turnstile'

    at = models.DateTimeField(default=timezone.now, db_index=True)
    # A CharField with choices rather than an enum column: later flows add
    # kinds (mint, signup, verification, reauthentication) without a migration
    # that rewrites every row.
    kind = models.CharField(max_length=32, choices=Kind.choices, db_index=True)
    user = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name='auth_events',
    )
    email = models.CharField(max_length=254, blank=True)
    ip = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=512, blank=True)
    detail = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ['-at']

    def __str__(self):
        who = self.user.email if self.user_id else (self.email or '-')
        return f'{self.at:%Y-%m-%d %H:%M:%S} {self.kind} {who}'


class PreviousEmail(models.Model):
    """
    An address an account used to sign in with, kept for a week.

    The attack this closes [mfa-recovery-3]: someone holding a session
    changes the account's email to their own, and the real owner — who still
    has the old mailbox — can no longer ask for a password reset because the
    account no longer answers to that address. For seven days it still does:
    a reset requested for a previous address goes to that address and resets
    the same account, so the owner can take it back. After `until` the row
    is ignored, and it is only ever read by the reset request.
    """
    GRACE_DAYS = 7

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='previous_emails')
    email = models.EmailField(db_index=True)
    replaced_by = models.EmailField()
    replaced_at = models.DateTimeField(default=timezone.now)
    until = models.DateTimeField(db_index=True)

    class Meta:
        ordering = ['-replaced_at']

    def __str__(self):
        return f'{self.email} was {self.user_id} until {self.until:%Y-%m-%d}'

    @classmethod
    def users_for(cls, email):
        """The users `email` may still reset a password for, newest change first."""
        now = timezone.now()
        rows = cls.objects.filter(email__iexact=email, until__gt=now).select_related('user')
        return [r.user for r in rows if r.user.is_active]
