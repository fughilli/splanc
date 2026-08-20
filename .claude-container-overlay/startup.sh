#!/usr/bin/env bash
#
# claude-container overlay startup hook — runs once per container start, just
# before Claude, as the mapped non-root user (root via the passwordless sudo the
# overlay Dockerfile installs). Requires claude-container >= 1.7.0; older
# launchers ignore this file entirely.
#
# Joins the container to the tailnet so the HITL rigs are reachable. The rigs
# accept tailnet peers only (pi/hitl/DESIGN.md "Security"), so without this
# `hitl reserve|flash|monitor` and //pi/hitl/harness:e2e fail from a container —
# and issuefleet workers run in exactly this container. The CI equivalent is the
# "Join the tailnet" step in .github/workflows/hitl.yaml.
#
# Companion settings in overlay.json, all three needed:
#   "capabilities": ["NET_ADMIN"]   to create the tailscale0 interface
#   "devices": ["/dev/net/tun"]     the TUN device it is built on
#   "env": ["TS_AUTHKEY"]           forwarded BY NAME, so the key's value comes
#                                   from the launching environment and never
#                                   lands in the container's argv
#
# TS_AUTHKEY should be EPHEMERAL and tagged, like the CI key: each container
# then self-reaps its node on exit instead of littering the tailnet. issuefleet
# workers get it from the daemon's secret config; interactively, export it
# before running claude-container.
#
# Missing key or missing kernel support is NOT fatal — the session continues
# without a tailnet, since most work in this repo doesn't need the rigs.

set -uo pipefail

# ---------------------------------------------------------------------------
# Presubmit lint gate (FUG-63)
#
# Wire the repo's prek hooks into THIS worktree's git before anything else, so
# every `git commit` runs .pre-commit-config.yaml and fails in-container when a
# lint is red. Lints were frequently landing broken on proposed PRs because
# agents never ran them; this makes a failing lint immediate and unmissable —
# and since the orchestrator only pushes committed work, a commit that succeeds
# is a commit whose lints passed.
#
# Runs FIRST, ahead of the tailnet block below, because that block `exit`s early
# in the common no-authkey path and would otherwise skip this entirely.
#
# `prek install` writes the git shim and is instant. Building the hook
# ENVIRONMENTS is the slow part (~40s cold: black/isort/flake8 venvs, node envs
# for prettier/markdownlint, a rustup toolchain for nixpkgs-fmt), and this hook
# blocks the session opening — so it must never be paid here.
#
# It normally isn't: the overlay Dockerfile bakes that cache into the image at
# $PREK_HOME=/opt/prek-cache, seeded from the copy of .pre-commit-config.yaml in
# this directory. When the workspace config still matches that copy, every
# environment is already prepared and there is nothing to do.
#
# When they differ (someone edited .pre-commit-config.yaml and hasn't relaunched
# into a rebuilt image), prek would rebuild the drifted hooks — so do it
# DETACHED, in the background, and let the session open immediately. A commit
# landing mid-build isn't a problem: prek locks per environment, so the hook run
# waits for the build in flight rather than racing it.
#
# All non-fatal: prek may be absent on an un-rebuilt image, or the network may be
# down with cold caches — neither should abort container startup.
prek_log() { printf 'prek: %s\n' "$*"; }
PREK_BAKED_CONFIG=/opt/prek-seed/.pre-commit-config.yaml
if command -v prek >/dev/null 2>&1; then
    if git -C /workspace rev-parse --git-dir >/dev/null 2>&1; then
        prek_log "installing lint hooks into /workspace (every git commit will run the lints)"
        if prek install --allow-missing-config -C /workspace >/tmp/prek-install.log 2>&1; then
            prek_log "git shim installed"
        else
            prek_log "install did not succeed — see /tmp/prek-install.log"
        fi

        if [ -f "$PREK_BAKED_CONFIG" ] \
           && cmp -s "$PREK_BAKED_CONFIG" /workspace/.pre-commit-config.yaml; then
            prek_log "hook environments served from the image's baked cache (${PREK_HOME:-~/.cache/prek})"
        else
            prek_log ".pre-commit-config.yaml differs from the copy baked into this image —"
            prek_log "  preparing the drifted hook environments in the BACKGROUND (log: /tmp/prek-prepare.log)"
            prek_log "  to re-bake: run tools/sync_prek_overlay_config.sh, commit, and relaunch claude-container"
            setsid nohup prek install-hooks -C /workspace >/tmp/prek-prepare.log 2>&1 &
        fi
    else
        prek_log "/workspace is not a git repo — skipping hook install"
    fi
else
    prek_log "prek is not in this image — relaunch claude-container to rebuild the overlay, then hooks won't run on commit"
fi

TS_SOCK=/var/run/tailscale/tailscaled.sock
TS_STATE=/var/lib/tailscale/tailscaled.state

log() { printf 'tailscale: %s\n' "$*"; }

if [ -z "${TS_AUTHKEY:-}" ]; then
    log "TS_AUTHKEY is not set — skipping the tailnet join (the HITL rigs will be unreachable)."
    log "  interactive:  export TS_AUTHKEY=<ephemeral key>  before claude-container"
    log "  issuefleet:   set tailscale_authkey in the daemon's secret config"
    exit 0
fi

if ! command -v tailscale >/dev/null 2>&1; then
    log "tailscale is not in this image — relaunch claude-container to rebuild the overlay."
    exit 1
fi

# The launcher only passes --device/--cap-add from overlay.json on >= 1.7.0, and
# Docker Desktop's VM has to expose the TUN node in the first place. Both fail
# the same way at `tailscale up`, so check up front and say which it is.
if [ ! -c /dev/net/tun ]; then
    log "/dev/net/tun is missing — cannot bring up a tailnet interface."
    log "  needs claude-container >= 1.7.0 (it passes overlay.json's \"devices\"/\"capabilities\"),"
    log "  and a Docker engine whose VM exposes /dev/net/tun."
    exit 1
fi

sudo mkdir -p "$(dirname "$TS_SOCK")" "$(dirname "$TS_STATE")"

if ! pgrep -x tailscaled >/dev/null 2>&1; then
    log "starting tailscaled"
    # SC2024 (sudo doesn't affect redirects) is fine here and the suggested
    # `| sudo tee` fix would be wrong: /tmp is world-writable, so the invoking
    # user's shell opens the log itself and tailscaled inherits the fd as root.
    # Piping instead would put tee at the head of the background job and cost us
    # the daemon's pid.
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
    exit 1
fi

# Name the node after the workspace instance (the launcher sets
# CLAUDE_SERVICE_INSTANCE to the workspace basename, so an issuefleet worker's
# worktree name identifies it in the admin console). Tailscale hostnames are
# DNS labels: lowercase, alphanumeric and dashes.
instance="${CLAUDE_SERVICE_INSTANCE:-$(hostname)}"
slug="$(printf '%s' "$instance" | tr '[:upper:]' '[:lower:]' | tr '_' '-' | tr -cd 'a-z0-9-' | cut -c1-40)"
slug="${slug:-container}"

# --accept-dns=false is deliberate: tailscaled would otherwise rewrite
# /etc/resolv.conf and cost us Docker's embedded DNS, which is how the container
# resolves the claude-proxy sidecar. MagicDNS names are mapped into /etc/hosts
# below instead. --accept-routes matches the CI job.
log "joining the tailnet as led-mapper-${slug}"
if ! sudo tailscale --socket="$TS_SOCK" up \
        --authkey="$TS_AUTHKEY" \
        --hostname="led-mapper-${slug}" \
        --accept-routes \
        --accept-dns=false \
        --timeout=60s; then
    log "tailscale up failed; see /tmp/tailscaled.log"
    exit 1
fi

# Map peers into /etc/hosts so the documented short names work without MagicDNS
# — pi/hitl's docs use `export HITL_SERVER=http://hitl-rig:8087`. Rebuilt from
# live status on every start, so a rig that changes address stays reachable.
status_file="$(mktemp)"
# SC2024 again, same reasoning: mktemp created the file as the invoking user, so
# that user's shell can open it for writing — only `status` itself needs root.
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

log "up — reach a rig with e.g. export HITL_SERVER=http://hitl-rig:8087"
