"""
The shape a refusal has, whichever half of the API gives it.

/auth/ is this project's own, and it answers {"error": "<word>", ...}: the
shape the SPA's request helper already unwraps (accounts/views.py). /_allauth/
is allauth's, and the SPA reads every answer from there as allauth's
{status, errors: [{code, message}]} — `codeOf` and `messageOf` in the UI's
session store. A refusal this project adds on an allauth path, the request
limit or a switched-off feature, has to be read by that same code, so there it
is written in allauth's shape, with the plain words beside it for anything that
reads only `error`.

A switched-off refusal writes no audit row. It says nothing about anybody's
account, only about the deployment, which the admin already shows; and a row
per refused request would make the cheapest answer here the most expensive one.
"""
from django.http import JsonResponse

ALLAUTH = '/_allauth/'


def refusal(request, status, error, message, **fields):
    """A JSON refusal: `{error, **fields}`, or under /_allauth/ allauth's shape with the same words in it."""
    body = {'error': error, **fields}
    if request.path.startswith(ALLAUTH):
        body = {'status': status, 'errors': [{'code': error, 'message': message, **fields}], **body}
    return JsonResponse(body, status=status)


def switched_off(request, key):
    """403 for a feature tenants/switches.py says is off: `{"error": "switched_off", "switch": key}`."""
    from tenants import switches
    return refusal(request, 403, 'switched_off', switches.sentence(key), switch=key)
