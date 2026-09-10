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
# .env.prod is root-owned and 0600 (docs/AUTH.md §12): nothing running as the
# deploy user can read the signing key in it. This script needs the file's
# shape — which keys, is the URL http — never a value, and reads it through
# the one sudoers line that allows exactly `cat` of exactly this file.
# The ABSOLUTE path, because sudo matches a command's arguments literally —
# fnmatch against the sudoers text, with no canonicalisation. A relative
# `cat .env.prod` is compared as ".env.prod" against "/opt/ghostclick/.env.prod"
# and refused, so on a host carrying only the two sudoers lines this read
# returned nothing and every deploy died at the "cannot read .env.prod"
# refusal with the sudoers line already correctly in place. It looked like it
# worked only because a stock Ubuntu image still grants `ubuntu ALL=NOPASSWD:
# ALL`, which matches everything.
ENVPATH="$PWD/.env.prod"
envfile() { if [ -r "$ENVPATH" ]; then cat "$ENVPATH"; else sudo -n /usr/bin/cat "$ENVPATH" 2>/dev/null || true; fi; }
# `|| true`: with no PUBLIC_URL= line grep exits 1, and under `set -euo
# pipefail` that took the whole remote script down through the command
# substitution — silently, before the refusal below could name the problem.
PUBLIC_URL=$(envfile | grep -E '^PUBLIC_URL=' | cut -d= -f2- | tr -d '\r' | sed 's#/*$##' || true)
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
    remote "cd $REMOTE_DIR && { cat .env.prod 2>/dev/null || sudo -n /usr/bin/cat $REMOTE_DIR/.env.prod; } | grep -oE '^[A-Z_]+' | sort"
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

# Who may run the daemon, and who may read the key (docs/AUTH.md §12
# [ops-supply-1]). The docker group is root by another name and nothing logs
# its use; scripts/gc goes through sudo instead, and .env.prod is readable by
# root alone. Both are refusals rather than warnings because each produces a
# deployment that is entirely healthy and quietly wider than it looks.
if id -nG | grep -qw docker; then
  echo "  \$(id -un) is in the docker group. The stack is run through sudo (scripts/gc,"
  echo "  one sudoers line, logged); the group is root with no log. Remove it:"
  echo "    sudo gpasswd -d \$(id -un) docker      (then log out and back in)"
  exit 1
fi
owner=\$(stat -c '%U:%a' .env.prod)
case "\$owner" in
  root:600|root:400) ;;
  *)
    echo "  .env.prod is \$owner; it holds the signing key and must be root:600."
    echo "    sudo chown root:root .env.prod && sudo chmod 600 .env.prod"
    echo "  (scripts/gc reads it as root; this script reads its key NAMES through"
    echo "  the sudoers line bootstrap-ec2.sh wrote — see docs/DEPLOY.md.)"
    exit 1 ;;
esac
$EDGE
ENVTXT=\$(envfile)
[ -n "\$ENVTXT" ] || { echo "  cannot read \$ENVPATH: it is root-owned and 'sudo -n /usr/bin/cat \$ENVPATH' is refused."
  echo "  Add the sudoers line from scripts/bootstrap-ec2.sh (docs/DEPLOY.md)."; exit 1; }
envgrep() { printf '%s\n' "\$ENVTXT" | grep "\$@"; }

if envgrep -q \$'\r'; then
  echo "  .env.prod has CRLF line endings. The last character of every value"
  echo "  would be a carriage return, and neither key would parse."
  exit 1
fi
dupes=\$(envgrep -oE '^[A-Z_]+' | sort | uniq -d)
[ -z "\$dupes" ] || { echo "  .env.prod sets these twice — the last one silently wins: \$dupes"; exit 1; }

# The signing keypair. Without the public set the runner starts OPEN — it
# says so in its own banner, but nobody reads a banner on a host they just
# deployed to. Without the private key the control plane refuses to start.
# Both come from one 'manage.py signing_key --new', and each is checked for
# the marker that says it is the right half in the right place.
envgrep -qE "^GC_SIGNING_KEY='?-----BEGIN PRIVATE KEY-----" || {
  echo "  .env.prod has no GC_SIGNING_KEY that looks like a PEM private key."
  echo "  'cd auth && python manage.py signing_key --new' prints it. Refusing to deploy."; exit 1; }
envgrep -qE "^GC_AUTH_PUBLIC_KEYS='?\{.*BEGIN PUBLIC KEY" || {
  echo "  .env.prod has no GC_AUTH_PUBLIC_KEYS holding a public key."
  echo "  The runner would start unauthenticated. Refusing to deploy."; exit 1; }
envgrep -qE '^GC_AUTH_PUBLIC_KEYS=.*PRIVATE KEY' && {
  echo "  GC_AUTH_PUBLIC_KEYS contains a PRIVATE key. The runner must never hold one."; exit 1; }

# The key second factors are encrypted with. A Fernet key is 44 characters
# of url-safe base64 ending in '='; the control plane refuses to start
# without one, and a deploy that then comes up unhealthy is a worse place
# to learn it than here.
envgrep -qE "^GC_MFA_KEY='?[A-Za-z0-9_-]{43}=" || {
  echo "  .env.prod has no GC_MFA_KEY that looks like a Fernet key."
  echo "  'cd auth && python manage.py mfa_key' prints one. Refusing to deploy."; exit 1; }

# The shared HMAC secret is gone. A line for it is not ignored: the runner
# refuses to boot with it in the environment, and a value still in this file
# is a signing key still on the box.
envgrep -qE '^GC_AUTH_SECRET=' && {
  echo "  .env.prod still sets GC_AUTH_SECRET. Tokens are signed with GC_SIGNING_KEY now"
  echo "  and the runner refuses to start with the old shared secret present. Remove the line."
  exit 1; }

# The placeholder check is the one that catches a copied example file. A
# literal CHANGE_ME is long enough to pass every length test above.
envgrep -qE '^(GC_SIGNING_KEY|GC_AUTH_PUBLIC_KEYS|GC_MFA_KEY|DJANGO_SECRET_KEY|PUBLIC_URL|POSTGRES_PASSWORD|REDIS_PASSWORD)=CHANGE_ME' && {
  echo "  .env.prod still has CHANGE_ME placeholders. Fill them in first:"
  envgrep -nE '^(GC_SIGNING_KEY|GC_AUTH_PUBLIC_KEYS|GC_MFA_KEY|DJANGO_SECRET_KEY|PUBLIC_URL|POSTGRES_PASSWORD|REDIS_PASSWORD)=CHANGE_ME' | sed 's/^/    /'
  exit 1; }

# A '\$(' in the file is command substitution that never ran. Compose reads
# .env.prod as data — it does no substitution — so the literal text becomes the
# value. With the old shared secret that was a deploy that was completely
# healthy with a key published in the runbook that told you to write it; with
# a PEM it is a control plane that refuses to start, which is better, but the
# refusal here is still the one with the message that says what happened.
envgrep -qE '^[A-Z_]+=.*\\\$\(' && {
  echo "  .env.prod contains \\\$( ... ) — that is a command, not a value."
  echo "  Nothing expands it. Run the command yourself and paste its OUTPUT."
  envgrep -nE '^[A-Z_]+=.*\\\$\(' | cut -c1-60 | sed 's/^/    /'
  exit 1; }

envgrep -qE '^PUBLIC_URL=https?://.+' || {
  echo "  .env.prod has no usable PUBLIC_URL (want https://<host>, or http://<ip> for a demo)."
  echo "  It is a BUILD argument: empty ships a UI with no sign-in at all."; exit 1; }

envgrep -qE '^DJANGO_SECRET_KEY=.{32,}' || {
  echo "  .env.prod has no DJANGO_SECRET_KEY of at least 32 characters."; exit 1; }

# The two store passwords are spliced into URLs (postgres://user:PASS@…), so
# they must be URL-safe as well as long. A '@' or '/' in one would be parsed
# as part of the address and read as "the database is unreachable".
for var in POSTGRES_PASSWORD REDIS_PASSWORD; do
  envgrep -qE "^\$var=[A-Za-z0-9_-]{16,}\$" || {
    echo "  .env.prod has no \$var of at least 16 URL-safe characters (letters, digits, - and _)."
    exit 1; }
done

# Hosts are derived from PUBLIC_URL now; this variable is not read at all.
# It is refused rather than ignored because someone who wrote '*' here meant
# it to do something, and what it used to do was accept any Host header.
envgrep -qE '^DJANGO_ALLOWED_HOSTS=' && {
  echo "  .env.prod sets DJANGO_ALLOWED_HOSTS. Nothing reads it any more: the host is"
  echo "  derived from PUBLIC_URL. Remove the line — '*' in particular is refused."
  exit 1; }

# Ten minutes is the ceiling on what a leaked token is worth. The control
# plane clamps it too; refusing here is what keeps the .env.prod honest.
ttl=\$(envgrep -E '^GC_TOKEN_TTL=' | cut -d= -f2- || true)
if [ -n "\$ttl" ] && { ! [ "\$ttl" -eq "\$ttl" ] 2>/dev/null || [ "\$ttl" -gt 600 ] || [ "\$ttl" -lt 60 ]; }; then
  echo "  GC_TOKEN_TTL=\$ttl — an executor token lives 60 to 600 seconds, no longer."
  exit 1
fi

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

# The instance metadata service (docs/AUTH.md §11). A GET with no token is
# 401 when IMDSv2 is required and 200 when v1 is still on — and v1 is what a
# page in the driven browser could read credentials from through one hole
# in the allowlist. Off EC2 there is no answer at all, and nothing to check.
imds=\$(curl -s -o /dev/null -w '%{http_code}' -m 2 http://169.254.169.254/latest/meta-data/ 2>/dev/null || echo 000)
case "\$imds" in
  000) echo "  no metadata service answered — not EC2, or IMDS is off; skipping the IMDSv2 checks" ;;
  401) echo "  IMDSv2 is required on this instance" ;;
  *)
    echo "  IMDSv1 is ENABLED (an untokened GET of the metadata service answered \$imds)."
    echo "  Require v2 with a hop limit of 1 and deploy again:"
    echo "    aws ec2 modify-instance-metadata-options --instance-id <id> \\\\"
    echo "      --http-tokens required --http-put-response-hop-limit 1 --http-endpoint enabled"
    exit 1 ;;
esac

ok_disk=\$(df --output=avail -BG / | tail -1 | tr -dc '0-9')
if [ "\${ok_disk:-99}" -lt 8 ]; then
  echo "  only \${ok_disk}G free — the image build needs room. Pruning."
  # Through the wrapper, which is the only thing with sudo rights on the
  # daemon: this script refuses to run for a user in the docker group, so a
  # bare \`docker\` here was guaranteed permission-denied on the socket — and
  # under \`set -euo pipefail\` that aborted the deploy in exactly the case
  # the branch exists to rescue. \`|| true\` because a prune that cannot run
  # is not a reason to stop either.
  $GC image prune -f >/dev/null 2>&1 || true
  $GC builder prune -f >/dev/null 2>&1 || true
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

# The hop limit, proven rather than assumed: the runner sits on a bridge
# network one NAT hop from the host, so with HttpPutResponseHopLimit=1 the
# token a PUT would return never reaches it. A token that DOES come back
# means the driven Chromium can read instance credentials, and that stack
# is taken down rather than left up.
if [ "\$imds" != 000 ]; then
  # The exec's own exit status, kept apart from what node printed. Folding
  # them together (\`|| echo unreachable\`) made "the probe could not run" —
  # container not up, exec refused, service renamed — indistinguishable from
  # node's own "unreachable", which is the PASS. The one check §11 upgrades
  # from "the bring-up script set it" to "the deploy proves it" could
  # therefore be no check at all.
  hop=\$($GC exec -T runner node -e "fetch('http://169.254.169.254/latest/api/token',{method:'PUT',headers:{'X-aws-ec2-metadata-token-ttl-seconds':'60'},signal:AbortSignal.timeout(3000)}).then(r=>console.log(r.status)).catch(()=>console.log('unreachable'))" 2>/dev/null | tr -d '\r') || probe_failed=1
  if [ "\${probe_failed:-0}" = 1 ] || [ -z "\$hop" ]; then
    echo "  could not run the IMDS probe inside the runner — the hop limit is UNPROVEN."
    $GC logs --tail=20 runner || true
    exit 1
  fi
  case "\$hop" in
    200)
      echo "  THE RUNNER CAN REACH INSTANCE CREDENTIALS: the IMDS hop limit is not 1. Taking it down."
      echo "    aws ec2 modify-instance-metadata-options --instance-id <id> \\\\"
      echo "      --http-tokens required --http-put-response-hop-limit 1 --http-endpoint enabled"
      $GC down; exit 1 ;;
    unreachable) echo "  IMDS is out of the runner's reach (hop limit 1): the token PUT timed out" ;;
    ''|*[!0-9]*)
      echo "  the IMDS probe answered \"\$hop\", which is neither a status nor 'unreachable'."
      echo "  The hop limit is UNPROVEN; not leaving this stack up."
      $GC down; exit 1 ;;
    *) echo "  IMDS answered \$hop to an untokened runner — not 200, so no credentials, but look at it." ;;
  esac
fi

echo "  migrating"
$GC exec -T control python manage.py migrate --noinput
$GC exec -T control python manage.py collectstatic --noinput >/dev/null
# Sessions are rows. Expired ones are never removed by being expired, only by
# this; and audit rows past ninety days go the same way. The scheduler
# service runs both daily; after a deploy is the one moment guaranteed to
# come round even if it has not.
$GC exec -T control python manage.py clearsessions
$GC exec -T control python manage.py purge_auth_events

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
# The extension hand-off is under the runner's gate (docs/AUTH.md §11): a
# 401 proves it. A 200 would be an open POST to the runner; a 403 would mean
# the edge's old refusal is back and the extension can never hand off.
probe /api/recording   401 "the extension hand-off is gated" POST
# From this box the admin is reachable only if GC_ADMIN_CIDRS says so, and
# the docker bridge is not in anyone's list. A 200 or 302 here means the
# allowlist is not being applied.
probe /admin/          403 "the admin is behind the allowlist"

# ---- and now the other direction ------------------------------------------
#
# Every probe above asserts that something is REFUSED, and a deployment nobody
# can sign in to passes all of them: a control plane with the wrong key, a
# bundle built against the wrong origin, a migration that never ran — each
# answers 401 exactly as a healthy one does. These two fail when access does
# not WORK.
RESOLVE="\$HOST:\$PORT:127.0.0.1"

# CSRF has to reach the browser before a sign-in can start, and without it
# every login 403s. The probe above cannot see that: a 200 carrying an empty
# body looks identical to a 200 carrying a token.
#
# Asserted in the BODY rather than as a Set-Cookie, because CSRF_USE_SESSIONS
# is on: Django issues no csrftoken cookie at all and the SPA reads the value
# from this response. Grepping for the cookie would fail on a healthy box.
csrf_probe=\$(curl -s -m 10 --resolve "\$RESOLVE" "\$PUBLIC_URL/auth/csrf" \
              | grep -o '"csrfToken":"[^"]*"' | cut -d'"' -f4)
if [ -n "\$csrf_probe" ]; then
  printf '    %-34s %s\n' "sign-in can actually start" "a token, \${#csrf_probe} chars"
else
  printf '    %-34s %s\n' "sign-in can actually start" "NO token in /auth/csrf — every login 403s"; FAIL=1
fi

# The whole round trip, when the operator supplies an account to do it with.
# Skipped LOUDLY rather than silently: a check that quietly does not run is one
# everybody believes is passing.
if [ -n "\${SMOKE_EMAIL:-}" ] && [ -n "\${SMOKE_PASSWORD:-}" ]; then
  jar=\$(mktemp)
  csrf=\$(curl -s -m 10 -c "\$jar" --resolve "\$RESOLVE" "\$PUBLIC_URL/auth/csrf" \
         | grep -o '"csrfToken":"[^"]*"' | cut -d'"' -f4)
  code=\$(curl -s -m 15 -b "\$jar" -c "\$jar" --resolve "\$RESOLVE" \
           -H "X-CSRFToken: \$csrf" -H 'Content-Type: application/json' \
           -d "{\"email\":\"\$SMOKE_EMAIL\",\"password\":\"\$SMOKE_PASSWORD\"}" \
           -o /dev/null -w '%{http_code}' \
           "\$PUBLIC_URL/_allauth/browser/v1/auth/login")
  if [ "\$code" = 200 ]; then
    # django rotates the CSRF token on sign-in; the one above is dead now.
    csrf=\$(curl -s -m 10 -b "\$jar" -c "\$jar" --resolve "\$RESOLVE" "\$PUBLIC_URL/auth/csrf" \
           | grep -o '"csrfToken":"[^"]*"' | cut -d'"' -f4)
    tok=\$(curl -s -m 10 -b "\$jar" -c "\$jar" --resolve "\$RESOLVE" -X POST \
            -H "X-CSRFToken: \$csrf" "\$PUBLIC_URL/auth/executor-token" \
            | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
    api=\$(curl -s -m 10 --resolve "\$RESOLVE" -H "Authorization: Bearer \$tok" \
            -o /dev/null -w '%{http_code}' "\$PUBLIC_URL/api/state")
    if [ -n "\$tok" ] && [ "\$api" = 200 ]; then
      printf '    %-34s %s\n' "sign in, mint, drive" "the runner answered 200 to a real token"
    else
      printf '    %-34s %s\n' "sign in, mint, drive" "signed in, but /api/state said \$api"; FAIL=1
    fi
  else
    printf '    %-34s %s\n' "sign in, mint, drive" "login answered \$code"; FAIL=1
  fi
  rm -f "\$jar"
else
  printf '    %-34s %s\n' "sign in, mint, drive" "SKIPPED — set SMOKE_EMAIL and SMOKE_PASSWORD"
fi

[ "\$FAIL" = 0 ] || { echo; echo "  smoke checks failed — rolling back is: bash scripts/deploy.sh rollback"; exit 1; }
REMOTE

step "deployed — open the app at the PUBLIC_URL in .env.prod (/app/)"
ok "no account yet?  ssh -t -i $PEM $EC2_USER@$EC2_HOST 'cd $REMOTE_DIR && ./scripts/gc exec control python manage.py createsuperuser'"
ok "roll back:       EC2_HOST=$EC2_HOST bash scripts/deploy.sh rollback"
echo
