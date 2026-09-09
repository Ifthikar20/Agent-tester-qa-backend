"""
Who acts for whom, and what the plan allows (docs/AUTH.md §10).

Four tables. A Plan is a named bundle of entitlements. An Organization is on
one plan and may override any of its numbers. A Membership says a user holds
a role in an organisation, and it is the ONLY place a role comes from: the
executor token copies the row, the runner reads the token, and nothing in
between is asked its opinion. An Invitation is a hashed single-use token that
becomes a Membership when the right person accepts it.

Every account has a personal organisation (tenants.personal), so there is
never a signed-in user with nowhere to act — the alternative is a null
organisation that every downstream check has to remember to refuse.
"""
import hashlib
import json
import secrets

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import F
from django.utils import timezone

from . import plans
from .slugs import is_slug


def _same_json(a, b):
    return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


class Plan(models.Model):
    slug = models.SlugField(unique=True)
    name = models.CharField(max_length=80)
    entitlements = models.JSONField(default=dict)

    class Meta:
        ordering = ['slug']

    def __str__(self):
        return self.name

    @classmethod
    def from_db(cls, db, field_names, values):
        # Keep what was loaded, so save() can tell whether the numbers moved.
        # Read from __dict__ rather than the attribute: a deferred load (the
        # deletion collector uses one) would otherwise fetch the field, which
        # comes back through here, which fetches the field.
        row = super().from_db(db, field_names, values)
        row._loaded_entitlements = row.__dict__.get('entitlements')
        return row

    def clean(self):
        plans.validate_entitlements(self.entitlements, complete=True)

    def save(self, *args, **kwargs):
        # Changing a plan changes what every organisation on it resolves to,
        # and the runner caches entitlements by (org, version): a plan edit
        # that left the versions alone would be enforced only for tokens
        # minted after the old ones ran out, silently and unevenly.
        was = getattr(self, '_loaded_entitlements', None)
        super().save(*args, **kwargs)
        if was is not None and not _same_json(was, self.entitlements):
            Organization.objects.filter(plan=self).update(entitlements_version=F('entitlements_version') + 1)
        self._loaded_entitlements = self.entitlements

    @classmethod
    def default(cls):
        """
        The plan a personal organisation starts on.

        get_or_create rather than get: the row is seeded by a migration, but
        a receiver that fires while a test database is being built, or an
        operator who deleted the row in the admin, would otherwise make
        signing up impossible, and the catalogue in plans.py already says
        exactly what the row should be.
        """
        spec = plans.PLANS[plans.DEFAULT_PLAN]
        row, _ = cls.objects.get_or_create(
            slug=plans.DEFAULT_PLAN, defaults={'name': spec['name'], 'entitlements': spec['entitlements']},
        )
        return row


class Organization(models.Model):
    slug = models.SlugField(unique=True)
    name = models.CharField(max_length=120)
    plan = models.ForeignKey(Plan, on_delete=models.PROTECT, related_name='organizations')
    entitlement_overrides = models.JSONField(default=dict, blank=True)
    # Bumped on every change to what resolve() would answer. The runner
    # honours it per organisation, so a downgrade takes effect on the next
    # token rather than when the old ones expire (docs/AUTH.md §8.6).
    entitlements_version = models.PositiveIntegerField(default=1)
    # Set on the organisation that was made FOR this user at sign-up. One per
    # user, enforced by the database rather than by whoever creates them.
    personal_of = models.OneToOneField(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.CASCADE,
        related_name='personal_organization',
    )
    members = models.ManyToManyField(settings.AUTH_USER_MODEL, through='Membership', related_name='organizations')
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ['name']

    def __str__(self):
        return self.name

    @classmethod
    def from_db(cls, db, field_names, values):
        # Same deferred-load care as Plan.from_db: only snapshot what came
        # back, and a partial row simply does not version-bump on save.
        row = super().from_db(db, field_names, values)
        loaded = row.__dict__
        if 'plan_id' in loaded and 'entitlement_overrides' in loaded:
            row._loaded = (loaded['plan_id'], loaded['entitlement_overrides'])
        return row

    def clean(self):
        if not is_slug(self.slug):
            raise ValidationError({'slug': 'lowercase letters, digits and hyphens, and not a reserved word'})
        plans.validate_entitlements(self.entitlement_overrides or {})

    def save(self, *args, **kwargs):
        loaded = getattr(self, '_loaded', None)
        if loaded is not None and (loaded[0] != self.plan_id or not _same_json(loaded[1], self.entitlement_overrides)):
            self.entitlements_version += 1
        super().save(*args, **kwargs)
        self._loaded = (self.plan_id, self.entitlement_overrides)

    @property
    def is_personal(self):
        return self.personal_of_id is not None

    def entitlements(self):
        """`{**plan.entitlements, **overrides}`, for every key there is."""
        return plans.resolve(self.plan.entitlements, self.entitlement_overrides or {})

    def seats_taken(self):
        """Members plus invitations that could still become members."""
        return self.memberships.count() + self.invitations.live().count()


class Role(models.TextChoices):
    OWNER = 'owner', 'owner'
    ADMIN = 'admin', 'admin'
    MEMBER = 'member', 'member'


# Higher grants more. The cap rule in Invitation.issue compares these.
RANK = {Role.MEMBER: 0, Role.ADMIN: 1, Role.OWNER: 2}


class Membership(models.Model):
    organization = models.ForeignKey(Organization, on_delete=models.CASCADE, related_name='memberships')
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='memberships')
    role = models.CharField(max_length=8, choices=Role.choices, default=Role.MEMBER)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['organization', 'user'], name='one_membership_per_user_per_org')]
        ordering = ['organization__name']

    def __str__(self):
        return f'{self.user} is {self.role} of {self.organization}'

    @property
    def manages(self):
        """May see and issue invitations, and change the organisation's settings."""
        return self.role in (Role.OWNER, Role.ADMIN)


class InvitationQuerySet(models.QuerySet):
    def live(self):
        return self.filter(accepted_at__isnull=True, revoked_at__isnull=True, expires_at__gt=timezone.now())


def hash_token(raw):
    # The raw token is 256 random bits, so a plain hash is a fine lookup key
    # and a stolen table gives nothing that can be presented. No salt, on
    # purpose: a salted hash cannot be looked up.
    return hashlib.sha256(raw.encode('ascii')).hexdigest()


class Invitation(models.Model):
    """
    A hashed, email-bound, single-use, week-long promise of a membership.

    The token itself is shown once, at issue, and only its hash is stored —
    the same rule as a password. It is bound to an address so that a link
    forwarded to the wrong person is worth nothing, and consumed only by a
    signed-in user holding that address, so an invitation can never create
    an account or a session by itself [credentials-6].
    """
    LIFETIME_DAYS = 7

    organization = models.ForeignKey(Organization, on_delete=models.CASCADE, related_name='invitations')
    email = models.EmailField()
    role = models.CharField(max_length=8, choices=Role.choices, default=Role.MEMBER)
    token_hash = models.CharField(max_length=64, unique=True, editable=False)
    invited_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name='invitations_sent',
    )
    created_at = models.DateTimeField(default=timezone.now)
    expires_at = models.DateTimeField()
    accepted_at = models.DateTimeField(null=True, blank=True)
    accepted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name='invitations_accepted',
    )
    revoked_at = models.DateTimeField(null=True, blank=True)

    objects = InvitationQuerySet.as_manager()

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f'{self.email} as {self.role} of {self.organization}'

    @property
    def is_live(self):
        return self.accepted_at is None and self.revoked_at is None and self.expires_at > timezone.now()

    @property
    def state(self):
        if self.accepted_at:
            return 'accepted'
        if self.revoked_at:
            return 'revoked'
        return 'pending' if self.expires_at > timezone.now() else 'expired'

    @classmethod
    def new_token(cls):
        return secrets.token_urlsafe(32)

    @classmethod
    def by_token(cls, raw):
        if not isinstance(raw, str) or not (20 <= len(raw) <= 128):
            return None
        return cls.objects.select_related('organization', 'organization__plan').filter(token_hash=hash_token(raw)).first()

    def to_json(self):
        return {
            'id': self.pk, 'email': self.email, 'role': self.role, 'state': self.state,
            'expiresAt': self.expires_at.isoformat(), 'invitedBy': getattr(self.invited_by, 'email', None),
        }
