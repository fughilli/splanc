# HITL rig — worklog

Handoff notes alongside git history. Newest first. Read this before touching the
rig's networking — there's live runtime state that isn't fully declarative yet.

## 2026-08-03 — self-hosted provisioning AP (+ tag discovery, CLI-driven e2e)

### What this adds

The rig hosts **its own WiFi AP** so a DUT (ESP32-C6) is ImprovBLE-provisioned onto
the rig itself — no dependence on a nearby WiFi network. Plus two supporting
changes: the `hitl` CLI discovers rigs by the `tag:splanc-hitl` tailnet tag, and
the Python e2e harness now shells out to the `hitl` CLI for everything (reserve /
flash / cp / run / forward) instead of reimplementing reservation in Python.

- Daemon serves the AP creds in `/status`; `hitl wifi` prints them; the e2e uses
  them automatically (no `--wifi-ssid` needed).
- e2e default WS scheme is now **wss (:443)** — that's the device's real TLS
  player socket; the plain `:81` isn't functional on the STA interface.

### Networking: Ethernet uplink + dedicated always-on AP (current, robust)

The rig's uplink is **Ethernet (`end0`)**, so the onboard WiFi radio (`wlan0`) is a
**dedicated, always-on 2.4 GHz AP** — NM profile `hitl-ap`, `autoconnect=true`,
`autoconnect-priority=999`, fixed **channel 6**, `ipv4.method=shared` (dnsmasq DHCP

- NAT on `10.42.0.0/24`, NAT'd out via Ethernet). No STA on `wlan0`, so none of the
  single-radio fragility below. This is the intended setup (`nix/hitl-app.nix`).

⚠️ **Live runtime state not captured in nix (clean this up):**

- The STA profile `seed-CoolerKids` was **deleted at runtime** (`nmcli con delete`)
  so it wouldn't fight the AP for `wlan0`. Baked STA profiles (`sbc-wifi-*` from
  `wifi.yaml`) still exist but aren't in range; the AP's priority 999 wins `wlan0`
  regardless. A future cleanup should make "wlan0 is AP-only" fully declarative
  (e.g. stop baking STA profiles on this rig).
- If Ethernet is unplugged, the rig has **no WiFi uplink** (by design) — it'd be
  unreachable until WiFi STA is re-added.

### The STA+AP-on-one-radio workaround (SUPERSEDED — history for context)

Before Ethernet, we ran **concurrent AP+STA on the single radio**. It works but is
fragile, and the workaround is worth knowing if anyone revisits a WiFi-uplink rig:

- Single radio ⇒ `#channels ≤ 1` ⇒ the AP is **co-channel with the STA**. The C6 is
  2.4-only, so the STA (hence the AP) had to be on 2.4 GHz.
- `wifi.band=bg` constrains the **initial** connect but **not roaming** — on a
  dual-band network (e.g. CoolerKids) wpa_supplicant roamed to 5 GHz and dragged
  the AP with it, so the C6 couldn't join. The AP's own ACS also prefers 5 GHz.
- The workaround that actually held 2.4: **lock the STA to a specific 2.4 GHz
  BSSID** (`nmcli con modify <sta> 802-11-wireless.bssid <ch-9-AP-MAC> band bg`),
  which pins the channel and forces the co-channel AP to 2.4. It worked but is
  location-specific (tied to one AP's MAC) — Ethernet removes the need entirely.
- The per-reservation AP machinery from that era is **retained but dormant**:
  `internal/ap` (on-demand `iw` vif creation on the STA's PHY + `nmcli` toggle),
  `queue.WithAP`, and the daemon's `--ap-conn/--ap-iface/--iw/--ip` flags. It's NOT
  wired in the current config (no `--ap-conn`); kept for the future multi-DUT design
  (per-reservation AP-per-DUT). The daemon serves creds via `--ap-ssid/--ap-psk`
  independent of that path.

### KNOWN OPEN ITEM: container→DUT unreachable (blocks the e2e WS check + agents poking the DUT)

The e2e's WS check tunnels from the agent's container to the DUT via `hitl forward`
(ssh -L; the far end dials the DUT **from the reservation container**). Flashing,
provisioning, and join all work, but **the reservation container cannot reach the
DUT at all**, so the WS check fails (and agents can't poke the device yet). This is
NOT the DERP relay (still fails on Ethernet) and NOT the DUT.

Isolated on hardware (AP always-on, so the DUT stays joined at `10.42.0.138`):

- rig host → `10.42.0.138:443` → **HTTP 200** (works; the DUT serves **wss :443**
  only — `:80`/`:81` are dead, hence the e2e now defaults to `--ws-scheme wss`).
- reservation container → `10.42.0.1:53` (AP gateway = host's wlan0) → **OK**.
- reservation container → `10.42.0.138:*` (a _wireless client_ on the AP) →
  **immediate `ECONNREFUSED`**, and `tcpdump -i wlan0` shows **the SYN never
  egresses wlan0**. So the host rejects the _forwarded_ container→AP-client path
  before it hits the air.
- FORWARD is default-ACCEPT; `NETAVARK_FORWARD` ACCEPTs `-s 10.88.0.0/16`; no
  REJECT-with-reset is visible — yet the RST is immediate. Suspects:
  `NETAVARK_ISOLATION_*` (`-o podman0 -j DROP`) on the return path, and/or how
  netavark masquerades podman→wlan0 into an NM `ipv4.method=shared` subnet.

Fix directions to try (didn't get to it):

1. Run the reservation container with **host networking** (or attach it to the AP
   subnet) so it reaches the DUT the way the rig host does — simplest, but changes
   the container's isolation model (see `internal/runner/podman.go`).
2. Dial the tunnel's far end from the **host netns** instead of the container.
3. An explicit podman↔wlan0-AP-subnet ACCEPT/route, if a specific DROP is found
   (needs a packet-level trace of the RST source; tcpdump is on the rig).

### Rig access (for the next agent — this was a time sink)

- **tailscale SSH:** `ssh root@hitl-rig` works now that the tailnet ACL has an
  `ssh` grant for `autogroup:member → tag:splanc-hitl` with `users:["root",...]`
  and `action:"accept"` (NOT `"check"` — headless can't browser-auth).
- **deploy key over LAN:** `ssh -i pi/secrets/deploy_key root@hitl-rig.local` also
  works (mDNS → real sshd), but mDNS from a container is flaky; the tailnet name
  hits tailscale-SSH (needs the ACL). `hitl-rig` (tailnet) ≠ `hitl-rig.local` (LAN).
- **daemon on the rig:** `curl http://localhost:8087/status` (+ `/reservation/<id>/
release`) is the reliable way to inspect/free the rig when the tailnet CLI path
  is timing out.

### Gotchas

- **BLE provisioning is intermittently flaky** (~half the runs `TimeoutError`) —
  wifi+BLE coexist on the Pi combo chip; worse under concurrent AP+STA. Retry.
  Ethernet (radio does only AP now) may reduce this — re-check.
- A `hitl-flash --erase-fs` wipes the DUT's saved WiFi creds; after that only a
  fresh ImprovBLE provision (not a bare reset) rejoins it.
- The DUT brings up its wss `:443` server only after a real provision, not a bare
  reset-rejoin.

### Verify

- In-container: `bazel test //pi/hitl/internal/... //pi/hitl/tests:hitl_test`.
- On hardware (after `bazel run //pi/hitl:hitl.deploy_live -- hitl-rig`):
  `hitl wifi` prints the SSID/PSK; `nmcli` on the rig shows `hitl-ap:wlan0:activated`
  on channel 6; `bazel run //pi/hitl/harness:e2e` flashes → provisions the DUT onto
  `hitl-<hostname>` → checks time-sync/rename over wss.
