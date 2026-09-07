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
