"""
The three plans, and a personal organisation for every account that exists.

The numbers are copied from tenants/plans.py rather than imported: a
migration must say what was true when it ran, and importing the catalogue
would make this one silently mean something else after the next edit. A
test (tenants/tests/test_entitlements.py) asserts the two still agree, so
changing a number there without a new migration is a failing test, not a
drift.

The backfill uses the slug function, which IS imported: it is pure string
logic with no model behind it, and freezing a copy here would be the case
where two accounts named ada could get different slugs from the migration
and from the receiver.
"""
from django.db import migrations

from tenants.slugs import personal_slug

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


def seed(apps, schema_editor):
    Plan = apps.get_model('tenants', 'Plan')
    Organization = apps.get_model('tenants', 'Organization')
    Membership = apps.get_model('tenants', 'Membership')
    User = apps.get_model('accounts', 'User')

    for slug, spec in PLANS.items():
        Plan.objects.get_or_create(slug=slug, defaults={'name': spec['name'], 'entitlements': spec['entitlements']})
    free = Plan.objects.get(slug='free')

    taken = set(Organization.objects.values_list('slug', flat=True))
    for user in User.objects.order_by('pk'):
        if Organization.objects.filter(personal_of=user).exists():
            continue
        slug = personal_slug(user.email, taken)
        taken.add(slug)
        org = Organization.objects.create(
            slug=slug, name=user.name or user.email.split('@', 1)[0], plan=free, personal_of=user,
        )
        Membership.objects.create(organization=org, user=user, role='owner')


def unseed(apps, schema_editor):
    """
    The reverse, and what it really costs.

    It deletes EVERY personal organisation, not only the ones this migration
    backfilled — there is nothing on the row that says which — and with them
    their memberships and invitations, by cascade. That is harmless while the
    whole app is being unapplied, because 0001 drops the tables next. It is
    destructive in the one case anybody actually runs it alone: rolling back
    to 0001 on a live database to re-run the data step. Do not; re-run the
    idempotent `manage.py personal_orgs` instead, which is what that step
    calls anyway.

    The three seeded plan rows go only if nothing is on them.
    """
    Organization = apps.get_model('tenants', 'Organization')
    Plan = apps.get_model('tenants', 'Plan')
    Organization.objects.filter(personal_of__isnull=False).delete()
    Plan.objects.filter(slug__in=PLANS, organizations__isnull=True).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('tenants', '0001_initial'),
        ('accounts', '0003_alter_authevent_kind'),
    ]

    operations = [migrations.RunPython(seed, unseed)]
