"""
What a plan can say, and the three plans there are.

An entitlement is a key from KEYS and a value of the kind KEYS gives it. A
count of None means unlimited, which is why the type is "int or None" rather
than a sentinel like -1: a limit that is genuinely absent should read as
absent, not as a number a comparison has to special-case.

RUNNER_ENFORCED is the half the runner needs. It rides in the executor token,
where every byte is a byte in a WebSocket URL, so the keys the control plane
enforces itself (how many members, whether MFA is demanded) stay out of it.

PLANS is the catalogue. The data migration that seeds the table copies these
numbers rather than importing them, because a migration must say what was
true when it ran; a test asserts the two agree, so changing a number here
without writing a new migration fails loudly rather than drifting.
"""
from django.core.exceptions import ValidationError

COUNT, BOOL = 'count', 'bool'

KEYS = {
    'suites.max': COUNT,
    'runs.per_day': COUNT,
    'origins.max': COUNT,
    'vault.enabled': BOOL,
    'history.retention_days': COUNT,
    'members.max': COUNT,
    'mfa.required': BOOL,
}

RUNNER_ENFORCED = ('suites.max', 'runs.per_day', 'origins.max', 'vault.enabled', 'history.retention_days')

PLANS = {
    'free': {
        'name': 'Free',
        'entitlements': {
            'suites.max': 3, 'runs.per_day': 20, 'origins.max': 2, 'vault.enabled': False,
            'history.retention_days': 7, 'members.max': 1, 'mfa.required': False,
        },
    },
    'team': {
        'name': 'Team',
        'entitlements': {
            'suites.max': 25, 'runs.per_day': 500, 'origins.max': 20, 'vault.enabled': True,
            'history.retention_days': 90, 'members.max': 10, 'mfa.required': False,
        },
    },
    'enterprise': {
        'name': 'Enterprise',
        'entitlements': {
            'suites.max': None, 'runs.per_day': None, 'origins.max': None, 'vault.enabled': True,
            'history.retention_days': 365, 'members.max': None, 'mfa.required': True,
        },
    },
}

# The plan every personal organisation starts on.
DEFAULT_PLAN = 'free'


def validate_entitlements(values, *, complete=False):
    """
    Refuse a key nobody reads or a value of the wrong kind.

    A typo in an override ('suite.max') would otherwise be stored, shown in
    the admin, and enforce nothing; a string where a count belongs would
    compare as greater than every integer on the runner. `complete` is for a
    plan, which must say something about every key so resolution never has
    to invent a default.
    """
    if not isinstance(values, dict):
        raise ValidationError('entitlements must be a JSON object')
    problems = []
    for key, value in values.items():
        kind = KEYS.get(key)
        if kind is None:
            problems.append(f'{key!r} is not an entitlement (one of {", ".join(KEYS)})')
        elif kind == BOOL and not isinstance(value, bool):
            problems.append(f'{key} must be true or false')
        elif kind == COUNT and not (value is None or (isinstance(value, int) and not isinstance(value, bool) and value >= 0)):
            problems.append(f'{key} must be a whole number, or null for unlimited')
    if complete:
        for key in KEYS:
            if key not in values:
                problems.append(f'a plan must say what {key} is')
    if problems:
        raise ValidationError(problems)


def resolve(plan_entitlements, overrides):
    """Plan defaults with the organisation's overrides on top, for every known key."""
    merged = {**plan_entitlements, **overrides}
    return {key: merged.get(key) for key in KEYS}


def runner_subset(entitlements):
    """The keys the runner enforces — the only ones that belong in a token."""
    return {key: entitlements.get(key) for key in RUNNER_ENFORCED}
