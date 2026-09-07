#!/usr/bin/env bash
#
# Prepare a fresh Ubuntu 24.04 instance to run ghostclick. Run once, on the
# host, before the first deploy:
#
#   scp -i cansee-deploy.pem scripts/bootstrap-ec2.sh ubuntu@<ip>:/tmp/
#   ssh -i cansee-deploy.pem ubuntu@<ip> 'bash /tmp/bootstrap-ec2.sh'
#
# It installs Docker, adds swap, and makes /opt/ghostclick. It does NOT clone
# the repo or start anything — that needs a repo URL and a filled-in .env.prod,
# and both are decisions rather than steps.
set -euo pipefail

say() { printf '\n  %s\n' "$*"; }

say "docker"
if command -v docker >/dev/null; then
  echo "    already installed"
else
  sudo apt-get update -qq
  sudo apt-get install -y -qq ca-certificates curl git
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER"
  echo "    installed — log out and back in for the group to take effect"
fi

# Chromium is 300-700MB with a page open, and it grows with the page under
# test. Without swap an OOM kill lands on whatever the kernel picks, which is
# rarely the browser — so the symptom is the runner or Django dying for no
# visible reason, and you spend an afternoon on it.
say "swap"
if swapon --show | grep -q .; then
  echo "    already active: $(swapon --show=SIZE --noheadings | tr -d ' \n')"
else
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  echo "    2G swapfile added"
fi

say "app directory"
sudo mkdir -p /opt/ghostclick
sudo chown "$USER:$USER" /opt/ghostclick
echo "    /opt/ghostclick ready"

say "memory"
free -h | sed 's/^/    /'

cat <<'NEXT'

  Next, on this host:

    git clone <repo-url> /opt/ghostclick
    cd /opt/ghostclick
    cp .env.prod.example .env.prod
    nano .env.prod            # GC_AUTH_SECRET and PUBLIC_URL

  Then from your laptop:

    EC2_HOST=<this-ip> bash scripts/deploy.sh

NEXT
