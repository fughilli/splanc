# Splanc on ESP32-P4 + ESP32-C6 (split player)

Status: proposed. Nothing here is built yet. Phase A runs on the bare ESP32-P4 dev boards we
already have. Phase B waits for the P4 boards with an on-board C6 on SDIO, which are on order.

Owner direction (2026-10-26): *"Let's integrate a c6 and p4 to have the expanded compute headroom
while still having wifi and ble."* And: *"We can do some initial porting and FX engine validation
against the bare P4 boards and then do the wireless bringup when we have the ones with the
attached C6."*

**The design in one paragraph.** The C6 stays what it is today on the network side: our netstack,
TLS, wss, BLE provisioning (Improv/GATT), mDNS, the Wi-Fi rejoin policies and the OTA loader, all
of it already covered by HITL. It stops rendering. Every player message (effects, uniforms, maps,
textures, video, keypoints) goes, still encoded as the client sent it, over a 4-bit SDIO link to
the P4. The P4 runs the player core: `fx_vm` with a PIE SIMD tier, the decks and maps, and 16
WS2812 strips from one PARLIO 16-bit DMA stream. Replies and pushes come back the same way. The
protobuf envelope (`shared/protocol/proto/ledmapper.proto`) is unchanged on the wire, so the app,
the agent and the bridge see one player.

Related docs: the P4 accelerator survey is §9 of `docs/design/fx-gpu-lowering.md` (PR #368,
branch `agent/fx-gpu-lowering`). This doc relies on it and does not repeat it. Also relevant:
`ota.md`, `live-control.md`, `wifi-rejoin-policy.md`, `ram-budget.md`, `memory-regions.md`,
`fx-perf-study.md` and `sensor-core.md`.

Fact tags. **[V]** means checked against a primary source; §8 lists the sources. **[V-pin]**
means read from the ESP-IDF build we pin: the `esp32-arduino-libs` zip in
`patches/embedded-esp32-libs-c6-c3.patch`, IDF release/v5.5, arduino-esp32 3.3.10. **[U]**
means unverified, to be confirmed at bring-up. **[E]** means an estimate.

## 1. Why split

**The C6 has run out of room on one core.** It is an RV32IMAC at 160 MHz with no FPU. The same
core runs the radio, TLS, the network loop and the renderer. These measurements set the ceiling:

| Limit on the C6 today | Measured | Source |
| --- | --- | --- |
| VM cost | about 54 cycles of dispatch per opcode, plus a fixed 1,790 cycles per LED per VM invocation; soft-float on every float op | `fx-perf-study.md` |
| LEDs | 2048 LEDs are CPU-bound at about 20 fps, even for trivial shades (about 3.8k cycles per LED) | #335, `ram-budget.md` |
| Heap | with the 1024 + 1024 config, the minimum free heap is 29.7 KB against a 24 KB floor | `ram-budget.md` "LED capacity" |
| Render vs network | loop and render priorities had to be tuned by hand. With the loop below render, video p50 was 523 ms and the session died; heavy-effect control is 58 ms input → applied (p50) and 123 ms to photon, dominated by the frame boundary wait and a 59 ms render | `wifi-rejoin-policy.md`, `live-control.md`, PR #366 |
| Output | two WS2812 channels (PARLIO, 2 lanes) | #261 |

**What the P4 adds.** Two HP RISC-V cores (RV32IMAFC plus Espressif's PIE SIMD extension). They run
at 400 MHz on die revision v3.x and 360 MHz on v1.x [V-pin]. It has a single-precision FPU and
768 KB of on-chip L2MEM. The IDF build we pin carves 256 KB of that out as L2 cache [V-pin], so
about 512 KB is left for static data and heap. It also has:

- 16 or 32 MB of in-package PSRAM, at 200 MHz in our config [V, V-pin];
- one PARLIO TX unit, up to 16 bits wide [V];
- the BitScrambler, JPEG and PPA blocks;
- an Ethernet MAC (RMII);
- USB: 2.0 HS OTG, FS OTG and USB-Serial-JTAG [V].

It has no internal flash, and **no radio** [V]. §9 of `fx-gpu-lowering.md` surveys these blocks
for FX use.

**Why split, and not a P4 alone.** The P4 needs a radio, and the C6 already has a radio stack that
works and is tested. Splitting the work gives the render path its own core, isolated in hardware.
The render-isolation machinery of #371, the loop priorities and the frame-wait sleeps all become
unnecessary on the C6. The P4 keeps rendering through anything the network does, including
rejoins, PBKDF2 and a C6 reboot. That makes the owner rule in `bootloop.txt` ("effects must keep
running") true by construction.

## 2. Architecture

```text
 phone / agent / bridge
        │  wss (TLS) · BLE GATT · OSC udp/9000 · mDNS
┌───────▼────────────────────────── ESP32-C6 (network front end) ────────────┐
│ netstack (802.11 MAC, WPA, TCP) · mbedTLS · wss · BLE Improv/GATT · mDNS     │
│ Wi-Fi rejoin policy · TLS identity · NVS creds/name · OTA loader + app        │
│ router: envelope_arm(frame) → handle locally | forward on the link            │
└───────┬─────────────────────────────────────────────────────────────────────┘
        │  SDIO 4-bit, 40 MHz (P4 = host, C6 = slave) · C6 EN driven by the P4
┌───────▼────────────────────────── ESP32-P4 (player) ────────────────────────┐
│ link endpoint · Player session core (ledmapper_player) · fx_vm + PIE tier    │
│ decks / crossfade / keypoints · maps + topology · textures/video (JPEG/PPA)  │
│ live mailbox · OSC mailbox · sensors (IMU) · littlefs (maps, effects)        │
│ PARLIO 16-bit + BitScrambler → 16 × WS2812                                   │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Roles

| Concern | C6 | P4 |
| --- | --- | --- |
| Wi-Fi, TCP, TLS, wss, mDNS | **owns** (unchanged netstack) | none |
| BLE Improv provisioning, BLE GATT player transport | **owns** | none (GATT frames are forwarded like wss frames) |
| Wi-Fi rejoin policy (`auto` / `fixed` / `manual` / `offline`), join guard | **owns** (unchanged) | none |
| TLS identity, per-device cert, Wi-Fi creds, device name | **owns** (NVS) | gets a copy of the name |
| OTA | own loader + app (unchanged scheme) | its own A/B slots, image relayed by the C6 (§5.1) |
| Player session, effects, decks, keypoints, maps, topology | forwards | **owns** |
| Rendering and LED output | **none** (drivers compiled out) | **owns** |
| Live mailbox (`set_uniforms` `commit:false`), `ControlAck` | forwards | **owns** |
| OSC udp/9000 | receives and forwards datagrams | parses into the mailbox, applies at frame boundaries |
| Time sync (`time_sync_ping`), effect time base | forwards (answers from its own clock only while the P4 is down) | **owns** (the renderer's clock) |
| IMU / sensor drivers | none (the C6 IMU pins are SDIO pins, §4.4) | **owns** |

### 2.2 Where the split falls in the code

`lm_player_handle` (`firmware/player_app/ffi.rs`) already routes on the envelope arm before it
decodes anything: `envelope_arm(frame)` reads the oneof field number and dispatches. The front-end
build replaces the player branches of that match with "forward this frame on the link". The arm
table becomes:

| Handled on the C6 | Forwarded to the P4 |
| --- | --- |
| `get_tls_info` 45; `set_wifi_policy` 90 / `get_wifi_policy` 91; `ota_*` 70–75 targeting the C6; `set_device_name` 27 (applied, then also forwarded) | everything else: mapping 3–20, effects 21–24 and 36, perf 25–26, textures 28, uploads 29, colour 30–31, JIT 32, hardware config 33–35, pose, time base, crossfade, keypoints 37–44, fps 46, sensors and drivers 48–56, `ota_*` targeting the P4 |
| `hello` 1: forwarded; the C6 patches its own fields into the P4's `Welcome` on the way back | `time_sync_ping` 2: forwarded |

Rules:

- **No re-encode.** The C6 forwards the WS (or GATT) payload byte for byte, and relays the P4's
  `ServerMessage` bytes the same way. The C6 front end needs no player bindings beyond
  `envelope_arm`. Nothing is decoded twice, and nothing on the link has to track proto changes.
- **The P4 builds the `Welcome`.** It knows the player state, features, `fxb_format` and
  `board`. The C6 overwrites only the fields it owns (`mac`, `device_name`, `fw_*` for the
  front end, the `ota` block) and adds a new **`coprocessor`** block: link state, link protocol
  version, the P4's firmware version, and the reason when the P4 is down. A splice like
  `Player::encode_reply` does this without a full decode. While the P4 is down, the C6 sends a
  minimal `Welcome` itself, with `coprocessor.state = DOWN`, and answers forwarded arms with
  `error{code: player_unavailable}`.
- **Pushes.** `perf_report`, `fps_state`, `playback_state` and the like are unsolicited
  `ServerMessage`s from the P4. The C6 sends them to the session that owns the matching request,
  or to the current session. The best-effort drop rule from #353 still holds: a live reply is
  dropped when the TCP send window can't take it, and RX is never blocked.

### 2.3 State and persistence

- **On the P4** (its own SPI flash and littlefs): maps, topology, effects and the effect library,
  keypoints, the colour LUT, the LED and hardware config, the sensor calibration. The P4 boots
  into its stored effect **before** the link is up.
- **On the C6** (NVS, as today): Wi-Fi credentials and policy, the TLS identity, the device name
  (it is authoritative because BLE and mDNS advertise it; the C6 pushes changes to the P4),
  and the OTA state.
- **Migration:** none. P4 boards are new devices. They are provisioned like a C6, over BLE Improv
  to the C6.

### 2.4 Rejected alternative: ESP-Hosted / `esp_wifi_remote`

Espressif's stock answer is ESP-Hosted-MCU. The C6 runs Espressif's coprocessor firmware as a
Wi-Fi/BT NIC, and the P4 runs `esp_wifi_remote`, lwIP, mbedTLS and the BT host. The IDF build we
pin ships it ready-made: the P4 libs link `esp_hosted` and `esp_wifi_remote` with
`CONFIG_ESP_HOSTED_ENABLED`, and the zip carries `hosted/esp32c6-v2.12.8.bin` [V-pin]. Arduino's
`WiFi` on a P4 already works this way.

We don't build on it:

- **It discards the netstack work and its HITL coverage.** That work is the heapless netstack,
  the GTK/RSN fixes for commercial APs, the stale-IP listener fix, the airtime TX pacing, the
  rejoin policies, the TLS region, the per-device cert, the BLE/wss coexistence fixes and the
  single-task wss reliability work. Every one was a field bug that HITL now gates. On
  ESP-Hosted, Wi-Fi, TLS, wss, BLE Improv and the GATT transport would be new code paths on the
  P4, with lwIP and Espressif's stack, and each needs new HITL coverage before it is as good as
  what we have.
- **It moves the network back onto the render chip.** lwIP, TLS and the BT host would share the
  P4's cores with the renderer. That brings back the contention that #371 and #366 spent weeks
  fencing off. Dual cores make it easier, but it is the same class of problem.
- **The C6 would be a black box** on the HITL rig: a prebuilt image we can't instrument with the
  netstack's status lines or JTAG heap watchers.

**Where it still helps:**

- **Bring-up aid.** When the C6 boards arrive, run the stock hosted firmware first. It proves the
  board's SDIO wiring, pull-ups, the reset line and the bus clock with a known-good stack, before
  any of our link code is suspect. The throughput numbers in §2.5 come from exactly this setup.
- **Fallback.** If the SDIO slave cannot coexist with the netstack's DMA and RAM budget on the C6
  (risk R3), ESP-Hosted is the plan B for the radio side. The player split on the P4 would not
  change.

### 2.5 Interconnect

**Use SDIO, 4-bit, P4 as host, C6 as slave.** This is how Espressif's P4 boards and the Waveshare
P4 boards wire the C6. The pinned hosted config defaults to SDIO slot 1, 4-bit, 40 MHz [V-pin].
The bus clock is 4 bits × 40 MHz = 160 Mbit/s; the C6 slave is specified up to 50 MHz [V].
Measured throughput at 40 MHz:

| Measurement | P4 → C6 | C6 → P4 | Source |
| --- | ---: | ---: | --- |
| Raw SDIO transport (no Wi-Fi) | 72 | 80 | Espressif, esp-hosted-mcu docs [V] |
| TCP over Wi-Fi via ESP-Hosted | 32 | 30 | same |
| UDP over Wi-Fi via ESP-Hosted | 50 | 49 | same |
| iperf receive, Waveshare P4-WIFI6-NANO | — | ≈ 36 | r4d10n/esp32p4-c6-wifi-test [V]. At 25 MHz the SDIO bus was the bottleneck |

All figures are in Mbit/s. **Our link is bounded by the raw row**, not the TCP row, because no
Wi-Fi frame crosses it.

esp-hosted-mcu issue #112 is often cited for these numbers. It measures an ESP32-WROOM
coprocessor at 20 MHz, not a C6: raw SDIO was 54 / 64 Mbit/s and TCP about 31 Mbit/s [V]. It is
useful only as a lower bound.

- **SPI with a handshake line is the fallback** if a board wires SPI, or if SDIO misbehaves. The
  link layer in §4.1 is transport-agnostic. Espressif's host-side `esp_serial_slave_link` (ESSL)
  speaks to the C6 over either SDIO or SPI half-duplex, and it is in the pinned P4 libs [V-pin].
- **UART only for control**: boot logs, the C6 ROM download (§5.1) and a last-resort status
  channel. It is too slow for textures.

## 3. Phase A: bare P4 boards (no radio)

**Goal:** prove the toolchain, the player core, the FX engine and LED output on the P4, driven by
the existing protocol and tests, before any wireless work.

### 3.0 Know the silicon first: die revision

The pinned IDF build has **two P4 library sets**, and an image built for one won't boot on the
other [V-pin]:

| Libs variant | Kconfig | Accepted revisions | CPU default |
| --- | --- | --- | --- |
| `esp32p4` | `CONFIG_ESP32P4_REV_MIN_301=y`, `REV_MAX_FULL=399` | **v3.1 – v3.99** | 400 MHz |
| `esp32p4_es` | `CONFIG_ESP32P4_SELECTS_REV_LESS_V3=y`, `REV_MIN_FULL=1`, `REV_MAX_FULL=199` | v0.1 – v1.99 | 360 MHz |

Note that the v3 set starts at **v3.1**, not v3.0. Espressif's documentation agrees:

- **No shared image.** "v1.x and v3.x chips cannot share the same firmware image" [V].
- **IDF support.** v3.x needs ESP-IDF v5.5.3+ or v6.0+ [V]. Our pinned SDK is release/v5.5, and the
  from-source pieces are v5.5.4.
- **Kconfig.** `CONFIG_ESP32P4_SELECTS_REV_LESS_V3` defaults to n. `CONFIG_ESP32P4_REV_MIN`
  defaults to `ESP32P4_REV_MIN_301`, and 360 MHz is only selectable with `LESS_V3` [V].
- **Mismatch.** A wrong-revision image is refused by the bootloader ("Image requires chip
  rev >= v3.0, but chip is v1.0") [V].

The die revision also decides what the BitScrambler can do (§3.5). Check every board before
anything else, and record the result in the HITL catalog notes. Use whichever of these is
easiest:

- **esptool.** Espressif's docs say to use `esptool chip-id` (esptool v5 spelling; v4 is
  `esptool.py --chip esp32p4 chip_id`) [V]. The exact output line differs between esptool
  versions. Look for the revision `vX.Y` [U: the exact P4 wording].
- **The second-stage bootloader log.** Any IDF app prints `boot: chip revision: v1.3` on the
  console at reset [V].
- **The chip marking.** The manufacturing-code letter on the package gives the revision:
  A = v0.0, C = v1.0, E = v1.3, F = v3.0, G = v3.1 [V]. The "P4X" in a board name (for example
  ESP32-P4X-Function-EV-Board) means a v3.1+ chip [V].
- **At runtime.** `efuse_hal_chip_revision()` returns major × 100 + minor. `esp32p4_hello`
  prints it (§3.1).

**Expect a mix of revisions:**

- The Waveshare ESP32-P4-WIFI6 uses an ESP32-P4NRW32, a non-X, v1.x-era part [V, vendor wiki].
- The ESP32-P4-Function-EV-Board v1.5.2 is v1.x. The P4X version is v3.1+ [V].

On a v1.x board, Phase A builds against `esp32p4_es`. That still covers the whole player, but
**not** the BitScrambler expansion path (§3.5).

### 3.1 Toolchain and target bring-up (Bazel / Nix)

The C3 port (#212, #216) is the template. It needed four things, and the P4 needs the same four:

1. **SDK libs.** `patches/embedded-esp32-libs-c6-c3.patch` unzips only `esp32c6/*` and
   `esp32c3/*` from the libs zip. That restriction exists because the full zip unpacks to about
   10 GB. Add `esp32p4/*` (or `esp32p4_es/*`, chosen per §3.0) and stage it at `sdk/esp32p4`.
   Measure the extra disk use first: each variant has about 4,200 entries, a size similar to the
   C6's.
2. **Platform and C toolchain.** In the style of `patches/embedded-esp32c3-build-target.patch`
   (949 lines): an `@embedded//platforms:is_esp32p4` constraint, a `cc_toolchain` with
   IDF v5.5.3's `-march=rv32imafc_zicsr_zifencei_xesploop_xespv -mabi=ilp32f` [V], a
   `libs/board:esp32p4` and bootloader, and
   the `esp32p4` section of the generated `arduino_esp32` scaffold. **The ABI changes:**
   `ilp32f` passes floats in FPU registers, so every object in the image must be built
   `ilp32f`: our C/C++, Rust, mbedTLS and the prebuilt libs. The prebuilt P4 libs already are.
   `libesp_driver_bitscrambler.a` from the pinned zip reads `single-float ABI`, with
   `Tag_RISCV_arch` `rv32i…_f2p2_c2p0…_xesploop1p0_xespv2p2` [V-pin, readelf].
3. **Rust triple.** Add `riscv32imafc-unknown-none-elf` to `rust.toolchain(extra_target_triples)`
   in `MODULE.bazel`. It is a tier-2 target with `llvm-abiname = ilp32f`, and `rust-std` for
   our pinned 1.85.0 is published [V]. We use the bare target with IDF's C drivers, not esp-hal.
   That matters: esp-hal supports only P4 v3.0+, and marks PARLIO and the BitScrambler as
   unsupported on the P4 [V]. The netstack is not linked on the P4, so its C6 register map
   (`lmac.rs`, `regs.rs`, `ccmp.rs`) doesn't matter here.
4. **Per-chip constants.** `led_caps.bzl` gets a P4 branch (§3.5: 16 channels × 1024), and the
   P4 build gets a `board_caps` textproto of its own.

**Memory map differences that bite** (all [V-pin] or from the TRM [U]):

- **The C6 linker work doesn't carry over.** It is C6-specific: the
  `sections.ld` override, IRAM pinning of the shade entry and the PMP TOR exec window for the
  JIT (#381). Start the P4 on the stock linker script.
- **L2MEM vs PSRAM placement is the main tuning knob.** Hot per-LED caches, the VM stack and the
  PARLIO frame go in L2MEM. Maps, textures, the effect library and video frames go in PSRAM.
  Allocate with `MALLOC_CAP_INTERNAL` / `MALLOC_CAP_SPIRAM` explicitly, and never through a
  default malloc that might land a DMA buffer in PSRAM without the alignment rules.
- **Caches and DMA.** The P4 has L1 and L2 caches in front of PSRAM and flash. A DMA buffer the
  CPU wrote has to be written back (`esp_cache_msync`) before PARLIO or SDIO reads it, and it
  must be cache-line aligned. The pinned config uses 128 B L2 lines [V-pin]. This is new: on
  the C6, DMA from internal SRAM needed no cache maintenance.
- **The JIT.** `fx_jit` emits RV32IM, which the P4 executes. The exec window, the PMP and the
  I-cache sync after writing code all differ from the C6. **Phase A runs with `set_jit` off.**
  Port the JIT only if the scalar VM is still the bottleneck after the PIE tier.
- **The console.** The pinned P4 config uses UART0 as the primary console and USB-Serial-JTAG as
  the secondary [V-pin]. The C3 lesson was to fix the console before anything else: an app that
  takes over USB-Serial-JTAG drops the host CDC.

**The first image is `//firmware/p4:esp32p4_hello`**, not the player. It prints the chip
revision, the CPU frequency, the L2MEM and PSRAM heap sizes and the flash size. It then runs an
`fx_vm` known-answer digest (§3.4) and blinks two PARLIO lanes. It validates the toolchain end to
end before the player's dependency graph is involved.

### 3.2 Player core on the P4

The player is `player_app_netstack` with its transports swapped. The new
`//firmware/player_app:esp32p4_player` target links:

- **Kept:** the Rust session core (`ledmapper_player`, `fx_vm`, arena, keypoint, osc, store,
  fps), `ffi.rs`, the render task and `main.cpp`'s render loop, under `LM_CHIP_ESP32P4`.
- **Dropped:** the netstack, BLE, Improv, mbedTLS, `wifi_ffi`, `tls_region`, the OTA loader
  hooks and `ws2812_rmt.cpp`.
- **New:** the link endpoint (the Phase A transport of §3.3, the SDIO host in Phase B) and
  `ws2812_parlio16.cpp` (§3.5).

**Use both cores.** `update()` runs once per frame. The per-LED `shade()` loop splits into two LED
ranges, one per core, with a barrier before the encode. Shading is meant to be per-LED
independent: the per-LED caches from #350 are indexed by LED. Any VM state that `shade()`
writes (buffers, memo slots, counters) must be per LED or per core. Audit this before
enabling the split. **Gate:** the 2-core frame digest
equals the 1-core digest for every corpus effect (§3.4).

**Sizing.** 16 × 1024 = 16,384 LEDs. At about 31 B per LED (`ram-budget.md`), the per-LED buffers
take about 500 KB. That is too much for L2MEM next to the PARLIO frame, so:

- `FX_LED_TOPO` and `FX_LED_POS` go in PSRAM, read sequentially, which suits the cache.
- `leds` and the encode buffers stay in L2MEM.

Measure before tuning this. `board.max_leds` on the P4 comes from the same
headroom-at-boot rule as on the C6.

### 3.3 Temporary control path (no C6)

Phase A needs the existing protocol and the existing HITL harnesses (`fx_bench`, `led_timing`,
`led_capture`, `player_probe`) to drive a radio-less P4. The proposal is to **run the Phase B link
protocol (§4.1) over USB from day one**:

- **On the P4.** A link endpoint over USB-Serial-JTAG CDC, or over UART0 if the console fight
  from the C3 recurs. It carries the §4.1 framing (COBS plus CRC on a byte stream).
- **On the host.** `tools/p4_link_bridge.py` serves `ws://127.0.0.1:<port>/ws` and, optionally,
  `wss://` with a throwaway cert. For each WS message it emits one link `PLAYER` frame, and it
  relays the replies and pushes. In other words, it plays the C6's role.
- **What this tests.** The harnesses already accept a URL: `player_probe` takes `ws://` or
  `wss://` with `--insecure`. They connect to the bridge and can't tell the difference.
- **Why this path.** In Phase A it exercises the P4 half of the link (framing, routing, the
  `Welcome` splice, pushes, flow control) with the existing tests. Phase B then only swaps the
  byte transport.

**Ethernet alternative.** It applies to boards with an RMII PHY: both Function EV Boards have one
(IP101GR on the P4X), and so does the Waveshare P4-ETH [V]. It needs lwIP and a WS server on the
P4. That is a second network stack we don't otherwise want, so treat it as optional. It earns
its place later as a wired Art-Net/sACN input on installations, not as the bring-up path.

**Throughput check.** USB-Serial-JTAG is a full-speed (12 Mbit/s) endpoint. Expect well under
1 MB/s [U]. That is plenty for maps, effects and control. If Phase A needs video-sized
transfers, move the link to a TinyUSB CDC on the **HS OTG** port (480 Mbit/s), which all the
boards above expose [V]. The framing doesn't change.

### 3.4 FX engine validation

The C6 goldens in `web/tests/testdata/device-bench-esp32c6{,-jit}.json` are **cycle** goldens: a
device-measurement bundle plus margins. They are not pixel goldens. Correctness therefore has to
be anchored on the host, where `fx_vm` already runs in `rust_test` and where
`fx_perf_bench`'s `host_test` cross-checks native against the VM per LED. The plan:

1. **A frame digest (new, host and device).** For each corpus program — the `fx_perf_bench`
   study, agent and valid groups, plus the `fx_bench` calibration set — run N frames at a fixed
   time step, map and uniforms. Hash every LED's `Rgb8` (FNV-1a or CRC32) per frame. The host
   `rust_test` commits the digests as a golden (`testdata/fx_digest.json`). Each device image
   recomputes them and logs `fxdg <name> <frame> <hex>` lines.
2. **Scalar first, bit-exact.** The P4 build of `fx_perf_bench` (an `esp32p4_bench` image; the
   bench is already radio-less) must match the host digests **exactly**. The same digest
   generator then runs on the C6 bench image too, which closes the loop: host = C6 = P4. Why
   bit-exactness is expected even though the P4 has an FPU and the C6 uses soft-float:
   - IEEE add, sub, mul, div and sqrt are correctly rounded both ways.
   - Rust never contracts `a*b+c` into an FMA unless asked.
   - `as` conversions saturate by definition.
   - The VM's transcendentals are our own LUTs and polynomials, not libm.

   Where it can still differ:
   - **NaN payloads.** RISC-V F returns the canonical NaN; compiler-rt soft-float can propagate
     a payload. This is visible only if a program reinterprets float bits (hash of a float
     slot, `F2I` of NaN is defined, bit-casts).
   - **Subnormal handling** in the P4 FPU [U: the spec requires IEEE subnormals; confirm on
     silicon].

   Any mismatch is a bug report, not a tolerance: the digest names the program and frame. Run
   one more check with `-C target-feature=-f` (soft-float on the P4). It splits "FPU numerics"
   from "port bug".
3. **Performance goldens.** Run `fx_bench` against the P4 over the Phase A bridge. Commit
   `device-bench-esp32p4.json` as the P4's own golden: same programs, LED counts and margins
   policy. Report the ratio against the C6 golden per program, with 1 core and 2 cores.
   - **Expected [E]:** 2.5× from the clock alone. Add about 2× from the second core on the shade
     loop. Float-heavy effects gain much more from the FPU: soft-float ops cost 50–250 cycles on
     the C6.
   - **The budget to beat:** 2 × 400 MHz is 800 Mcycles/s. At 16,384 LEDs × 30 fps that is about
     1,600 cycles per LED-eval. The C6's fixed per-LED VM overhead alone is 1,790 cycles. **The
     scalar VM will not reach 16 × 1024 at 30 fps on typical effects.** That is what the next
     step is for.
4. **PIE tier for the fixed-point kernels.** This is the survey's item 1 and is not repeated
   here. What validation needs:
   - **Work order.**
     1. The fixed output pipeline first: colour correction, brightness, the crossfade blend,
        `RetRgb8` quantisation, and the bit-plane transpose for PARLIO (§3.5). These kernels are
        small and fixed, are integer only, and the LA can check them end to end.
     2. Then a batched VM path: SoA over 8 × i16 or 4 × i32 LEDs, for the fixed-point and hash
        opcodes (`MulFix`, the `fixed8` / `fixed16` ops, `Hash1` / `Hash3`).
   - **Exactness.** These are class 1 ("exact") in the `fx-gpu-lowering.md` §3 numerics policy,
     so the PIE path must reproduce the scalar digests **bit for bit**. No tolerance class
     applies on the P4. Effects that use an op the PIE tier doesn't cover stay scalar per
     program, never per LED.
   - **How to write PIE.** LLVM, and so Rust, doesn't know the PIE instructions. The kernels are
     C with inline asm, or `.S` files, built with the IDF GCC, or `.insn` encodings. They link
     over FFI like the other C pieces.
     - **The `-march` spelling.** IDF v5.3 spelled the extension `xesppie`; v5.5.3 splits it
       into `xesploop_xespv` [V].
     - **No intrinsics.** No C intrinsics are documented [V: Espressif's PIE introduction uses
       asm]. esp-dsp is in the pinned libs [V-pin] and is the reference for idioms.
     - **The toolchain is ready.** The nix toolchain we already use for the C6 assembles PIE
       (R1).
   - **Gates.** Digest equality against scalar, and an `fx_bench` speedup per program with no
     regressions over scalar.

### 3.5 WS2812 output: PARLIO 16-bit + BitScrambler

**The wire format is the C6's (#261), widened to 16 lanes.** The P4 has **one** PARLIO TX unit,
up to 16 bits wide [V], so all 16 strips share one DMA stream and one clock. Expect to write the
driver ourselves, as on the C6:

- Espressif's `led_strip` component has RMT and SPI backends, not PARLIO [V].
- The third-party `ultraled` component drives WS2812 over PARLIO, but needs P4 rev ≥ 3.0 and
  IDF 6.0+ [V]. It is reference code, not a dependency.
- IDF's BitScrambler examples are a loopback demo and a HUB75 panel, not WS2812 [V].

The format:

- **Samples.** 3 samples per WS2812 bit at 2.5 MHz (400 ns per sample: `1` = 110, `0` = 100),
  with whole-frame GDMA.
- **Frame size.** One 16-bit PARLIO word carries one sample for all 16 strips:
  24 bits × 3 samples × 2 B = **144 B per LED index**, so 1024 LEDs per strip is **147,456 B**
  per frame.
- **Wire time.** It is per strip, not per total: 1024 LEDs × 28.8 µs = 29.5 ms, so **about 33 fps
  at 1024 per strip** whatever the strip count. 512 per strip allows about 66 fps, and 256 per
  strip about 130 fps.
- **Padding.** Keep the C6 rule from #261: pad every transfer with low samples to 4 B plus one
  word, or the tail of unaligned frames corrupts.

**Two encoders, built in this order:**

1. **The CPU encoder (works on every die revision).** The CPU (PIE in §3.4) transposes 16 strips'
   bytes into 16-bit bit-planes and writes the 3× expanded buffer directly. That is 147 KB in
   L2MEM, double-buffered if the encode overlaps the wire, or single-buffered with the encode in
   the latch gap. This is the baseline and the fallback.
2. **The BitScrambler encoder (die v3.x).** The CPU writes only the bit-planes: 48 B per LED
   index, 48 KB at 1024. The BitScrambler, bound to the PARLIO TX DMA, expands each 16-bit
   plane word into the three samples (`0xFFFF`, the word, `0x0000`). That cuts the buffer to a
   third and takes the expansion off the CPU. PARLIO TX binds a program with
   `parlio_tx_unit_decorate_bitscrambler()` [V]. Two caveats:
   - **Die revision.** Before rev 3.0, a BitScrambler-decorated PARLIO stream "must have the same
     length as the original bitstream" [V]. So the 1-in, 3-out expansion needs **v3.x**.
   - **Program size.** Programs are limited to **8 instructions**, plus a 2 KB LUT [V].
     **Gate this first.** Write the `.bsasm` expander, check that it fits and assembles, and run
     it in the driver's loopback mode (IDF's BitScrambler loopback example). Compare
     memory-to-memory against the CPU encoder's buffer before attaching PARLIO. If it doesn't
     fit in 8, look at the LUT path, then try two passes. If neither works, the CPU encoder
     ships.
   - **Clock.** The PARLIO output clock limit isn't stated in the docs; the source clock is
     160 MHz [U]. Our 2.5 MHz sample clock is far below any plausible limit.

**Validation on the logic analyzer.**

- **Sample rate.** The rig's FX2 samples at up to 24 MHz. A 400 ns sample is 9.6 analyzer samples,
  which is enough for WS2812 (and not for SPI, which this doesn't need).
- **Tools.** Use the existing `//pi/hitl/harness:led_timing` (per-frame start, duration, LED count,
  gaps, runt and split flags) and `led_capture` / `--pixels` with `ledTimingRamp.fxb`.
- **Which lanes.** The analyzer can't watch 16 lanes at 24 MHz. It watches the lanes its channel
  map exposes (two today: `--split`). Rotate lanes across runs: 0 + 1, then 7 + 8, then 14 + 15.
  The lane-swizzle bugs live at the edges.
- **Gate.** Zero bad frames over 30 s per mode, as #261 achieved, with the ramp decoding to the
  right pixel on each watched lane.

**Pins.** Any 16 free GPIOs through the GPIO matrix. Avoid strapping pins, USB, the SDIO-to-C6
group on Phase B boards (§4.4) and flash/PSRAM pins. Each board gets a `board_caps` textproto
with its safe pins. **Level shifting** to 5 V (for example 2 × 74HCT245) is a board concern
(§5.3). Dev boards drive 3.3 V, which most strips accept on short leads.

### 3.6 Phase A exit criteria

- `esp32p4_hello` boots, reports the revision, CPU, L2MEM and PSRAM figures, and passes its digest.
- `esp32p4_player`, driven through `p4_link_bridge`, passes `player_probe`. It accepts a map, an
  effect, uniforms and a texture, and it reconnects.
- The scalar digests equal host = C6 = P4 for the whole corpus, with 1 and 2 cores.
- `device-bench-esp32p4.json` is committed, with the P4/C6 ratio table.
- The PARLIO CPU encoder has zero bad frames on the LA. The BitScrambler gate has a result,
  whether pass or fail.
- At least one PIE kernel from the output pipeline is digest-exact and measurably faster.

## 4. Phase B: P4 + C6 boards

### 4.1 The SDIO link protocol

**Layers:**

1. **Bus.** On the C6, IDF `sdio_slave` in packet mode (`libesp_driver_sdio.a`, in the pinned C6
   libs [V-pin]). On the P4, `sdmmc` host plus ESSL (`libespressif__esp_serial_slave_link.a`
   [V-pin]). ESSL gives us the slave's receive-buffer count, packet reads and the slave-to-host
   interrupt on DAT1, and it speaks SPI-HD for the fallback.
2. **Link frames** (ours). They are the same over USB in Phase A, SDIO in Phase B and SPI as the
   fallback. On byte streams (USB, UART) frames are COBS-delimited. On SDIO and SPI, one frame is
   one packet.

**Frame header** (12 B, little-endian):

| off | size | field | |
| --- | --- | --- | --- |
| 0 | 1 | `ver` | link protocol version (major) |
| 1 | 1 | `type` | `PLAYER` (ClientMessage bytes), `REPLY` / `PUSH` (ServerMessage bytes), `LINK` (link control), `BULK` (chunked stream), `LOG` (P4 console lines) |
| 2 | 1 | `lane` | 0 = live, 1 = bulk |
| 3 | 1 | `flags` | `MORE` (fragment follows), `ACK_REQ` |
| 4 | 2 | `session` | which C6 client session (wss socket or GATT); replies are routed by it |
| 6 | 2 | `seq` | per-direction, per-lane sequence number (loss and reorder detection) |
| 8 | 2 | `len` | payload bytes |
| 10 | 2 | `crc` | CRC-16/CCITT over the header and payload |

SDIO has bus CRCs, so the link CRC is there for the SPI and UART transports and for end-to-end
buffer bugs. It costs about 1 µs per KB on either core [E].

**Max frame and fragmentation.**

- **Frame size.** The link MTU is **4,096 B of payload**, which matches the existing chunk sizes
  (`ota_chunk` ≤ 4096, the `upload_chunk` windows). The C6 SDIO receive buffers are sized to one
  frame.
- **Forwarding.** A WS message larger than the MTU is forwarded as `MORE`-flagged fragments as it
  is decrypted. **The C6 never reassembles a player message** (cut-through). The P4 reassembles
  into PSRAM. This needs the netstack's WS receive path to release a frame in pieces; today it
  buffers one whole frame. It is a Phase B follow-up, not a day-one requirement.
- **What this unlocks.** Today the largest message a C6 can accept is set by its WS buffer
  (about 6 KB), which is why `HITL_CHUNK_BYTES=1024` and the client-side chunking exist. With
  cut-through, the **P4's** memory sets the ceiling instead. A 2048-LED map, a big `.fxb` or a
  256 × 256 texture can be one message. Clients keep chunking until a feature flag (`big_frames`)
  says the device takes more.

**Large transfers (maps, textures, video).**

- **Maps, topology and effects** keep the existing `upload_chunk` protocol, which is stop-and-wait
  per window with a `chunk_ack`. The acks now come from the P4. The bulk lane carries the
  windows, so they can't delay the live lane.
- **Textures and video.** `set_texture` stays fire-and-forget with `texture_ack` (latest-wins,
  bounded in flight). The C6 forwards each frame on the bulk lane. A single-fragment texture
  still queued on the C6 is **replaced** when a newer one for the same `tex_index` arrives,
  the same rule as the live mailbox, so a slow link drops frames rather than queuing them.
  Multi-fragment frames go through cut-through. The client's `texture_ack` window bounds them.
- **Decoding on the P4.** JPEG (hardware) and PPA resize are the survey's path for bigger video
  sources. They need a new `format` value and don't change the link.

**Flow control and lanes.**

- **C6 to P4.** The slave's receive buffers *are* the credits. ESSL reads the count before every
  write, so the P4 host never overruns the C6. The C6 keeps at least **one buffer reserved for the
  live lane**, so a texture burst can't block a knob move.
- **P4 to C6.** The C6 queues send buffers (`send_queue_size`) and raises the host interrupt. The
  P4 drains live before bulk. Pushes and replies to a session whose TCP window is full are
  dropped by the C6 under #353's rule. They are never back-pressured onto the link.
- **Live lane order.** Live-lane frames are always sent before queued bulk frames, in both
  directions. Within a lane, order is preserved, which `seq` checks.
- **Heartbeat.** A `LINK` heartbeat every 100 ms in each direction. Three missed heartbeats mean
  the link is down (§4.5).

**`LINK` control messages:**

- `HELLO`: both directions at link-up. It carries the protocol version (major and minor), the
  MTU, the buffer counts, the build ids, and the P4's player descriptor (features, `board`,
  `fxb_format`). That way the C6 can answer `hello` from cache for a few hundred ms during a P4
  restart.
- `HEARTBEAT`.
- `RESET` (resync).
- `NAME` (device name push, C6 to P4).
- `STATS` (counts and errors for the status line).

**Versioning.** The major version must match. The minor is negotiated down to the lower one. A
release pairs both images, but either chip may run N while the other runs N−1 during an update
(§5.1).

### 4.2 Latency budget

The baselines are the live-control results on the LAN (PR #366, rig-2, 150 LEDs, p50 in ms):

| Stage (heavy effect, wss) | C6 today | P4 + C6 [E] | Why |
| --- | ---: | ---: | --- |
| client pacing | 20 | 20 | unchanged (the client's live channel) |
| uplink (Wi-Fi + RX ring) | 3.3 | ≤ 3.3 | the C6 loop no longer competes with render, so the ring drains at once |
| decode | 3.7 | < 1 | the C6 only peeks the arm; the decode moves to a free 400 MHz core |
| **link** (≈ 60 B frame) | — | **0.1 – 0.5** [U: measure] | the SDIO transfer itself takes a few µs. Interrupt and task wakeup on both sides dominate |
| frame wait (to the next boundary) | 30 | ≈ ½ P4 frame | a frame on the P4 is several times shorter for the same effect (§3.4) |
| **input → applied** | **58** | **≈ 25–35** | |
| render | 59 | one P4 frame | ditto |
| wire (150 LEDs) | 4.7 | 4.7 | WS2812 physics |
| **input → photon** | **123** | **≈ 40–60** | the frame-boundary terms shrink. The link adds well under 1 ms |

The control path's floor stays "wait for the next frame boundary, then one render" (#366). The P4
makes the frame shorter, which shortens both. The link has to stay **under 1 ms p99 for live
frames under bulk load**, and that becomes a gate: `link_latency` in §5.2, run while a texture
stream saturates the bulk lane.

**Video.** Today `video_latency_netstack` measures **20.6 / 27.4 / 34.7 ms** (p50 / p95 / p99)
for 24 × 24 RGB565 at 30 fps (`wifi-rejoin-policy.md`). Over the link:

- A 1,152 B frame adds about 0.1–0.5 ms.
- A 64 × 64 RGB888 frame (12 KB, 3 fragments) adds about 1.3 ms at the raw rate of 72 Mbit/s
  (§2.5), plus per-fragment overhead [E].

The C6's Wi-Fi + TLS receive rate becomes the limit, well before SDIO does. The OTA HITL saw
58 KiB/s through the rig *tunnel*, stop-and-wait. A streaming wss rate on the LAN hasn't been
measured: that's a Phase B measurement. The link is never the video bottleneck at the sizes the
C6 can receive. With the C6 no longer rendering, its loop always runs at full rate. That removes
the starvation failure in `wifi-rejoin-policy.md` (523 ms p50) outright.

### 4.3 C6 firmware: the front-end build

**What changes.** A new `esp32c6_frontend` target. It is `player_app_netstack` with the player core
compiled out under `LM_FRONTEND`. In its place go the link driver and the router of §2.2.

**What stays exactly as it is.**

- **Network:** the netstack, wss, TLS (`tls_region`), BLE Improv and the GATT transport, mDNS,
  OSC receive.
- **Policy and identity:** the Wi-Fi rejoin policy (`wifi_ffi.rs`, arms 90/91, NVS `wifi_pol`),
  the join guard, the per-device cert, the OTA loader and app hooks.

**Render-isolation logic goes away.** The C6 has no render task. The "loop at render priority while
the data plane is active" rule from #371 becomes "loop at the highest app priority, always". The
rejoin policies stay because they are about the network, not rendering. The one behaviour that
changes is a C6 reboot during a rejoin: it no longer blanks the LEDs, because the P4 keeps
rendering.

**What moves out of the C6** (frees heap, IRAM and flash):

| Item | C6 cost today | Source |
| --- | --- | --- |
| per-LED buffers (`leds`, PARLIO frame, `FX_LED_TOPO` / `POS` / `MAPPED`) | 15,992 B at 512, 63,800 B at 2048 | `ram-budget.md` |
| FX decks: `DECK_A` + morph state, video/deck-B aux union, `KP_IO` | ≥ 11.4 KB static (the aux union alone is 11,436 B) | `ram-budget.md` (#285) |
| `FX_TEX_PREV`, FX arena, texture buffers | 8 KB + arena | `c6-ram-audit` notes, `ram-budget.md` |
| shade entry pinned in IRAM | 2,192 B IRAM | #285 |
| the player, FX VM, JIT, keypoints and LED drivers in flash | ≈ 500 KB of the 2.16 MB app | `ota.md` |
| sensor driver task (2.5 KB stack) | the IMU moves to the P4 | `sensor-core.md` |

**What the link adds:**

- the SDIO slave receive buffers: about 6 × 4 KB = 24 KB of DMA-capable SRAM [E];
- the send-queue descriptors (sends are zero-copy from the netstack's buffers, which must stay
  valid until done);
- one link task.

**Expected net [E]:** about +60–100 KB of minimum free heap against today's 2048-LED config
(29.7 KB). The min-free figure stops depending on the LED count at all. Measure it with the
heap census (#271) and the JTAG `ram_audit` watcher, and record the figure in `ram-budget.md`.

**Image size.** The app drops by about 500 KB, to about 1.65 MB [E]. That frees the room
`ota.md` had to give up. One option worth evaluating (not in scope here): grow the loader slot
until BLE fits in the loader again. That would restore BLE provisioning in recovery.

**The DMA and RAM risk** (R3): every byte of the C6's HP SRAM is DMA-capable, and today it is
nearly full. The netstack's own buffers, the HW-AES bounce and the 6.5 KB WS upgrade all compete for it
(`c6-ram-audit` notes). Bring up the SDIO slave with the player already removed, never next to
it.

### 4.4 Pin map and conflicts

**C6 side: fixed.** The C6 SDIO slave pins go through the IO MUX, not the GPIO matrix:

| Signal | C6 GPIO |
| --- | --- |
| CMD | 18 |
| CLK | 19 |
| D0 | 20 |
| D1 (and the interrupt to the host) | 21 |
| D2 | 22 |
| D3 | 23 |

Source: `soc/esp32c6/include/soc/sdio_slave_pins.h` in the pinned C6 SDK [V-pin], and the C6
datasheet [V]. The owner's GPIO18–23 is right. Note the order, though: CMD is 18 and CLK is 19.
The P4 side is wired the other way round (CLK 18, CMD 19).

**P4 side: board-chosen.** The SDIO host on slot 1 goes through the GPIO matrix. The table below
is the Function EV Board's wiring. It matches the defaults in the pinned hosted config
[V, V-pin]. Waveshare doesn't publish its pin numbers, so read them from that board's
schematic [U]:

| Signal | P4 GPIO |
| --- | --- |
| CLK | 18 |
| CMD | 19 |
| D0 | 14 |
| D1 | 15 |
| D2 | 16 |
| D3 | 17 |
| C6 reset (to C6 `EN`), active high | 54 |

**Conflicts with today's C6 firmware:**

| C6 pin | Today's use | Conflict | Resolution |
| --- | --- | --- | --- |
| GPIO20 | WS2812 channel 0 (`LED_DATA_PIN`) | **SDIO D0** | LED drivers are compiled out of the front end, so it never touches GPIO20 |
| GPIO21 | IMU INT (`sensor-core.md`, PixieLamp default) | **SDIO D1 / host interrupt** | the sensor bus is compiled out; the IMU moves to the P4 |
| GPIO6 / GPIO7 | IMU SDA / SCL | none with SDIO | unused on the front end |
| GPIO14 | WS2812 channel 1 | none | unused on the front end |
| GPIO18 / 19 | `led_config.h` says the SuperMini's flash uses them | the SDIO CMD / CLK | **SuperMini-only and irrelevant here**: both the Function EV Board and the Waveshare P4-WIFI6 carry an ESP32-C6-MINI-1 module [V]. Treat the claim itself as unverified: the C6's in-package flash normally sits on dedicated pins |

The front end's `board_caps` must list GPIO18–23 as reserved, so the app's GPIO picker never
offers them. Any build that brings up `sensor_bus` or a WS2812 driver on these pins **must** fail
to compile under `LM_FRONTEND`. A `static_assert` against the SDIO pin set is enough.

**Pull-ups.** SDIO needs external pull-ups on CMD and D0–D3. ESP-Hosted specifies 51 kΩ [V],
and the dev boards fit them. The C6 driver's `SDIO_SLAVE_FLAG_INTERNAL_PULLUP` is a bring-up aid,
not a fix at 40 MHz. Our own board needs them in the schematic.

**C6 programming on the P4 boards.** The C6 is not on USB. It is reachable through:

- its UART0 pads or header;
- `EN`, which the P4 drives on GPIO54;
- the `GPIO9` boot strap.

Whether the board routes `GPIO9` and the C6's UART0 to the P4, or only to a header, decides the
recovery path in §5.1 [U: read each board's schematic].

### 4.5 Boot sequencing and failure modes

**Boot order:**

1. **The P4 boots** and starts rendering the stored effect from its own flash at once, with the
   link down.
2. **The P4 resets the C6.** It asserts the C6 reset line (P4 GPIO54, active high in the pinned
   hosted config [V-pin]) for ≥ 10 ms, then releases it. The hosted config waits 1,500 ms after
   a reset (`CONFIG_ESP_HOSTED_SDIO_RESET_DELAY_MS`) [V-pin], so start there and trim it down.
3. **The C6 boots.** Its app, or its loader in recovery, initialises the SDIO slave before Wi-Fi
   and BLE, so the link comes up in well under a second of C6 boot [E].
4. **The P4 enumerates the card** (CMD5/CMD3/CMD7, bus width, clock) and exchanges `LINK HELLO`.
   The C6 caches the player descriptor.
5. **The C6 starts Wi-Fi and BLE** under its rejoin policy, as today. Clients connect and see one
   player.

**Failure modes:**

| Failure | Detected by | Behaviour |
| --- | --- | --- |
| P4 crash or reboot | the C6 sees missed heartbeats or a new `HELLO` | The C6 keeps the network up and answers `hello` with `coprocessor.state = DOWN`. Forwarded arms get `error{player_unavailable}`, and the status line reports it. When `HELLO` returns, the C6 sends a fresh `Welcome` push so clients resync |
| P4 hang (no reboot) | the P4's own task watchdog reboots it; the C6 sees missed heartbeats | as above. The C6 cannot reset the P4 (no such wire on the dev boards [U]), so the P4's watchdog is the backstop |
| C6 crash or reboot | the P4 sees CMD timeouts or missed heartbeats | **The P4 keeps rendering.** It retries the card and re-`HELLO`s. After 3 failed attempts it pulses `EN`, with backoff 1, 2, 4 … 60 s. Clients reconnect to the C6 as after any reboot |
| C6 in its OTA loader | the loader answers `LINK HELLO` with `role = loader` (if the loader carries the link driver; otherwise the link is down) | the P4 renders; the C6 loader serves OTA as in `ota.md` |
| CRC error or bad `seq` | the receiver | Drop the frame and count it in `STATS`. Live frames are not retried, because latest-wins makes the next one supersede them. Bulk frames are retried by the protocol above, because `upload_chunk` and OTA are already stop-and-wait. Five errors in 1 s trigger a link `RESET` |
| link `RESET` / resync | either side | Re-init the SDIO card and re-`HELLO`. In-flight requests get `error{link_reset}` toward their sessions. Uploads resume at the next `upload_chunk` window, and OTA resumes at its persisted offset |
| version mismatch (major) | `HELLO` | The C6 refuses to forward and reports `coprocessor.state = INCOMPATIBLE` with both versions. The app offers the update (§5.1) |
| P4 storage full or corrupt | the P4 | the P4's own error replies, unchanged from the C6 player's |

**Never reboot to recover.** Recovery is always reset-the-link or reset-the-*other*-chip. No path
blanks the LEDs because the network had trouble (`bootloop.txt`).

### 4.6 Phase B exit criteria

- The stock ESP-Hosted bring-up passes on each board: iperf in the 30–40 Mbit/s range proves
  the wiring.
- `esp32c6_frontend` + `esp32p4_player` pass the existing netstack gates with the forwarding
  in place: provisioning, `loaded_tls`, `live_latency_netstack`, `video_latency_netstack` and
  OTA (C6 side).
- The new `link_soak`, `link_latency` and `link_faults` gates pass (§5.2).
- The C6's min free heap is measured and recorded.

## 5. Phase C: OTA, HITL, product

### 5.1 OTA for both chips

**Recommendation: each chip updates itself, and the C6 relays the P4's image.** The C6 never
writes the P4's flash, and the P4 never writes the C6's application flash.

- **C6: unchanged.** The split loader and app, the manifest, the keyring (ids 0 `release`,
  1 `backup`, 2 `next`), key epochs and the security floor all work as in `ota.md`. A smaller app
  (§4.3) only adds headroom.
- **P4: plain A/B.** The P4 boards carry far more flash than 4 MB: 16 MB on the Function EV
  Board, 32 MB on the Waveshare P4-WIFI6 [V]. Two
  app slots, `otadata`, littlefs and NVS fit with room to spare. The P4 needs **no split loader**,
  because the C6 already plays the role the loader plays on a C6: it stays reachable even when the
  P4 image is bad. Rollback is the IDF bootloader's: `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`
  with `esp_ota_mark_app_valid_cancel_rollback()` called after the health check. **The health
  check:** the link is up and `HELLO` completes, frames render, and the C6 has relayed one
  client `hello` (the C6 app's "lease" rule adapted).
- **Same manifest, same keyring.** The P4 app verifies the 108-byte manifest (ECDSA P-256 over
  bytes 0..44) against a compiled-in copy of the **same** ring, with the same `kRing`
  generator. It does this before it writes the slot, and it reads the slot back through SHA-256
  before it switches `otadata`. It also checks the image header's chip id: `ESP_CHIP_ID_ESP32P4 = 0x0012`, against the C6's
  `0x000D` [V-pin, `esp_app_format.h`]. The target is bound **inside the signed bytes**: use the manifest's spare `flags`
  bits 24–27 as `target` (0 = C6 app, 1 = P4 app). A C6 image can then never be installed on a
  P4, or the reverse, even when both are signed with the same key. The C6 loader learns to refuse
  `target ≠ 0` (a one-line check). Until it does, its existing chip-id check (0x000D) already
  refuses a P4 image. Each chip keeps its own `sfloor` (security floor) and its own key epoch.
- **Wire.** `OtaBegin` gains `target` (new field). With `target = P4`, the C6 app does **not**
  reboot into its loader. It forwards `ota_*` 70–75 on the bulk lane, and the P4 answers
  `ota_status` as the loader does today. The flow is otherwise the same: `RECEIVING` + offset,
  4 KB stop-and-wait chunks, resume at a persisted offset, `INSTALLED`. Throughput is the C6's
  wss rate.
- **Release bundle.** `p4c6-<ver>.tar` carries `esp32c6-frontend-<ver>.ota`,
  `esp32p4-player-<ver>.ota`, `key-epoch.bin`, and a manifest naming the link protocol version
  each image speaks.
- **Update order.** Update the **P4 first**, then the C6. The C6 stays up to relay the P4's image,
  and link-version N/N−1 compatibility (§4.1) covers the gap. The agent's `update_firmware` and
  the web Flash screen sequence the two and show them as one update with two steps.
- **Recovery, by severity:**
  1. A bad P4 image rolls back on its own.
  2. A bad C6 app falls back to the C6 loader. The P4 keeps rendering.
  3. A broken C6 loader, or a C6 that can't boot at all, can be **reflashed by the P4** through
     the C6 ROM download mode: the P4 drives `EN`, holds `GPIO9` low and talks to UART0 with
     `esp-serial-flasher`. **This needs `GPIO9` and the C6's UART0 wired to the P4** (§4.4). If
     a board doesn't wire them, that board's C6 loader is USB/header-only, exactly as on a C6
     today. This path is also how the factory programs the C6 on our own board (§5.3).
- **Why not "the C6 flashes the P4"?** The P4 is the SDIO host, and its boot straps and UART are
  not wired to the C6 on these boards [U]. More to the point, the P4 doesn't need it: A/B plus
  rollback is safer than any external flasher, and the image still travels through the C6.

### 5.2 HITL integration

**SKUs** (`pi/hitl/skus.bzl`, mirrored in `skus.json`; the catalog's `resource_types`):

| SKU | Phase | Capabilities |
| --- | --- | --- |
| `esp32p4` | A | `flash`, `jtag`, `led-strip`, `usb-link` (the bridge of §3.3), `chip:esp32p4` |
| `esp32p4-c6` | B | `flash` (the P4), `jtag` (the P4), `improv`, `wss-app`, `led-strip`, `coproc:esp32c6`, `chip:esp32p4` |

**Discovery.** The P4's USB-Serial-JTAG enumerates with the same Espressif VID:PID as a C6, so
auto-discovery has to read the chip type (`esptool chip-id`) rather than assume a C6
[U: confirm whether the USB product string already differs]. The die revision belongs in the
unit's notes, because a v1.x and a v3.x unit take different images (§3.0). Make it a capability
(`die:v3`) so BitScrambler tests only fan out to v3 units.

**Which existing gates apply:**

| Gate | `esp32p4` (A) | `esp32p4-c6` (B) | Notes |
| --- | --- | --- | --- |
| `fx_bench` (and the Grafana drift pipeline) | ✅ new golden `device-bench-esp32p4.json` | ✅ | the soc label is `esp32p4`; dashboards split by soc already |
| digest gate (new, §3.4) | ✅ | ✅ | host = C6 = P4, exact |
| `led_timing`, `led_capture` | ✅ | ✅ | rotate lanes; zero bad frames |
| provisioning (Improv), BLE GATT | — | ✅ | runs against the C6, unchanged |
| `loaded_tls`, wss reliability | — | ✅ | the C6's heap is now player-independent |
| `live_latency_netstack`, OSC | via the bridge, informational | ✅ same budgets | expect wide margins |
| `video_latency_netstack` | — | ✅ | |
| `wifi_cadence` | — | ✅, **stronger** | the assertion becomes "the P4's wire cadence is unchanged while the C6 scans, rejoins, derives a PMK or **reboots**" |
| OTA gates | — | ✅ both targets, plus the cross-target refusal | |
| `ram_audit`, heap census, `stack_bound_test` | — | ✅ the C6 front end | |
| new `link_soak` | — | ✅ | 1 h of bulk + live; zero lost live frames; CRC errors counted |
| new `link_latency` | — | ✅ | live link p99 < 1 ms under a saturating texture stream |
| new `link_faults` | — | ✅ | reset the P4 mid-stream and the C6 mid-stream; assert the §4.5 behaviour, the LEDs never blank, and serial logs from **both** chips on failure (the HITL logs standard) |

**Serial logs from both chips.** The P4's console is on its USB. The C6's console is not on USB on
these boards. The P4 relays C6 log lines as `LOG` link frames, prefixed `[c6]`, so one serial
capture holds both. Until the link is up, the C6's UART header is the only source. A rig unit
should wire it to a second USB-UART.

**Analyzer.** Same broker, same 24 MHz FX2. The channel map decides how many lanes we see.

### 5.3 Product and board story

| Tier | Hardware | Strips × LEDs | Compute | Network |
| --- | --- | --- | --- | --- |
| Splanc (today) | C6 SuperMini | 2 × 1024 (CPU-bound about 20 fps at 2048) | 1 × 160 MHz, no FPU | Wi-Fi 6, BLE |
| **Splanc + P4** (this doc) | P4 + C6 over SDIO | 16 × 1024 at ≈ 33 fps, or 16 × 256 at ≈ 130 fps (wire-bound) | 2 × 400 MHz + FPU + PIE, JPEG/PPA | Wi-Fi 6, BLE (the C6), optional Ethernet |
| Splanc MAX | Pi + FPGA | 20 × 1024 (GPU lowering, 120 fps target) | Pi GPU / 4-core VM | Pi Wi-Fi / Ethernet |

**Boards:**

- **Now:** the dev boards. The bare P4 boards for Phase A. For Phase B, the P4-Function-EV-Board
  class or the Waveshare ESP32-P4-WIFI6 class, which have the C6 on SDIO.
- **Later:** a Splanc board through `hardware/` (atopile, `rules_atopile`). It would have:
  - a P4 module and a C6 module, wired per §4.4;
  - `GPIO9`, UART0 and `EN` of the C6 routed to the P4, for §5.1 recovery and factory
    programming;
  - 16 outputs behind 2 × 74HCT245 with series resistors;
  - one USB-C for P4 flashing and console;
  - an IMU footprint on the P4's I2C;
  - an Ethernet PHY as a stuffing option.

**Power** (R5). The P4 at 400 MHz with PSRAM, plus a C6 with Wi-Fi TX peaks, needs a regulator
sized for the C6's TX bursts on top of the P4's load. LED power stays on its own rail and
injection, as today. Measure on the dev boards with a USB power meter in Phase B before any
board work.

## 6. Risks and open questions

| # | Risk / question | Impact | Mitigation / next action |
| --- | --- | --- | --- |
| R1 | **PIE availability.** No documented C intrinsics: asm or `.S` only [V]. LLVM/Rust can't emit PIE. The toolchain is *not* a blocker: our nix `riscv32-esp-elf` GCC (esp-14.2.0_20260121) accepts `-march=rv32imafc_zicsr_zifencei_xesploop_xespv` and assembles `esp.vld.128.ip` / `esp.vadd.s16` / `esp.vst.128.ip` (checked in-container, 2026-10-26) | Effort for the SIMD tier | Write the kernels in C/asm over FFI; use esp-dsp as reference code; first kernel = the PARLIO transpose (§3.4) |
| R2 | **BitScrambler limits:** the 8-instruction program, die v3.x for length-changing programs, and our boards' revision is unknown | the 3× buffer stays on the CPU | The CPU encoder ships regardless; gate the `.bsasm` expander first in loopback; check the die revision on day 1 (§3.0) |
| R3 | **SDIO slave next to the netstack on the C6:** DMA-capable SRAM, the HW-AES bounce buffers, the 6.5 KB WS upgrade block, the TLS region, interrupt latency from the slave ISR vs the netstack's TX re-arm timing (#358/#360) | the front end is unstable or starves TLS | Bring up the slave only with the player removed (§4.3); `ram_audit` + `loaded_tls` + `link_soak` gates; ESP-Hosted is the plan B |
| R4 | **The two P4 lib variants.** v1.x vs v3.1+ means two images and two bench goldens (the clock differs: 360 vs 400 MHz). The BitScrambler expansion works only on some units. The Waveshare P4-WIFI6 on order is likely a **v1.x** part (P4NRW32) [V], so the Phase B boards may not run the BitScrambler path | test matrix doubles | Standardise on v3.1+ for anything beyond dev (P4X boards); a `die:v3` HITL capability; check the boards on order on arrival |
| R5 | **Power:** P4 + PSRAM + C6 TX peaks on dev-board regulators | brown-outs read as link faults | Measure in Phase B; the link fault gate logs the reset reason on both chips |
| R6 | **Link latency under bulk load** (interrupt + task wakeup on both sides) | live control regresses | the live lane, the reserved C6 buffer, the `link_latency` gate |
| R7 | **USB-Serial-JTAG console vs app transport** on the P4 (the C3 console lesson) | Phase A control path flaky | UART0 for the console, USB CDC for the link, or the reverse; decide in `esp32p4_hello` |
| R8 | **Rust on `ilp32f`:** the hard-float ABI mismatch with any soft-float object | link errors or silent ABI bugs | build everything `ilp32f`; `readelf -A` check in a build test |
| R9 | **PSRAM bandwidth** shared by the CPU, PARLIO GDMA (if the frame lands there) and JPEG/PPA | frame jitter | the PARLIO frame and hot caches in L2MEM; PSRAM only for streamed data |
| R10 | **Proto changes:** the `Welcome.coprocessor` block, `OtaBegin.target`, `error{player_unavailable, link_reset}`, the `big_frames` feature | the app, agent and bridge need small updates | additive only; old clients ignore them |
| Q1 | Owner: standardise the product on v3.1+ silicon only? | | |
| Q2 | Owner: Ethernet in the product (wired Art-Net/sACN) or dev-only? | | |
| Q3 | Owner: does the Splanc + P4 tier keep the IMU (moved to the P4), and the sensor suite plans in `sensor-core.md` §10? | | |

## 7. First steps with the bare P4 boards

The agent work for steps 3–6 can start before the boards are on the desk. Each step's success
criterion is what to look for.

1. **Identify each board.** Plug it into USB and run `esptool chip-id` (esptool v5), or
   `esptool.py --chip esp32p4 chip_id` (v4). Also read the letter in the chip marking (§3.0).
   Write down the board model, the **revision line** (§3.0), the flash size, and whether it has
   PSRAM and an Ethernet jack. **Success:** every board is labelled with `v1.x` or `v3.x`. That
   decides `esp32p4_es` vs `esp32p4` libs, and whether the BitScrambler gate can run on it.
2. **Prove the board with stock IDF, before our build is involved.** With ESP-IDF v5.5:
   - `idf.py set-target esp32p4`;
   - on a v1.x board, `idf.py menuconfig` → *Chip revision* → select "support < v3.0";
   - build, flash and monitor `get-started/hello_world`, then one `parlio` TX example and the
     `bitscrambler` loopback example [U: the example names in v5.5].

   **Success:** the boot log shows the revision and the CPU frequency, and the PARLIO example
   shows a waveform on a scope or the LA.
3. **`//firmware/p4:esp32p4_hello` (our Bazel build, §3.1).** Flash it with the flash bundle the
   same way as a C6 (`bazel run …:esp32p4_hello_flashbundle` or the flash server).
   **Success:** it prints the revision, the CPU, the L2MEM and PSRAM heap totals and
   `fxdg kat ok`, and two PARLIO lanes toggle.
4. **The `fx_perf_bench` P4 image** (`esp32p4_bench`). **Success:** every `fxdg` line matches
   the host golden. Then the cycle table against the C6, with 1 and 2 cores.
5. **The PARLIO CPU encoder on two strips plus the LA** (`led_timing --split`). **Success:** zero
   bad frames over 30 s and a correct ramp on both lanes. Then move the strips to other lanes.
6. **`esp32p4_player` + `tools/p4_link_bridge.py`.** Run `player_probe ws://127.0.0.1:<port>/ws`.
   **Success:** map, effect, uniforms and texture all work, and `fx_bench` runs end to end
   through the bridge.

Everything after that (the BitScrambler gate, the PIE kernels, the 16-lane LA rotation) follows
§3.4 and §3.5. Phase B starts when the C6 boards arrive, with step 2's equivalent: stock
ESP-Hosted iperf on each board.

## 8. Sources

**Pinned build (primary):** `esp32-arduino-libs-idf-release_v5.5-73550728-v6.zip`, as referenced
from `patches/embedded-esp32-libs-c6-c3.patch`. Files read:

- `esp32p4/sdkconfig`, `esp32p4_es/qio_qspi/include/sdkconfig.h`: revisions, CPU, PSRAM, L2
  cache, hosted SDIO pins and reset;
- `esp32c6/include/soc/esp32c6/include/soc/sdio_slave_pins.h`;
- `esp32c6/include/esp_driver_sdio/include/driver/sdio_slave.h`;
- `esp32c6/lib/libesp_driver_sdio.a`;
- the P4 `lib/` list (`esp_driver_bitscrambler`, `esp_driver_ppa`, `esp_hosted`,
  `esp_wifi_remote`, `esp_serial_slave_link`, `esp-dsp`, `sdmmc`), plus `readelf` on
  `esp32p4/lib/libesp_driver_bitscrambler.a`;
- `hosted/esp32c6-v2.12.8.bin`.

**Rust:** `rustc --print target-spec-json --target riscv32imafc-unknown-none-elf`, and
`https://static.rust-lang.org/dist/rust-std-1.85.0-riscv32imafc-unknown-none-elf.tar.xz` (200).

**Espressif documentation:**

- P4 datasheet: <https://www.espressif.com/sites/default/files/documentation/esp32-p4_datasheet_en.pdf>
- C6 datasheet: <https://www.espressif.com/sites/default/files/documentation/esp32-c6_datasheet_en.pdf>
- P4 chip revision v3.x user guide:
  <https://documentation.espressif.com/esp32-p4-chip-revision-v3.x_user_guide_en.html>
- P4 chip identification (package marking):
  <https://docs.espressif.com/projects/esp-chip-errata/en/latest/esp32p4/01-chip-identification/index.html>
- Chip revision handling in IDF:
  <https://docs.espressif.com/projects/esp-idf/en/v6.0.3/esp32p4/api-reference/system/chip_revision.html>
- P4 revision Kconfig:
  <https://github.com/espressif/esp-idf/blob/master/components/esp_hw_support/port/esp32p4/Kconfig.hw_support>
- P4 CPU frequency Kconfig:
  <https://github.com/espressif/esp-idf/blob/master/components/esp_system/port/soc/esp32p4/Kconfig.cpu>
- IDF chip support matrix: <https://github.com/espressif/esp-idf/blob/master/COMPATIBILITY.md>
- P4 toolchain flags (`-march`):
  <https://github.com/espressif/esp-idf/blob/v5.5.3/tools/cmake/toolchain-esp32p4.cmake>
- BitScrambler:
  <https://docs.espressif.com/projects/esp-idf/en/latest/esp32p4/api-reference/peripherals/bitscrambler.html>
- PARLIO TX:
  <https://docs.espressif.com/projects/esp-idf/en/latest/esp32p4/api-reference/peripherals/parlio/parlio_tx.html>
- C6 SDIO slave:
  <https://docs.espressif.com/projects/esp-idf/en/latest/esp32c6/api-reference/peripherals/sdio_slave.html>
- PIE introduction: <https://developer.espressif.com/blog/2024/12/pie-introduction/>
- ESP-Hosted-MCU SDIO wiring, pull-ups and pins:
  <https://github.com/espressif/esp-hosted-mcu/blob/v2.13.1/docs/sdio.md>
- ESP-Hosted-MCU throughput:
  <https://github.com/espressif/esp-hosted-mcu/blob/v2.13.1/docs/performance_optimization.md>
- `led_strip` (no PARLIO backend): <https://github.com/espressif/idf-extra-components/tree/master/led_strip>
- `ultraled`: <https://components.espressif.com/components/pedrominatel/ultraled/versions/0.3.0/readme>

**Boards:**

- <https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32p4/esp32-p4-function-ev-board/user_guide.html>
- <https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32p4/esp32-p4x-function-ev-board/user_guide.html>
- <https://www.waveshare.com/wiki/ESP32-P4-WIFI6>
- <https://www.waveshare.com/wiki/ESP32-P4-ETH>

**Rust and esp-hal:** <https://doc.rust-lang.org/rustc/platform-support.html>,
<https://github.com/esp-rs/esp-hal/blob/main/README.md>.

**Community throughput:** <https://github.com/r4d10n/esp32p4-c6-wifi-test>,
<https://github.com/espressif/esp-hosted-mcu/issues/112> (an ESP32-WROOM coprocessor, not a C6).

**In-repo:** `docs/design/fx-gpu-lowering.md` §3 and §9 (PR #368), `ota.md`, `live-control.md`,
`wifi-rejoin-policy.md`, `ram-budget.md`, `fx-perf-study.md`, `sensor-core.md`, PR #261
(PARLIO), #335 (1024 per channel), #366 (control floor), #371 (render isolation).
