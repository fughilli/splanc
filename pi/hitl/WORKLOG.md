# HITL rig — worklog

Handoff notes alongside git history. Newest first. Read this before touching the
rig's networking — there's live runtime state that isn't fully declarative yet.

## 2026-08-05 — deflake e2e provisioning (FUG-61): retry the BLE connect

Looping the e2e against the rig reproduced the CI flake at **20% run-level
failure** (2/10 runs failed outright) with the **first provision attempt failing
~50% of the time**. Every failure was a message-less `TimeoutError:` at the BLE
**connect** — the provisioner log never reached `connected=True`. Root cause: the
single-core C6 shares one radio between WiFi and BLE, so the first `BleakClient`
connect right after a (re)boot routinely times out during coexistence bring-up.

The old `provision_dut` recovery rebooted the DUT and tried the connect **once**
per reboot; with the connect flaking independently each try, a run could lose that
coin-flip on all three reboots (seen twice in ten) — that is the CI "timeout
during provisioning". The CI "attempt 1 saw only the MAC, no name" is the same
early-pounce: the firmware advertises the name in the **scan response** (only the
Improv service UUID rides in the primary ADV, `improv_ble.cpp`), so a name-less
match means the board was caught mid-advertise.

Fix (`pi/hitl/harness`, no rig redeploy — these files are scp'd per run):

- `hitl_improv.py` `_connect()`: retry the connect up to 5× **within one
  attempt** (same boot, no reboot; 12 s each + backoff; tear down half-open links
  between tries). Rapid reconnects ride out the coexistence window far more
  reliably and cheaply than reboot-gated single tries.
- `hitl_improv.py` `find()`: prefer a device advertising a resolved **name**,
  re-scanning briefly for the scan response before falling back to a name-less
  hit — so we connect to a board that's actually up.
- Report the real transport error (`BLE transport failed: …`) instead of the
  bare `TimeoutError:`.
- `provision.py`: widen the per-attempt ssh budget to cover the in-attempt
  retries; the outer reset+retry stays as a last-resort backstop.

Method note (for the next agent reproducing on hardware): run the built binary
directly in a loop rather than `bazel run … | tee | tail` (that pipeline buffers
and can drop the result). Also, `-c opt` vs a stray non-opt `bazel` command flaps
the `bazel-bin` convenience symlink — pin the `aarch64-opt/bin/...` path.

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

### RESOLVED: container→DUT reject (was blocking the e2e WS check + agents poking the DUT)

The e2e's WS check tunnels from the agent's container to the DUT via `hitl forward`
(ssh -L; the far end dials the DUT **from the reservation container**). The
container could not reach the DUT at all — root-caused with an `nft monitor trace`:

- **NetworkManager's shared mode** (`ipv4.method=shared`) installs a private
  native-nft table `nm-shared-<iface>` whose `filter_forward` chain ends in
  `iifname "wlan0" reject` / `oifname "wlan0" reject`. That catch-all **rejects
  every NEW connection forwarded INTO the AP subnet** (shared mode expects clients
  to reach OUT, not to be reached). It's a separate native-nft table, so
  `iptables -S` never showed it — the SYN was RST'd before egress (0 packets on
  wlan0). Not the DERP relay, not netavark, not the DUT.
- **Fix (confirmed on hardware):** allow the rig's podman bridge → the AP iface,
  inserted **before** the reject inside NM's own chain:
  `nft insert rule ip nm-shared-wlan0 filter_forward iifname "podman0" oifname "wlan0" accept`
  → `container→DUT:443` then does a full TLS handshake (`TLSv1.2`).
- NM regenerates that table only when the **AP connection (re)activates** — NOT on
  container start/stop or DUT (dis)association (all tested; the rule survives them).
  So a **NetworkManager dispatcher script** (in `hitl-app.nix`) re-inserts the rule
  on the AP's `up`/`dhcp4-change`/`connectivity-change` events, idempotently.
- The DUT serves **wss :443** only (`:80`/`:81` are dead on the STA iface), so the
  e2e defaults to `--ws-scheme wss`.

Alternative if the dispatcher ever proves flaky: drop `ipv4.method=shared` and run
our own DHCP (`services.dnsmasq`, port=0) + `networking.nat` on wlan0 → no
`nm-shared` table, forwarding governed by the (permissive) NixOS FORWARD chain.

### KNOWN OPEN ITEM: the DUT doesn't reliably stay associated to the AP

Separate from the fix above: the ESP32-C6 intermittently **drops off the AP**
(`iw dev wlan0 station dump` → 0 stations; `rig→DUT` goes dead), and a bare
`--reset` sometimes lands it in its own soft-AP (`ledmapper`) instead of rejoining.
This — plus flaky BLE provisioning (wifi+BLE coexistence on the combo chip) — made
full-e2e verification painful and is likely why some WS runs failed even with the
forward fix in place. Worth chasing on the firmware/RF side (power-save? fixed
channel 6 interference?), and it matters for real use (agents need the DUT to stay
joined). The forward fix itself is verified at the reachability layer regardless.

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
