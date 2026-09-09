"""
The commands that have to run on a schedule, and the one process that runs them.

    python manage.py housekeeping          loop forever — what the compose `scheduler` service runs
    python manage.py housekeeping --once   run every task now and exit — for a host cron line
    python manage.py housekeeping --list   what runs, and how often

Three things decay if nobody runs a command (docs/AUTH.md §1, §6.6, §12):
expired sessions are rows that only `clearsessions` removes, an unverified
address claim is stale after fifteen minutes, and audit rows past ninety
days are a liability rather than a record. The deploy runs the first and
the last once, after every migrate, and nothing used to run any of them
between deploys.

This is a loop rather than a cron daemon because the image is python:slim
and the environment the commands need — the database URL, the keys — is
the control plane's, which compose already hands to a container built from
the same image. A second container running this command IS the schedule,
its output is in `./scripts/gc logs scheduler`, and there is no crontab to
keep in step with the compose file. A host that would rather use cron runs
`--once` from it (docs/DEPLOY.md); every task is idempotent, so running it
more often than its period changes nothing but how fresh the table is.

A task that fails — the database is restarting, most likely — is logged
and tried again at its next period; one bad tick must not stop the other
tasks or end the process, or the schedule quietly becomes "never".
"""
import time
import traceback

from django.core.management import call_command
from django.core.management.base import BaseCommand

# (command, every N seconds). The periods are the rules in docs/AUTH.md:
# daily for sessions and the audit log, every few minutes for the address
# claims whose code lives fifteen minutes.
TASKS = (
    ('purge_unverified_emails', 5 * 60),
    ('clearsessions', 24 * 3600),
    ('purge_auth_events', 24 * 3600),
)
# How long the loop sleeps between looks. Short enough that a five-minute
# task runs within a minute of being due; long enough to cost nothing.
POLL_SECONDS = 60


def due(now, last, tasks=TASKS):
    """
    The tasks whose period has elapsed since they last ran. `last` maps a
    command to the monotonic time it last ran; a task with no entry is due,
    which is what makes the first tick run everything.
    """
    return [name for name, every in tasks if name not in last or now - last[name] >= every]


class Command(BaseCommand):
    help = 'Run clearsessions, purge_unverified_emails and purge_auth_events on their schedule.'

    def add_arguments(self, parser):
        parser.add_argument('--once', action='store_true', help='run every task now, then exit')
        parser.add_argument('--list', action='store_true', help='print the schedule and exit')

    def run(self, name):
        """One task, and never an exception out of it: the loop goes on."""
        started = time.monotonic()
        try:
            call_command(name, stdout=self.stdout, stderr=self.stderr)
            self.stdout.write(f'housekeeping: {name} done in {time.monotonic() - started:.1f}s')
            return True
        except Exception:  # noqa: BLE001 — any failure is one to log and outlive
            self.stderr.write(f'housekeeping: {name} failed\n{traceback.format_exc()}')
            return False

    def handle(self, *args, once=False, list=False, **options):  # noqa: A002 — the flag's name
        if list:
            for name, every in TASKS:
                self.stdout.write(f'  {name:<26} every {every // 60} minutes' if every < 3600
                                  else f'  {name:<26} every {every // 3600} hours')
            return
        if once:
            for name, _ in TASKS:
                self.run(name)
            return
        self.stdout.write('housekeeping: ' + ', '.join(f'{n} every {e}s' for n, e in TASKS))
        last = {}
        while True:
            now = time.monotonic()
            for name in due(now, last):
                # Stamped whether or not it succeeded: a task that fails
                # every time must not be retried every minute forever.
                last[name] = now
                self.run(name)
            time.sleep(POLL_SECONDS)
