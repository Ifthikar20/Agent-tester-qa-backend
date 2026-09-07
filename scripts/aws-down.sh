#!/usr/bin/env bash
#
# Delete everything scripts/aws-up.sh made.
#
#   bash scripts/aws-down.sh
#
# An Elastic IP costs money while it exists whether or not anything is attached
# to it, so "just stop the instance" is the version of this that quietly keeps
# billing. This releases it.
#
# The instance's volume is deleted with it. That volume holds the origin
# allowlist, the vault and every account — this script asks before it does that.
set -euo pipefail

REGION=${REGION:-${AWS_DEFAULT_REGION:-us-east-1}}
NAME=${NAME:-ghostclick}
aws_() { aws --region "$REGION" "$@"; }
step() { printf '\n  %s\n' "$*"; }
ok()   { printf '    %s\n' "$*"; }

command -v aws >/dev/null || { echo "  no aws CLI on PATH" >&2; exit 1; }

ID=$(aws_ ec2 describe-instances --filters Name=tag:Name,Values="$NAME" \
      "Name=instance-state-name,Values=pending,running,stopped" \
      --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || echo None)
IP=$(aws_ ec2 describe-addresses --filters Name=tag:Name,Values="$NAME" \
      --query 'Addresses[0].PublicIp' --output text 2>/dev/null || echo None)

step "in $REGION, tagged Name=$NAME:"
ok "instance    ${ID:-none}"
ok "elastic ip  ${IP:-none}"
[ "$ID" = "None" ] && [ "$IP" = "None" ] && { step "nothing to remove"; exit 0; }

cat <<'WARN'

    Terminating deletes the root volume, and with it:
      - .ghostclick/  the origin allowlist, the run history, the vault
      - the control-plane database: every account you created
    There is no backup unless you made one.

WARN
printf '    type the word delete to continue: '; read -r CONFIRM
[ "$CONFIRM" = delete ] || { step "left alone"; exit 0; }

if [ "$IP" != "None" ]; then
  ALLOC=$(aws_ ec2 describe-addresses --public-ips "$IP" --query 'Addresses[0].AllocationId' --output text)
  ASSOC=$(aws_ ec2 describe-addresses --public-ips "$IP" --query 'Addresses[0].AssociationId' --output text)
  [ "$ASSOC" != "None" ] && aws_ ec2 disassociate-address --association-id "$ASSOC" >/dev/null
  aws_ ec2 release-address --allocation-id "$ALLOC"
  step "released $IP"
fi
if [ "$ID" != "None" ]; then
  aws_ ec2 terminate-instances --instance-ids "$ID" >/dev/null
  step "terminating $ID"
  aws_ ec2 wait instance-terminated --instance-ids "$ID"
  ok "gone"
fi

# The security group can only be deleted once nothing references it, which is
# why this runs last and is allowed to fail.
SG=$(aws_ ec2 describe-security-groups --filters Name=group-name,Values="$NAME" \
      --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo None)
[ "$SG" != "None" ] && aws_ ec2 delete-security-group --group-id "$SG" 2>/dev/null && step "deleted $SG" || true

step "done — the key pair $NAME-deploy is left in place, it costs nothing"
echo
