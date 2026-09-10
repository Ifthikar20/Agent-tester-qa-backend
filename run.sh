#!/usr/bin/env bash
#
# Start ghostclick, with the sign-in.
#
#   bash run.sh                both repositories: builds ../poc-qa-stack, starts the rest
#
#   bash run.sh                the runner, the UI and the control plane — you sign in
#   bash run.sh --open         no sign-in at all, the one-person-one-laptop shape
#   bash run.sh --fast         runs skip the performance, for a quick check
#   bash run.sh --headed       a real browser window instead of the canvas
#   bash run.sh --setup        do the first-run work and stop
#   bash run.sh --port 3100    the runner somewhere else (--auth-port moves the other)
#
# One Ctrl-C stops whatever it started.
#
# The UI is the poc-qa-stack repository (docs/BOUNDARY.md), and this is the one
# command for both. Clone it beside this one and run.sh builds it on every run,
# with the sign-in address this run needs baked in — the address has to be in
# the bundle, and a build reused from a run with different flags would be the
# wrong app. GC_UI_REPO names a checkout that is not beside this one.
#
# GC_WEB_DIR=<a build> still wins, and is how a deployment does it: name a build
# made elsewhere and nothing gets built here. scripts/app.js does the work and
# says which of the two it took.
#
# THE DEFAULT IS THE SIGN-IN, and that is the one thing here worth arguing
# about, because it inverts `npm start`. Two different questions have two
# different right answers:
#
#   npm start    "run the runner"          — no login, because one person on
#                                            one laptop should not need a
#                                            second service to try the thing.
#   bash run.sh  "run the application"     — with the login, because the
#                                            application HAS a login now, and a
#                                            script that quietly starts a
#                                            cut-down version of it teaches you
#                                            the wrong thing about what you
#                                            built. Discovering that the login
#                                            you spent a week on is missing —
#                                            and that it is missing because of a
#                                            flag you did not pass — is half an
#                                            hour you do not get back.
#
# `--open` is the way out, and it is a word rather than a negation because
# `--no-auth` reads as "broken" when it is in fact a supported shape.
#
# The work is all in scripts/app.js — finding the built UI, installing what is
# missing, downloading the browser, migrating, generating the signing keypair
# whose two halves go to two different processes, and starting the processes.
# This is a wrapper, and it earns its place with three things that are easy to
# get wrong from a terminal:
#
#   - `npm run app --auth` does not do what it looks like. npm eats the flag
#     unless you write `npm run app -- --auth`, and without it you get the app
#     with NO sign-in and nothing saying why.
#   - A port already in use is found only after the install work, so you wait
#     through all of it to be told the thing you could have been told
#     immediately. With the control plane there are two ports to be wrong about.
#   - This repository is usually checked out more than once — a worktree per
#     branch — and every copy has its own node_modules, its own .ghostclick and
#     its own idea of what the application is. Running the wrong one shows you
#     code you did not write. So this says which checkout it is starting.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

die() { printf '\n  %s\n\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "no node on PATH. ghostclick needs Node 20+ — https://nodejs.org"

# ---- what did they ask for? -------------------------------------------------
# Only the parts that decide which ports to check, and whether to add --auth.
# Everything else is passed through untouched, so this never has to be kept in
# step with app.js's flags.
PORT=3000
AUTH_PORT=8000
WANT_AUTH=1
ARGS=()
for ((i = 1; i <= $#; i++)); do
  case "${!i}" in
    --open|--no-auth)
      # Swallowed: app.js has no such flag. Its absence IS the flag.
      WANT_AUTH=0 ;;
    --auth)
      # Harmless and still accepted, because it is in everyone's shell history.
      WANT_AUTH=1 ;;
    --port)      j=$((i + 1)); [ $j -le $# ] && PORT=${!j};      ARGS+=("${!i}") ;;
    --auth-port) j=$((i + 1)); [ $j -le $# ] && AUTH_PORT=${!j}; ARGS+=("${!i}") ;;
    -h|--help)   exec node scripts/app.js --help ;;
    *)           ARGS+=("${!i}") ;;
  esac
done
[ "$WANT_AUTH" = 1 ] && ARGS+=(--auth)

# ---- is anything already there? ---------------------------------------------
# Asked of node rather than of lsof/netstat/ss, because which of those exists
# depends on the machine and node is already a hard requirement above.
busy() {
  node -e '
    const net = require("net");
    const s = net.createServer();
    s.once("error", (e) => process.exit(e.code === "EADDRINUSE" ? 1 : 0));
    s.once("listening", () => s.close(() => process.exit(0)));
    s.listen(Number(process.argv[1]), "127.0.0.1");
  ' "$1"
}

# The command that frees it is not the same everywhere, and a message that says
# "port in use" without saying what to do about it just moves the search.
freeing() {
  case "$(uname -s 2>/dev/null || echo unknown)" in
    MINGW*|MSYS*|CYGWIN*)
      printf 'powershell -c "Stop-Process -Id (Get-NetTCPConnection -LocalPort %s -State Listen).OwningProcess -Force"' "$1" ;;
    *)
      printf 'lsof -ti tcp:%s | xargs kill' "$1" ;;
  esac
}

check_port() {   # port, what uses it, the flag that moves it
  busy "$1" && return 0
  die "port $1 is already in use — $2 cannot start there.

    Something is already listening. If it is an older ghostclick, stop it:
      $(freeing "$1")

    Or use another port:
      bash run.sh $3 $(( $1 + 100 ))"
}

# The flag is passed in because the two ports are moved by different flags:
# --port moves the runner and --auth-port the control plane. This used to say
# --port for both, so a busy 8000 was answered with `bash run.sh --port 8100`,
# a command that moves the wrong service and fails on 8000 all over again.
check_port "$PORT" "the runner" --port
[ "$WANT_AUTH" = 1 ] && check_port "$AUTH_PORT" "the control plane" --auth-port

# ---- say which copy of the code this is -------------------------------------
# `git worktree list` on this repository routinely shows three checkouts on
# three branches. They look identical from a terminal and they are not.
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'not a git checkout')
printf '\n  %-12s->  %s\n' 'checkout' "$(pwd)"
printf '  %-12s->  %s\n'   'branch'   "$BRANCH"
# Where the app will come from, said before the build rather than after it, so
# a missing UI checkout is the first thing on screen rather than the last.
UI_REPO="${GC_UI_REPO:-../poc-qa-stack}"
if [ -n "${GC_WEB_DIR:-}" ]; then
  printf '  %-12s->  %s\n' 'ui' "$GC_WEB_DIR  (GC_WEB_DIR, used as given)"
elif [ -f "$UI_REPO/package.json" ]; then
  printf '  %-12s->  %s\n' 'ui' "built from $UI_REPO on every run"
else
  printf '  %-12s->  %s\n' 'ui' "none — clone poc-qa-stack beside this one, or set GC_WEB_DIR"
fi
if [ "$WANT_AUTH" = 1 ]; then
  printf '  %-12s->  on — sign in at http://localhost:%s/app/  (bash run.sh --open for none)\n' 'sign-in' "$PORT"
  printf '  %-12s->  bash scripts/adduser.sh you@example.com\n' 'no account?'
else
  printf '  %-12s->  OFF — anyone who can reach port %s can drive this browser\n' 'sign-in' "$PORT"
fi

exec node scripts/app.js "${ARGS[@]}"
