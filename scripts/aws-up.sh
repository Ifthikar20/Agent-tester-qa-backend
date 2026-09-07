#!/usr/bin/env bash
#
# Create the box and put ghostclick on it, from nothing, in one command.
#
#   bash scripts/aws-up.sh
#
# Needs: the AWS CLI, logged in (`aws sts get-caller-identity` must work).
# Everything else it makes. It prints the URL at the end.
#
# What it creates, and what it costs (us-east-1, on-demand, ~Sep 2026):
#
#   t3.medium                ~$30/mo   4 GB RAM. A t3.small cannot run Chromium;
#                                      that is why this does not reuse the
#                                      Cansee host.
#   20 GB gp3, encrypted      ~$1.60/mo
#   Elastic IP                ~$3.60/mo while associated
#                            ~$35/mo total. `bash scripts/aws-down.sh` removes it.
#
# It is deliberately not Terraform. Terraform is the right home for this once
# the box is worth keeping — see docs/DEPLOY.md, "Where this goes next".
set -euo pipefail

# Git Bash / MSYS rewrites any argument that looks like a unix path into a
# Windows one before the program sees it, so `--names /aws/...` arrives as
# `C:/...`. Nothing here wants that translation.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

REGION=${REGION:-${AWS_DEFAULT_REGION:-us-east-1}}
NAME=${NAME:-ghostclick}
TYPE=${TYPE:-t3.medium}
KEY_NAME=${KEY_NAME:-ghostclick-deploy}
KEY_FILE=${KEY_FILE:-./ghostclick-deploy.pem}
REPO_URL=${REPO_URL:-https://github.com/Ifthikar20/poc-qa-stack}
BRANCH=${BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}
REMOTE_DIR=/opt/ghostclick

step() { printf '\n  %s\n' "$*"; }
ok()   { printf '    %s\n' "$*"; }
die()  { printf '\n  %s\n' "$*" >&2; exit 1; }
aws_() { aws --region "$REGION" "$@"; }

command -v aws >/dev/null || die "no aws CLI on PATH"
aws_ sts get-caller-identity >/dev/null 2>&1 || die "aws credentials are not working — run 'aws configure' or set AWS_PROFILE"
ACCT=$(aws_ sts get-caller-identity --query Account --output text)
WHO=$(aws_ sts get-caller-identity --query Arn --output text)

# ---- preflight --------------------------------------------------------------
#
# Every permission this needs, tested before anything is created. Discovering
# them one at a time is three round trips of "create half a thing, fail, clean
# up" — and the first thing it creates is a key pair whose private half AWS
# will never show again.
#
# Only the read calls can be tested without doing the thing. The writes are
# listed in the policy below, which is what to attach when one of these fails.
if [ "${SKIP_PREFLIGHT:-}" != "1" ]; then
  MISSING=""
  try() { # action, command...
    local name=$1; shift
    "$@" >/dev/null 2>&1 || MISSING="$MISSING $name"
  }
  try ec2:DescribeImages         aws_ ec2 describe-images --owners 099720109477 --filters Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-* --max-items 1
  try ec2:DescribeVpcs           aws_ ec2 describe-vpcs --filters Name=isDefault,Values=true
  try ec2:DescribeSecurityGroups aws_ ec2 describe-security-groups --max-items 1
  try ec2:DescribeKeyPairs       aws_ ec2 describe-key-pairs
  try ec2:DescribeInstances      aws_ ec2 describe-instances --max-items 1
  try ec2:DescribeAddresses      aws_ ec2 describe-addresses

  if [ -n "$MISSING" ]; then
    cat >&2 <<POLICY

  $WHO cannot:$MISSING

  Attach this to that user (IAM > Users > Permissions > Add > Create inline
  policy > JSON), then run this script again. It is scoped to EC2 — no IAM, no
  SSM, nothing that can grant itself more.

{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "ec2:DescribeImages", "ec2:DescribeVpcs", "ec2:DescribeSubnets",
      "ec2:DescribeSecurityGroups", "ec2:DescribeSecurityGroupRules",
      "ec2:DescribeKeyPairs", "ec2:DescribeInstances", "ec2:DescribeAddresses",
      "ec2:DescribeInstanceStatus", "ec2:DescribeVolumes", "ec2:DescribeTags",
      "ec2:CreateKeyPair", "ec2:CreateSecurityGroup",
      "ec2:AuthorizeSecurityGroupIngress", "ec2:CreateTags",
      "ec2:RunInstances", "ec2:TerminateInstances",
      "ec2:AllocateAddress", "ec2:AssociateAddress",
      "ec2:DisassociateAddress", "ec2:ReleaseAddress",
      "ec2:ModifyInstanceMetadataOptions", "ec2:DeleteSecurityGroup"
    ],
    "Resource": "*"
  }]
}

  If you would rather not widen that user, any admin credentials work for this
  one script: AWS_PROFILE=<admin> bash scripts/aws-up.sh

POLICY
    exit 1
  fi
fi


MY_IP=$(curl -s -m 10 https://checkip.amazonaws.com || true)
[ -n "$MY_IP" ] || die "could not determine your public IP (needed for the SSH rule)"
SSH_CIDR=${SSH_CIDR:-$MY_IP/32}
HTTP_CIDR=${HTTP_CIDR:-0.0.0.0/0}

step "account $ACCT in $REGION"
ok "ssh  from $SSH_CIDR"
ok "http from $HTTP_CIDR"
if [ "$HTTP_CIDR" = "0.0.0.0/0" ]; then
  cat <<'NOTE'

    Port 80 will be open to the internet, because you asked to reach this
    from another computer. What that means, exactly:

      - The app IS gated. /api/* answers 401 without a token, and the token
        comes from a Django login. An anonymous visitor gets a sign-in page.
      - There is NO TLS yet. The session cookie and the executor token (which
        rides in the WebSocket query string, because a browser cannot set
        headers on a WebSocket) cross the network in cleartext. Anyone on the
        path can read them and drive your browser.
      - So: fine for a demo you are watching. Not fine for anything real, and
        not fine to leave running. Take it down with scripts/aws-down.sh.

    To restrict it to one other machine instead, re-run with:
      HTTP_CIDR=<that-machine-ip>/32 bash scripts/aws-up.sh

NOTE
  printf '    press enter to continue, ctrl-c to stop: '; read -r _
fi

# ---- key pair ---------------------------------------------------------------
if aws_ ec2 describe-key-pairs --key-names "$KEY_NAME" >/dev/null 2>&1; then
  step "key pair $KEY_NAME exists"
  [ -f "$KEY_FILE" ] || die "$KEY_NAME exists in AWS but $KEY_FILE is not here — set KEY_FILE, or use KEY_NAME=<other>"
else
  step "creating key pair $KEY_NAME"
  aws_ ec2 create-key-pair --key-name "$KEY_NAME" --query KeyMaterial --output text > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  ok "private key written to $KEY_FILE — it is gitignored, and AWS will not show it again"
fi

# ---- security group ---------------------------------------------------------
VPC=$(aws_ ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
[ "$VPC" != "None" ] || die "no default VPC in $REGION"
SG=$(aws_ ec2 describe-security-groups --filters Name=group-name,Values="$NAME" Name=vpc-id,Values="$VPC" \
       --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo None)
if [ "$SG" = "None" ]; then
  step "creating security group $NAME"
  SG=$(aws_ ec2 create-security-group --group-name "$NAME" --vpc-id "$VPC" \
        --description "ghostclick: ssh from one address, http from the demo audience" \
        --query GroupId --output text)
fi
# Swallowing only the duplicate. A rule that failed to be created for any
# other reason — no permission, most likely — must not pass silently: the
# symptom is an ssh that hangs for four minutes with nothing to point at.
auth() {
  local out
  if out=$(aws_ ec2 authorize-security-group-ingress --group-id "$SG" \
            --ip-permissions "IpProtocol=tcp,FromPort=$1,ToPort=$1,IpRanges=[{CidrIp=$2,Description=\"$3\"}]" 2>&1); then
    return 0
  fi
  case "$out" in
    *InvalidPermission.Duplicate*) return 0 ;;
    *) die "could not open port $1 to $2:
    $(echo "$out" | tail -2)" ;;
  esac
}
auth 22 "$SSH_CIDR" "deploys from the operator's laptop"
auth 80 "$HTTP_CIDR" "the app"
ok "security group $SG"

# ---- the instance -----------------------------------------------------------
EXISTING=$(aws_ ec2 describe-instances \
  --filters Name=tag:Name,Values="$NAME" "Name=instance-state-name,Values=pending,running" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || echo None)

if [ "$EXISTING" != "None" ] && [ -n "$EXISTING" ]; then
  ID=$EXISTING
  step "reusing running instance $ID"
else
  # Asked of EC2, not SSM. The published SSM parameter is the tidier lookup,
  # but it needs ssm:GetParameters — a permission an EC2 deploy user has no
  # other reason to hold — and its name begins with a slash, which Git Bash
  # rewrites into a Windows path before the CLI ever sees it. Between them
  # that is two failures for a value describe-images already knows.
  #
  # 099720109477 is Canonical. Pinning the owner is the security half: image
  # NAMES are not reserved, so filtering on the name alone would let anyone
  # who published a lookalike choose the operating system this box boots.
  if [ -z "${AMI:-}" ]; then
    step "finding the latest Ubuntu 24.04 image"
    for pattern in \
      'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*' \
      'ubuntu/images/hvm-ssd/ubuntu-noble-24.04-amd64-server-*'; do
      AMI=$(aws_ ec2 describe-images --owners 099720109477 \
              --filters "Name=name,Values=$pattern" Name=state,Values=available \
                        Name=architecture,Values=x86_64 \
              --query 'sort_by(Images, &CreationDate)[-1].ImageId' --output text 2>/dev/null || echo None)
      [ "$AMI" != "None" ] && [ -n "$AMI" ] && break
    done
  fi
  [ "${AMI:-None}" != "None" ] && [ -n "${AMI:-}" ] || die "could not resolve an Ubuntu 24.04 AMI — pass one with AMI=ami-xxxxxxxx bash scripts/aws-up.sh"
  step "launching $TYPE from $AMI"
  ID=$(aws_ ec2 run-instances \
    --image-id "$AMI" --instance-type "$TYPE" --key-name "$KEY_NAME" --security-group-ids "$SG" \
    --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=20,VolumeType=gp3,Encrypted=true,DeleteOnTermination=true}' \
    --metadata-options 'HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled' \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{Key=project,Value=ghostclick}]" \
    --query 'Instances[0].InstanceId' --output text)
  ok "instance $ID"
  # hop limit 1 is the point: Chromium runs in a Docker bridge network, so one
  # extra NAT hop drops the TTL to zero and a container cannot reach IMDS at
  # all. On a service whose whole job is fetching URLs other people choose,
  # that is the difference between SSRF and credential theft.
  aws_ ec2 wait instance-running --instance-ids "$ID"
fi

# ---- elastic ip -------------------------------------------------------------
IP=$(aws_ ec2 describe-addresses --filters Name=tag:Name,Values="$NAME" \
      --query 'Addresses[0].PublicIp' --output text 2>/dev/null || echo None)
if [ "$IP" = "None" ] || [ -z "$IP" ]; then
  step "allocating an elastic IP"
  ALLOC=$(aws_ ec2 allocate-address --domain vpc \
    --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$NAME}]" \
    --query AllocationId --output text)
  IP=$(aws_ ec2 describe-addresses --allocation-ids "$ALLOC" --query 'Addresses[0].PublicIp' --output text)
else
  ALLOC=$(aws_ ec2 describe-addresses --public-ips "$IP" --query 'Addresses[0].AllocationId' --output text)
fi
aws_ ec2 associate-address --instance-id "$ID" --allocation-id "$ALLOC" >/dev/null
ok "public address $IP"

# ---- wait for ssh -----------------------------------------------------------
step "waiting for ssh"
SSH="ssh -i $KEY_FILE -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 ubuntu@$IP"
for i in $(seq 1 40); do
  $SSH true 2>/dev/null && break
  [ "$i" = 40 ] && die "no ssh after ~4 minutes. Check the security group allows $SSH_CIDR on 22."
  sleep 6
done
ok "in"

# ---- bootstrap, clone, configure, deploy ------------------------------------
#
# The two secrets are generated ON THE BOX and never leave it. Nothing prints
# them, nothing sends them back over this link, and they are not in this
# script's output or your shell history.
step "installing docker, cloning, generating secrets, building"
ok "the first build downloads a Playwright image — expect 5-10 minutes"
$SSH "REPO_URL='$REPO_URL' BRANCH='$BRANCH' PUBLIC_IP='$IP' bash -s" <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

if ! command -v docker >/dev/null; then
  echo "  installing docker"
  sudo apt-get update -qq
  sudo apt-get install -y -qq ca-certificates curl git >/dev/null
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  sudo usermod -aG docker ubuntu
fi

# 4 GB is enough to RUN the stack and tight to BUILD it. Swap is what stops the
# OOM killer taking Chromium during the first image build.
if ! swapon --show | grep -q .; then
  echo "  adding 2G swap"
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

sudo mkdir -p /opt/ghostclick && sudo chown ubuntu:ubuntu /opt/ghostclick
if [ -d /opt/ghostclick/.git ]; then
  git -C /opt/ghostclick fetch --quiet origin "$BRANCH"
  git -C /opt/ghostclick reset --hard --quiet "origin/$BRANCH"
else
  git clone --quiet --branch "$BRANCH" "$REPO_URL" /opt/ghostclick
fi
cd /opt/ghostclick

if [ ! -f .env.prod ]; then
  echo "  generating secrets (on this host only — they are never printed or sent back)"
  cp .env.prod.example .env.prod
  gen() { head -c 48 /dev/urandom | base64 | tr -d '=+/\n' | cut -c1-64; }
  # sed with a | delimiter: a base64url secret can contain / but never |.
  sed -i "s|^GC_AUTH_SECRET=.*|GC_AUTH_SECRET=$(gen)|"        .env.prod
  sed -i "s|^DJANGO_SECRET_KEY=.*|DJANGO_SECRET_KEY=$(gen)|"  .env.prod
  sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=http://$PUBLIC_IP|"     .env.prod
  chmod 600 .env.prod
fi

export GC_GIT_SHA=$(git rev-parse --short HEAD)
sg docker -c './scripts/gc up -d --build'
sg docker -c './scripts/gc exec -T control python manage.py migrate --noinput'
sg docker -c './scripts/gc exec -T control python manage.py collectstatic --noinput' >/dev/null

echo "  waiting for the browser"
for i in $(seq 1 90); do
  case "$(curl -s -m 5 http://localhost/healthz || true)" in
    *'"browser":true'*) break ;;
  esac
  [ "$i" = 90 ] && { echo "  the browser never came up:"; sg docker -c './scripts/gc logs --tail=40 runner'; exit 1; }
  sleep 2
done
REMOTE

# ---- prove it from outside --------------------------------------------------
step "checking from outside the box"
FAIL=0
probe() {
  local code; code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' -X "${4:-GET}" "http://$IP$1" || echo 000)
  if [ "$code" = "$2" ]; then printf '    %-34s %s\n' "$3" "$code"
  else printf '    %-34s %s  WANT %s\n' "$3" "$code" "$2"; FAIL=1; fi
}
probe /app/          200 "the UI loads"
probe /api/state     401 "the API is gated"
probe /auth/csrf     200 "the control plane answers"
probe /healthz       200 "the browser is up"
probe /api/recording 403 "the extension hand-off is shut" POST
[ "$FAIL" = 0 ] || die "the box is up but not healthy — EC2_HOST=$IP PEM=$KEY_FILE bash scripts/deploy.sh logs runner"

step "up at  http://$IP/app/"
echo
ok "make yourself an account (interactive, so the password is never in a script):"
echo "      ssh -i $KEY_FILE ubuntu@$IP 'cd $REMOTE_DIR && ./scripts/gc exec control python manage.py createsuperuser'"
echo
ok "then sign in at http://$IP/app/ from any machine allowed by $HTTP_CIDR"
echo
ok "later:  EC2_HOST=$IP PEM=$KEY_FILE bash scripts/deploy.sh          (redeploy)"
ok "        EC2_HOST=$IP PEM=$KEY_FILE bash scripts/deploy.sh health   (is it up)"
ok "        bash scripts/aws-down.sh                                   (delete it all)"
echo
