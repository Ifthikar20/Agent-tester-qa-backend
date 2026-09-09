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
  echo "    installed"
fi

# NOT `usermod -aG docker`. The docker group is root by another name — anyone
# in it can mount / into a container — and nothing logs its use. Instead one
# sudoers line lets this user run the stack's own wrapper as root, so every
# compose command is in auth.log with who ran it, and .env.prod can be
# root-owned where no process running as this user can read the signing key
# (docs/AUTH.md §12 [ops-supply-1]). SETENV lets the deploy pass GC_GIT_SHA
# through; the second line is what lets scripts/deploy.sh read the file's
# KEYS (never values) for its refusals.
say "sudoers"
if id -nG "$USER" | grep -qw docker; then
  echo "    ! $USER is in the docker group; remove it: sudo gpasswd -d $USER docker"
fi
printf '%s ALL=(root) NOPASSWD:SETENV: /opt/ghostclick/scripts/gc\n%s ALL=(root) NOPASSWD: /usr/bin/cat /opt/ghostclick/.env.prod\n' "$USER" "$USER" \
  | sudo tee /etc/sudoers.d/ghostclick >/dev/null
sudo chmod 440 /etc/sudoers.d/ghostclick
sudo visudo -cf /etc/sudoers.d/ghostclick >/dev/null
echo "    /etc/sudoers.d/ghostclick: $USER may run scripts/gc as root, and read .env.prod through it"

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
    sudo install -m 600 -o root -g root .env.prod.example .env.prod
    sudoedit .env.prod        # PUBLIC_URL, the keypair, the three secrets, the two store passwords

  root-owned and 0600: the signing key in it is read by compose under sudo
  (scripts/gc) and by nothing running as you. Then from your laptop:

    EC2_HOST=<this-ip> bash scripts/deploy.sh

NEXT
