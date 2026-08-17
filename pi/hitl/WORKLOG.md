# HITL rig — worklog

Handoff notes alongside git history. Newest first. Read this before touching the
rig's networking — there's live runtime state that isn't fully declarative yet.

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
