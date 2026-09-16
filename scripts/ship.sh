#!/usr/bin/env bash
#
# Ship the CURRENT local working tree to the box and rebuild — one command from
# your laptop:
#
#   bash scripts/ship.sh
#
# Defaults to the current box; point it elsewhere with EC2_HOST=<ip>.
#
# It keeps ATTACH mode running: only the code images (runner, control,
# scheduler) are rebuilt, so the signed-in Chromium and its proxy are never
# restarted and the human login survives the deploy.
#
# Override with env vars:
#   PEM=./ghostclick-deploy.pem   the key (default this)
#   EC2_USER=ubuntu   REMOTE_DIR=/opt/ghostclick
#   SERVICES="runner"             rebuild fewer images (default all three)
#   COMPOSE_FILES="-f docker/docker-compose.prod.yml"   headless, no attach
#   UI_DIR=/path/to/poc-qa-stack  ALSO ship the UI: build it there and put the
#                                 build where the box serves it (see below).
#                                 Unset, only the backend goes.
#
# This is a WORKING-TREE deploy: whatever is on disk goes, committed or not.
# Fast for iterating, but it leaves the box's git checkout dirty — for a
# git-pinned, reproducible deploy use scripts/deploy.sh instead.
set -euo pipefail

# Run from the backend repo root no matter where you invoke this from, so the
# relative paths below (the key, the source to ship) always resolve.
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

PEM=${PEM:-./ghostclick-deploy.pem}
EC2_HOST=${EC2_HOST:-52.200.74.72}
EC2_USER=${EC2_USER:-ubuntu}
DIR=${REMOTE_DIR:-/opt/ghostclick}
SERVICES=${SERVICES:-runner control scheduler}
COMPOSE_FILES=${COMPOSE_FILES:--f docker/docker-compose.prod.yml -f docker/docker-compose.attach.yml}
DC="sudo docker compose $COMPOSE_FILES --env-file .env.prod"
SSH="ssh -i $PEM -o StrictHostKeyChecking=accept-new"

[ -f "$PEM" ] || { echo "  no key at $PEM — set PEM=/path/to/key.pem"; exit 1; }
say() { printf '\n  %s\n' "$*"; }

# 0. Build the UI, when told where it is. The runner image carries no UI
#    (docker/no-ui): in production it serves the folder .env.prod names as
#    GC_WEB_DIR (docker/docker-compose.prod.yml), read per request — so the UI
#    is a folder to replace, not an image to rebuild, and this script used to
#    leave it alone entirely. Built FIRST, so a build that fails stops the
#    deploy before anything has reached the box. The control plane's address
#    is baked in at build time (VITE_AUTH_URL; poc-qa-stack/src/config.js).
UI_OUT=""
if [ -n "${UI_DIR:-}" ]; then
  [ -f "$UI_DIR/package.json" ] || { echo "  no UI at $UI_DIR (no package.json) — set UI_DIR=/path/to/poc-qa-stack"; exit 1; }
  UI_OUT="$UI_DIR/.ship-dist"
  trap 'rm -rf "$UI_OUT"' EXIT
  say "building the UI from $UI_DIR (VITE_AUTH_URL=http://$EC2_HOST)"
  ( cd "$UI_DIR" && rm -rf .ship-dist && VITE_AUTH_URL="http://$EC2_HOST" npx vite build --outDir .ship-dist >/dev/null )
  [ -f "$UI_OUT/index.html" ] || { echo "  the UI build left no index.html in $UI_OUT"; exit 1; }
fi

# 1. Ship the source. tar-over-ssh (portable — Git Bash has tar, not always
#    rsync), additive (never deletes), and it never carries .git, dependencies,
#    builds, secrets, or the box's OWN org state (suites/, .ghostclick/).
say "shipping source -> $EC2_USER@$EC2_HOST:$DIR"
tar czf - \
  --exclude='./.git' --exclude='*node_modules*' --exclude='./dist' \
  --exclude='./.ghostclick' --exclude='./suites' \
  --exclude='*__pycache__*' --exclude='*.pyc' --exclude='*.pem' \
  --exclude='./.env' --exclude='./.env.*' --exclude='./.last_deploy_prior' \
  . | $SSH "$EC2_USER@$EC2_HOST" "mkdir -p '$DIR' && tar xzf - -C '$DIR'"

# 1b. Ship the UI build over the folder the runner serves. Extracted OVER it
#     rather than swapped in: the folder is bind-mounted into the running
#     container, and a mount follows the directory, not its name — a renamed
#     replacement would not be seen until the runner restarted. Additive, so
#     earlier builds' hashed assets stay behind unreferenced; harmless, and
#     the runner picks up the new index.html on the next request. .env.prod
#     is root's (it holds secrets), so it is read with sudo, the way docker
#     compose reads it above.
if [ -n "$UI_OUT" ]; then
  say "shipping the UI -> the box's GC_WEB_DIR"
  tar czf - -C "$UI_OUT" . | $SSH "$EC2_USER@$EC2_HOST" "set -e; cd '$DIR'
    WEB=\$(sudo grep '^GC_WEB_DIR=' .env.prod | cut -d= -f2- | sed -e 's/^\"//' -e 's/\"\$//' -e \"s/^'//\" -e \"s/'\$//\")
    [ -n \"\$WEB\" ] || { echo '    .env.prod names no GC_WEB_DIR'; exit 1; }
    sudo mkdir -p \"\$WEB\" && sudo tar xzf - -C \"\$WEB\" --no-same-owner
    echo \"    -> \$WEB\""
fi

# 2. Rebuild only the code images; chrome / cdp-proxy / caddy / postgres / redis
#    stay up, so the attached browser survives. Then migrate (a no-op unless a
#    model changed) and collect static.
say "rebuilding [$SERVICES] — attach browser left running"
$SSH "$EC2_USER@$EC2_HOST" "set -e; cd '$DIR'
  $DC up -d --build $SERVICES
  for i in \$(seq 1 30); do $DC exec -T control true 2>/dev/null && break; sleep 1; done
  $DC exec -T control python manage.py migrate --noinput
  $DC exec -T control python manage.py collectstatic --noinput >/dev/null"

# 3. Ready = the BROWSER answers, not just the port — /healthz is 503 until
#    chromium is up (or, in attach mode, until the CDP attach succeeds).
say "waiting for the browser"
$SSH "$EC2_USER@$EC2_HOST" "for i in \$(seq 1 60); do
    curl -sf http://127.0.0.1/healthz -H 'Host: $EC2_HOST' 2>/dev/null | grep -q '\"browser\":true' && { echo '    healthy'; exit 0; }
    sleep 2
  done
  echo '    browser did not come back in 120s:'; $DC ps; exit 1"

say "deployed -> http://$EC2_HOST/app/"
