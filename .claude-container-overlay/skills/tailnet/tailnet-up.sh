#!/usr/bin/env bash
#
# tailnet-up.sh — join a claude-container to the user's tailnet, then map peer
# names into /etc/hosts. Portable across projects: no repo-specific paths.
#
# Call this from the project's .claude-container-overlay/startup.sh, e.g.:
#     "$(dirname "$0")/tailnet-up.sh"
# or copy it next to startup.sh and invoke it there. It runs as the mapped
# non-root user, using the passwordless sudo the overlay installs.
#
# Requires (all wired by the tailnet skill — see SKILL.md):
#   * the tailscale client in the image (Dockerfile.snippet)
#   * overlay.json: "capabilities":["NET_ADMIN"], "devices":["/dev/net/tun"],
#     "env":["TS_AUTHKEY"]
#   * claude-container >= 1.7.0 (older launchers ignore devices/capabilities)
#
# TS_AUTHKEY should be EPHEMERAL and tagged, so each container self-reaps its
# node on exit instead of littering the tailnet. Export it before launching:
#     export TS_AUTHKEY=tskey-auth-...
#
# Nothing here is fatal: a missing key or missing kernel support logs and returns
# 0 so container startup continues — most work doesn't need the tailnet.
#
# Optional env:
#   TS_HOSTNAME_PREFIX   node-name prefix in the admin console (default: claude)
#   TS_EXTRA_UP_ARGS     extra args appended to `tailscale up` (advanced)

set -uo pipefail

TS_SOCK=/var/run/tailscale/tailscaled.sock
TS_STATE=/var/lib/tailscale/tailscaled.state
PREFIX="${TS_HOSTNAME_PREFIX:-claude}"

log() { printf 'tailscale: %s\n' "$*"; }

if [ -z "${TS_AUTHKEY:-}" ]; then
    log "TS_AUTHKEY is not set — skipping the tailnet join."
    log "  export an ephemeral, tagged key before claude-container:"
    log "    export TS_AUTHKEY=tskey-auth-...   (see SKILL.md for how to mint one)"
    exit 0
fi

if ! command -v tailscale >/dev/null 2>&1; then
    log "tailscale is not in this image — add Dockerfile.snippet and relaunch claude-container."
    exit 0
fi

# The launcher only passes --device/--cap-add from overlay.json on >= 1.7.0, and
# the Docker engine's VM has to expose the TUN node in the first place. Both fail
# the same way at `tailscale up`, so check up front and say which it is.
if [ ! -c /dev/net/tun ]; then
    log "/dev/net/tun is missing — cannot bring up a tailnet interface."
    log "  needs claude-container >= 1.7.0 (passes overlay.json \"devices\"/\"capabilities\")"
    log "  and a Docker engine whose VM exposes /dev/net/tun."
    exit 0
fi

sudo mkdir -p "$(dirname "$TS_SOCK")" "$(dirname "$TS_STATE")"

if ! pgrep -x tailscaled >/dev/null 2>&1; then
    log "starting tailscaled"
    # SC2024 (sudo doesn't affect redirects) is fine: /tmp is world-writable, so
    # the invoking user's shell opens the log and tailscaled inherits the fd as
    # root. Piping to `sudo tee` instead would cost us the daemon's pid.
    # shellcheck disable=SC2024
    sudo tailscaled \
        --state="$TS_STATE" \
        --socket="$TS_SOCK" \
        --tun=tailscale0 \
        >/tmp/tailscaled.log 2>&1 &
fi

for _ in $(seq 1 50); do
    [ -S "$TS_SOCK" ] && break
    sleep 0.2
done
if [ ! -S "$TS_SOCK" ]; then
    log "tailscaled did not come up within 10s; see /tmp/tailscaled.log"
    exit 0
fi

# Name the node after the workspace instance (the launcher sets
# CLAUDE_SERVICE_INSTANCE to the workspace basename, so a worktree name identifies
# the node in the admin console). Tailscale hostnames are DNS labels: lowercase,
# alphanumeric and dashes.
instance="${CLAUDE_SERVICE_INSTANCE:-$(hostname)}"
slug="$(printf '%s' "$instance" | tr '[:upper:]' '[:lower:]' | tr '_' '-' | tr -cd 'a-z0-9-' | cut -c1-40)"
slug="${slug:-container}"

# --accept-dns=false is deliberate: tailscaled would otherwise rewrite
# /etc/resolv.conf and cost us Docker's embedded DNS (how the container resolves
# sidecars/services). MagicDNS peer names are mapped into /etc/hosts below
# instead. --accept-routes lets subnet routes through.
log "joining the tailnet as ${PREFIX}-${slug}"
# SC2086: TS_EXTRA_UP_ARGS is intentionally word-split into separate flags.
# shellcheck disable=SC2086
if ! sudo tailscale --socket="$TS_SOCK" up \
        --authkey="$TS_AUTHKEY" \
        --hostname="${PREFIX}-${slug}" \
        --accept-routes \
        --accept-dns=false \
        --timeout=60s \
        ${TS_EXTRA_UP_ARGS:-}; then
    log "tailscale up failed; see /tmp/tailscaled.log"
    exit 0
fi

# Map peers into /etc/hosts so short names work without MagicDNS. Rebuilt from
# live status on every start, so a peer that changes address stays reachable.
status_file="$(mktemp)"
# SC2024 again: mktemp created the file as the invoking user; only `status` needs root.
# shellcheck disable=SC2024
if sudo tailscale --socket="$TS_SOCK" status --json > "$status_file" 2>/dev/null; then
    sudo python3 - "$status_file" <<'PY'
import json, pathlib, sys

BEGIN = "# BEGIN claude-container tailnet peers"
END = "# END claude-container tailnet peers"

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
nodes = list((data.get("Peer") or {}).values())
if data.get("Self"):
    nodes.append(data["Self"])

entries = []
for node in nodes:
    ips = node.get("TailscaleIPs") or []
    dns = (node.get("DNSName") or "").rstrip(".")
    if not ips or not dns:
        continue
    short = dns.split(".")[0]
    names = [dns] if short == dns else [dns, short]
    entries.append(f"{ips[0]}\t{' '.join(names)}")

hosts = pathlib.Path("/etc/hosts")
kept, in_block = [], False
for line in hosts.read_text().splitlines():
    if line == BEGIN:
        in_block = True
        continue
    if line == END:
        in_block = False
        continue
    if not in_block:
        kept.append(line)

if entries:
    kept += [BEGIN] + sorted(entries) + [END]
hosts.write_text("\n".join(kept) + "\n")
print(f"tailscale: mapped {len(entries)} tailnet peer(s) into /etc/hosts")
PY
else
    log "could not read tailnet status; peer names are not in /etc/hosts (tailnet IPs still work)"
fi
rm -f "$status_file"

log "up — peers reachable by tailnet IP and by their short names"
