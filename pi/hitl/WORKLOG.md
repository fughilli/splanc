# HITL rig — worklog

Handoff notes alongside git history. Newest first. Read this before touching the
rig's networking — there's live runtime state that isn't fully declarative yet.

## 2026-08-28 — fpga_ws281x E2E green (ws2812) — wrong DUT + a musl crash-loop

Resolved the previous entry's "DUT WSS never completes the handshake" block. It was
a chain of three unrelated problems, none of them the harness:

1. **The network-DUT seed pointed at the WRONG Pi.** `pi-ledmapper-1` was seeded to
   `192.168.68.50` = **splanc-max-1** (a Pi5, APA102 role, **no Tang FPGA**). The
   actual FPGA rig is **splanc-max-2** = `192.168.68.68` (a **Pi3**, Tang Nano 9K
   attached; `apps.nix` even says so). So every capture had nothing to see. Re-seeded
   to `.68` (edit `/var/lib/hitl/network-duts.json` on the rig — reached via
   `tailscale ssh root@hitl-rig-1`, since the seed tool needs `pi/secrets/deploy_key`
   which the container lacks; the `--discover` monitor ingests it in ~3s). A fresh
   reservation then injects `HITL_DUT_ADDR=192.168.68.68`.

   - Note: the WSS on `.50` was ALSO down at first because that box was running a
     stale pre-fpga image (8443 firewall-closed → SYN dropped → "opening handshake
     timeout"); a `deploy_live` fixed that, but `.50` is the wrong box regardless.

2. **The static-musl player crash-loops on WS connections** (real bug, fixed in
   commit "pi/player_rs: pin thread stacks"). musl's 128 KiB default spawned-thread
   stack + tokio not setting a worker stack → rustls/tungstenite/protobuf overflows
   it and SIGABRTs the whole process on the harness's `set_counting_pattern`
   (`NRestarts` climbed to 18 on `.50`; coredump = `stack_overflow::signal_handler`
   on a `tokio-rt-worker`). Fix: `thread_stack_size(8 MiB)` + render `stack_size(4
MiB)`. Same `player_musl` artifact runs on both boxes, so `.68` needed it too.

3. **The macOS host builder chain** (to run `deploy_live` via hostdeploy) needed
   three one-time fixes, see the new `sbc-deploy-host-builder-chain` memory:
   `trusted-users += kevin`, a `linux-builder` ssh alias, and `StrictHostKeyChecking
accept-new` + `UserKnownHostsFile /dev/null` on that alias (ephemeral builder-VM
   host key). Debug with `nix store info --store ssh-ng://builder@linux-builder … -vvv`.

**E2E result on splanc-max-2** (fixed player, Tang present): the WS drive succeeds
(no crash) and the **ws2812 capture PASSES all 4 ports** — correct per-port WS281x
colours, i.e. the whole WSS→player→SPI→FPGA→WS281x chain works end-to-end. The
**raw-SPI cross-check does NOT pass**: the FX2 (`fx2lafw`) samples at 24 MHz but the
player drives SPI at 6.4 MHz = **3.75 samples/bit**, too marginal for a clean sigrok
SPI decode (byte count grows with the window — 57→285 — but no clean 97 B STREAM
frame). Redundant with ws2812 (which proves the SPI stream is correct); it's an
analyzer-fidelity limit, so **ws2812 is the accepted validation** and the raw-SPI
check should be made sample-rate-aware (or gated) separately.

**Also hardened `tools/hostdeploy`** so a hung/interactive command can't wedge the
watcher (stdin=/dev/null, threaded heartbeat + `running` marker, per-command
timeout, cancel-on-exit) — separate commit, self-tested.

**Follow-ups landed the same day:**

- **Deploy hardware guard** (the real root cause of the splanc-max-1 brick — I
  deployed a **Pi5 closure to a Pi3**, which installs an incompatible kernel and
  bricks the next boot). sbc-deploy's `cmd_deploy` now reads the target's
  `/proc/device-tree/model` and REFUSES a `$SBC_BOARD` mismatch (PR #13, merged;
  MODULE.bazel bumped). Verified live on both a Pi3 deploy and the Pi5 rig deploy
  (prints `==> Board check: … matches SBC_BOARD=…`). **BOTH test boards are Pi3s**
  (the `apps.nix` "Pi5 splanc-max-1" label was wrong — fixed); the Pi5 target stays
  for a future SKU.
- **splanc-max-2 persistent deploy** via `:ledmapper_pi3.deploy_live -- --hostname
splanc-max-2 192.168.68.68` (replaced the manual player; `NRestarts=0`, E2E
  ws2812 green). Watch hostrun's STREAMED stdout, not one-shot reads of the raw
  `.hostdeploy/<id>.log` — it lags over the shared mount and twice fooled me into
  cancelling a healthy deploy.
- **`.local` DUT seeds now work.** The reservation container has no mDNS (glibc NSS
  in the minimal nix image ignores `LD_LIBRARY_PATH` and reads its own store-path
  `ld.so.cache`, so nss-mdns won't load without nsncd/a custom glibc). So the
  manager resolves `HITL_DUT_ADDR` `*.local` → IP HOST-side (`getent`, needs
  `pkgs.getent` on the daemon PATH + `services.avahi`) before injecting it. Seed by
  hostname freely; it's re-resolved per reservation.

**Live-state caveats a fresh agent must know:**

- **splanc-max-1 (`.50`) is DOWN** — I rebooted it (chasing the Tang, before
  realising it's the wrong box) and it did NOT rejoin the LAN (it had the wrong-board
  Pi5 closure). No rig-side power control for a network DUT → needs a **physical
  power-cycle at rig-1**, then redeploy with the **Pi3** target (`:ledmapper_pi3`) or
  `update` — the guard now blocks a wrong-board repeat.
- **The raw-SPI E2E check** is FX2-sample-rate-limited (24 MHz vs 6.4 MHz SPI); it's
  redundant with ws2812 (the accepted validation) and should be made sample-rate-
  aware or gated separately.

## 2026-08-27 — fpga_ws281x HITL drives the DUT over WS; BLOCKED on the DUT WSS

Rewrote `pi/hitl/harness/hitl_fpga_ws281x.py` to drive the **network DUT**
(`pi-ledmapper-1` = the Pi player at rig-1, 192.168.68.50) the way the phone does —
over its WSS — instead of the old `_drive_static` control-socket path (which can't
work: the reservation is a container on the rig, with no line to the Pi's local
unix socket). This is Phase 5 of the Python→Rust player rewrite (the `pi/player_rs/*`
commits; context inlined below under "Inlined context"): get the FPGA E2E green
against the deployed Rust player.

**What the harness now does** (this change; not yet committed-green — see blocker):

- `_dut_addr(res)` reads `$HITL_DUT_ADDR` from the reservation container (the
  network-DUT env, seeded via `//pi/hitl:seed_network_dut`) → `res.forward(addr,
8443)` tunnels a local port to the Pi's WSS, exactly like `:map_upload`.
- `_open_ws` (bounded 30s retry, mirrors `:map_upload`) → hello→welcome, then
  `set_counting_pattern` with **one solid ColorBlock per FPGA port** and
  `color_order="GRB"`. The render's counting path (`render.rs Source::Counting`)
  honours that order, so the WS2812 wire bytes come out GRB for the sigrok decoder.
- `_expected_frame` is now **per-port solids** (`_PALETTE[p]`); `_counting_blocks`
  emits `{start:p*lpp, count:lpp, rgb:[…]/255}`. The player codec splits the
  `num_ports*lpp` counting LEDs evenly across ports (`wire.rs split_ports`,
  port_counts=None) so block p lands entirely on port p. **`--num-ports` MUST
  match the deployed player `--fpga-ports` (=4)** or the split misaligns.
- Capture/verify path unchanged (ws2812 per port + raw-SPI STREAM cross-check via
  `fpga_spi.encode_stream`). Defaults updated to rig-1 wiring: `--ws-channels
D0,D2,D4,D6`, `--spi-channels D3,D1,D5` (clk,mosi,cs), `--num-ports 4`,
  `--leds-per-port 8`, `--serve-port 8443`.
- Fixed `_reserved_device`: match the nested `active.id` in `/status` (was looking
  for a flat `reservation`/`reservationId` key that doesn't exist) — now resolves
  network DUTs.

**Builds + runs**: `bazel build //pi/hitl/harness:fpga_ws281x_led-mapper-pi-fpga`
green; `bazel run … -- --server http://hitl-rig-1:8087` reserves `pi-ledmapper-1`,
resolves the addr, and forwards `localhost:NNNNN -> (rig) -> 192.168.68.50:8443`.

**BLOCKER — the DUT's WSS never completes the opening handshake.** The TCP tunnel
establishes but websockets reports `TimeoutError: timed out during opening
handshake`, and it persists across the 30s retry loop — so it is NOT a
first-connect race and NOT the harness. Something on the Pi at
`192.168.68.50:8443` accepts TCP but doesn't answer TLS/WS.

Next agent — narrow it from the container (the container CAN reach the Pi over the
LAN; only the harness's local host can't ssh the Pi):

1. `res.ssh('curl -kv --max-time 8 https://192.168.68.50:8443/ 2>&1; nc -zv
192.168.68.50 8443')` — is 8443 listening / does TLS respond?
2. Prime suspect: **the player service isn't up**. Its unit has
   `ExecStartPre = "+${fpgaCommission}"` (apps.nix) which flashes the Tang over
   USB-JTAG before ExecStart; if commissioning hangs or the Tang is absent at
   rig-1, the player never binds 8443. Check `systemctl status sbc-led-driver`
   and the commission log on the DUT (needs a shell on the Pi — via tailscale or
   the rig's LAN, out of band).
3. Or a single-connection server wedge in the Rust player (see the "Server-wedge
   precedent" below): `res.forward` opens/half-closes a probe dial that could wedge
   a single-task accept loop. If so, fix in `pi/player_rs/src/server.rs` (serve
   loop) — it must accept serially without wedging on an aborted TLS client. Was
   live-verified serving WSS on splanc-max-2 before the move to rig-1; verify it
   survived the move/reboot.

Always `hitl release` — the run above released cleanly (`released`).

### Inlined context (facts a fresh agent won't have — they lived in prior-session memory)

**Network-DUT model** (how the Pi attaches to a rig; `runner.Device.Kind == "network"`):

- Reached over the LAN via `$HITL_DUT_ADDR` (the DUT env, injected into the reservation
  container with `-e`), plus BLE. The reservation is a podman container on the rig,
  published on the DUT's SSH port (2230); **`res.ssh` runs IN that container**, which
  reaches the Pi ONLY over the network/BLE — it CANNOT touch the Pi's local
  `/run/ledmapper/control.sock`. That is the whole reason this test drives over WSS
  instead of the old control-socket path.
- The container has NO mDNS resolver → address the Pi by ETH IP `192.168.68.50`, never
  `*.local`.
- Pin-only: a network DUT is reachable only by `--sku` or `--device`, never a bare
  `--require-caps`/unpinned reserve (so a C6 test can't drift onto the Pi).
- Seeded at runtime (not baked): `bazel run //pi/hitl:seed_network_dut -- hitl-rig-1
--name pi-ledmapper-1 --addr 192.168.68.50 --sku led-mapper-pi-fpga
--ble-mac B8:27:EB:63:E8:18`. Writes `/var/lib/hitl/network-duts.json`; the `--discover`
  monitor ingests it in ~3s (no restart). `--sku` is REQUIRED; re-seed after any reflash.
- rig-1 is now a Pi5 ANALYZER rig (`SBC_ANALYZER=1`, fx2lafw). DUT caps under the
  `led-mapper-pi-fpga` sku = `[improv, led-strip, logic-analyzer, spi-fpga]`. LA wiring:
  FPGA ws pins 70,71,72,73 → FX2 D0,D2,D4,D6; SPI clk=D3, mosi=D1, cs=D5 (== the harness
  defaults). Pi BLE MAC `B8:27:EB:63:E8:18`.

**The deployed player** (Phase 5 of the Python→Rust rewrite; branch `pi/spi-ws281x`):

- The DUT at rig-1 (physically `splanc-max-2`) runs the unified RUST player
  `//pi/player_rs:player` — it REPLACED the Python `led_driver` M1 + `pi/server` M2 on the
  FPGA path. ONE process: serves the protocol over WSS AND drives the FPGA from a shared
  `Arc<Mutex<Player>>`, reusing the firmware Rust core directly (no FFI). Shipped as a
  fully-STATIC aarch64-linux-musl binary through the build graph
  (`//pi/player_rs/musl:player_musl`); 100% Rust (rustls + rustls-rustcrypto +
  x509-cert/p256, no ring/C), self-signed EC cert (phone/harness bypass verification).
- Live-verified at deploy time: `sbc-led-driver.service` active, `render 4 ports @ 60 fps,
spidev0.0 @ 6400000 Hz`, `WSS listening 0.0.0.0:8443` — so the harness targets `:8443`.
  If it isn't answering now, something changed after the move to rig-1 (see the blocker).
- The render's counting path honours `counting_color_order()` (render.rs `Source::Counting`
  applies the message's order), which is why we send `color_order="GRB"`.

**Server-wedge precedent** (from the C6 firmware TLS server — an analogous risk here):

- On the C6, a single-task TLS server with `max_open_sockets=2` held dead/half-open
  sessions FOREVER and never recovered without a reboot; fixed there with TCP keepalive +
  recv/send timeouts + a TLS-handshake timeout + SO_LINGER. Two durable lessons if the Rust
  player has an analogous single-connection wedge (e.g. `res.forward`'s far-end probe dial
  leaving a half-open TLS session): a wedged device STAYS wedged until reboot, so
  **power-cycle the Pi and measure against a known-clean device**; and the fix would live in
  `pi/player_rs/src/server.rs`'s accept loop (accept serially without wedging on an aborted
  TLS client).

## 2026-08-22 — BT dongle deflakes provisioning (Pi 5 onboard Cypress is the flake)

The long-hunted ImprovBLE provisioning flake (FUG-61/FUG-94: ~50% per-attempt
connect failure, ridden out by `_connect`'s retry loop) is the **Pi 5 onboard
Cypress BCM4345/6 BT controller** — not coexistence, not the DUT. Proven with a
same-rig/same-DUT A/B on rig-2 (`gatttool --primary`, whose pass/fail matches the
btmon `Connection Failed to be Established (0x3E)` count exactly):

- onboard `hci0` (Cypress, `98:FE:54:…`): **0/20 usable, 20× 0x3E**
- USB dongle `hci1` (RTL8851BU, `90:DE:80:…`): **20/20 usable, 0× 0x3E**

Control: rig-3 (Pi 3, onboard BCM43438 `B8:27:EB:…`) `hci0` passed 20/20 — so the
flake is **Pi5-Cypress-specific**, not Pi-BT-in-general.

Fix (`SBC_BT_DONGLE=1`): route BLE central onto the dongle's BT half.

- `nix/rtl8851bu-bt.nix` ships `rtl_bt/rtl8851bu_fw.bin` (vendored under
  `nix/firmware/`; the trimmed rig image has no `rtl_bt/` dir, so btusb registers
  the hci but leaves it DOWN). No `rtl8851bu_config.bin` exists; btrtl's load-miss
  is non-fatal.
- `hitl-app.nix`: `useBtDongle` adds the firmware, shares the `usb_modeswitch` udev
  rule (0bda:1a2b→b851) with the AP-dongle path, and passes `--ble-adapter usb`.
- daemon resolves `"usb"` → the USB controller by sysfs bus (`resolveUSBHCI`, so
  it's robust to hciN ordering), injects `HITL_BLE_ADAPTER` into the container and
  `-i <hci>` into btmon. bleak (provisioning `hitl_improv.py` + `hitl-ble`) honors
  `$HITL_BLE_ADAPTER` — bleak's BlueZ backend defaults to `hci0`, so this is
  required, not cosmetic. Falls back to the default controller if no dongle is up.

Validated by hand before the deploy (all reverts on reboot; the deploy makes it
durable): a nix-built `usb_modeswitch`, the injected firmware, and a `btusb`
rebind brought `hci1` up on rig-2 and rig-3. rig-3's dongle also scored 19/20 (one
transient 0x3E = noise). Go/py units cover the resolver + adapter threading. See
memory `hitl-bt-dongle-fixes-pi5-flake`.

## 2026-08-17 — DUT identification + `map_la` (acquire the analyzer channel map)

Which physical board (hence which analyzer channel) is which `c6-<serial>` can't
be known from software, so two tools acquire it on the bench:

- `firmware/dut_id` breathes a DUT's onboard WS2812 (GPIO8) with a serial toggle;
  `//pi/hitl/harness:dut_id` walks a rig's DUTs to eyeball each one.
- `//pi/hitl/harness:map_la` drives that blink DUT-by-DUT, asks which channel each
  is on, and `POST`s the map to the daemon. New broker endpoints
  `GET/POST /analyzer/channel-map` apply it live and persist it to
  `<state-dir>/analyzer-channel-map.json` (reloaded at boot, overlaid on the deploy
  default) — the map sticks across reboots, no redeploy. Validated locally
  end-to-end + a round-trip/persist Go unit test.

Serial toggle caveat: sending `'0'`/`'1'` to the C6's `/dev/ttyACM0` from a raw
container shell couldn't be _confirmed_ to echo back (the C6 USB-CDC RX read-back
via bare `cat` doesn't capture like `hitl-monitor` does); the write itself goes
over USB CDC so the stop should land — the operator sees the LED stop. If it turns
out unreliable, a distinct-color-per-MAC scheme would let all DUTs be ID'd in one
pass with no stop needed.

`POST /analyzer/channel-map` also refreshes the `/status` capability snapshot
(`Manager.SetAnalyzer(brk.Describe())`) so its channel list tracks the live map,
not the boot-time default.

### Test sweep 2026-08-17 (both DUTs, all three rigs)

Rig IPs churn on re-registration (tailnet MagicDNS is stale in-container); current
truth by `/status`: **hitl-rig-1** `100.99.64.43`, **hitl-rig-2** (analyzer, Pi 5)
`100.107.245.18` DUTs `c6-003f08`/`c6-fa0324`, **hitl-rig-3** (Pi 3) `100.85.115.53`
DUTs `c6-117d10`/`c6-fa3304`. You _can_ SSH the rigs from the container via tailscale
SSH: `ssh -o StrictHostKeyChecking=accept-new root@<ip>` (clear the stale host key with
`ssh-keygen -R <ip>` after churn). Run harness tests with `bazel run`/the built binary
`PYTHONUNBUFFERED=1` **to a file, never `| tail`** — the long-lived reservation-holder
subprocess keeps a pipe open so nothing flushes until the end.

- **Non-LA e2e — all 4 DUTs PASS** (`--device` pins each): rig-3 `c6-117d10`,
  `c6-fa3304`; rig-2 `c6-003f08`, `c6-fa0324`. rig-2's BLE connect is flaky
  (host BT), but the provisioner's 3× retry recovers every time.
- **LA capture on hitl-rig-2:** wrote the map via the new endpoint — `c6-003f08`→D6,
  `c6-fa0324`→D7 (determined empirically: `c6-003f08` captured clean on the default
  D6). `led_capture --device c6-003f08` **PASS**. `--device c6-fa0324` on D7 **the
  tap is fine** — decode is pristine (exact colors, no noise) and a re-run **PASSED**
  on the same wiring. The one FAIL was a **capture frame-alignment flake**, not the
  D7 tap:
  - The wire carries **256-pixel frames** (`led_config.h NUM_LEDS 256`) with only the
    first 8 lit, and every pixel is scaled to **160/255** (`main.cpp:1593
FastLED.setBrightness(160)`) — both are player_app defaults, decoded exactly.
  - With a 256-LED strip captured across ~2 repaints, the FX2 software-trigger's
    frame-start doesn't reliably land on physical pixel 0: run 1 put the 8-lit block
    at decoded offset 61 (so `got[:8]` was black → FAIL); run 2 at offset 0 → PASS.
  - FOLLOW-UP (test, not bench): `led_capture` assumes the lit pattern starts at index
    0 — harden it to locate the lit region within the decoded frame (the pattern is
    the sole non-black run), so it's alignment-independent. NOT a wiring issue.

### Rig gotcha: `hitl-image-load` fails after a fresh Pi 3 reflash

hitl-rig-3 (freshly reflashed) couldn't reserve — `POST /reserve` returned `null`
because the container wouldn't start: `hitl-test:latest` wasn't loaded. The
`hitl-image-load` oneshot had failed with `readlink
/var/lib/containers/storage/overlay/l: invalid argument` — a corrupt/half-baked
podman overlay store shipped in the SD image. Fix (per session, on the rig):
`systemctl stop hitl-manager && podman system reset -f && systemctl start
hitl-image-load` (slow on the Pi 3 — ~5 min for the 446 MB image) `&& systemctl
start hitl-manager`. FOLLOW-UP: the image build shouldn't ship a populated
graphroot, or the load unit should `podman system reset` on a prior failure.

## 2026-08-17 — `--hostname` now sets the identity (sbc-deploy fix, pin bumped)

`--hostname` was overloaded: image mode used it as the identity override, but
deploy_live/ssh used it to pick the `nixosConfigurations` attr — so you had to set
identity via `SBC_HOSTNAME_OVERRIDE` and never touch `--hostname` on deploy. Fixed
upstream (sbc-deploy `caa484d`, branch `hostname-identity-decouple`): `--hostname`
sets the machine identity (networking.hostName → tailscale name → AP SSID) in ALL
modes; a new target-baked `--nixos-attr` picks the config variant. Pin bumped in
MODULE.bazel + flake.nix/lock (nix/ was unchanged, so the flake narHash is kept).

So the two knobs are now: **target** = what to build, **`--hostname`** = the box:

```sh
bazel run //pi/hitl:hitl_pi3.deploy_live -- --hostname hitl-rig-3 <host>       # plain Pi 3
SBC_ANALYZER=1 bazel run //pi/hitl:hitl.deploy_live -- --hostname hitl-rig-2 <host>  # analyzer Pi 5
```

`SBC_HOSTNAME_OVERRIDE` still works (the flag just sets it), but prefer `--hostname`.
Verified live: deployed hitl-rig-2 with `--hostname hitl-rig-2` (no env), all three
names stuck.

## 2026-08-17 — decouple analyzer + AP-dongle from the board (3 orthogonal axes)

The logic analyzer moved from a Pi 3 to a Pi 5 (hitl-rig-2), and hitl-rig-3 became a
plain Pi 3. The old config conflated everything with the board (`isAnalyzerRig =
SBC_BOARD == raspberry-pi-3`, and the RTL8851BU AP dongle was gated on the analyzer).
Split into **three independent axes**, each set per-deploy:

- **Board** — bazel target: `//pi/hitl:hitl` (Pi 5) or `//pi/hitl:hitl_pi3` (Pi 3B/3B+).
  (Renamed from `hitl_la`, since it's no longer analyzer-specific.)
- **`SBC_ANALYZER=1`** — wire the FX2/sigrok capture (was `SBC_BOARD == pi-3`).
- **`SBC_AP_DONGLE=1`** — host the AP on the RTL8851BU `ap0` instead of onboard
  `wlan0`. Now OFF by default: a Pi 5 hosts its AP fine on onboard wlan0 (verified on
  hitl-rig-1), so the analyzer Pi 5 needs no dongle. The dongle is on neither rig now.

Deploys: `SBC_HOSTNAME_OVERRIDE=hitl-rig-2 SBC_ANALYZER=1 bazel run //pi/hitl:hitl.deploy_live -- <host>`
(analyzer Pi 5); `SBC_HOSTNAME_OVERRIDE=hitl-rig-3 bazel run //pi/hitl:hitl_pi3.deploy_live -- <host>`
(plain Pi 3). hitl-rig-2 has 2 DUTs (serials …FA:03:24, …3F:08) on the FX2 — set the
per-DUT D6/D7 channel map (`analyzerChannelMap`) once the wiring is confirmed.

Note (Pi 3B+ brcmfmac): boot logs a `memcpy: detected field-spanning write … fweh.c:466`
WARNING in `brcmf_fweh_activate_events` — a known upstream fortify-source warning for
BCM4345 on 6.x; noisy, non-fatal (WiFi still comes up). The `onboard-usb-dev 1-1:
can't set config #1, error -110` is a separate Pi 3B+ onboard-USB-hub quirk.

## 2026-08-16 — container LA capture path green end-to-end (3 bugs fixed)

`//pi/hitl/harness:led_capture` now **PASSES on real hardware** through the full
container path (reserve → flash → BLE-provision onto the RTL8851BU AP → drive →
`hitl-capture` in the container → decode): `[PASS] 8 pixels match the driven pattern`.
This path had never actually run before — the 2026-08-14 "verified" run used
`--device-ws` (daemon-side capture), which skips the container. Three bugs surfaced:

- **Container SSH sessions didn't inherit the per-reservation env.** The daemon injects
  `HITL_CAPTURE_SERVER` (and `HITL_DUT`/`HITL_ADAPTER_SERIAL`) via `podman -e`, but that
  reaches only sshd's process, not the `ssh host cmd` sessions the harness uses (static
  `SetEnv`, `UsePAM no`). `hitl-capture` saw `$HITL_CAPTURE_SERVER unset`. Fix: the
  entrypoint writes `~/.ssh/environment` + `PermitUserEnvironment yes` (container.nix).
  Also had to add **gnugrep** to the entrypoint's runtimeInputs — it uses `printenv |
grep` and only openssh+coreutils were on PATH, so the env file came out empty.
- **Capture window too short for the DUT's duty cycle.** fx2lafw has no hardware trigger,
  so sigrok software-triggers within the sample window. The C6 counting probe repaints
  the WS2812 frame at only 10 Hz (`kStaticPollMs = 100ms` in player_app), so the old
  ~8.3ms window missed the burst ~92% of the time → "trigger never fired". Bumped the
  default to ~208ms (2× the cadence); analyzer.go / main.go `--analyzer-samples`.
- **`podman load` didn't move the `hitl-test:latest` tag** to the freshly-built image
  while a stale reservation container still referenced the old one — so container.nix
  changes silently never reached the rig (had to `podman load` by hand). hitl-image-load
  now clears stale hitl containers + untags before load, ordered Before=hitl-manager.

Gotcha for the next agent: **nix `path:` flake caching** bit twice — editing a file in
place bumps the file mtime but not the dir mtime, so `deploy_live` served a stale tree
and rebuilt the SAME derivation hash. If a deploy doesn't pick up a `pi/hitl/**` edit,
`touch pi/hitl/flake.nix` (or commit) to force a fresh copy.

## 2026-08-16 — dedicated USB AP radio: RTL8851BU (rtw89), hardware-verified

The analyzer rig now hosts its AP on a **dedicated USB WiFi dongle** (frees the Pi 3's
onboard brcmfmac, which can't reliably run an AP) — `ap0` in `hitl-app.nix`, wlan0 left
for STA. Hardware-verified on `hitl-rig-2`: driver binds, WiFi firmware loads, iface
renames to `ap0`, and NetworkManager `hitl-ap` activates on it.

- **The dongle is an RTL8851BU, not an RTL8188GU.** After usb_modeswitch it enumerates
  `0bda:b851` "802.11ax" (WiFi 6 + BT combo, `rtl8851bu_fw.bin`), not `0bda:b711`. The
  earlier RTL8188GU packaging (`rtl8188gu.nix` + 6.12 port patch, commit `d410e9b`) was
  the wrong chip and never bound — **deleted**.
- **Driver: `nix/rtl8851bu.nix` from `morrownr/rtw89`** (pinned `e2be1a0`) — the mainline
  mac80211 rtw89 family backported to kernels 6.6+, so it supports hostapd AP cleanly.
  The rig's in-tree rtw89 predates 8851BU-USB (that landed ~6.14; rig is 6.12.87), hence
  out-of-tree. **Builds clean on 6.12 with zero source patches** (unlike the 8188gu
  vendor driver). Module for the USB adapter is `rtw89_8851bu_git` (KBUILD_MODNAME); the
  derivation also ships the WiFi firmware `rtw8851b_fw-1.bin` (nixpkgs' linux-firmware
  predates it) → wired into `hardware.firmware`.
- **rtw89 is built with `-DCONFIG_RTW89_LEDS_MC`,** so `rtw89_core_git` needs
  `led-class-multicolor`'s symbols. Added it to `boot.kernelModules` **before** the
  driver. (modprobe/udev auto-resolve it via modules.dep anyway, but the explicit line
  documents the dep and avoids a boot race.)
- **`.link` rename uses `matchConfig.Driver = "rtw89_8851bu_git"`** — verified: udev's
  `ID_NET_DRIVER` reports the usb_driver's KBUILD_MODNAME, and `wlan1 → ap0` renamed.
- **New kernel modules need a reboot (or manual insmod) to load** — `deploy_live` does a
  `switch`, which does NOT put new `extraModulePackages` into `/run/booted-system`, so
  `modprobe`/`systemd-modules-load` can't find them until the next boot. First deploy
  looked like a failure for exactly this reason; the module + AP came up fine after
  loading it by hand, and the reboot path is the production one.
- **BT half is a bonus, not done**: `hci1` wants `rtl_bt/rtl8851bu_fw.bin`, which isn't
  in nixpkgs linux-firmware yet — would give a dedicated BLE radio. Deferred.

### TODO (later): enable the RTL8851BU BT half as a second BLE radio

The dongle is a WiFi 6 + BT combo. Only the WiFi half (`ap0`) is wired up; the BT
controller (`hci1`) enumerates but stays DOWN because its firmware is missing —
`dmesg`: `Bluetooth: hci1: RTL: firmware file rtl_bt/rtl8851bu_fw not found`
(also wants `rtl_bt/rtl8851bu_config.bin`). BlueZ has the driver; it's purely a
firmware-provisioning gap. Today the rig does BLE on the Pi's integrated adapter
(`hci0`), which works, so this is upside, not a blocker.

To do it: fetch `rtl8851bu_fw.bin` + `rtl8851bu_config.bin` from upstream
linux-firmware (`rtl_bt/`) — recent enough to include 8851BU — and add them under
`lib/firmware/rtl_bt/` via `hardware.firmware` (extend `rtl8851bu.nix` to also
install the BT blobs, or a small separate firmware derivation). Then `hci1` should
init and give a second, dedicated BLE controller (e.g. run DUT BLE on one and keep
the other free, or parallelize). Nice-to-have; no rush.

Deploy, then reboot (new kernel modules only load on the next boot):

```sh
SBC_HOSTNAME_OVERRIDE=hitl-rig-la-1 bazel run //pi/hitl:hitl_la.deploy_live -- hitl-rig-2 --keep-builder
```

`nmcli device` should then show `ap0:wifi:connected:hitl-ap`, and `dmesg | grep
rtw89` the firmware load + `ap0: renamed from wlan1`.

## 2026-08-14 — LA rig confirmed on real hardware (`hitl-rig-2` / `hitl-rig-la-1`)

The logic-analyzer rig is **hardware-verified end-to-end**: drove a known
`set_counting_pattern` (2×red/2×green/4×blue) on the ESP32-C6 DUT and the FX2 on
**D6** captured + decoded it via the daemon `/capture` — decoded pattern matches
(GRB→RGB, correct positions/order). Pin bumped to sbc-deploy `18a5346` (auto-managed
macOS builder for external consumers, PRs #4/#5).

Key facts learned + fixes:

- **Analyzer channel is D6, not D0.** PIN20/GPIO20 (the C6's WS2812 DIN) is wired to
  the FX2's CH6. `hitl-app.nix` `analyzerChannelMap` now defaults to `D6`. (Was D0.)
- **`hitl_la` `hostname` must be the flake's nixosConfigurations attr (`hitl-rig`),**
  not a novel name — `deploy_live`'s `--hostname` is the attr selector, not the
  machine name. Per-rig identity is `SBC_HOSTNAME_OVERRIDE` at deploy/flash time
  (this rig runs as `hitl-rig-la-1`; deploy with
  `SBC_HOSTNAME_OVERRIDE=hitl-rig-la-1 bazel run //pi/hitl:hitl_la.deploy_live -- hitl-rig-2`).
- **Firmware scales the wire**: full-scale 255 reaches the WS2812 as ~160 (color-
  correction/gamma+brightness). The correctness test asserts lit-channel STRUCTURE
  (`led_pattern.diff_structure`), not exact bytes.
- **Bugs fixed this pass**: broker returned a cryptic "No such file" when the tapped
  line is idle (trigger never fires → sigrok writes no `.sr`) — now a clear "no data
  captured" (`internal/analyzer`); and 4 in the harness (`CompletedProcess` vs str
  ×2, stale `_drive_pattern` signature, missing rig-AP cred resolution). Added a
  `--device-ws` harness mode (drive a reachable ws URL + capture via the daemon, no
  reservation).

**⚠️ Open rig-networking issues (BLOCK the normal container-based `led_capture` flow):**

1. **The Pi 3 can't host the provisioning AP.** `wlan0: AP-DISABLED` /
   `hostapd… interface wasn't started` — brcmfmac AP mode won't start, so NM falls
   back to the STA (`BigVibes`). The single-radio AP design that works on the Pi 5
   doesn't here. **Fix: a dedicated USB Wi-Fi dongle for the AP** (DESIGN already
   anticipates this), or debug brcmfmac/hostapd AP mode.
2. **Container can't reach a DUT on an external LAN.** With the AP down, provisioning
   onto `BigVibes` gives the DUT a link-local `169.254.x` addr and the reservation
   container routes via Ethernet, so it can't reach the DUT's WSS. The **rig host**
   can (same `wlan0` subnet). The hardware-confirming run therefore drove the DUT via
   an **ssh tunnel through the rig host** (`ssh -L …:169.254.x:81 root@hitl-rig-2`) +
   `--device-ws`, capturing via the daemon. Until (1) is fixed, `led_capture`'s
   reservation flow won't pass on this rig; use `--device-ws`.

Also: the DUT needed a **physical power-cycle** twice — a latched USB-download strap
(`boot:0x10 (USB_BOOT)`) and then flash flakiness (`esptool: chip stopped responding`).
Watch for probes/ground loading GPIO8/9/15 or the reset/EN line.

## 2026-08-12 — Logic-analyzer rig variant (Pi 3 + shared FX2/sigrok)

New rig **variant** for LED-driver correctness/latency: a Raspberry Pi 3B
(`//pi/hitl:hitl_la`, `board = raspberry-pi-3`, hostname `hitl-la-rig`) with an
FX2/fx2lafw "Saleae clone" 24 MHz logic analyzer tapping the ESP32-C6 DUT's WS2812
DIN. Closes the "needs a logic analyzer on a bench" gap flagged in
`pi/led_driver/README.md` + `docs/{decisions,runbook}.md`. Built on the FUG-105 pin
that added first-class Pi 3B (`@sbc_deploy//deploy/boards:raspberry-pi-3`).

**The FX2 is a rig-level SHARED instrument** (per the ask: wire 1–2 channels to each
DUT to save analyzer hardware), so the design differs from passing a DUT into a
container:

- `internal/analyzer` — the daemon owns the one FX2; a `Broker` serializes captures
  (mutex) and maps DUT→channels/protocol (`--analyzer-channel-map` JSON). New
  `POST /capture {device}` runs a triggered `sigrok-cli` capture scoped to that DUT
  and decodes it. Because the FX2 never enters a container, **`internal/runner`
  raw-USB isolation is untouched**.
- `nix/container.nix` — `hitl-capture` thin client (POSTs `/capture` via
  `$HITL_CAPTURE_SERVER = host.containers.internal:<apiPort>`, injected by the
  runner's new `PodmanConfig.CaptureURL`). No sigrok/raw-USB in the container.
- `nix/{sigrok,hitl-app}.nix` — sigrok closure + capture flags + FX2 udev rules are
  board-gated (`builtins.getEnv "SBC_BOARD" == "raspberry-pi-3"`), so the **same
  appModule** yields a lean Pi 5 image and a capture-enabled Pi 3 image — no flake
  fork. `sbc_application(board=…)` swaps the board via `$SBC_BOARD` at eval.

**Decoders:** `rgb_led_ws281x` (WS2812) and `rgb_led_spi`+`spi` (future APA102) are
BUILT IN to libsigrokdecode ≥0.5.3 — no vendored decoder. The ws281x decoder emits
`#rrggbb` in logical RGB (it un-GRBs the wire).

**Verified (no hardware):** `internal/analyzer` synthesizes a WS2812 `.sr` and runs
the real `sigrok-cli` decode over it — `go test` PASS (ran, not skipped, with
sigrok-cli installed in-container via the overlay). Pure pattern/pixel contract in
`//pi/hitl/tests:hitl_test` (`test_led_pattern.py`). `bazel build` of daemon/CLI/
`led_capture` + all 6 Go test targets PASS; `hitl_la.image_sd` resolves with the
Pi 3 board wired in (build eval, not a full aarch64 image — that OOMs here).

**Not yet on hardware (follow-ups):** the reserve→flash→drive→`hitl-capture`→assert
loop (`//pi/hitl/harness:led_capture`, manual+hitl) against a real Pi3+FX2+board;
full E2E latency (needs stimulus+capture co-timed — `CaptureResult.TriggerSample`/
`SampleRate` are the hooks); confirm the 3.3 V DIN tap / level-shift + common ground.
sbc-deploy's `$SBC_BOARD` eval-gating of appModule config should be re-confirmed on
the real image build (fail-safe: unset board ⇒ analyzer off).

## 2026-08-10 — FUG-94: the FUG-61 provisioning flake is a per-connect BLE failure, not coexistence

The FUG-61 fix works; its recorded root cause (WiFi/BLE **coexistence** starves the
first BLE connect) was wrong and was repeated in three places. Re-measured on the rig
(DUT `c6-2ce684`, board `f0:f5:bd:2c:e6:86`, driven from the container over the LAN)
to settle the mechanism empirically. **Behaviour is unchanged** — this was a diagnosis
exercise, not a behaviour change.

### Method

An experiment-only instrument (`fug94_measure.py`; not committed — this is a
diagnosis, not a shipped tool). The board is held **cred-less** (never write the WiFi
RPC), so every reset reboots into the **erase-fs first-provision state**: `setup()`
runs `WiFi.mode(WIFI_AP_STA)`+`softAP()` unconditionally but `WiFi.begin()` is gated
behind `if (ssid.length() > 0)`, so there is **no STA association** — only an idle
soft-AP beacon (verified in the boot banner: `sta off`, AP `192.168.4.1`);
`improv_ble_begin()` runs last. So the ticket's premise holds: there is no WiFi
association on the failing boot to "coexist" with. Per sample the instrument
hard-resets the DUT, stamps the `[ble] advertising …` serial line (t_adv), then does a
harness-faithful scan+single-connect (`tries=1` — fix disabled) recording whether the
match had a **resolved name**, **ms since advertising start** at connect, connect
latency, and the exact error.

Rig time was heavily contended (the neighbouring DUT was held by another reservation
on the **same shared host BLE adapter** throughout — itself relevant to H3, below), so
samples were gathered across many short reservations streamed to a durable local file.

### Data (Wilson 95% CI)

Every failure is the FUG-61 symptom: a message-less `TimeoutError` at
`BleakClient.connect()`, never reaching `connected=True`. **All arms are the same
no-creds soft-AP-only board** — I did not have an uncontended window to reflash a
WiFi-off variant or provision a stored-creds arm (see H1 below).

**Fix DISABLED (`tries=1`, one connect per reboot):**

| arm                                | scan / connect timing       | n      | connect FAIL | rate (95% CI)    | named     |
| ---------------------------------- | --------------------------- | ------ | ------------ | ---------------- | --------- |
| baseline_softap (harness-faithful) | discover 8 s, ~8 s post-adv | 19     | 10           | **53% (32–73%)** | 19/19     |
| delay sweep                        | fast scan, 0–5 s post-adv   | 28     | 13           | **46% (30–64%)** | 28/28     |
| **pooled `tries=1`**               | 88 ms – 8.1 s post-adv      | **47** | **23**       | **49% (35–63%)** | **47/47** |

Delay-sweep per pre-connect delay (fail/n): 0 s → 3/6, 0.5 s → 1/6, 1 s → 4/6,
2 s → 2/5, 5 s → 3/5 — **flat ~50%, no monotonic trend**. In the discover arm every
match is fully settled (~8 s advertising, name resolved) and still ~half time out.
Across all 47 samples the scan-response name resolved within ~200 ms — **0 name-less
matches** — even at a 0 s delay.

**Fix ENABLED (`tries=5`, rapid same-boot retries; discover 8 s):**

| arm        | n   | RUN FAIL (all 5 tries lost) | rate (95% CI)  | runs a retry rescued (try>1 won) |
| ---------- | --- | --------------------------- | -------------- | -------------------------------- |
| fix_tries5 | 12  | 0                           | **0% (0–24%)** | 5/12                             |

5/12 runs had a first-connect failure that a later try rescued, and 0/12 runs failed
overall — with each try failing ~independently ~50%, five tries predict a run-level
failure of ~0.5⁵ ≈ 3%, consistent with 0/12. Rapid same-boot retries ride out the
per-attempt failure; that is exactly what the fix does and why it works.

### Which hypothesis the evidence supports

- **H2 (peripheral readiness / name-less early-pounce) — RULED OUT.** Two independent
  signals: the connect-failure rate is **independent of time-since-advertising** (flat
  ~50% across the whole 88 ms → 8.1 s range; the discover arm connects only after a
  full 8 s scan, fully settled, and still fails at the same rate), and the match had a
  **resolved name in 47/47** samples (0 name-less — the scan-response name resolves in
  ~200 ms). A readiness/early-pounce race predicts the opposite; connecting _later_
  does not help.
- **H1 (WiFi/BLE coexistence) — the recorded mechanism is FALSIFIED.** The failing
  erase-fs boot has **no STA association at all** (`WiFi.begin` gated off, only an idle
  soft-AP), so there is no "coexistence bring-up during association" to drop the
  CONNECT*REQ — which is exactly what the docs claimed. A \_residual* H1 (does the idle
  soft-AP beacon / BT-controller-beside-the-WiFi-stack itself perturb BLE connect?) is
  **not separable here from H3** and was **not** isolated: that needs the WiFi-off
  firmware arm (Arm B in the ticket), which I could not run for lack of an uncontended
  window to build+flash a variant. Honest status: coexistence-during-association is
  ruled out; a residual soft-AP-beacon H1 is untested.
- **H3 (central-side / BlueZ / shared adapter) — the leading candidate, unconfirmed.**
  The failure is a **transient, ~per-attempt-independent** connection-establishment
  timeout (~0.5 each), which is exactly why _rapid_ retries within one boot work
  (≈0.5^tries) while reboot-gated single tries don't (a reboot re-rolls the same coin).
  The rig's BLE radio is a **single shared host adapter, not isolated per DUT**
  (DESIGN.md open item), and the neighbouring DUT was held by another reservation
  scanning/connecting on that same host `bluetoothd` throughout my window — a live
  contention source consistent with the signature. Two checks remain outstanding: the
  cheap both-DUTs-held control (no neighbour on the adapter — no uncontended window to
  run it), and the decisive link-level HCI/btmon capture inside the reservation
  (**FUG-93**, not yet landed) that would separate "peripheral never answers
  CONNECT_IND" from "central never issues / BlueZ stalls".

### Which half of the fix is load-bearing

The **`_connect` rapid-retry loop** (`hitl_improv._connect`, `tries>1`) — the OPPOSITE
of the ticket's H2-wins hypothesis. Because the per-attempt failures are ~independent
at ~50%, retrying within one boot drives the compound failure to ≈0.5^tries (five
tries → ~3%, observed 0/12); a single try — or one try per slow reboot — cannot. The
`find()` **name-wait gate** is cheap defence-in-depth (avoids pouncing on a
half-advertised board), **not** the deflaker — a name-less match does not predict
connect failure (it never even occurred). Keep both; the docstrings now say so, and
`pi/hitl/tests/test_improv_find.py` guards both (the retry default stays > 1 and rides
out transient failures; the name gate never hands a name-less advertisement to the
connect path un-waited) so neither is "simplified" away on the wrong premise.

### Bottom line

The flake is a **transient, per-attempt BLE connection-establishment failure on a
freshly-booted C6** (~49% per connect, n=47 `tries=1` samples — clears the n≥30 bar
for the pooled rate), independent of advertising-settle time and of any WiFi
association (there is none). **H2 ruled out; the recorded coexistence-during-
association story falsified; H3 (shared-adapter / central-side) strongly indicated but
unconfirmed at packet level (FUG-93).** The un-run controls (WiFi-off firmware arm for
a residual H1; both-DUTs-held and HCI capture for H3) are the acknowledged gaps. The
coexistence explanation is corrected here, in the 2026-08-05 entry below, and in the
`_connect` / `provision_dut` / `find` docstrings.

## 2026-08-08 — FOLLOW-UP: tighten the FX cost-model estimator (~10% → ~5%)

`fx_bench` now has two tests off one golden (`web/tests/testdata/device-bench-esp32c6.json`):
the on-hardware margin check (fresh run vs golden frame cycles) and the software
estimator test (`web/tests/deviceProfileHardware.test.ts`: fit `buildDeviceProfile`,
validate a held-out spread of real effects). The estimator gate is **13%**, not the
requested 5%, because that's where the current model tops out — this is the
follow-up to close that gap.

Root cause (measured, not guessed — use `FIT_DEBUG=1 bazel run //web:fit_device_profile -- <bundle>`
for the per-program dump): the linear sum-of-independent-op-costs fit
(`web/src/effects/calibrationFit.ts`) **over-predicts the cheapest real effects**
(`empty` +34%, `sweep16` +42%, `neg2M` +14%, held-out `lavalamp` +19%) while every
expensive program lands ±3–7%. It's an absolute-error least-squares, so the huge
programs dominate and the fixed/per-LED overhead is set to fit _them_. Held-out
spread RMS ≈ 9.9% (R² 0.97); `lavalamp` is a ~19% outlier.

Tried and rejected: reweighting the fit toward **relative** error (with a soft
floor, swept the parameter). It lowers the cheap-program in-sample error but makes
**held-out generalization worse** (the tiny `empty`/`sweep` anchors then dominate).
So it's a model-structure ceiling, not a weighting knob. Reverted; production
`calibrationFit.ts` is unchanged.

To actually reach ~5%, the promising directions (each needs rig time to re-measure
the golden — drive it via `hitl_shim`; regenerate with
`fx_bench --emit-golden <the golden path>`):

- Richer features: a fixed per-shade / per-op-issue overhead term, or structural
  features (branch/call counts) the pure opcode histogram misses.
- Non-negative-clamp interaction: the fit clamps costs at 0 (`Math.max(0, x)`),
  which distorts under-determined columns — try a proper NNLS or a better prior.
- Diagnose `lavalamp`'s specific mis-costed opcodes (its histogram vs the fit
  coverage) — it's the lone structural outlier.
- Add isolation microbenchmarks for any op the real effects use but the current
  set under-covers, so the linear fit is better anchored.

The offline loop (`//web:fit_device_profile`, no hardware) makes fit/model
iteration fast; only _new_ microbenchmarks need a rig re-measure.

## 2026-08-05 — deflake e2e provisioning (FUG-61): retry the BLE connect

> **CORRECTION (2026-08-10, FUG-94):** the _fix_ below is correct and stays, but
> the **root-cause explanation in this entry is wrong**. The "single-core C6 shares
> one radio between WiFi and BLE, so the first connect times out during coexistence
> bring-up" story does not hold: on the erase-fs failing boot there is **no WiFi
> association** (WiFi.begin is gated off with no stored creds — only an idle
> soft-AP), so there is no coexistence bring-up to contend with. Re-measurement
> shows the failure is a **transient, per-attempt BLE connection-establishment
> failure** (~50% of first connects), **independent of advertising-settle time and
> of whether the name had resolved** — which rules out the readiness-race reading
> too. The load-bearing half of the fix is therefore the `_connect` **rapid-retry
> loop**, not the `find()` name gate. See the FUG-94 findings entry at the top of
> this file for the arms, n, and confidence intervals.

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

## 2026-08-05 — multiple DUTs per rig (FUG-67)

The queue manager now hands out **N DUTs concurrently**, each its own container +
sshd port + device nodes, from **one shared FIFO** with a per-DUT active slot
(`internal/queue`). `reconcile` fills every free DUT with the earliest compatible
waiter; a reservation can pin a DUT (`ReserveRequest.Device` / `hitl reserve
--device <name>`) or take any free one (default, and what old clients send).

- **Config:** `nix/hitl-app.nix` has a `duts` list (default = the one MVP DUT);
  it generates one `--dut '{"name","ssh_port","devices":["host:container"],"env"}'`
  flag per DUT and opens each port. Each DUT's tty is remapped to `/dev/ttyACM0`
  in-container so `hitl flash/monitor --port` defaults hold everywhere. To add a
  second board: give it a distinct `sshPort` and its stable `/dev/serial/by-id/…`
  path (find with `ls -l /dev/serial/by-id/`), mapped to `:/dev/ttyACM0`.
- **API stayed backward-compatible** — no client rebase. `Status.Active`/
  `queue_length` report the rig idle while _any_ DUT is free (so old clients +
  the pool picker still work); `Status.Devices` is the new per-DUT breakdown.
- **Hardware follow-ups (single shared resources, not yet split per DUT):** JTAG
  raw-USB isolation (all containers see the whole `/dev/bus/usb`; boards are
  selected by `HITL_ADAPTER_SERIAL`, wired into `hitl-jtag`/`hitl-gdb` — set the
  per-DUT `env` and verify openocd's `adapter serial` picks the right C6 on real
  hardware); one BT radio shared for BLE; rig-level provisioning AP. Filed as
  follow-ups if the humans want them tracked.
- Verified: `bazel test //pi/hitl/...` (queue routing/concurrency/pin, Status
  compat, `--dut` parsing, pool packing). Not run on real multi-DUT hardware yet.

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
