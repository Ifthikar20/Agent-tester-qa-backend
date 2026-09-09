"""
Ending every session an account has.

Django keeps sessions in one table with no column naming the user, so this
walks the live rows and reads each one. That is fine at this size and the
alternative — allauth's usersessions app, which indexes them — is the mfa
step's, which also gives the person a page listing them. Until then, a
password reset or change is the one moment every other session must die
[mfa-recovery-3]: the person doing the resetting is, in the case that
matters, the person who just lost the cookie.
"""
from django.contrib.auth import SESSION_KEY
from django.contrib.sessions.models import Session
from django.utils import timezone


def flush_all(user, keep=None):
    """Delete every session belonging to `user` except the key `keep`. Returns how many."""
    target = str(user.pk)
    gone = 0
    for row in Session.objects.filter(expire_date__gt=timezone.now()).iterator():
        if keep and row.session_key == keep:
            continue
        try:
            data = row.get_decoded()
        except Exception:  # a row signed with an older SECRET_KEY decodes to nothing useful
            continue
        if str(data.get(SESSION_KEY, '')) == target:
            row.delete()
            gone += 1
    return gone
