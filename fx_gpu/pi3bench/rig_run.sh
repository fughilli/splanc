#!/bin/sh
# Runs INSIDE a HITL reservation container on hitl-rig-1 (the operator streams
# this dir + the payload into the container). Copies the payload to the
# reserved led-mapper Pi, runs run.sh there, streams its JSON to stdout, and
# removes everything it created — on the Pi AND in the container — on exit,
# including on failure.
#
#   PI_KEY_FILE=<path the operator placed the Pi deploy key at> sh rig_run.sh [run.sh opts]
#
# The key is never printed, logged or copied anywhere else; it is chmod 600 and
# deleted on exit. The Pi address comes from the reservation ($HITL_ADDRESS, or
# $HITL_DUT_ADDR). Nothing is installed on the Pi: the payload lands in
# /var/tmp/fxgpu-pi3bench-*, run.sh unpacks into its own temp dir, and both are
# removed; any leftover from an earlier preempted run is removed first.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
KEY=${PI_KEY_FILE:?set PI_KEY_FILE to the key path inside this container}
ADDR=${HITL_ADDRESS:-${HITL_DUT_ADDR:-}}
[ -n "$ADDR" ] || { echo '{"bench":"rig","ok":false,"error":"no HITL_ADDRESS/HITL_DUT_ADDR"}'; exit 1; }
for t in ssh scp; do
  command -v $t >/dev/null 2>&1 || { echo "{\"bench\":\"rig\",\"ok\":false,\"error\":\"$t not in container\"}"; exit 1; }
done
REMOTE=/var/tmp/fxgpu-pi3bench-$$
SSHO="-i $KEY -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=15"
cleanup() {
  # shellcheck disable=SC2086
  ssh $SSHO "root@$ADDR" "rm -rf $REMOTE" >/dev/null 2>&1 || true
  rm -f "$KEY"
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM HUP
chmod 600 "$KEY"
# shellcheck disable=SC2086
ssh $SSHO "root@$ADDR" "rm -rf /var/tmp/fxgpu-pi3bench-* && mkdir -p $REMOTE" || {
  echo '{"bench":"rig","ok":false,"error":"ssh to Pi failed"}'; exit 1; }
# shellcheck disable=SC2086
scp -q $SSHO "$HERE/pi3bench-payload.tar.gz" "$HERE/run.sh" "root@$ADDR:$REMOTE/" || {
  echo '{"bench":"rig","ok":false,"error":"scp to Pi failed"}'; exit 1; }
# shellcheck disable=SC2086
ssh $SSHO "root@$ADDR" "sh $REMOTE/run.sh $REMOTE/pi3bench-payload.tar.gz $*"
echo "{\"bench\":\"rig\",\"ok\":true,\"rc\":$?}"
