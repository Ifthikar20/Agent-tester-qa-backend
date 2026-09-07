#!/usr/bin/env bash
#
# Deploy ghostclick to the EC2 host, and get back out again.
#
#   EC2_HOST=<ip> bash scripts/deploy.sh              deploy the current branch
#   EC2_HOST=<ip> bash scripts/deploy.sh rollback     back to the previous sha
#   EC2_HOST=<ip> bash scripts/deploy.sh health       is it up, is it busy
#   EC2_HOST=<ip> bash scripts/deploy.sh logs runner  tail a service
#   EC2_HOST=<ip> bash scripts/deploy.sh status       containers, disk, memory
#   EC2_HOST=<ip> bash scripts/deploy.sh inspect-env  which keys are set (names only)
#
# Runs from your laptop with the PEM at the repo root. It SSHes in itself; you
# do not need to SSH first. Read docs/DEPLOY.md before the first run.
set -euo pipefail

PEM=${PEM:-./cansee-deploy.pem}
EC2_HOST=${EC2_HOST:?set EC2_HOST=<elastic-ip>}
EC2_USER=${EC2_USER:-ubuntu}
REMOTE_DIR=${REMOTE_DIR:-/opt/ghostclick}
# Not defaulted to main on purpose: this repo's work is on a branch, and a
# silent default to a branch that does not exist here would deploy nothing and
# say it succeeded.
BRANCH=${BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}
GC="./scripts/gc"

step() { printf '\n  %s\n' "$*"; }
ok()   { printf '    %s\n' "$*"; }
warn() { printf '\n  ! %s\n' "$*" >&2; }
die()  { printf '\n  %s\n' "$*" >&2; exit 1; }

[ -f "$PEM" ] || die "no PEM at $PEM — set PEM=/path/to/key.pem"
chmod 600 "$PEM" 2>/dev/null || true
remote() { ssh -i "$PEM" -o StrictHostKeyChecking=accept-new "$EC2_USER@$EC2_HOST" "$@"; }

CMD=${1:-deploy}; shift || true

case "$CMD" in
  help|-h|--help)
    sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0 ;;

  logs)
    exec ssh -t -i "$PEM" -o StrictHostKeyChecking=accept-new "$EC2_USER@$EC2_HOST" \
      "cd $REMOTE_DIR && $GC logs -f --tail=200 ${*:-}" ;;

  health)
    remote "curl -sS -m 10 http://localhost/healthz || echo '  no answer — the runner is down'"
    echo; exit 0 ;;

  status)
    remote bash -s <<REMOTE
cd "$REMOTE_DIR"
echo; echo "  containers"; $GC ps
echo; echo "  disk";   df -h / | tail -1
echo; echo "  memory"; free -h | sed -n '1,3p'
echo; echo "  commit"; git rev-parse --short HEAD
REMOTE
    exit 0 ;;

  inspect-env)
    # NAMES only. There is deliberately no mode that prints values: the whole
    # point of the vault is that secrets do not travel back over this link.
    remote "cd $REMOTE_DIR && grep -oE '^[A-Z_]+' .env.prod | sort"
    exit 0 ;;

  deploy|rollback) : ;;
  *) die "unknown command '$CMD' — try: bash scripts/deploy.sh help" ;;
esac

TARGET_SHA=${1:-}
step "$CMD -> $EC2_USER@$EC2_HOST:$REMOTE_DIR (branch $BRANCH)"

remote bash -s <<REMOTE
set -euo pipefail
cd "$REMOTE_DIR"

# One deploy at a time. Two concurrent runs would interleave a reset --hard
# with a container recreate, and the recreate kills the single Chromium, the
# run lock and every screencast socket at once.
exec 9>.deploy.lock
flock -n 9 || { echo "  another deploy holds $REMOTE_DIR/.deploy.lock"; exit 1; }

CMD="$CMD"; BRANCH="$BRANCH"; TARGET_SHA="$TARGET_SHA"

# ---- the three refusals ----------------------------------------------------
#
# Each of these produces a deployment that LOOKS healthy. That is why they are
# refusals and not warnings, and why none of them has a --force.
[ -f .env.prod ] || { echo "  no .env.prod — copy .env.prod.example and fill it in"; exit 1; }

if grep -q \$'\r' .env.prod; then
  echo "  .env.prod has CRLF line endings. The last character of every value"
  echo "  would be a carriage return, so the two signing keys would not match."
  exit 1
fi
dupes=\$(grep -oE '^[A-Z_]+' .env.prod | sort | uniq -d)
[ -z "\$dupes" ] || { echo "  .env.prod sets these twice — the last one silently wins: \$dupes"; exit 1; }

# GC_AUTH_SECRET: without it the runner starts OPEN. It says so in its own
# banner, but nobody reads a banner on a host they just deployed to.
grep -qE '^GC_AUTH_SECRET=.{32,}' .env.prod || {
  echo "  .env.prod has no GC_AUTH_SECRET of at least 32 characters."
  echo "  The runner would start unauthenticated. Refusing to deploy."; exit 1; }

# The placeholder check is the one that catches a copied example file. A
# literal CHANGE_ME is long enough to pass every length test above.
grep -qE '^(GC_AUTH_SECRET|DJANGO_SECRET_KEY|PUBLIC_URL)=CHANGE_ME' .env.prod && {
  echo "  .env.prod still has CHANGE_ME placeholders. Fill them in first:"
  grep -nE '^(GC_AUTH_SECRET|DJANGO_SECRET_KEY|PUBLIC_URL)=CHANGE_ME' .env.prod | sed 's/^/    /'
  exit 1; }

# A '\$(' in the file is command substitution that never ran. Compose reads
# .env.prod as data — it does no substitution — so the literal text becomes the
# signing key. It is long, it is identical on both services, every token
# verifies, and the deploy is completely healthy with a key published in the
# runbook that told you to write it.
grep -qE '^[A-Z_]+=.*\\\$\(' .env.prod && {
  echo "  .env.prod contains \\\$( ... ) — that is a command, not a value."
  echo "  Nothing expands it. Run the command yourself and paste its OUTPUT."
  grep -nE '^[A-Z_]+=.*\\\$\(' .env.prod | cut -c1-60 | sed 's/^/    /'
  exit 1; }

grep -qE '^PUBLIC_URL=https?://.+' .env.prod || {
  echo "  .env.prod has no usable PUBLIC_URL (want http://<host> or https://<host>)."
  echo "  It is a BUILD argument: empty ships a UI with no sign-in at all."; exit 1; }

grep -qE '^DJANGO_SECRET_KEY=.{32,}' .env.prod || {
  echo "  .env.prod has no DJANGO_SECRET_KEY of at least 32 characters."; exit 1; }

ok_disk=\$(df --output=avail -BG / | tail -1 | tr -dc '0-9')
if [ "\${ok_disk:-99}" -lt 8 ]; then
  echo "  only \${ok_disk}G free — the image build needs room. Pruning."
  docker image prune -f >/dev/null; docker builder prune -f >/dev/null
fi

# ---- move to the target commit ---------------------------------------------
PRIOR_SHA=\$(git rev-parse HEAD)
git fetch --quiet origin "\$BRANCH"

if [ "\$CMD" = rollback ]; then
  WANT=\${TARGET_SHA:-\$(cat .last_deploy_prior 2>/dev/null || true)}
  [ -n "\$WANT" ] || { echo "  nothing recorded to roll back to — pass a sha"; exit 1; }
else
  WANT=\${TARGET_SHA:-\$(git rev-parse "origin/\$BRANCH")}
fi

echo "  before  \$(git rev-parse --short \$PRIOR_SHA)"
echo "  after   \$(git rev-parse --short \$WANT)"

# reset --hard, never `checkout <sha>`: a detached HEAD makes the NEXT deploy's
# branch lookup resolve to the literal string "HEAD".
git reset --hard --quiet "\$WANT"
git checkout --quiet -B "\$BRANCH"
[ "\$(git rev-parse HEAD)" = "\$(git rev-parse \$WANT)" ] || { echo "  tree is not at the requested commit"; exit 1; }
echo "\$PRIOR_SHA" > .last_deploy_prior

# ---- refuse to interrupt someone -------------------------------------------
busy=\$(curl -s -m 5 http://localhost/healthz | grep -o '"busy":true' || true)
if [ -n "\$busy" ] && [ "\${FORCE:-}" != "1" ]; then
  echo "  a run is in progress. Recreating the runner kills its browser mid-step."
  echo "  Wait, or re-run with FORCE=1."; exit 1
fi

export GC_GIT_SHA=\$(git rev-parse --short HEAD)
echo "  building and starting (\$GC_GIT_SHA)"
$GC up -d --build

echo "  migrating"
$GC exec -T control python manage.py migrate --noinput
$GC exec -T control python manage.py collectstatic --noinput >/dev/null

# nginx resolves runner and control once, at config load, and --build just gave
# them new addresses.
$GC exec -T nginx nginx -s reload 2>/dev/null || $GC restart nginx >/dev/null

# ---- readiness: the BROWSER, not the port ----------------------------------
#
# express starts listening about a hundred lines before chromium.launch, so
# polling the UI exits on the first iteration against a runner that has no
# browser and never will. /healthz is 503 until the page object exists.
echo "  waiting for the browser"
for i in \$(seq 1 60); do
  body=\$(curl -s -m 5 http://localhost/healthz || true)
  case "\$body" in *'"browser":true'*) break ;; esac
  [ "\$i" = 60 ] && { echo "  no browser after 120s. Last answer: \${body:-<none>}"; $GC logs --tail=40 runner; exit 1; }
  sleep 2
done

# ---- smoke ------------------------------------------------------------------
echo
echo "  smoke checks"
FAIL=0
probe() { # path expected description [method]
  local code
  code=\$(curl -s -o /dev/null -w '%{http_code}' -X "\${4:-GET}" "http://localhost\$1" || echo 000)
  if [ "\$code" = "\$2" ]; then printf '    %-34s %s\n' "\$3" "\$code"
  else printf '    %-34s %s  WANT \$2\n' "\$3" "\$code"; FAIL=1; fi
}

# Ahead of the table, because a 200 here is not a failed check, it is the one
# outcome this whole script exists to prevent.
api=\$(curl -s -o /dev/null -w '%{http_code}' http://localhost/api/state || true)
if [ "\$api" = "200" ]; then
  echo "    THE RUNNER IS UNAUTHENTICATED. Taking it down."
  $GC down; exit 1
fi

probe /app/            200 "the UI loads"
probe /api/state       401 "the API is gated"
probe /auth/csrf       200 "the control plane answers"
probe /healthz         200 "the browser is up"
# nginx is the only thing closing this one — server.js exempts it from the
# bearer gate by design, so an edit that drops the location block is a real
# regression and must not deploy green.
probe /api/recording   403 "the extension hand-off is shut" POST

[ "\$FAIL" = 0 ] || { echo; echo "  smoke checks failed — rolling back is: bash scripts/deploy.sh rollback"; exit 1; }
REMOTE

step "deployed — open http://$EC2_HOST/app/"
ok "no account yet?  ssh -t -i $PEM $EC2_USER@$EC2_HOST 'cd $REMOTE_DIR && ./scripts/gc exec control python manage.py createsuperuser'"
ok "roll back:       EC2_HOST=$EC2_HOST bash scripts/deploy.sh rollback"
echo
