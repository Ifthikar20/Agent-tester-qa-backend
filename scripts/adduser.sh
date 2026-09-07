#!/usr/bin/env bash
#
# Make an account on a running ghostclick — here, or on the box.
#
#   bash scripts/adduser.sh qa@example.com                          the local auth/
#   EC2_HOST=<ip> bash scripts/adduser.sh qa@example.com            the deployed one
#   EC2_HOST=<ip> bash scripts/adduser.sh qa@example.com --staff    and give it /admin/
#   EC2_HOST=<ip> bash scripts/adduser.sh --list                    who has an account
#
# It prints a generated password once. To choose the password instead — which is
# what a test suite that signs in on every run wants — pipe it in:
#
#   printf '%s' "$PASS" | EC2_HOST=<ip> bash scripts/adduser.sh qa@example.com --password-stdin
#
# Never as an argument. `ps` on the host shows every argument of every running
# process to every account on it, and on your own machine it goes into shell
# history — both of which outlive the run.
#
# Why this exists next to createsuperuser: createsuperuser prompts, a prompt
# needs a terminal, and `ssh host '<command>'` does not allocate one. It dies on
# "the input device is not a TTY" before asking anything. `ssh -t` fixes that
# for a person sitting there; it does nothing for a script that wants an
# account without anyone sitting there at all.
set -euo pipefail

PEM=${PEM:-./ghostclick-deploy.pem}
EC2_USER=${EC2_USER:-ubuntu}
REMOTE_DIR=${REMOTE_DIR:-/opt/ghostclick}

die() { printf '\n  %s\n' "$*" >&2; exit 1; }

[ $# -gt 0 ] || die "usage: bash scripts/adduser.sh <email> [--name=...] [--staff] [--superuser]
                                        [--password-stdin] [--reset-password]
       bash scripts/adduser.sh --list

       against the deployed box, set EC2_HOST=<ip> as well."

# The arguments are interpolated into a command that a remote shell will parse,
# so their shape is checked here. This is the friendly error for a typo, and it
# is also the reason a quoted argument cannot become a second command.
case "$1" in
  --list) ;;
  -*) die "the first argument is the email address, not $1" ;;
  *[!A-Za-z0-9._%+@-]*) die "$1 does not look like an email address" ;;
  *@*.*) ;;
  *) die "$1 does not look like an email address" ;;
esac
for arg in "${@:2}"; do
  case "$arg" in
    --staff|--superuser|--password-stdin|--reset-password) ;;
    --name=*[\'\"\\\$\`]*) die "--name may not contain quotes, backslashes, \$ or backticks" ;;
    --name=*) ;;
    *) die "unknown option $arg — the options are listed at the top of this script" ;;
  esac
done

if [ -z "${EC2_HOST:-}" ]; then
  # Local: auth/ against its own sqlite file. No env needed — DJANGO_DEBUG
  # defaults on, and nothing here touches the signing key.
  cd "$(dirname "${BASH_SOURCE[0]}")/../auth"

  # `command -v python3` is not enough on Windows, which ships a python3.exe
  # that exists only to open the Microsoft Store. The lookup succeeds, and the
  # command after it prints "Python was not found" instead of doing anything.
  # Asking each candidate to actually execute is what tells an interpreter from
  # a shortcut — and `python` goes first there, because that is the name a real
  # install answers to. scripts/app.js probes the same way for the same reason.
  case "$(uname -s 2>/dev/null || echo unknown)" in
    MINGW*|MSYS*|CYGWIN*) CANDIDATES='python python3 py' ;;
    *)                    CANDIDATES='python3 python' ;;
  esac
  PY=${PY:-}
  if [ -z "$PY" ]; then
    for c in $CANDIDATES; do
      [ "$("$c" -c 'import sys; print(sys.version_info[0])' 2>/dev/null)" = 3 ] && { PY=$c; break; }
    done
  fi
  [ -n "$PY" ] || die "no working python3 on PATH. Set PY=/path/to/python, or make the
    account on the box instead:  EC2_HOST=<ip> bash scripts/adduser.sh $1"

  "$PY" -c 'import django' 2>/dev/null || die "$PY runs, but has no Django. This needs the interpreter that runs auth/:

    cd auth && $PY -m pip install -r requirements.txt
        a virtualenv is the usual fix on a managed python

    or make the account on the box instead, where Django is already installed:
        EC2_HOST=<ip> bash scripts/adduser.sh $1"

  # No database means no table to put an account in, and Django's own error for
  # that names a table rather than the thing you have not done yet.
  [ -f db.sqlite3 ] || die "auth/db.sqlite3 does not exist — there is no local database yet:
    npm run app -- --auth      (from the repository root; it migrates and starts the control plane)"

  exec "$PY" manage.py adduser "$@"
fi

[ -f "$PEM" ] || die "no PEM at $PEM — set PEM=/path/to/key.pem"
chmod 600 "$PEM" 2>/dev/null || true

# Single-quoted one at a time rather than "$*": an unquoted expansion would let
# the remote shell re-split --name=Ada Lovelace into two arguments.
ARGS=''
for arg in "$@"; do ARGS="$ARGS '$arg'"; done

# -T on both hops, and for the same reason twice: this is not interactive, and
# a pseudo-terminal would both echo a piped-in password back and stop stdin
# reaching the command that is supposed to read it.
exec ssh -T -i "$PEM" -o StrictHostKeyChecking=accept-new "$EC2_USER@$EC2_HOST" \
  "cd $REMOTE_DIR && ./scripts/gc exec -T control python manage.py adduser$ARGS"
