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

# Every probe of the running stack goes through the edge with the public
# host name, because the edge answers for exactly that host and the control
# plane refuses any other. A curl to http://localhost gets an empty page from
# Caddy and a 400 from Django, both of which read as "down" when it is not.
# Shared with the remote script below as text, hence the single quotes.
read -r -d '' EDGE <<'EDGE' || true
PUBLIC_URL=$(grep -E '^PUBLIC_URL=' .env.prod | cut -d= -f2- | tr -d '\r' | sed 's#/*$##')
SCHEME=${PUBLIC_URL%%://*}
HOSTPORT=${PUBLIC_URL#*://}
HOST=${HOSTPORT%%:*}
PORT=${HOSTPORT##*:}
[ "$PORT" != "$HOSTPORT" ] || { [ "$SCHEME" = https ] && PORT=443 || PORT=80; }
# --resolve pins the public name to this box without touching DNS, so the
# request is the same one a browser makes — TLS handshake and certificate
# included. An https URL whose certificate has not been issued fails here,
# which is a real failure and not one to hide with -k.
edge() { curl -s -m "${2:-5}" --resolve "$HOST:$PORT:127.0.0.1" "$PUBLIC_URL$1"; }
EDGE

CMD=${1:-deploy}; shift || true

case "$CMD" in
  help|-h|--help)
    sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0 ;;

  logs)
    exec ssh -t -i "$PEM" -o StrictHostKeyChecking=accept-new "$EC2_USER@$EC2_HOST" \
      "cd $REMOTE_DIR && $GC logs -f --tail=200 ${*:-}" ;;

  health)
    remote bash -s <<REMOTE
cd "$REMOTE_DIR"
$EDGE
edge /healthz 10 || echo '  no answer — the runner is down'
REMOTE
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

# ---- the refusals ------------------------------------------------------------
#
# Each of these produces a deployment that LOOKS healthy. That is why they are
# refusals and not warnings, and why none of them has a --force.
[ -f .env.prod ] || { echo "  no .env.prod — copy .env.prod.example and fill it in"; exit 1; }

if grep -q \$'\r' .env.prod; then
  echo "  .env.prod has CRLF line endings. The last character of every value"
  echo "  would be a carriage return, and neither key would parse."
  exit 1
fi
dupes=\$(grep -oE '^[A-Z_]+' .env.prod | sort | uniq -d)
[ -z "\$dupes" ] || { echo "  .env.prod sets these twice — the last one silently wins: \$dupes"; exit 1; }

# The signing keypair. Without the public set the runner starts OPEN — it
# says so in its own banner, but nobody reads a banner on a host they just
# deployed to. Without the private key the control plane refuses to start.
# Both come from one 'manage.py signing_key --new', and each is checked for
# the marker that says it is the right half in the right place.
grep -qE "^GC_SIGNING_KEY='?-----BEGIN PRIVATE KEY-----" .env.prod || {
  echo "  .env.prod has no GC_SIGNING_KEY that looks like a PEM private key."
  echo "  'cd auth && python manage.py signing_key --new' prints it. Refusing to deploy."; exit 1; }
grep -qE "^GC_AUTH_PUBLIC_KEYS='?\{.*BEGIN PUBLIC KEY" .env.prod || {
  echo "  .env.prod has no GC_AUTH_PUBLIC_KEYS holding a public key."
  echo "  The runner would start unauthenticated. Refusing to deploy."; exit 1; }
grep -qE '^GC_AUTH_PUBLIC_KEYS=.*PRIVATE KEY' .env.prod && {
  echo "  GC_AUTH_PUBLIC_KEYS contains a PRIVATE key. The runner must never hold one."; exit 1; }

# The shared HMAC secret is gone. A line for it is not ignored: the runner
# refuses to boot with it in the environment, and a value still in this file
# is a signing key still on the box.
grep -qE '^GC_AUTH_SECRET=' .env.prod && {
  echo "  .env.prod still sets GC_AUTH_SECRET. Tokens are signed with GC_SIGNING_KEY now"
  echo "  and the runner refuses to start with the old shared secret present. Remove the line."
  exit 1; }

# The placeholder check is the one that catches a copied example file. A
# literal CHANGE_ME is long enough to pass every length test above.
grep -qE '^(GC_SIGNING_KEY|GC_AUTH_PUBLIC_KEYS|DJANGO_SECRET_KEY|PUBLIC_URL|POSTGRES_PASSWORD|REDIS_PASSWORD)=CHANGE_ME' .env.prod && {
  echo "  .env.prod still has CHANGE_ME placeholders. Fill them in first:"
  grep -nE '^(GC_SIGNING_KEY|GC_AUTH_PUBLIC_KEYS|DJANGO_SECRET_KEY|PUBLIC_URL|POSTGRES_PASSWORD|REDIS_PASSWORD)=CHANGE_ME' .env.prod | sed 's/^/    /'
  exit 1; }

# A '\$(' in the file is command substitution that never ran. Compose reads
# .env.prod as data — it does no substitution — so the literal text becomes the
# value. With the old shared secret that was a deploy that was completely
# healthy with a key published in the runbook that told you to write it; with
# a PEM it is a control plane that refuses to start, which is better, but the
# refusal here is still the one with the message that says what happened.
grep -qE '^[A-Z_]+=.*\\\$\(' .env.prod && {
  echo "  .env.prod contains \\\$( ... ) — that is a command, not a value."
  echo "  Nothing expands it. Run the command yourself and paste its OUTPUT."
  grep -nE '^[A-Z_]+=.*\\\$\(' .env.prod | cut -c1-60 | sed 's/^/    /'
  exit 1; }

grep -qE '^PUBLIC_URL=https?://.+' .env.prod || {
  echo "  .env.prod has no usable PUBLIC_URL (want https://<host>, or http://<ip> for a demo)."
  echo "  It is a BUILD argument: empty ships a UI with no sign-in at all."; exit 1; }

grep -qE '^DJANGO_SECRET_KEY=.{32,}' .env.prod || {
  echo "  .env.prod has no DJANGO_SECRET_KEY of at least 32 characters."; exit 1; }

# The two store passwords are spliced into URLs (postgres://user:PASS@…), so
# they must be URL-safe as well as long. A '@' or '/' in one would be parsed
# as part of the address and read as "the database is unreachable".
for var in POSTGRES_PASSWORD REDIS_PASSWORD; do
  grep -qE "^\$var=[A-Za-z0-9_-]{16,}\$" .env.prod || {
    echo "  .env.prod has no \$var of at least 16 URL-safe characters (letters, digits, - and _)."
    exit 1; }
done

# Hosts are derived from PUBLIC_URL now; this variable is not read at all.
# It is refused rather than ignored because someone who wrote '*' here meant
# it to do something, and what it used to do was accept any Host header.
grep -qE '^DJANGO_ALLOWED_HOSTS=' .env.prod && {
  echo "  .env.prod sets DJANGO_ALLOWED_HOSTS. Nothing reads it any more: the host is"
  echo "  derived from PUBLIC_URL. Remove the line — '*' in particular is refused."
  exit 1; }

# Ten minutes is the ceiling on what a leaked token is worth. The control
# plane clamps it too; refusing here is what keeps the .env.prod honest.
ttl=\$(grep -E '^GC_TOKEN_TTL=' .env.prod | cut -d= -f2- || true)
if [ -n "\$ttl" ] && { ! [ "\$ttl" -eq "\$ttl" ] 2>/dev/null || [ "\$ttl" -gt 600 ] || [ "\$ttl" -lt 60 ]; }; then
  echo "  GC_TOKEN_TTL=\$ttl — an executor token lives 60 to 600 seconds, no longer."
  exit 1
fi

$EDGE

if [ "\$SCHEME" = http ]; then
  echo
  echo "  ! PUBLIC_URL is http://. That works for a demo, and this is what it means:"
  echo "  !   - the session cookie is NOT Secure and NOT __Host- prefixed, because a"
  echo "  !     browser will not send a Secure cookie over http — it would sign in"
  echo "  !     and stay signed out"
  echo "  !   - no HSTS, no certificate: the cookie and the executor token cross the"
  echo "  !     network in the clear, and anyone on the path can drive your browser"
  echo "  !   Give it a hostname, set PUBLIC_URL=https://that, and Caddy does the rest."
  echo
fi

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

# reset --hard, never 'checkout <sha>': a detached HEAD makes the NEXT deploy's
# branch lookup resolve to the literal string "HEAD".
git reset --hard --quiet "\$WANT"
git checkout --quiet -B "\$BRANCH"
[ "\$(git rev-parse HEAD)" = "\$(git rev-parse \$WANT)" ] || { echo "  tree is not at the requested commit"; exit 1; }
echo "\$PRIOR_SHA" > .last_deploy_prior

# ---- refuse to interrupt someone -------------------------------------------
busy=\$(edge /healthz | grep -o '"busy":true' || true)
if [ -n "\$busy" ] && [ "\${FORCE:-}" != "1" ]; then
  echo "  a run is in progress. Recreating the runner kills its browser mid-step."
  echo "  Wait, or re-run with FORCE=1."; exit 1
fi

export GC_GIT_SHA=\$(git rev-parse --short HEAD)

# The edge config, checked by the edge itself before anything is built. A
# Caddyfile mistake would otherwise surface as a caddy container in a restart
# loop and a readiness wait that times out blaming the runner.
echo "  validating the edge config"
$GC run --rm --no-deps -T caddy caddy validate --config /etc/caddy/Caddyfile >/dev/null || {
  echo "  docker/Caddyfile does not validate. Caddy's own message is above."; exit 1; }

echo "  building and starting (\$GC_GIT_SHA)"
$GC up -d --build

echo "  migrating"
$GC exec -T control python manage.py migrate --noinput
$GC exec -T control python manage.py collectstatic --noinput >/dev/null
# Sessions are rows. Expired ones are never removed by being expired, only by
# this; after a deploy is the one moment guaranteed to come round.
$GC exec -T control python manage.py clearsessions

# No edge reload: Caddy resolves runner and control per request, so the
# new containers' addresses are picked up on the next one.

# ---- readiness: the BROWSER, not the port ----------------------------------
#
# express starts listening about a hundred lines before chromium.launch, so
# polling the UI exits on the first iteration against a runner that has no
# browser and never will. /healthz is 503 until the page object exists.
echo "  waiting for the browser"
for i in \$(seq 1 60); do
  body=\$(edge /healthz || true)
  case "\$body" in *'"browser":true'*) break ;; esac
  [ "\$i" = 60 ] && {
    echo "  no browser after 120s. Last answer: \${body:-<none>}"
    [ "\$SCHEME" = https ] && echo "  (no answer at all over https? Caddy may still be getting a certificate: $GC logs caddy)"
    $GC logs --tail=40 runner; exit 1; }
  sleep 2
done

# ---- smoke ------------------------------------------------------------------
echo
echo "  smoke checks"
FAIL=0
probe() { # path expected description [method]
  local code
  code=\$(curl -s -o /dev/null -m 10 -w '%{http_code}' -X "\${4:-GET}" --resolve "\$HOST:\$PORT:127.0.0.1" "\$PUBLIC_URL\$1" || echo 000)
  if [ "\$code" = "\$2" ]; then printf '    %-34s %s\n' "\$3" "\$code"
  else printf '    %-34s %s  WANT \$2\n' "\$3" "\$code"; FAIL=1; fi
}

# Ahead of the table, because a 200 here is not a failed check, it is the one
# outcome this whole script exists to prevent.
api=\$(curl -s -o /dev/null -w '%{http_code}' --resolve "\$HOST:\$PORT:127.0.0.1" "\$PUBLIC_URL/api/state" || true)
if [ "\$api" = "200" ]; then
  echo "    THE RUNNER IS UNAUTHENTICATED. Taking it down."
  $GC down; exit 1
fi

probe /app/            200 "the UI loads"
probe /api/state       401 "the API is gated"
probe /auth/csrf       200 "the control plane answers"
# allauth's session endpoint: 401 is "nobody is signed in", which is the one
# answer that proves the JSON API is mounted and reachable through the edge.
probe /_allauth/browser/v1/auth/session 401 "sign-in is allauth's"
probe /healthz         200 "the browser is up"
# The edge is the only thing closing this one — server.js exempts it from the
# bearer gate by design, so an edit that drops the respond line is a real
# regression and must not deploy green.
probe /api/recording   403 "the extension hand-off is shut" POST
# From this box the admin is reachable only if GC_ADMIN_CIDRS says so, and
# the docker bridge is not in anyone's list. A 200 or 302 here means the
# allowlist is not being applied.
probe /admin/          403 "the admin is behind the allowlist"

[ "\$FAIL" = 0 ] || { echo; echo "  smoke checks failed — rolling back is: bash scripts/deploy.sh rollback"; exit 1; }
REMOTE

step "deployed — open the app at the PUBLIC_URL in .env.prod (/app/)"
ok "no account yet?  ssh -t -i $PEM $EC2_USER@$EC2_HOST 'cd $REMOTE_DIR && ./scripts/gc exec control python manage.py createsuperuser'"
ok "roll back:       EC2_HOST=$EC2_HOST bash scripts/deploy.sh rollback"
echo
