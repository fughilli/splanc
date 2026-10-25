---
name: tailnet
description: Put a claude-container on the user's Tailscale tailnet so the agent can reach tailnet-only peers (SSH targets, HITL/bench rigs, private HTTP services, other nodes). Use when a task needs to reach a host that only accepts tailnet peers, when `ssh`/`curl` to a private name times out from the container, or when setting up a new project that must talk to tailnet-only infrastructure. Wires a Dockerfile fragment + overlay.json capabilities + a per-container join script, and reads an ephemeral TS_AUTHKEY.
---

# tailnet: join a claude-container to Tailscale

A claude-container has no network identity on the user's private tailnet, so any
peer that accepts **tailnet peers only** (a bench rig, a private box you `ssh`
into, an internal HTTP service) is unreachable — `ssh`/`curl` just time out. This
skill joins the container to the tailnet at startup, names the node after the
workspace, and maps peer names into `/etc/hosts` so short names resolve.

It is a **wiring procedure**, not a one-file drop: three container-overlay pieces
must agree (an image layer, runtime capabilities, and a startup join). The skill
bundles the reusable pieces and this file tells you how to install them into a
project's `.claude-container-overlay/`.

## Bundled files (travel with this skill)

- `Dockerfile.snippet` — installs the tailscale client into the image.
- `tailnet-up.sh` — starts `tailscaled` and joins the tailnet per container,
  then rebuilds the `/etc/hosts` peer block. Project-independent.

## Install into a project (three pieces, all required)

1. **Image layer — append `Dockerfile.snippet` to the overlay Dockerfile:**
   ```sh
   cat "$THIS_SKILL_DIR/Dockerfile.snippet" >> .claude-container-overlay/Dockerfile
   ```
   Match the distro codename in the snippet to the base image (`noble` = Ubuntu
   24.04; check the base image and adjust if needed). The daemon can't live in an
   image layer, so the snippet only installs the client — the join happens at
   runtime in step 3.

2. **Runtime privileges — add to `.claude-container-overlay/overlay.json`:**
   ```json
   {
     "capabilities": ["NET_ADMIN"],
     "devices": ["/dev/net/tun"],
     "env": ["TS_AUTHKEY"]
   }
   ```
   Merge these into any existing keys (don't clobber `services`/`ports`).
   - `NET_ADMIN` + `/dev/net/tun` let tailscaled create the `tailscale0`
     interface. Needs **claude-container >= 1.7.0** (older launchers silently
     ignore `devices`/`capabilities`, and the join then fails at `tailscale up`).
   - `env: ["TS_AUTHKEY"]` forwards the key **by name**: its value comes from the
     launching shell and never lands in the container's argv or image.

3. **Startup join — copy `tailnet-up.sh` next to the overlay `startup.sh` and
   call it.** If the project has no `startup.sh`, create one:
   ```sh
   #!/usr/bin/env bash
   set -uo pipefail
   "$(dirname "$0")/tailnet-up.sh"
   ```
   If it already has one, add that call (early, but after anything that must run
   even without a tailnet). `startup.sh` runs once per container start as the
   mapped user with passwordless sudo. Requires claude-container >= 1.7.0.

## The auth key (user provides it)

`tailnet-up.sh` reads `TS_AUTHKEY`. You can't mint it — tell the user to:

1. In the Tailscale admin console → **Settings → Keys → Generate auth key**.
2. Make it **Ephemeral** (the node self-reaps when the container exits, so
   containers don't litter the tailnet) and **Reusable** if they launch often.
   Tagging it (e.g. `tag:ci`) is recommended so ACLs can scope what it reaches.
3. Export it before launching, so it's forwarded by name:
   ```sh
   export TS_AUTHKEY=tskey-auth-...
   claude-container
   ```
   For an automated/daemon launcher, source it from that system's secret store
   into the environment — never bake it into the image or commit it.

A missing key is **not** an error: `tailnet-up.sh` logs and continues, so the
session still opens (most work doesn't need the tailnet).

## Verify it worked

After launch, from inside the container:
```sh
tailscale --socket=/var/run/tailscale/tailscaled.sock status   # lists peers
ping -c1 <peer-short-name>                                      # /etc/hosts entry
ssh user@<peer>                                                 # reach a tailnet host
```
The startup log prints `tailscale: up — ...` and how many peers it mapped. If it
says `TS_AUTHKEY is not set`, the key wasn't exported. If `tailscale up failed`,
check `/tmp/tailscaled.log`; the usual cause is a launcher older than 1.7.0 or a
Docker engine whose VM doesn't expose `/dev/net/tun`.

## Gotchas baked into the script (don't "fix" them)

- **`--accept-dns=false` is deliberate.** Letting tailscaled rewrite
  `/etc/resolv.conf` breaks Docker's embedded DNS (how the container resolves
  service sidecars). Instead the script maps MagicDNS peer names into a managed
  `/etc/hosts` block, rebuilt from live status on every start.
- **Node name** = `${TS_HOSTNAME_PREFIX:-claude}-<workspace-slug>`. Set
  `TS_HOSTNAME_PREFIX` in `startup.sh` before the call to brand nodes per project.
- **Non-fatal everywhere.** Every failure path returns 0 so a tailnet hiccup
  never blocks the session.

## Optional: mirror the setup in CI

If the project's CI also needs the tailnet, use the official
`tailscale/github-action` (or `tailscale up --authkey=...` with a CI secret) as
the CI equivalent of `tailnet-up.sh` — same ephemeral-tagged-key discipline.
