# Mesh HITL rig: conducted RF, real display flip timing

Status: proposed, software built (desk D-92). The hardware is still arriving. Everything below
that names a part number is a recommendation or a question for the owner (§11). Nothing has been
bought.

This rig extends the conducted RF bench (`/workspace/.claude/rfbench/RF-BENCH.md`, the "starter
N = 4" purchase) into a reservable HITL unit that measures what the mesh is for: **every fixture
showing the same frame at the same instant, while links come and go and change length.** The M4
gate (`mesh_apply_at_skew`) measured apply skew against AP beacons, because rig-1 has no
analyser on its strips. This rig measures the light itself, with an overhead camera, and the
data wires, with a 16-channel analyser.

What is in this PR:

| Piece | Where | State |
| --- | --- | --- |
| RP2350 RF controller firmware: line protocol, µs timeline, lease watchdog, safe state, frame-start timestamps | `pi/hitl/meshbench/rfctl/` | builds with pico-sdk 2.1.1 (`rfctl.uf2`, 92 KB); core unit-tested under Bazel |
| Controller simulator (the shipped core behind a simulated HAL) | `rfctl/sim/sim_main.c` | used by every Python test |
| Host driver | `rfctl.py` | tested against the simulator |
| RF scenarios (link flap, chain re-route, partition/heal, delay-line steps, walking fades, meshsim replay) | `scenarios.py` | compile and play on the simulator |
| Display pattern | `meshFlipClock.fx` | not yet run on a device |
| Camera flip timing | `flip_cv.py` (+ `camsim.py`, `accuracy.py`) | 21 tests; Monte Carlo in §7.5 |
| Analyser flip timing | `la_phase.py` | 9 tests |
| Results, HITL metrics, verdict | `bench_core.py` | schema v1 `HITL_METRIC` records |
| Harness + rig agent | `hitl_mesh_bench.py`, `meshbench_rig.py` | `--simulate` runs end to end; hardware path untested |
| HITL catalog entry | `pi/hitl/reserve/catalog-meshbench.json` | placeholders; checked by the PR-24/PR-30 catalog tests |

## 1. Summary

- **Topology.** A host SBC runs `hitl-reserved` with one pin-only composite unit, `mesh-bench-1`.
  The unit holds the RP2350 controller, 4 TinyC6 u.FL DUTs on the conducted matrix, 2 P4+C6
  boards, the camera and the analyser. Each DUT strip has 3 LEDs. The camera looks down on all
  strips and on a sync LED that the controller drives. The analyser taps 11 strip data lines and
  the controller's SYNC line. ![topology](mesh-hitl-rig/topology.png)
- **Links come and go** through the matrix's cut switches and attenuators. **Links change length**
  through the delay bank on pair 0–1: 16 lengths from 0 to 375 cm of cable. A scenario is a timeline
  played by the controller on its own clock. Every step is one latch edge, accurate to about 1 µs.
- **Display flip timing.** Each strip shows a three-scale clock of its own show time. A camera frame
  that integrates a flip gives the flip's instant to a fraction of the exposure. Fits over 1 s windows
  give each fixture's display offset. The spread across fixtures is the measurement.
- **Accuracy targets.**

  | Instrument | Target |
  | --- | --- |
  | Controller | steps within ±1 µs; a step later than 50 µs is a fault |
  | Analyser | per flip 0.1 µs at 10 MS/s; skew between fixtures ≤ 1 µs |
  | Camera | 1 s window skew p95 ≤ 250 µs on the rig. The simulated ideal is 7 µs; the budget leaves room for line-time, linearity and LED-stage systematics |

  The camera is validated against the analyser on the tapped strips: they must agree to 0.3 ms.
  The things checked are the mesh's own target, a 2 ms spread across 3 hops, and the HITL gate,
  p99 below 10 ms + one frame (`docs/design/mesh.md` §6.1, §14). Both are at least 8× above the
  camera target.
- **Results** land in the HITL performance dashboards as `HITL_METRIC` lines under gate
  `mesh_bench`, following the hitlmetrics schema v1.

## 2. Topology

| Block | Role | Connects to |
| --- | --- | --- |
| Host SBC (NanoPi-class, Q1) | `hitl-reserved` + catalog-meshbench; reservation containers; Tailscale | USB: hub(s) with DUTs + controller, camera, analyser |
| RP2350 controller (Raspberry Pi Pico 2) | Every RF switch and attenuator, via a 74HC595 chain; SYNC out; sync LED; 12 frame-start inputs | USB CDC to the host; chain to the RF enclosure; SYNC to analyser D12 |
| Conducted matrix (RF-BENCH starter) | Per pair: cut switch + 3 DSAs + 10 dB pad. Per node: 8-way Wilkinson splitter. Delay bank in series on pair 0–1 | u.FL pigtails from the 4 TinyC6 |
| 4 × TinyC6 u.FL | Conducted mesh nodes 0–3 | matrix node i; USB; 2 strips each |
| 2 × P4+C6 | The P4 renders, the C6 is the radio (`docs/design/p4-c6-split.md`). Over the air unless their C6 has a connector (Q3) | USB; 2 strips now, 16 lanes later |
| Camera | Light-output timing of every strip + sync LED | USB (its own controller, §4) |
| 16-ch analyser | Wire timing of 11 strip lines + SYNC | USB (its own controller, §4) |
| Enclosure | Steady darkness; no 100/120 Hz room-light flicker in the camera | — |

Each P4 board sits in the same mesh over the air at reduced TX power. It needs no matrix port. If
its C6 has an antenna connector, it can take the matrix's AUX port on a node splitter (RF-BENCH §2).

## 3. Wiring and GPIO maps

### 3.1 Strips

Every strip is 3 LEDs of the same part and reel on every board, so LED-stage latency is common
(§7.4). The pattern lights **green only**, at most 20 mA per LED. Wiring from each strip drive pin:
330 Ω series resistor at the board, then data, 5 V and GND, with 20 cm leads. Use a 74AHCT125
buffer per board if the strips are fed at 5 V (WS2812B VIH = 0.7 VDD is marginal at 3.3 V). The
analyser and the frame-start inputs tap the **3.3 V side**, through 1 kΩ.

**TinyC6 u.FL** (C6 firmware: 2 channels, `firmware/player_app/led_caps.bzl`):

| Board | Strip | GPIO | Analyser | FSTI |
| --- | --- | --- | --- | --- |
| c6-0 … c6-3 | s0 | GPIO20 (firmware default ch0) | D0, D2, D4, D6 | 0, 2, 4, 6 |
| c6-0 … c6-3 | s1 | GPIO14 (firmware default ch1) | D1, D3, D5, D7 | 1, 3, 5, 7 |

That is every strip-drive output the C6 firmware has. Check that the TinyC6 brings GPIO20 and
GPIO14 to its pads (Q4). If not, pick two `PIN_SAFETY_RECOMMENDED` pins from
`board_caps.textproto` (0–3, 10, 11, 21–23) and set them with `set_hardware_config`.

**P4+C6 (Waveshare ESP32-P4-WIFI6 class, `board_caps_p4.textproto`).** The firmware drives 2
PARLIO lanes today. The planned encoder drives 16. Wire all 16 now, so the rig doesn't change when
the encoder lands:

| Lane | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GPIO | 20 | 21 | 22 | 23 | 26 | 27 | 32 | 33 | 46 | 47 | 48 | 2 | 3 | 5 | 28* | 29* |

\* Free only with Ethernet off (IP101 RMII). The SDIO pins 14–19, C6 reset 54, USB 24/25 and
UART0 37/38 are never used.

Analyser taps on the P4 boards:

| Analyser | Board | Lane |
| --- | --- | --- |
| D8 | p4-0 | 0 |
| D9 | p4-1 | 0 |
| D10 | p4-0 | 1 |
| D11 | p4-0 | 15 |

D10 and D11 against D8 measure PARLIO lane skew. FSTI 8–11 mirror D8–D11.

### 3.2 Analyser channels

| Channels | Signal |
| --- | --- |
| D0–D7 | c6-0…3 s0/s1 |
| D8, D9 | p4-0 lane 0, p4-1 lane 0 |
| D10, D11 | p4-0 lanes 1 and 15 |
| D12 | controller SYNC (GP7) |
| D13 | camera strobe, if the camera has one (gives exposure timing directly) |
| D14, D15 | spare (a DUT debug pin for render-vs-output splits) |

GND goes to the controller, which shares ground with the hub. The map lives in the catalog
(`HITL_LA_MAP`).

### 3.3 Controller (Pico 2, RP2350A)

| Pin | Function |
| --- | --- |
| GP2 / GP3 / GP4 | SPI0 SCK → all 595 SRCLK / TX → chip 0 SER / RX ← last chip QH' (selftest loopback) |
| GP5 | RCLK (latch), all chips |
| GP6 | /OE, all chips, **10 kΩ pull-up**: outputs hi-Z until the safe vector is latched |
| GP7 | SYNC out (toggles at every commit) → analyser D12 |
| GP8 | sync LED (board device `syncled`), in the camera's view, through a transistor + 330 Ω |
| GP10–GP21 | FSTI 0–11, frame-start timestamp inputs (pull-down; taps through 1 kΩ) |
| GP25 | on-board LED: blinks 2 Hz idle, 10 Hz playing, solid on a fault |

The chain is **18 × 74HC595, 144 bits**: 108 for the DSAs, 18 for the cut switches, 12 for the
delay bank, 6 spare (`rfctl/board_default.c`). The procurement list has 16 chips, so buy 2 more
(§11.1). Pull every control line to its safe level with a resistor: DSA bits high (31.5 dB) and
switch EN high (all off). The lines then sit safe while /OE is high.

## 4. USB and power budget

| Load | Current (5 V) | Notes |
| --- | --- | --- |
| TinyC6, radio on, 2 strips green | ≤ 0.35 A peak (TX), 0.12 A typical + 0.12 A strips | × 4 → 1.9 A peak |
| P4+C6 board, 16 strips green | ≈ 0.5 A board + 16 × 60 mA = 1.5 A | × 2 → 3.0 A: **strips on a separate 5 V supply**, not USB |
| Pico 2 + 18 × 595 + 18 DSA + 11 switch modules | ≈ 0.25 A | own 5 V 3 A supply (procurement line 13); USB data only |
| Camera (UVC) | 0.25–0.5 A | own controller |
| Analyser (DSLogic class) | 0.3–0.5 A | own controller |

Lessons from rig-1/2/3 (memories `hitl-rig-usb-power-budget`, `hitl-rig-hardware-constraints`):

- Hubs are **self-powered** (≥ 5 V 4 A). The host's own USB budget must never feed DUTs.
- The camera's MJPEG stream (15–30 MB/s at 1280×800, 120 fps) and the analyser's stream
  (16 ch × 10 MS/s = 20 MB/s) **must not share a USB 2 controller**, with each other or with the DUT
  hub. Plan three independent controllers: the DUT hub, the camera, and the analyser. Pi 5 has two
  xHCI controllers on RP1, so it fits only with the analyser on the USB 3 port of one and the
  camera on the other's. This decides the host (Q1).
- After assembly, check `journalctl -k | grep -c 'over-current'` stays flat through a run.

## 5. RF controller (rfctl)

### 5.1 Why an RP2350 and this design

The controller plays the scenario on its own clock, so USB and host jitter never reach the RF
timing. An RP2350 with no radio cannot leak into the bench. The 595 chain makes every line one
latch edge: all switches and attenuators of a step change in the same instant. SYNC and the sync LED
mark that instant for the analyser and the camera.

### 5.2 Device model

`list` reports the board table. The host never hard-codes it. Each device is one of three kinds:

| Kind | Value | Example |
| --- | --- | --- |
| `switch` | an index into a code table of raw line patterns (any truth table, including "all off") | `cut01` (0 = cut, 1 = through), `dlyA` (0–3 = arm, 4 = off), `syncled` |
| `atten` | parallel DSA, value in dB (0–31.5, 0.5 steps), line i = bit i | `att01a`, `att01b`, `att01c` |
| `atten_serial` | PE4302 serial (CLK, DATA, LE on direct GPIOs) | none on the default board |

**The switch codes are provisional** (HMC7992-class: V1, V2, and an all-off line). They must be
checked against the switches that arrive before first power-up (Q2). The safe state is only safe if
these codes are right.

### 5.3 Protocol (USB CDC, one line per command, ≤ 255 bytes)

An optional `@tag` prefix is echoed on every line of the reply. A reply ends with `ok …` or
`err <code> <text>`, where code is one of `unknown_cmd`, `bad_arg`, `unknown_dev`, `range`, `busy`,
`order`, `full`, `line_too_long`.

| Command | Effect |
| --- | --- |
| `hello` | `ok rfctl proto=1 board=starter-n4 devices=27 chain=144 timeline_cap=8192 edge_lines=16` |
| `list` / `state` / `get <dev>` | the device table / every value + chain hex / one value |
| `set <dev> <v> [<dev> <v>…]` | immediate, all pairs in **one latch**; refused while playing |
| `safe` | stop the timeline, every device to its safe value |
| `at <t_rel_us> <dev> <v> […]` | append a timeline entry. Times must not decrease. Entries with the same time form one step |
| `clear` / `play <t0_us>`\|`+<delay_us>` / `stop` | manage and run the timeline. `play` refuses a first step less than 400 µs away |
| `status` | playing, next/n, now, t0, steps, late_last/max, faults, lease left, sync count, FSTI state |
| `log [n]` | the last steps: scheduled vs actual commit µs |
| `lease <ms>` | watchdog: no command for ms → timeline stopped + safe state + fault |
| `cap <mask> [holdoff_us]` / `capread [n]` | frame-start timestamps: the first rising edge after holdoff, per FSTI line |
| `time` / `ping` | controller µs (the host fits a clock map from ping midpoints) |
| `selftest` | shifts a pattern through the chain twice and compares QH'; outputs never move |
| `latelimit <us>` / `clearfaults` / `bootsel` / `reset` | — |

### 5.4 Timing

The main loop stages a step 400 µs early: it shifts the chain in while outputs are unchanged. A
hardware alarm fires 20 µs before the step. The handler spins to the exact µs with interrupts off,
then raises RCLK, sets the direct GPIOs and toggles SYNC in one SIO write.

- Expected lateness: ≤ 1 µs. It is measured (`log`) and faulted above `latelimit` (50 µs).
- Minimum step spacing: 50 µs. 144 bits at 10 MHz SPI take 15 µs.
- The DSAs settle in about 1 µs. The SP4T switches settle in about 0.1–1 µs. During a delay-bank
  change the path is open for under 1 µs: a link changes length without being cut for longer.

### 5.5 Safe default

- **Power-up.** /OE is high, so the 595 outputs are hi-Z and the pull resistors hold the lines safe.
  The firmware shifts in and latches the safe vector: every DSA at 31.5 dB, every cut open, the delay
  bank at arm 0, the sync LED off. Only then does it drive /OE low.
- A hardware watchdog (500 ms) resets a hung loop back into that state.
- The `lease` covers a dead host or agent. The rig agent always takes one.
- `safe` and `stop` work while playing.

### 5.6 Build and flash

```sh
nix shell nixpkgs#cmake nixpkgs#gcc-arm-embedded nixpkgs#python3 \
  --command pi/hitl/meshbench/rfctl/pico/build.sh /tmp/rfctl-build   # -> out/rfctl.uf2
```

Flash by holding BOOTSEL (or sending `bootsel`) and copying the UF2, or with `picotool load -x`.
The core, the board table, the unit test and the simulator build under Bazel
(`//pi/hitl/meshbench/rfctl:{rfctl_core_test,rfctl_sim}`). pico-sdk's own Bazel support would pull
an ARM toolchain and picotool into the root module for one target, so the firmware stays on
pico-sdk CMake. The CMake flow is verified to build.

## 6. Scenarios: links that come and go and change length

`scenarios.py` builds on the board's device names. `compile()` does five things:

- merges steps;
- drops values that didn't change;
- prepends the sync-LED start code (toggles at 0, 80, 160, 400, 480 and 800 ms, an unambiguous
  pattern for the camera);
- toggles the LED at every labelled event;
- checks spacing, capacity (8192 entries) and **sneak paths** (RF-BENCH §3).

A cut pair whose two-hop detour through a third node is under 100 dB is flagged, because there the
"cut" is not real.

| Scenario | What happens | Timing | Expected mesh behaviour |
| --- | --- | --- | --- |
| `baseline` | full mesh at 60 dB | 30 s | spread at the floor |
| `link_flap` | pair 01 cut for 3 s every 10 s, 6 cycles | step-exact | full mesh: no re-route needed, spread unchanged |
| `chain_reroute` | chain 0-1-2-3 plus a weak 0-2 backup (85 dB); 1-2 cut at 10 s, healed at 25 s | step-exact | 3 now reached via 0-2: delivery holds, spread holds |
| `partition_heal` | {0,1} \| {2,3} for 20 s | step-exact | islands drift apart (ungated), then converge after the heal (gated: < 2 ms within 30 s) |
| `length_steps` | pair 01 through 0…375 cm, 4 s each | sub-µs switch-over | **no change**: delay is ns against µs MAC timing |
| `walk_fade` | 8 Hz Doppler fading (30 dB deep) + 3–15 dB body dips on pair 01 | 100 Hz updates | rate adaptation without spread excursions |
| `from_meshsim` | replay `meshsim --export-bench` (t, i, j, PL); shift by TX_sim − TX_bench; cut past the edge | as exported | sim and bench agree |

Untested on hardware: whether the starter matrix's real isolation is good enough for "cut" to mean
cut without shield boxes (RF-BENCH §5). Measure it in assembly step 14. Until then, run at reduced
TX power.

## 7. Camera flip timing

### 7.1 Camera

Recommended (Q5): a **global-shutter UVC camera** with manual exposure up to the frame period, at
120 fps: an OV9281 (mono) or OV9782 (colour) USB board, about $60–90. Mono is enough, because the
pattern is brightness only.

Global shutter removes the row offset. A rolling shutter works too (Pi Camera Module 3 at
120 fps), but the line time must then be known to 0.5 % (§7.5). Its readout must also fit the frame
(about 8 µs per row at 120 fps).

Optics:

- Mount the camera about 1 m above a 60 × 40 cm strip area. That gives about 1.8 px/mm, and
  WS2812 LEDs 16 mm apart land about 30 px apart.
- Use a black, non-reflective background and a 1 cm black foam baffle between strips, so one LED's
  light doesn't spill into another's region.
- Fit an ND filter or stop down until a full-on LED sits at about 80 % of full scale with gain at
  minimum.
- Turn off auto-exposure, auto white balance, power-line compensation and dynamic frame rate
  (the rig agent does this).

### 7.2 The pattern (`meshFlipClock.fx`)

With m = floor(time · 80 + 0.01), the 80 fps frame index of the shared show time:

| LED | On while | Duty | Role |
| --- | --- | --- | --- |
| 0 | m mod 5 < 2 | 25 ms of every 62.5 ms | fine phase |
| 1 | ⌊m/16⌋ even | 200 of 400 ms | unwraps LED 0 |
| 2 | ⌊m/128⌋ + ev even | 1.6 of 3.2 s | unwraps LED 1 |

Offsets between fixtures are therefore unambiguous within ±1.6 s.

`ev` is a uniform. A `set_uniforms{apply_at_ms}` that flips it inverts LED 2 off its grid. That
edge is the apply instant on that fixture, so apply skew is measured on the light, not on a log
line.

Why 2-on/3-off rather than a square wave: a 120 fps camera is commensurate with the 80 fps render
grid (25 ms = 3 frames). A 25 ms square wave would put every flip at one exposure phase, possibly
in the inter-frame gap. The 2/3 split puts flips on both grid parities, which is two phases 4.17 ms
apart. At most one of them can be in a gap of under 0.5 ms (test `test_short_exposure_*`).

### 7.3 Estimator (`flip_cv.py`)

1. **Regions.** Each LED's region comes from the assembly layout (boxes for each strip and for the
   sync LED). Or detect them: the temporal-range image goes through a threshold and connected
   components, the idea of `web/src/cv/diffuseDetect.ts` applied to blinking.
2. **Series.** Take the region's mean per frame, linearised by the camera response LUT (§7.4).
   Normalise to x ∈ [0, 1] with plateau levels: the medians of the bottom and top 8 % bands, or
   levels measured in calibration. Note that 2-means fails at 60 fps, where every third frame is a
   partial.
3. **Flips.** Between two plateau frames of opposite state:
   - One partial frame k gives the flip instant directly: rising t = s_k + E(1 − x_k), falling
     t = s_k + E·x_k. Here s_k is the exposure start of that region's row, which includes the
     rolling-shutter offset row·line_time.
   - With no partial frame, the flip was at an exposure edge, and a plateau frame still holds a share
     above 5σ: use that share.
   - Otherwise the flip was in the gap. It is timestamped at the gap middle and excluded from fits.
4. **Offsets.** Each flip gives (t − pattern time) mod period (rising = 0, falling = on-time). A Huber
   line fit over the window gives the offset at the window centre, the drift (DUT clock against
   camera clock), the residual RMS (render jitter + noise) and the standard error.
   - A window is **untrusted** if fewer than 25 % of its flips were timed inside an exposure. That
     is the commensurate-gap trap; untrusted windows are excluded and counted, never silently used.
5. **Skews.** Per-LED differences are unwrapped coarse to fine. Per-flip skews pair each flip with
   the other fixture's nearest flip of the same polarity, so the gate gets a distribution, not a
   mean.
6. **Camera time → controller time.** Fit the sync-LED flips to the controller's toggle instants
   (`bench_core.fit_sync`: tries ±4 index shifts with polarity matching, so a late camera start is
   fine). V4L2 timestamps are used only to number frames, which catches drops. Frame starts are a
   line fit of timestamp against frame number, so host timestamp jitter does not enter.

Camera clock errors common to all regions cancel in skews: start jitter, exposure-length error,
clock offset and rate (test `test_common_camera_jitter_cancels`). Errors that don't cancel are the
row offset, response non-linearity, and per-LED latency.

### 7.4 Calibration (once per assembly, and on any optics change)

1. **Layout.** Light each DUT's strips in turn. `detect_rois` proposes boxes and the operator names
   them. The result is stored as `HITL_MESHBENCH_LAYOUT_JSON` in the catalog.
2. **Response.** Exposure sweep (10 steps, 5–100 % of the frame) with every LED held on → LUT
   (`Response.from_sweep`). Without it, gamma 2.2 costs about 100 µs at a 4 ms skew (the error is
   about (g′ − 1) × skew). With it, the error is 15 µs.
3. **Levels.** Hold all LEDs on, then off, for 1 s each. This is required below 100 fps.
4. **Rolling shutter only.** Line time from one strip laid across 400+ rows. Its 3 LEDs latch at
   the same reset, so their apparent offsets fall on a line whose slope is the line time.
5. **LED stage.** Camera offset minus analyser offset on the tapped strips. That is the data time
   plus the latch time plus the PWM restart, constant per LED part. With mixed parts or reels it
   becomes a per-LED correction.
6. **Zero check.** Two strips of the same C6 (one RMT/PARLIO frame) must read 0 ± 50 µs apart.

### 7.5 Accuracy

Monte Carlo (`accuracy.py`, 60 trials per condition, random true skews within ±4 ms, the estimator
run exactly as on the rig):

![camera accuracy](mesh-hitl-rig/camera-accuracy.png)

| Condition | 1 s window: bias / sd / p95 abs (µs) | 10 s capture p95 abs (µs) | one flip in an exposure, p95 abs (µs) | flips in a gap | untrusted windows |
| --- | --- | --- | --- | --- | --- |
| global shutter 120 fps, E 95 % | -0.2 / 3.8 / 7.3 | 2.8 | 29 | 10 % | 0 % |
| + 1 ms render jitter (FreeRTOS tick) | -6.0 / 89 / 181 | 100 | - | - | 0 % |
| + 1 kHz PWM restart on turn-on | -6.0 / 85 / 174 | 125 | - | - | 0 % |
| ±30 ppm DUT clocks | 1.6 / 4.0 / 8.7 | 4.7 | 29 | 9 % | 0 % |
| 300 µs camera start jitter | 0.0 / 3.6 / 7.1 | 2.3 | 28 | 9 % | 0 % |
| exposure 50 % | 0.1 / 2.5 / 4.8 | 16 | 15 | 52 % | 8 % |
| global shutter 90 fps | -0.1 / 4.9 / 9.8 | 2.5 | 40 | 9 % | 0 % |
| 60 fps, measured levels | 0.4 / 7.7 / 16 | 4.6 | 44 | 17 % | 0 % |
| rolling 120 fps, rows 100/900, line time known | -0.3 / 3.9 / 7.8 | 3.1 | 29 | 8 % | 0 % |
| rolling, line time 2 % off | 128 / 3.9 / 134 | 130 | 40 | 8 % | 0 % |
| gamma 2.2 not linearised | 0.6 / 57 / 97 | 99 | 1315 | 8 % | 0 % |
| gamma 2.2 + response LUT | -1.0 / 13 / 15 | 4.2 | 32 | 5 % | 0 % |
| full frames + MJPEG q85 + ROI detect | -2.7 / 11 / 22 | 16 | - | - | 0 % |

How to read it:

- **Measurement noise is about 4 µs per 1 s window.** The rows with render jitter or PWM are the
  *device's real* frame-to-frame jitter, averaged over a window's 32 flips. The per-flip skew
  distribution keeps the jitter itself, so the p99 gate sees it.
- **The systematics to control are line time** (2 % error costs 128 µs over 800 rows) **and
  linearity.** Both have a calibration step.
- **Stated accuracy:** 1 s skew p95 ≤ 25 µs measurement-limited with the §7.4 calibration. The rig
  target is ≤ 250 µs, which leaves 10× for what the model leaves out:
  - region crosstalk;
  - LED parts that differ;
  - real MJPEG on a real sensor;
  - an exposure that isn't a perfect box.

  The real-recording test (`test_real_recordings`, skipped until a recording with matching analyser
  data is committed) holds camera against analyser to 0.3 ms.
- Not covered by the model: ambient flicker. Use the enclosure.

### 7.6 Tests

`test_flip_cv.py` covers:

- flip instants, and skews across the full ±1.6 s range;
- a step tracked by windows;
- jitter shown in the RMS, not in the mean;
- the commensurate-gap trap flagged, and an incommensurate rate that is fine;
- rolling shutter, with and without the line-time correction;
- 60 fps with measured levels;
- gamma with and without the response LUT;
- common camera jitter cancelling;
- the LED 2 event flip;
- full frames with detection;
- **an MJPEG AVI round trip through OpenCV's decoder** (the recorded-video path);
- the CLI on a recorded file.

A real-camera recording slot is `testdata/recorded/<name>/{video.avi, meta.json, expect.json}`.
Commit the first one from the rig together with its analyser skew.

## 8. Analyser phase (`la_phase.py`)

- **Signals.** The WS2812 data lines (§3.2) plus SYNC. The analyser measures the *wire*: when each
  fixture's frame data starts. The camera measures the *light*. Their difference is the LED stage
  (§7.4 step 5).
- **Sample rate.** 10 MS/s: WS2812 bits are 1.25 µs; T0H 0.4 µs and T1H 0.8 µs are 4 and 8 samples,
  so decoding is clean. Timestamps have 0.1 µs resolution. 4 MS/s still gives frame starts, but
  decoding is marginal.
- **Decode.** Edges → frames (split at idle-low > 50 µs) → the first 3 LEDs' GRB → the pattern state
  of each frame → flips at the frame start. This feeds the same `fit_offset` as the camera, so
  camera and analyser skews are the same quantity.
- **Correlation with controller and mesh time.** SYNC toggles once per commit. The analyser starts
  before `play`, with no commit in between, so its edges pair in order with the steps. A line fit
  maps analyser time onto controller µs (rms < 1 µs in tests).
- **Show time.** Each fixture's pattern encodes its show time, so its offset is display time minus
  shared show time. Relative to one fixture this is the skew. Against the controller it is absolute,
  once the harness logs the epoch the app set in controller time (via the clock map).
- **Also reported:** frame periods (median, max) per channel, which catch render stalls; PARLIO lane
  skew (D10 and D11 against D8).
- **Frame-start inputs (FSTI).** 12 RP2350 inputs record the first rising edge per frame, with a
  2 ms holdoff, at µs resolution on the controller's own clock. That gives always-on frame-start
  timing with no analyser. It has no data decode, so it can't tell which frame is which by itself.

## 9. Host software

### 9.1 Results and metrics (`bench_core.py`)

**Windows.** Each instrument produces 1 s windows of per-fixture offsets on the controller clock.
The scenario's marks split them into phases (`full`, `down`, `up`, `partition`, `heal`, `len`, …).

**Per phase:** p50, p95, p99 and max of the **spread** (max − min offset across fixtures).

**Per recovery event** (`up`, `heal`, `len`, `full`, `chain`): the time until the spread stays
under 2 ms for 3 windows. Down and partition events report their peak only. Partition islands keep
their own time by design (mesh.md §6.2), so the `partition` phase is reported and not gated.

**Metrics:** `HITL_METRIC` lines and the `"metrics"` array, schema v1, gate `mesh_bench`:

| Metric | Unit | Phase | Stat | Limit |
| --- | --- | --- | --- | --- |
| `flip_spread` (camera) / `flip_spread_la` | ms | `<scenario>:<phase>` | p50 / p95 / p99 / max | p99 ≤ 22.5 (10 ms + one frame), not on ungated phases |
| `reconverge_time` / `_la` | s | event kind | — | ≤ 30 |
| `untrusted_windows` / `_la` | pct | — | — | telemetry |
| `switch_late` | us | — | max | ≤ 50 |

**Verdict:**

- **SKIP** (infra, never FAIL) when there is no controller, when there is neither camera nor
  analyser, or when no window is trusted (no flips at all: mesh down or LEDs dark).
- **FAIL** when a gated p99 exceeds its limit, a recovery doesn't converge, a controller step is
  late, or a DUT resets.
- **PASS** otherwise.

A `RESULT gate=mesh_bench … verdict=…` line closes the log.

### 9.2 Harness and rig agent

`hitl_mesh_bench.py` runs these steps in order:

1. Reserve `mesh-bench` (atomic, pin-only).
2. Probe the instruments: SKIP if they are missing.
3. Read the device table from the controller and compile the scenario.
4. Optional `--gate-cmd`: start the DUT workload and wait for `MESHBENCH READY`.
5. `meshbench_rig.py run` in the container:
   - safe state, a lease, and a selftest;
   - load the timeline and fit the clock map;
   - start ffmpeg (MJPEG copy, no re-encode) and sigrok-cli;
   - `play +500 ms`, renewing the lease while it plays;
   - drain the FSTI, read the log, return to safe.
6. Fetch the video, frame timestamps, VCD and controller JSON.
7. Analyse, then write `results.json` and the metrics.

The controller is left safe on every exit path.

### 9.3 Simulation (`--simulate`, `benchsim.py`)

The same pipeline runs with no hardware:

- the real controller core (`rfctl_sim --virtual`) plays the scenario;
- a toy mesh-time model reacts to link states:
  - cut-off nodes drift at their ppm;
  - they slew back at 0.5 ms/s on reconnect;
- camsim renders the camera series (render jitter, a camera clock at +35 ppm, the sync LED);
- synthetic WS2812 wires feed the analyser path;
- the real analysis and verdict run on the result.

`test_end_to_end_simulation` runs `link_flap` and `partition_heal` this way. In the latter, nodes 2
and 3 drift more than 3 ms apart while cut off and reconverge 2–15 s after the heal. The analyser
taps nodes 0 and 1, which never lost each other, and stays under 1.5 ms. This is the template for a
real run and its regression test.

### 9.4 DUT workload: what is still missing

The M3–M5 gates (`mesh_smoke`, `mesh_apply_at_skew`, `mesh_gateway`) are on PR branches (#565–#567).
They hold one reservation per DUT and load their own effects. To run under the bench, they need a
small follow-up after they merge:

- accept a held composite reservation, where DUT i is `--dut i` in one container;
- load `meshFlipClock.fx`;
- print `MESHBENCH READY` after `sync`.

`mesh_apply_at_skew` should then also flip `ev` with `apply_at_ms`, so its apply skew is measured on
the light (camera) and on the wire (analyser) next to its AP-beacon reference. Until then, the
DUTs are meshed by an operator, or by any command passed as `--gate-cmd`.

## 10. HITL registration

`pi/hitl/reserve/catalog-meshbench.json` defines one unit:

- **Name and type.** `mesh-bench-1`, type `mesh-bench`, **pin_only** (the `c6-sdr` pattern): caps-only
  netstack jobs can never land on conducted DUTs.
- **Components.** `c6-0…3` (esp32c6, env `HITL_TTY[_N]` / `HITL_ADAPTER_SERIAL[_N]`), `p4-0/1`
  (`_4`, `_5`), `rfctl-0` (`HITL_RFCTL_TTY`, `HITL_MESHBENCH_FIXED_DB`), `cam-0` (`HITL_CAMERA_DEV`,
  `HITL_CAMERA_LINE_TIME`, `HITL_MESHBENCH_LAYOUT_JSON`), and `la-0` (`HITL_LA_DRIVER`,
  `HITL_LA_MAP`).
- **Placeholders.** Board serials are `00:00:00:00:C6:0n` and `00:00:00:00:F4:0n`, and the
  instruments are `SERIAL_*`. Assembly step 21 replaces them.
- **Checks.** The catalog joins the PR-24 isolation and PR-30 stable-identity tests as its own host
  (`mesh-rig`).

**No hitl-reserve engine feature is needed** for the unit itself: composites, per-component env and
pin_only already exist. Host-side follow-ups, through `pi/hitl/nix` (the allowed route), are all
genuinely missing HITL features:

1. a board target for the host (NanoPi needs a new sbc-deploy board; a Pi 5 needs none, Q1);
2. container toolbox additions:
   - `ffmpeg`, `v4l2-ctl` and `sigrok-cli` with the DSLogic firmware;
   - `picotool`, so `bootsel` + load can reflash rfctl from a reservation;
3. `hitl-devices` lists only DUTs 0–2: extend it to N;
4. the privileged single-unit environment that `c6-sdr` uses, for the raw-USB analyser.

**Owner rules.**

- Tests change only DUTs and the bench's own instruments, never the host.
- The pattern is an ordinary effect that never parks.
- The bench sends no frames itself. The matrix monitor tap (RF-BENCH §2) lets a sniffer check the
  mesh frames for an Espressif OUI.
- Untrusted windows are counted and reported, never retried away.

## 11. Hardware reconciliation

### 11.1 BOM delta against the starter purchase (nothing bought)

| Item | Delta | Why |
| --- | --- | --- |
| 74HC595 | +2 (16 → 18) | 144 control bits for the N = 4 board table (§3.3) |
| Pull resistors (10 kΩ × 150, SIP networks) | new | safe levels while /OE is high |
| Controller | Raspberry Pi Pico 2 (RP2350A, no W) replaces the "any C6" controller | owner request; no radio by construction; µs alarms |
| 74AHCT125 | 1 per DUT board (6) | 3.3 → 5 V strip data |
| WS2812B/SK6812 strips | 6 × (2 × 3 LEDs) C6 + 2 × (16 × 3) P4 = 132 LEDs, one reel | strips on every drive pin |
| 5 V 5 A supply | +1 | P4 strip power off USB |
| Camera | global-shutter UVC 120 fps (Q5) | §7.1 |
| Lens ND filter / black foam / black background | new | §7.1 |
| 16-ch analyser | Q6 | §8 |
| Second powered hub, or a host with 3 controllers | Q1 | §4 |
| Enclosure (black photo tent, about 80 × 80 × 120 cm, matte inside) | Q7 | ambient flicker |
| Shield boxes | still out (owner decision) | isolation measured in step 14 |

### 11.2 Questions for the owner

Each is one decision with options; ★ marks the recommendation.

- **Q1 — Host.**
  - A: one of the NanoPi boards in a metal case (which model?). This needs a new sbc-deploy board
    target, and only works if it has ≥ 3 independent USB controllers.
  - ★ B: a Raspberry Pi 5 (known deploy path, 2 controllers + a second hub).
  - C: the NanoPi, with the analyser and camera on a USB 3 hub (risky for bandwidth).
- **Q2 — What arrived.** Which RF switches (part, SPST/SP4T, absorptive?, control lines and truth
  table, logic level), which DSAs (model, serial or parallel header), and which delay-line lengths
  and cable type?
  - ★ A: send photos or links, and I fill the board table and safe codes before power-up.
  - B: use HMC7992 / PE4302-parallel as assumed.
- **Q3 — P4+C6 boards and RF.**
  - ★ A: over the air at reduced TX, near the matrix.
  - B: conducted, if their C6 has a u.FL/IPEX (needs an AUX port per board).
  - C: shield them out, render-only nodes.
- **Q4 — TinyC6 strip pins.**
  - ★ A: GPIO20 + GPIO14 (firmware defaults), if the TinyC6 exposes them.
  - B: two other recommended pins via `set_hardware_config`.
- **Q5 — Camera.**
  - ★ A: OV9281 global-shutter USB UVC (mono, 120 fps at 1280×800, about $60–90).
  - B: OV9782 colour version.
  - C: Raspberry Pi Global Shutter camera (CSI; needs a Pi 5 host; raw, no MJPEG).
  - D: Camera Module 3 (rolling, cheap; needs line-time calibration).
- **Q6 — Analyser** (check sigrok's 16-channel streaming rate before buying).
  - ★ A: DreamSourceLab DSLogic Plus/U2Basic class (sigrok `dreamsourcelab-dslogic`).
  - B: Kingst LA2016 (sigrok `kingst-la2016`, 16 ch).
  - C: only the RP2350 frame-start inputs, no analyser yet (no data decode).
- **Q7 — Enclosure.**
  - ★ A: black photo tent (matte inside).
  - B: a dark room, no enclosure (room lights must be off: 100/120 Hz flicker).
  - C: a grow tent (reflective inside: no, unless lined).
- **Q8 — Strip part.**
  - ★ A: WS2812B-V5 or SK6812, one reel for all boards.
  - B: whatever is on hand (camera-vs-analyser calibration per LED becomes mandatory).
- **Q9 — VNA.** Does the owner's NanoVNA reach 2.6 GHz or more (H/H4 stop at 1.5 GHz)?
  - ★ A: yes, use it.
  - B: no: a LiteVNA-64 (about $300) is needed for delay-bank and DSA calibration.
- **Q10 — Gate integration.**
  - ★ A: after M3–M5 merge, a follow-up PR adds `--bench` to the mesh gates (§9.4).
  - B: keep the bench standalone with `--gate-cmd`.

## 12. Assembly checklist (owner)

1. Unpack and photograph the switches, DSAs and delay lines. Answer Q2. Don't power any RF part yet.
2. Check the NanoVNA reaches 2.6 GHz (Q9). VNA every delay cable (one-way delay) and label it.
   Spot-check one DSA's 0 and 31.5 dB states (RF-BENCH §7).
3. Build the controller board: Pico 2, 18 × 74HC595 daisy-chained (QH' → SER), shared
   SRCLK/RCLK//OE, the last QH' → GP4, a 10 kΩ pull-up on /OE, pull resistors on every control line to
   its safe level, and a 5 V 3 A supply.
4. Flash `rfctl.uf2` (§5.6). Check `hello`, `selftest` → `chain=pass`, and `state` (all safe). Probe
   a DSA line and a switch EN line: both high.
5. Wire the DSAs and switches to the chain per `board_default.c`. Toggle each device with
   `set <dev> <v>` and check its lines with a meter or the analyser. Fix any wrong code in the table.
6. Assemble the matrix in the aluminium enclosure (RF-BENCH §2): pair chains, splitters, the delay
   bank on pair 0–1, 50 Ω on every unused port, SMA torqued.
7. Fit TinyC6 u.FL pigtails (mate once). Connect nodes 0–3. Terminate the node AUX and monitor ports.
8. Wire the strips: 3 LEDs, 330 Ω, a 74AHCT125 buffer, green-only test with any effect. Use GPIO20
   and GPIO14 on each TinyC6 and the 16 lanes on each P4 (§3.1). Strip 5 V comes from the separate
   supply on the P4s.
9. Tap the analyser (D0–D11 on the 3.3 V side through 1 kΩ, D12 = GP7 SYNC, common GND) and the
   FSTI inputs (GP10–GP21, same taps).
10. Mount the sync LED (GP8) in a corner of the camera's view.
11. Mount the camera about 1 m over the strips. Add the black background, baffles and ND filter.
    Close the enclosure.
12. Host: Pi 5 or NanoPi (Q1). Put the DUT hub, camera and analyser on separate USB controllers
    (§4). Use powered hubs.
13. Power-check: `journalctl -k | grep -c over-current` stays flat while all DUTs transmit.
14. Isolation (RF-BENCH §5): per pair with its cables unplugged, a CW tone at max power from one
    DUT, raw RSSI on the other. Record L_leak. Set the bench TX power rule
    (TX ≤ L_leak − 99 − 10 dBm).
15. Path-loss calibration: every pair end to end at all-zero DSAs → `HITL_MESHBENCH_FIXED_DB` (and
    per-pair values for a future `bench_cal.json`).
16. Camera calibration (§7.4): layout boxes → `HITL_MESHBENCH_LAYOUT_JSON`; exposure-sweep response
    LUT; on/off levels.
17. Zero check: two strips of one C6 read 0 ± 50 µs on camera and analyser.
18. Camera against analyser on the tapped strips (`baseline`, 30 s): agreement within 0.3 ms.
    Commit that recording as `testdata/recorded/first/`.
19. Dry run: `mesh_bench --scenario baseline` with DUTs meshed by an operator (or `--gate-cmd`).
20. Run every scenario once and look at `results.json` and the plots.
21. Fill the real USB serials into `catalog-meshbench.json` (replacing the placeholders) and deploy
    the host (follow-ups 1–4 in §10).
22. Add `mesh_bench` to the HITL lane (manual first, then periodic).

## 13. Risks and open items

- **Isolation without shield boxes** may cap "cut" at 100–110 dB (RF-BENCH §5). Run at low TX
  power and measure first.
- **The switch truth table** decides the safe state (Q2).
- **The `time` precision in the VM.** If effect time is float32 seconds, its step at 600 s of show
  time is 61 µs. The workload should re-base the time base at each run start; check it on the
  first device run.
- **The host's USB topology** (Q1) is the most likely source of flakes, as on rig-3.
- **The P4 16-lane encoder** isn't merged. Until it is, lanes 2–15 stay dark (their strips are wired
  anyway).
- The camera estimator is validated only on synthetic and MJPEG-round-trip video until step 18.
