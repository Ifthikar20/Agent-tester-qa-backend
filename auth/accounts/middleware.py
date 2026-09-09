"""
The absolute session lifetime.

Django's session expiry slides: SESSION_SAVE_EVERY_REQUEST pushes it twelve
hours past every request, which is right for a person and wrong for a stolen
cookie, which the thief simply keeps using. This is the clock that does not
slide. The receiver in accounts.events writes the sign-in time into the
session once; this reads it and, past GC_SESSION_ABSOLUTE_SECONDS, flushes
the session and answers 401 so the SPA sends the person back to sign in.
"""
import time

from django.conf import settings
from django.contrib.auth import SESSION_KEY
from django.http import JsonResponse

from .events import LOGIN_AT, record
from .models import AuthEvent


class AbsoluteSessionLifetime:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        # The session key, not request.user: touching the lazy user costs a
        # query on every request, and an anonymous session has nothing to
        # expire.
        session = getattr(request, 'session', None)
        if session is not None and SESSION_KEY in session:
            began = session.get(LOGIN_AT)
            now = int(time.time())
            if began is None:
                # A session from before this rule existed. Its start is
                # unknown, so the clock starts now rather than never.
                session[LOGIN_AT] = now
            elif now - int(began) > settings.GC_SESSION_ABSOLUTE_SECONDS:
                record(AuthEvent.Kind.SESSION_EXPIRED, request, user=request.user, began=int(began))
                session.flush()
                return JsonResponse({'error': 'session_expired'}, status=401)
        return self.get_response(request)
