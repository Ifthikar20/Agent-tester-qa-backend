#!/usr/bin/env bash
#
# Deploy ghostclick to the EC2 host.
#
#   EC2_HOST=<ip> bash scripts/deploy.sh
#
# Run from your laptop with the PEM at the repo root. It SSHes in itself; you
# do not need to SSH first. Read docs/DEPLOY.md before the first run.
set -euo pipefail

PEM=${PEM:-./cansee-deploy.pem}
EC2_HOST=${EC2_HOST:?set EC2_HOST=<elastic-ip>}
EC2_USER=${EC2_USER:-ubuntu}
REMOTE_DIR=${REMOTE_DIR:-/opt/ghostclick}
COMPOSE="docker compose -f docker/docker-compose.prod.yml"

[ -f "$PEM" ] || { echo "  no PEM at $PEM — set PEM=/path/to/key.pem"; exit 1; }
chmod 600 "$PEM" 2>/dev/null || true

say() { printf '\n  %s\n' "$*"; }
remote() { ssh -i "$PEM" -o StrictHostKeyChecking=accept-new "$EC2_USER@$EC2_HOST" "$@"; }

say "deploying to $EC2_USER@$EC2_HOST:$REMOTE_DIR"

remote bash -s <<REMOTE
set -euo pipefail
cd "$REMOTE_DIR"

echo "  pulling"
git pull --ff-only origin \$(git rev-parse --abbrev-ref HEAD)

# The one check worth failing a deploy over.
#
# Without GC_AUTH_SECRET the runner starts OPEN — it says so in its own banner,
# but nobody reads a banner on a host they just deployed to. An open ghostclick
# on a reachable address is an unauthenticated service that will fetch URLs from
# inside your VPC and stream the result back. Refusing here is cheaper than
# noticing later.
if [ ! -f .env.prod ]; then
  echo "  no .env.prod — copy .env.prod.example and fill it in"; exit 1
fi
if ! grep -qE '^GC_AUTH_SECRET=.{32,}' .env.prod; then
  echo "  .env.prod has no GC_AUTH_SECRET of at least 32 characters."
  echo "  The runner would start unauthenticated. Refusing to deploy."
  exit 1
fi

echo "  building and starting"
$COMPOSE --env-file .env.prod up -d --build

echo "  migrating"
$COMPOSE --env-file .env.prod exec -T control python manage.py migrate --noinput
$COMPOSE --env-file .env.prod exec -T control python manage.py collectstatic --noinput >/dev/null

echo "  waiting for the browser to come up"
for i in \$(seq 1 60); do
  code=\$(curl -s -o /dev/null -w '%{http_code}' http://localhost/app/ || true)
  [ "\$code" = "200" ] && break
  sleep 2
done

echo
echo "  smoke checks"
ui=\$(curl -s -o /dev/null -w '%{http_code}' http://localhost/app/ || true)
api=\$(curl -s -o /dev/null -w '%{http_code}' http://localhost/api/state || true)
csrf=\$(curl -s -o /dev/null -w '%{http_code}' http://localhost/auth/csrf || true)
rec=\$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost/api/recording || true)

printf '    %-34s %s\n' "the UI loads"                    "\$ui   (want 200)"
printf '    %-34s %s\n' "the API is GATED"                "\$api   (want 401)"
printf '    %-34s %s\n' "the control plane answers"       "\$csrf   (want 200)"
printf '    %-34s %s\n' "the extension hand-off is shut"  "\$rec   (want 403)"

# A 200 from /api/state is not a pass here, it is the failure this whole script
# exists to catch: the runner came up with no gate in front of it.
if [ "\$api" = "200" ]; then
  echo
  echo "  THE RUNNER IS UNAUTHENTICATED. Taking it down."
  $COMPOSE --env-file .env.prod down
  exit 1
fi
[ "\$ui" = "200" ] && [ "\$api" = "401" ] || { echo; echo "  smoke checks failed"; exit 1; }
REMOTE

say "deployed — open http://$EC2_HOST/app/ and sign in"
say "if you have no account yet:"
echo "    ssh -i $PEM $EC2_USER@$EC2_HOST 'cd $REMOTE_DIR && $COMPOSE exec control python manage.py createsuperuser'"
echo
