#!/usr/bin/env bash
# ==============================================================================
# setup-attic.sh — Attic nix binary cache as its OWN tailnet node (tag:attic),
# fully containerized, data on named volumes.
#
# Design (learned the hard way):
#   * All containers — no macOS-native process (avoids TCC on /Volumes).
#   * Named volumes for the cache DB/chunks + tailscale state — coherent writes
#     (colima can't write-back a container's writes to an external /Volumes mount)
#     and they PERSIST across container + colima restarts (only `colima delete` or
#     `docker volume rm` clears them).
#   * A tailscale SIDECAR joins the tailnet as node "<NODE>" with a dedicated,
#     tag:attic-tagged auth key; atticd + caddy + the dashboard share its network
#     namespace, so they're reachable at <NODE>.<tailnet>.ts.net and scoped by ACLs.
#   * TOKENLESS PUSH via a Caddy proxy: atticd derives all authorization from the
#     request's Authorization header (a public cache grants anonymous PULL only —
#     there is no anonymous-push mode). Caddy owns the public :8080, injects a fixed
#     bearer (the shared push token) on every request, and proxies to atticd on
#     :8083 — so any client on the tailnet pushes with NO token of its own, and the
#     tag:attic ACL is the sole access boundary.
#   * Config is BAKED into the image (COPY) — no bind mount, so colima's mount
#     quirks can't touch it.
#
# PREREQUISITES — in the tailscale admin console (one-time):
#   1. Access Controls (policy): add to "tagOwners":
#          "tag:attic": ["autogroup:admin"]
#   2. Settings → Keys → Generate auth key → tick "Tags: tag:attic" (reusable is
#      handy). Copy it.
#   3. (optional) ACL grants to scope who may reach tag:attic (e.g. only your rigs +
#      the claude container).
#
# Run:  TS_AUTHKEY=tskey-… ATTIC_DRIVE=unused ./setup-attic.sh
#       (ATTIC_DRIVE is ignored now — data lives in a named volume.)
# Re-run-safe.
# ==============================================================================
set -euo pipefail

STACK_DIR="${ATTIC_STACK_DIR:-$HOME/attic-cache}"
CACHE_NAME="${ATTIC_CACHE:-splanc}"
NODE="${ATTIC_NODE:-attic}"                         # tailnet hostname → <NODE>.<tailnet>.ts.net
TOKEN_VALIDITY="${ATTIC_TOKEN_VALIDITY:-10 years}"

say(){ printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die(){ printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "docker not found (brew install docker docker-compose colima)."
docker info >/dev/null 2>&1 || die "docker daemon unreachable — start it: colima start"

# Retire the previous NATIVE approach (launchd atticd/dashboard + tailscale serve),
# so it doesn't hold :8080 or double-serve. Best-effort.
launchctl bootout "gui/$(id -u)/rs.attic.atticd" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/rs.attic.dashboard" 2>/dev/null || true
tailscale serve --https=443 off 2>/dev/null || true

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$STACK_DIR/config"

# ---- .env (secret + tailscale key) -------------------------------------------
ENV_FILE="$STACK_DIR/.env"; touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
get_env(){ grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-; }
set_env(){ if grep -qE "^$1=" "$ENV_FILE"; then sed -i '' "s|^$1=.*|$1=$2|" "$ENV_FILE"; else printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"; fi; }

SECRET="$(get_env ATTIC_SERVER_TOKEN_HS256_SECRET_BASE64)"
[ -n "$SECRET" ] || { SECRET="$(openssl rand -base64 64 | tr -d '\n')"; set_env ATTIC_SERVER_TOKEN_HS256_SECRET_BASE64 "$SECRET"; say "generated signing secret"; }
TS_AUTHKEY="${TS_AUTHKEY:-$(get_env TS_AUTHKEY)}"
[ -n "$TS_AUTHKEY" ] || die "Need a tag:attic-tagged tailscale auth key. See PREREQUISITES at top, then: TS_AUTHKEY=tskey-… $0"
set_env TS_AUTHKEY "$TS_AUTHKEY"

# ---- atticd config (baked into the image) ------------------------------------
# atticd listens INTERNAL-only (8083) in the shared netns; the Caddy proxy owns the
# public 8080 and injects the Authorization header (tokenless push — see below).
cat > "$STACK_DIR/config/atticd.toml" <<'TOML'
listen = "127.0.0.1:8083"
[database]
url = "sqlite:///data/server.db?mode=rwc"
[storage]
type = "local"
path = "/data/storage"
[chunking]
nar-size-threshold = 65536
min-size = 16384
avg-size = 65536
max-size = 262144
[compression]
type = "zstd"
[garbage-collection]
interval = "12 hours"
default-retention-period = "6 months"
TOML
cp "$SRC_DIR/attic-dashboard.py" "$STACK_DIR/attic-dashboard.py"

# ---- Dockerfiles -------------------------------------------------------------
cat > "$STACK_DIR/Dockerfile.atticd" <<'DOCKER'
FROM nixos/nix:latest
RUN printf 'experimental-features = nix-command flakes\n' >> /etc/nix/nix.conf
RUN nix profile install 'github:zhaofengli/attic#attic-server' 'github:zhaofengli/attic#attic-client' --accept-flake-config \
 || nix profile install 'github:zhaofengli/attic' --accept-flake-config
COPY config/atticd.toml /etc/atticd.toml
ENTRYPOINT ["sh","-c"]
CMD ["mkdir -p /data/storage && exec atticd -f /etc/atticd.toml"]
DOCKER

cat > "$STACK_DIR/Dockerfile.dashboard" <<'DOCKER'
FROM python:3-slim
RUN apt-get update && apt-get install -y --no-install-recommends coreutils && rm -rf /var/lib/apt/lists/*
COPY attic-dashboard.py /app/dashboard.py
CMD ["python3","/app/dashboard.py"]
DOCKER

# ---- TOKENLESS push proxy ----------------------------------------------------
# atticd has no anonymous-push mode: authorization is derived entirely from the
# request's `Authorization: Bearer <jwt>` header (a public cache grants anonymous
# PULL only). So a header-injecting reverse proxy IS the tokenless-push mechanism —
# Caddy owns the public :8080, injects a fixed bearer (the shared push token) on
# every request, and proxies to atticd on :8083. Any client on the tailnet then
# pushes with NO token of its own; the tag:attic ACL is the only access boundary.
# The token is read from $PUSH_TOKEN at config-load; the Caddyfile carries no secret.
cat > "$STACK_DIR/Caddyfile" <<'CADDY'
{
	admin off
	auto_https off
}
:8080 {
	reverse_proxy 127.0.0.1:8083 {
		header_up Authorization "Bearer {$PUSH_TOKEN}"
	}
}
CADDY
cat > "$STACK_DIR/Dockerfile.caddy" <<'DOCKER'
FROM caddy:latest
COPY Caddyfile /etc/caddy/Caddyfile
DOCKER

# ---- compose: tailscale node + atticd + dashboard sharing its netns ----------
cat > "$STACK_DIR/docker-compose.yml" <<COMPOSE
services:
  tailscale:
    image: tailscale/tailscale:latest
    hostname: $NODE
    environment:
      - TS_AUTHKEY=\${TS_AUTHKEY}
      - TS_STATE_DIR=/var/lib/tailscale
      - TS_USERSPACE=false
    volumes:
      - tailscale-state:/var/lib/tailscale
    devices:
      - /dev/net/tun:/dev/net/tun
    cap_add:
      - net_admin
    ports:
      - "127.0.0.1:8080:8080"     # local admin/debug; tailnet access is via the node's :8080
    restart: unless-stopped
  atticd:
    build: { context: ., dockerfile: Dockerfile.atticd }
    image: attic-local:latest
    network_mode: service:tailscale
    environment:
      - ATTIC_SERVER_TOKEN_HS256_SECRET_BASE64=\${ATTIC_SERVER_TOKEN_HS256_SECRET_BASE64}
    volumes:
      - attic-data:/data
    depends_on: [tailscale]
    restart: unless-stopped
  caddy:
    build: { context: ., dockerfile: Dockerfile.caddy }
    image: attic-caddy:latest
    network_mode: service:tailscale
    environment:
      - PUSH_TOKEN=\${PUSH_TOKEN:-}     # injected as the fixed bearer; set after the token is minted
    depends_on: [atticd]
    restart: unless-stopped
  dashboard:
    build: { context: ., dockerfile: Dockerfile.dashboard }
    image: attic-dashboard:latest
    network_mode: service:tailscale
    environment:
      - ATTIC_DB=/data/server.db
      - ATTIC_STORAGE=/data/storage
      - ATTIC_DASH_PORT=8081
    volumes:
      - attic-data:/data
    depends_on: [atticd]
    restart: unless-stopped
volumes:
  tailscale-state:
  attic-data:
COMPOSE

cd "$STACK_DIR"
say "building + starting (tailscale + atticd + caddy + dashboard)…"
docker compose up -d --build

say "waiting for atticd (via the caddy proxy on :8080)…"
for i in $(seq 1 40); do
  curl -s -o /dev/null --max-time 3 http://localhost:8080/ && break
  sleep 2; [ "$i" = 40 ] && { docker compose logs --tail 30 atticd caddy tailscale; die "atticd didn't come up"; }
done
say "atticd up ✓"

# ---- token + cache + make public --------------------------------------------
# Admin ops talk to atticd DIRECTLY on :8083 (bypassing caddy, which may not yet
# carry the token on this first run).
TOKEN="$(docker compose exec -T atticd atticadm -f /etc/atticd.toml make-token \
          --sub host --validity "$TOKEN_VALIDITY" --pull '*' --push '*' --create-cache '*' --configure-cache '*' --destroy-cache '*' \
          2>/dev/null | tr -d '\r' | tail -1)"
docker compose exec -T atticd sh -c "attic login self http://localhost:8083 '$TOKEN' >/dev/null 2>&1; attic cache create $CACHE_NAME >/dev/null 2>&1 || true"
# make public via SQLite (the client's --public panics on this atticd version); the
# dashboard image has python3+sqlite3 and the same volume. busy_timeout rides atticd's WAL writer.
docker compose exec -T dashboard python3 -c "
import sqlite3,sys
c=sqlite3.connect('/data/server.db',timeout=10); c.execute('PRAGMA busy_timeout=8000')
try:
    c.execute(\"UPDATE cache SET is_public=1 WHERE name='$CACHE_NAME'\"); c.commit(); print('public ✓')
except Exception as e: print('public toggle failed:',e, file=sys.stderr)
" 2>&1 | tail -1 || true
PUBKEY="$(docker compose exec -T atticd sh -c "attic cache info $CACHE_NAME 2>/dev/null" | awk -F': +' '/Public Key/{print $2}' | tr -d '\r')"
TSNAME="$(docker compose exec -T tailscale tailscale status --json 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || echo "$NODE.<your-tailnet>.ts.net")"

# Persist the token (for reference / direct-to-atticd use) and — the point of the
# proxy — hand it to caddy as the injected bearer, so tailnet clients push TOKENLESS.
printf '%s\n' "$TOKEN" > "$STACK_DIR/push-token"; chmod 600 "$STACK_DIR/push-token"
set_env PUSH_TOKEN "$TOKEN"
say "wiring the push token into the caddy proxy…"
docker compose up -d caddy >/dev/null 2>&1        # recreate caddy with PUSH_TOKEN set
sleep 2

cat <<EOF

============================================================================
  Attic is up as tailnet node: $TSNAME   (tag:attic — scope it with ACLs)
  Data: docker named volumes attic-data + tailscale-state (persist restarts)
  Manage:  cd $STACK_DIR && docker compose {logs -f,restart,down,up -d}
============================================================================

  Cache:     http://$TSNAME:8080/$CACHE_NAME
  Dashboard: http://$TSNAME:8081

PULL — public cache, no token (add to nix.conf / a flake's nixConfig):
  extra-substituters        = http://$TSNAME:8080/$CACHE_NAME
  extra-trusted-public-keys = $PUBKEY

PUSH — TOKENLESS (the caddy proxy injects the shared bearer; tag:attic ACL is the
only boundary). Any machine on the tailnet, no login:
  attic login $NODE http://$TSNAME:8080          # NO token argument
  attic push $CACHE_NAME /run/current-system     # e.g. warm from a rig

  Shared token (only needed to bypass the proxy / re-seed it): $STACK_DIR/push-token
============================================================================
EOF
