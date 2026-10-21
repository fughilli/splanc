# Sensor core: on-board IMU, fusion, and sensor values in effects

Status: phase 1 implemented (native MPU-6050-family driver, Mahony fusion,
uniform pool, `get_sensors` / `calibrate_sensors`, agent tools). Not yet
validated on hardware: the first target is the PixieLamp (ESP32-C6 netstack
player, 250 LEDs, 3D-mapped) once its IMU is wired. The HITL rigs have no I2C
sensor (`pi/hitl` has no I2C/IMU inventory), so all results below are host tests
and static/measured image numbers.

Follow-ups covered by this design and landing as their own PRs on top of this
one:

- **The driver VM** (FUG-107, superseding PR #96): I2C drivers written as `.fxb`
  programs, run by the effects VM, with exports published into the same uniform
  pool. The MPU-6050 also runs as a VM driver so the two backends can be A/B'd
  (§8).
- **IMU-to-fixture extrinsic calibration** as a post-mapping step, plus a
  standalone "Calibrate IMU" flow (§7).

## 1. Goals and constraints

The goal is a Splanc **sensor suite**. It starts with one IMU on one fixture and
should grow to more sensor types, several fixtures, and sensors shared through
the relay and agent. Phase 1 has to fit the C6 netstack player as it is today:

- **RAM.** The worst-case free heap is about 54 KB (`firmware/sysmode`
  `MIN_FREE_MEASURED`), measured during the first wss handshake after Improv.
  IRAM and DRAM share the HP SRAM, so every IRAM byte also costs heap.
- **CPU.** The core is a single RV32IMAC at 160 MHz with no FPU, so every f32
  operation is a libgcc soft-float call. The render task (priority 10) and the
  netstack loop (also priority 10) share it. Effects already run soft-float or
  fixed-point.
- **No cost when absent.** Players without a sensor must not pay: no task, no
  boot delay, and no heap left behind after the probe.
- **WiFi/BLE coexistence and TLS.** The single-task TLS server and the radio
  timing must not see new long critical sections or new IRAM-safe interrupts.

## 2. indoor_localization: what was read, what is reused

Two commits of `fughilli/indoor_localization` were read. The user owns that
repo; parts of it are GPL-3.0 because its DWM3000 driver derives from
CircuitDigest's code, while `swarm/` is the user's own.

- **`8229dd7`** (2026-07-17) was read first.
- **`f07842d`** (2026-10-20, "Swarm node firmware on hardware + swarm network")
  is the current HEAD and is what this design is based on.

### 2.1 The fusion module (`swarm/core`)

`swarm/core` is a Rust **15-state error-state Kalman filter**:

- **Nominal state:** p, v, q (body→world, scalar-first `[w,x,y,z]`, world ENU
  with z up), accel bias, gyro bias.
- **Error state:** `[dp, dv, dθ, dba, dbg]`, with a 15×15 covariance.
- **`predict(accel m/s² specific force, gyro rad/s, dt)`** does strapdown
  propagation plus a dense `F·P·Fᵀ`.
- **Corrections** are sequential *scalar* updates (no matrix inversion), each
  behind an innovation gate:
  - `update_range` / `update_aoa`: UWB to a neighbor, folding in the neighbor's
    advertised variance.
  - `update_gps`, `update_alt`, `update_zero_vel`.
  - `update_mag` and `update_gravity(accel, σ)`: direction updates on dθ. The
    caller gates `update_gravity` on |a| ≈ g.

Changes since `8229dd7`:

- The crate is now `#![no_std]` with one dependency, `libm`. It is built for the
  classic ESP32 with the esp-rs Xtensa toolchain.
- The cooperative swarm rules moved into `swarm_core::coop`.
- Updates gained masks: position-only injection for mean-only ranges, and
  `update_zero_vel_masked`.
- There is a range-innovation "lock" statistic.

There is also a new **node runtime** (`swarm/node`) and real hardware: ACEBOTT
ESP32 boards with an **MPU-6050 + QMC5883L** (`apps/node/imu.cpp`).

- The node runs at **200 Hz** with a 44 Hz DLPF, ±4 g and ±500 °/s, using direct
  14-byte burst reads.
- It runs an I2C **bus-clear** at boot, because the IMU keeps power across an
  ESP reset and can hold SDA low.
- It does a **boot static calibration**: a 200-sample still window gives the
  gyro bias as the mean rate and the accel scale as g/|ā|.
  - One of their MPU-6050s read **8.4 m/s²** at rest.
  - The window is accepted when the gyro std-dev is under 0.01 rad/s and the
    scale is within 0.7–1.3.
- It applies gravity aiding every 5th sample when ||a| − g| < 0.5.

### 2.2 What ports to the C6, and what doesn't

| Piece | On the C6? | Why |
|---|---|---|
| Conventions (SI units, scalar-first body→world quat, z-up world, specific force) | **adopted** | Splanc's sensor core uses exactly these, so data and code move between the two projects unchanged |
| MPU-6050 bring-up details (register values, clone WHO_AM_I list, bus clear) | **adopted** | `sensor_bus.cpp` recover_bus, `mpu6050.rs` |
| Boot static calibration (gyro bias + accel scale from a still window) | **adopted** as a continuous at-rest learner | `Hub::ingest`; it also re-learns at every rest, which a lamp does often |
| The full 15-state ESKF | **not as is** | Dense `F·P·Fᵀ` is ~6,750 MAC, about 13.5 k soft-float ops per sample. At ~60 cycles each that is ~0.8 M cycles (5 ms) per sample, or **~50% CPU at 100 Hz**. With no UWB/GPS, a lamp's position and velocity states are unobservable anyway |
| An attitude-only ESKF (6 states: dθ, dbg), keeping the scalar-update structure | **feasible later** | 2·6³ ≈ 430 MAC plus gravity updates ≈ 1.4 k flops ≈ 85 k cycles (0.5 ms) per sample, **~5% at 100 Hz**. It gives covariance-honest bias tracking and plugs into the same seam (§4.3) |
| `libm` | possible | splanc firmware avoids it (fx_vm has its own approximations). The sensor core follows suit: `inv_sqrt` uses a bit seed plus Newton, `atan2`/`asin` are minimax, error < 1e-5 |
| `coop`, `swarm/net`, UWB, OTA | n/a | Out of scope for a lamp. A Splanc "fixture swarm" could reuse `swarm/net` later (§10) |

**Re-sync, not fork.** Splanc does not copy `swarm_core` source. The seam is
`fusion::AttitudeFilter` (§4.3):

- `update(a, w, dt)` maps to `Estimator::predict(a, w, dt)` plus a gated
  `update_gravity(a, σ)`.
- `quat()` maps to `.q`, and `gyro_bias()` to `.bg`.

When the attitude-only cut is wanted, `swarm_core` comes in as a Bazel
dependency (`git_override` / `archive_override`, like `@embedded`), pinned to a
commit. A wrapper implements the trait. Re-syncing means bumping the pin.

## 3. Hardware: bus, pins, the MPU-6050 family

**Pins.**

| Signal | Default | Notes |
|---|---|---|
| SDA | **GPIO6** | |
| SCL | **GPIO7** | |
| INT | **GPIO2** | Optional; recorded and collision-checked. The core polls the FIFO whether INT is wired or not (§4.3) |
| AD0 | GND | Address 0x68; 0x69 is probed too |

- These are the compile-time defaults: `LM_SENSOR_SDA` / `LM_SENSOR_SCL` /
  `LM_SENSOR_INT` in `sensor_bus.h`. They are the recommended PixieLamp wiring.
- 6/7 is the C6's LP_I2C pair, which keeps a future low-power path possible. It
  is also the FUG-131 Splanc Dev Module's I2C0 (`splanc_dev.ato`, 2k2 pull-ups;
  that board routes INT to GPIO21).
- The defaults avoid:
  - the strapping pins 4/5/8/9/15;
  - USB-JTAG 12/13;
  - the SuperMini's flash pins 18/19;
  - the LED data pins 20/14;
  - GPIO0/1, which carry the 32 kHz crystal on some boards.
- On the SuperMini, 6/7 are the MTCK/MTDO pads, which are free because the C6
  uses USB-Serial-JTAG by default.
- **Runtime overrides** work like `hw_gpio0/1`: NVS keys `sens_sda` / `sens_scl`
  / `sens_int` / `sens_en`, read at boot. Protocol access is in §9.
- **Collision checks.**
  - If SDA or SCL equals an active LED output (`hw_gpio0/1`), the sensor core
    reports `DISABLED` (logged as a pin conflict) instead of fighting the strip.
  - An INT pin that collides with the bus or an LED pin is dropped (logged).
- None of the boards has a qwiic connector yet. `splanc-mini` only has the
  mechanical provision.

**Bus.**

- The driver is ESP-IDF `i2c_master` (IDF 5.x) at 400 kHz with internal pull-ups
  enabled (breakouts carry their own) and a 10 ms transaction timeout.
- Before creating the bus, `recover_bus` checks SDA. If SDA is low it clocks SCL
  until SDA releases, then sends a STOP (indoor_localization's fix).
- Device objects are created lazily, and only after `i2c_master_probe` ACKs. An
  absent part costs no allocation.

**IRAM.**

- The prebuilt sdkconfig has `CONFIG_I2C_MASTER_ISR_HANDLER_IN_IRAM=y`, which
  would pin 724 B, but `CONFIG_I2C_ISR_IRAM_SAFE=n`. The interrupt is therefore
  allocated without `ESP_INTR_FLAG_IRAM` and is masked while the flash cache is
  off.
- `ld/esp32c6_iram_to_flash.txt` moves the handler back to flash.
- The cost of that choice: a transfer that overlaps a flash erase (littlefs/NVS)
  can stall past the 10 ms timeout. That counts as one bus error and the next
  drain retries. FAULT needs 5 errors in a row.
- On hardware, the I2C path should be exercised during a keypoint save to
  confirm the error stays at one retry.

**MPU-6050 specifics** (`firmware/sensor/src/mpu6050.rs`):

- **Address** 0x68 (AD0 low; GY-521 boards pull AD0 down) or 0x69. Both are
  probed: 0x68 first, and a recognized IMU wins over an unknown responder.
- **WHO_AM_I (0x75)** returns bits 6:1 of the default address, so a genuine
  6050 reads 0x68 at *either* address.
  - Accepted: 0x68 (MPU-6050/6000), 0x70 (MPU-6500), 0x71 (MPU-9250),
    0x73 (MPU-9255), 0x98 (ICM-20689), and 0x72/0x74/0x75 (remarked clones,
    treated as 6500 family).
  - Anything else at 0x68 is reported as `UNKNOWN_DEVICE` and **never written**.
    DS3231/PCF8523 RTCs and the ITG-3200 also live at 0x68.
- **Configuration:**
  - PWR_MGMT_1 = 0x01 (PLL on the X gyro), set after a DEVICE_RESET (0x80).
    The reset needs ~100 ms; the hub waits non-blockingly in `Starting`, so
    `setup()` never sleeps.
  - DLPF_CFG = 3 (~42 Hz): anti-aliased for the 100 Hz ODR, ~4.8 ms group delay.
    SMPLRT_DIV = 9 gives 100 Hz.
  - **±1000 °/s** (32.8 LSB/°/s) and **±8 g** (4096 LSB/g). Hand spins stay in
    range, and taps and knocks peak at 2–4 g.
  - INT_ENABLE = 0 (polled; §5).
  - Every config write is verified by reading back GYRO_CONFIG and ACCEL_CONFIG.
    A write that didn't land fails `configure` and the hub goes to `Fault`.
- **6500 family** additions:
  - ACCEL_CONFIG2 gets the accel DLPF.
  - CONFIG bit 6 (FIFO_MODE) is set, so a full FIFO *drops new* frames instead of
    overwriting the oldest, which would misalign the 12-byte frames.
  - The FIFO is 512 B instead of 1024.
  - Temperature is raw/333.87 + 21 (the 6050 uses raw/340 + 36.53).
- **Clone issues handled:**
  - Accel scale errors (see §2.1): a 0.7–1.3× error is re-scaled from the first
    second at rest, and the `accel_scale_corrected` flag is set.
  - Dead FIFOs: after 5 empty drains in a row the hub switches to direct polling.
  - FIFO overflow with misaligned counts: `count ≥ capacity` or
    `count % 12 ≠ 0` resets the FIFO.
- **Not used yet:**
  - The aux I2C master and bypass (a QMC5883L or HMC5883L magnetometer behind
    the MPU, as on the indoor_localization nodes).
  - The DMP.
  - Motion-interrupt wake.

## 4. Firmware architecture

```
 ESP-IDF i2c_master (C++)        Rust, no_std (//firmware/sensor)            consumers
 sensor_bus.cpp                  ┌──────────────────────────────────┐
  probe at boot ── LmI2cOps ───► │ hub::Hub  state machine          │
  sensor task (prio 5) ────────► │  mpu6050  probe/config/FIFO      │──► Snapshot (seqlock, sensor_ffi.rs)
  NVS calibration persist ◄───── │  fusion   Mahony + rest learner  │      ├─ uniform pool → effect uniforms (imu_*)
                                 │  gesture  tap / shake            │      ├─ Frame imu.accel / imu.gyro
                                 │  calib    record + mount         │      ├─ get_sensors (zero-copy encode)
                                 └──────────────────────────────────┘      └─ [sensor] serial log line
```

### 4.1 Bus seam

`bus::I2cBus` exposes `write_read` and `write` (plus the `read_reg` and
`write_reg` helpers), and distinguishes `Nack` from `Other`. On the device it is
`sensor_ffi::FfiBus`, which calls the C++ callbacks through **function pointers
registered at runtime** (`LmI2cOps`) rather than through extern symbols. Host
builds and tests of `player_ffi` therefore link without stubs. That was a
problem in PR #96, which had to stub `lm_i2c_*` in two test binaries. The host
tests use a register-file fake (`firmware/sensor/tests/fake_mpu.rs`) that
models auto-increment, reset, the FIFO with per-family overflow, NACKs, ignored
writes and a dead FIFO.

### 4.2 Discovery and lifecycle

`setup()` calls `sensor_begin()` after `hardware_config_begin()` and before the
render task starts. It runs bus clear, then bus create, then `lm_sensor_begin`,
which probes 0x68/0x69 and issues the reset if a known IMU answers.

- **Absent, unknown device, or fault at boot:** the bus objects are deleted, the
  pins are reset, and there is **no task and no residual heap**. The hub stays
  in `.data` with state `Absent`, so `get_sensors` answers `ABSENT` with the
  probed pins. Hot-plug is not supported; re-probing would need a reboot or the
  config message in §9.
- **Found:** a FreeRTOS task (`sensor`, priority 5, 2,560 B heap stack whose
  static bound is checked by `stack_bound.json`) loops
  `lm_sensor_poll(now_us)`. The poll returns the sleep time, and the task
  persists a changed calibration record to NVS.
- **Hub states:** `Starting` (waits out the reset), then `Running`, and
  `Running` → `Fault` after 5 consecutive bus errors. In `Fault` it re-probes
  every 1 s and comes back through `Starting`, so an unplug/replug while running
  recovers.

### 4.3 Sampling

FIFO batching is used, not a timer, and the interrupt pin is not used yet.

- **Sample timing comes from the IMU's own clock:** 100 Hz, dt = 1/ODR exactly.
  The task drains every **20 ms** (2 samples), reading FIFO_COUNT and then the
  frames, 16 per transaction, at most 48 per poll.
- Priority 5 sits below render and netstack (both 10), so a long frame or a TLS
  handshake delays the drain but **cannot jitter dt or drop samples**. The FIFO
  holds 0.42 s (6500, 512 B) to 0.85 s (6050).
- The measured rate (samples per wall-second) is reported as a diagnostic.
- Direct polling is kept as a fallback (dead FIFO): one 14-byte burst per poll,
  with dt from `esp_timer`, clamped to 0.1 s.
- **The INT pin** (optional; default GPIO2, GPIO21 on the Dev Module) is the next step:
  data-ready or FIFO-watermark wakes the task by notification instead of the
  20 ms poll, and wake-on-motion would let a sleeping lamp wake on pickup. It
  needs an IRAM-safe GPIO ISR, and therefore IRAM, so it is left off until a use
  case pays for it.

### 4.4 Fusion

`fusion::AttitudeFilter` is the seam:

```rust
fn update(&mut self, accel_ms2: Vec3, gyro_rads: Vec3, dt: f32); // fixture frame, gyro NOT bias-corrected
fn quat(&self) -> Quat;            // fixture -> world, [w,x,y,z], z up
fn gyro_bias(&self) -> Vec3;
fn set_gyro_bias(&mut self, b: Vec3);
fn reset(&mut self);
```

Phase 1 implements it with **Mahony** (explicit complementary filter on SO(3)):

- Kp = 1 s⁻¹, which gives ~1 s tilt re-levelling.
- Ki = 0.02 s⁻² for slow roll/pitch bias tracking.
- The accel correction is gated at ||a|/g − 1| < 0.15 and computed without a
  sqrt. While the lamp is shaken, the accelerometer isn't measuring gravity, so
  the correction is skipped.
- First-order quaternion integration with renormalization. The error is
  ~1e-4 rad per step at 1 rad/s and 100 Hz.
- The filter levels from the first sample (shortest-arc rotation from measured
  up to +z, yaw 0).

**Why Mahony over Madgwick:**

- **Cost.** Mahony is ~190 soft-float ops per sample (counted below); Madgwick's
  gradient step is about the same.
- **Bias.** Mahony's integral term is a real gyro-bias estimator for
  roll/pitch. Madgwick's bias compensation is an add-on.
- **Gating.** Mahony's gains map directly to time constants and are easy to
  gate. Madgwick's β step misbehaves when the accel correction is switched off
  and on.

Both lack covariance, which the attitude ESKF (§2.2) adds if needed.

**Gyro bias at rest (`RestDetector` plus EMA).** Yaw bias is unobservable from
gravity, so a still lamp would otherwise drift in yaw.

- **Rest test:**
  - |ω − b| < 0.05 rad/s.
  - ||a|/g − 1| < 0.03.
  - The accel *direction* drifts less than 0.02 g (≈1.1°) from the start of the
    streak, so a slow tilting rotation can't pass.
  - All of this held for 50 samples (0.5 s).
- **Before the bias and scale are known** (the first second at rest), the gates
  loosen to 0.35 rad/s (the ±20 °/s ZRO spec) and 30% in |a|.
- **Bias EMA:** α = 0.05 until 100 rest samples, then 0.01.
- **Accel scale:** the first 100 rest samples also fix a scalar accel gain
  (indoor_localization's boot calibration).
- A slow spin purely about the gravity axis is indistinguishable from bias, so a
  stored calibration (`bias_known`) is what protects that case.

**Fixed point or float?** All of the above is f32. Q16.16 fixed point would
roughly halve the per-op cost of the 15-mul/15-add quaternion products, but the
inv-sqrt normalizations need range management and saturation analysis, and at
1–2% CPU the work isn't worth it. The effects-facing values are *converted* to
Q16.16 once per frame (the `imu.*` context `_fix` mirrors) so fixed-point
effects pay nothing per LED.

### 4.5 Gestures

The gesture outputs are counters, so a consumer sampling slower than 100 Hz
never misses an event.

- **Tap:** |Δa| between consecutive samples above 80 g/s, scaled by dt (0.8 g in
  10 ms), followed by a 0.2 s refractory period.
- **Shake level:** EMA (τ = 0.3 s) of |linear accel|², with RMS mapped so that
  1.5 g gives level 1.0. A shake episode counts when the level rises through 0.5
  and re-arms below 0.25.
- The thresholds are first guesses and need tuning on the PixieLamp.

### 4.6 Calibration storage

`calib::Calibration` holds:

- gyro bias (sensor frame, rad/s)
- accel offset and per-axis scale
- **mount quaternion** (sensor → z-up fixture frame)
- flags

It is encoded as a 76-byte record: `"SCAL"`, version 1, flags, 16 LE f32,
CRC-32.

- **Persisted** as one NVS blob (`sens_cal`) by the sensor task. An NVS entry
  write is atomic: after a power cut the key reads either the old or the new
  record. A CRC, magic or version mismatch, or a non-finite value, is rejected,
  and defaults apply. Defaults are benign: the bias re-learns in ~1 s at rest.
- **Written only on an explicit action**, never automatically, so there is no
  flash wear. The actions:
  - `GYRO_BIAS` commits the learned bias, plus the learned accel scale folded
    into the per-axis scale.
  - `LEVEL` means "upright now". It rotates the mount so the measured gravity
    becomes fixture −z, with yaw arbitrary.
  - `RESET` returns to defaults.
- Actions cross from the message handler to the sensor task through an atomic
  mailbox. The reply carries `calibration_seq`, which advances once the action
  has been applied, and `calibration_result`.

## 5. Budget (measured on the netstack image, `size -A` / `nm -S`, vs main @ 2e7fbf68)

| | Δ | Notes |
|---|---|---|
| `.iram0.text` | **+68 B** (99,704 → 99,772) | `xQueueCreateCountingSemaphoreStatic`, pulled in by the I2C driver. The I2C ISR (724 B) is moved to flash (§3). `firmware/sysmode` `IRAM_TEXT` updated, so the budget headroom shrinks by 68 B and `PINNED_WORST` is unchanged |
| `.dram0.data` + `.bss` | **+720 B** | `HUB` 352, the snapshot `SNAP` 124 + reader copy `SNAP_LAST` 124, `OPS` 16, pins / atomics / C++ statics ~40, `s_i2c_platform` 20. This is resident with or without a sensor, comes out of free heap, and is not modelled in `firmware/sysmode` (mode-independent, like the per-device cert) |
| heap, sensor **absent** | **0** | Bus and device objects are freed after the probe; no task |
| heap, sensor **present** | **~3.3 KB** (estimate) | Task stack 2,560 (static bound 1,056 B, or 1,640 B with the 1.25 margin) + TCB ~350 + i2c bus/device objects and their semaphores ~400. On hardware, read `heap` / `min` on the 5 s status line with and without the IMU |
| `.flash.text` / `.rodata` | +40 KB / +5.6 KB | Rust sensor core 13.9 KB, IDF i2c driver and HAL 13.9 KB, `sensor_ffi` glue 3.9 KB, `sensor_bus.cpp` 2.5 KB, and new proto views and encoders. The app partition has room (huge_app, 2.10 MB image) |
| boot time, absent | < 1 ms (estimate) | Bus clear checks one pin, then bus create, then 2 NACKed 1-byte probes (~50 µs each at 400 kHz). The boot log prints the measured `probe … us` |
| CPU per fused sample | **~190 soft-float calls (Mahony)**, **~460 for the whole `ingest`** (static upper bound, all branches) | Counted from the RV32 LTO disassembly (`riscv32imac`, opt-level s). At ~50–80 cycles per call, the whole ingest is ~25–35 k cycles, ≈0.2 ms. **≈1.7–2% of the 160 MHz core at 100 Hz.** The device self-measures `ingest` with the cycle counter (`fusion_cycles` in `get_sensors`, `cyc=mean/min` in the log) |
| I2C bus time | ~0.8 ms per 20 ms drain (4%) | Interrupt-driven; the CPU is free during transfers |
| per rendered frame | snapshot copy + bound uniforms only | `uniform_pool::apply_frame` is one branch when nothing is bound. `imu.accel/gyro` cost no float work unless a sensor is running |

## 6. Effects: the uniform pool

Sensor values reach effects as **ordinary uniforms bound by name**. An effect
opts in by declaring a uniform with a pool name:

```glsl
uniform vec3  imu_gravity = 0.0, -1.0, 0.0;   // unit DOWN vector, map frame
uniform float imu_shake : 0.0 .. 1.0 = 0.0;
uniform float imu_tap   : 0.0 .. 1000.0 = 0.0;
```

| Pool name | Width | Meaning |
|---|---|---|
| `imu_quat` | 4 | fixture → world, (w, x, y, z), map axes (+Y up) |
| `imu_euler` | 3 | (roll, pitch, yaw) rad, Z-Y-X about the z-up axes; yaw drifts (no magnetometer) |
| `imu_gravity` | 3 | unit DOWN vector, map frame: `dot(led.pos, imu_gravity) > 0` toward the floor |
| `imu_lin_accel` | 3 | gravity-removed accel, world, g |
| `imu_accel` | 3 | calibrated accel, map frame, g (1.0 up at rest) |
| `imu_gyro` | 3 | rad/s, map frame |
| `imu_shake` | 1 | 0..1 |
| `imu_tap`, `imu_shake_count` | 1 | counters: compare against a `state` copy in `update()` |

**Why a pool of named uniforms, rather than new VM context ids:**

- **No format change.** Uniforms already exist end to end: compiler, manifest,
  app sliders, keypoints, OSC.
- **It works without hardware.** With no sensor running, the firmware doesn't
  touch the uniform, so it keeps its default or UI value. The same effect
  previews in the app, on the agent's `preview_effect`, and on a player without
  an IMU, and it can be driven by hand (drag `imu_gravity` to simulate a tilt).
- **One mechanism for every producer.** The driver VM's exports (FUG-107) land
  in the same pool by name, so the native and VM backends are interchangeable to
  effects (§8).

**Mechanics** (`firmware/player_app/uniform_pool.rs`):

- At effect load, `bind(deck, manifest)` resolves pool names against the
  manifest through `osc::parse_manifest`, on the loop task.
- Each frame, before `update()`, the render task runs `apply_frame()`. It reads
  the snapshot once if any binding is a sensor entry, computes only the bound
  entries, and writes them with `fx_set_uniform`.
- Both decks are supported, with up to 12 bindings per deck and 24 pool entries.
- Euler angles cost 3 `atan2`s per frame, and only when `imu_euler` is bound.

**Frames.** The sensor core works in a z-up fixture frame: the sensor axes after
the mount rotation. The pool converts to the **map frame effects use for
`led.pos` (+Y up)** with the fixed change of basis (x, y, z) → (x, z, −y), and
for quaternions (w, x, y, z) → (w, x, z, −y). Until the extrinsic calibration in
§7 exists, yaw between the IMU and the LED map is unknown: "level" fixes tilt
only. Tilt-driven effects such as `imu_tilt.fx` are only correct once that yaw
is calibrated, unless the IMU is mounted axis-aligned.

**The legacy built-ins `imu.accel` / `imu.gyro`** (VM context ids 9/10, which
already existed and were never driven) are now filled from the snapshot in g
and rad/s, z-up fixture frame, with Q16.16 mirrors.

**Demo effect:** `agent/skill/examples/imu_tilt.fx` ("glass of light"). The
LEDs below a gravity-level surface glow, and a shake or tap flashes white. The
agent's examples test compiles and previews it on the fixture.

**Cost in the fx VM.** A bound uniform is one `LoadUniform` per read, the same
as any knob. The per-frame pool write is ~4 float stores per binding. Effects
that call `atan2` on `imu_quat` per LED pay soft-float per LED. The skill doc
points them to `imu_gravity` (dot products) and `imu_euler`, which are
precomputed once per frame.

## 7. IMU-to-fixture extrinsic calibration (post-mapping step + "Calibrate IMU")

Implementation: its own PR on top of this one (solver, protocol, firmware
storage, capture-profile reuse). The guided app screen follows it.

### 7.1 The problem

The unknown is **R_fi**: the rotation from the IMU body frame into the
fixture/map frame, the frame of `led.pos` (+Y up). Until R_fi is known, sensor
vectors can be expressed relative to gravity but not relative to the LEDs. That
is the yaw ambiguity noted in §6.

R_fi is related to the firmware's stored mount quaternion (sensor → z-up
fixture frame, §4.6) by the fixed change of basis `C = (x,y,z) ↦ (x,−z,y)`
(map → z-up):

```
mount = C · R_fi
```

The pool's map-frame conversion (§6) is `C⁻¹`. Once R_fi is installed, every
pool vector is therefore exactly `R_fi · (IMU vector)`.

What one still pose k provides:

- **g_i,k**: the IMU's settled "up" (the specific-force direction) in its body
  frame. The firmware averages it while `at_rest` (§4.4) and reports it with a
  quality figure (sample count and angular std-dev). It is reported *before*
  the mount rotation, so it is independent of any earlier calibration.
- **g_f,k**: "up" in the fixture frame.
  - **Pose 1, mapping itself.** The solver levels the map with gravity
    (`solver/src/pipeline.rs gravity_level_rot`: the estimated gravity goes to
    −Y), and the fixture does not move while it is mapped, so
    **g_f,1 = (0, 1, 0)** for free. The app reads g_i,1 from `get_sensors`
    right after a successful solve, while the fixture is still standing as it
    was mapped.
  - **Poses k ≥ 2.** The user re-orients the fixture. The app re-localizes the
    camera against the *known* LED map: the LEDs play the Gray-hue code with the
    stored capture profile (§7.5), the decoder assigns LED ids after about one
    code cycle (a few seconds), and `web/src/geom/pnp.ts estimatePose` returns
    the camera→map rotation R_fc. This is the same path `projectionOverlay`
    uses for the registered overlay. The phone's own gravity in the camera
    frame, u_c (DeviceMotion `accelerationIncludingGravity`, averaged over the
    same ~1 s window, with the phone held still), gives **g_f,k = R_fc · u_c**.
    No full re-solve is needed: one PnP lock per pose.

**One pair constrains R_fi to a 1-DOF family.** Any rotation taking g_i,1 to
g_f,1, composed with a rotation about g_i,1 by an arbitrary θ, fits. That is the
user's "360° rotation group". A second pair whose g_f is **not parallel** to the
first resolves θ.

### 7.2 Solver

The solver is Wahba's problem:

```
R_fi = argmin_R Σ_k w_k ‖g_f,k − R g_i,k‖²
```

- It uses the **Davenport q-method**:
  - Form `B = Σ w_k g_f,k g_i,kᵀ`.
  - Form the 4×4 symmetric `K` from `σ = tr B`, `S = B + Bᵀ` and
    `z = (B₂₃−B₃₂, B₃₁−B₁₃, B₁₂−B₂₁)`.
  - R_fi is the eigenvector of K's largest eigenvalue (a quaternion). It is
    found by shifted power iteration (no LAPACK in TS or no_std Rust).
- For exactly 2 pairs this equals TRIAD up to weighting.
- **Weights:** `w_k = 1/σ_k²` from each pose's stillness std-dev (IMU side) and
  PnP RMS (camera side). The camera is usually the weaker side: phone gravity
  while hand-held is about 0.5–1°.
- **Conditioning:** `sep = max_{j<k} ∠(g_f,j, g_f,k)`.
  - The yaw about the first gravity direction is observable in proportion to
    `sin(sep)`.
  - The predicted yaw error is about `σ_dir / sin(sep)`.
  - **sep < 20° is rejected as degenerate**, 20–45° is accepted with a warning,
    and ≥ 45° (ideally ~90°) is good.
- **Residual:** the RMS of `∠(g_f,k, R g_i,k)` after the fit, in degrees.
  - With 3 or more poses, a residual well above the expected noise (more than
    ~3°) flags a bad pose: the fixture moved mid-capture, or the PnP lock was
    wrong.
  - The UI offers to drop the worst pose and re-solve.
- **One-pose (gravity-only) solve:** take the minimal rotation g_i,1 → g_f,1 and
  choose θ to keep the previous R_fi's yaw if there is one, else 0. It is
  flagged `yaw_resolved = false`.

### 7.3 Guided flow (app)

The flow is offered as a post-mapping step after `capture.ts stopCapture` saves
a first-time map, **only when `get_sensors` reports RUNNING**. It is also
available any time later as **"Calibrate IMU"** on Map Detail (next to
"Supplement", via a `/capture?calibrate=<mapId>` mode) and in the device sheet.

1. **Pose 1** is recorded automatically at the end of mapping (g_f,1 = +Y, and
   g_i,1 from the settled IMU). The step opens with a tilt-only calibration
   already applied, so effects work for tilt immediately.
2. *"Turn or tip the fixture to a different resting position."*
   - The app polls `get_sensors` at ~5 Hz and shows:
     - a **stillness** indicator (`at_rest`);
     - the live **angle** between the current IMU up and every accepted pose's
       g_i;
     - a target ring (≥ 45°, green at ≥ 70°).
   - "Capture pose" enables when the fixture is still, the separation is
     ≥ 45°, and PnP has a lock with RMS ≤ 4 px and at least 5 inliers.
3. Solve after pose 2. The flow **recommends a third pose** (another ~90° axis)
   for redundancy, and shows the residual, the predicted yaw error, and a 3D
   preview of the IMU axes on the map. The user accepts or redoes.
4. **Accept** sends `set_sensor_mount { R_fi, quality, timestamp }`. The firmware
   persists it, and the app also stores it on the map's summary, so the map
   export carries it.

**Agent path.** An agent can't see the camera. It can do the gravity-only step
("set the lamp upright, I'll level it": `calibrate_sensors level`), and it can
read the stored mount and its quality. It cannot do the full extrinsic.

### 7.4 Fixtures that can't be re-oriented

Wall-mounted or heavy fixtures can't be turned over. For them only pose 1 is
available, which is a **2-of-3-DOF** calibration: tilt is correct and yaw about
gravity is unresolved.

- For a **static** fixture this rarely matters. It doesn't tilt, so the
  gravity-relative values (`imu_gravity` is exactly −Y, `imu_lin_accel`'s
  vertical component, shake, tap) are all correct. Only the *horizontal
  direction* of a knock or sway is rotated by the unknown θ.
- **Remedies:**
  - a manual yaw nudge in the 3D view: the user rotates the drawn IMU axes
    about +Y to match the board's silkscreen arrows;
  - a magnetometer later (§10), which makes yaw observable from the field;
  - one tilted pose in place (lean it on a book) if it can tip at all.
- `yaw_resolved = false` is shown in the app and returned by `read_sensors`.

### 7.5 Capture profile: reuse what worked

A successful map capture records the capture parameters that worked:

- **diffuse** (on/off);
- the LED **stride** (`stride_spacing`) and `anchor_density`;
- the code timing (`symbols`, `bit_period_ms`);
- LED `brightness` at the end of the servo;
- the detector `threshold`, `downscale` and `lc_gain`.

They are stored **on the device, next to the map**, as a small `CaptureProfile`
(new `set_capture_profile` / `get_capture_profile` arms).

- The firmware keeps the encoded message and persists it as an NVS blob, which
  is atomic and survives reboots and OTA updates.
- It **drops the profile when a new map is uploaded** (`handle_map_upload`). The
  app then writes the new one right after the map, so a profile always belongs
  to the stored map. The profile carries the map id as well.
- The calibration's re-localisation step, and any later re-capture or
  supplemental capture, **load it instead of re-asking or re-probing**: diffuse
  and stride come from the profile, and the timing skips the 1.2 s
  "Measuring light…" probe unless the user asks for it.
- **Fixtures mapped before this existed** have no profile. They fall back to
  today's sources: the global diffuse pref, the per-device `captureStride`, and
  the probe.
- The agent reads it via `get_capture_profile` (part of `read_sensors`'
  calibration context).

## 8. The driver VM backend (FUG-107) and the native-vs-VM A/B

Implementation and measured results: in the driver VM PR, which supersedes
PR #96. Design:

- **Drivers are `.fxb` programs.** They have a `void poll()` entry instead of
  `shade()`, `export <ty> name;` declarations, and the
  `i2c_write(addr, reg, val)` / `i2c_read8` / `i2c_read16` intrinsics. Two new
  VM ops, `I2cWrite` and `I2cRead`, are appended after the current last op. An
  effect and a driver are mutually exclusive in one program.
- **They run on the loop task**, in a second VM with its own small arena, under
  the player mutex. The bus is the **same `LmI2cOps` seam** as the native core,
  so there are no extern stubs.
- **Exports are published into the uniform pool by name** (`uniform_pool::publish`).
  PR #96's explicit export→slot `DriverBinding` table is replaced by the
  name-binding that effects already use, so a VM driver and the native core are
  interchangeable to an effect.
- **MPU-6050 as a VM driver.** The driver reads the raw accel and gyro registers
  and exports `imu_raw_accel` / `imu_raw_gyro` (counts). The firmware feeds these
  into the *same native* `Hub::ingest` (scaling → calibration → Mahony →
  gestures → pool). Only the bus/driver layer differs, so the A/B isolates
  exactly the driver cost.
- **A/B axes:** correctness (identical fused output on identical register
  streams), CPU cycles per sample at 100 Hz, RAM (second VM plus arena against
  the native statics), timing jitter (VM polls on the loop task, with no FIFO in
  the simple driver, against IMU-clocked FIFO batches), and the impact on effect
  frame time and TLS/WS responsiveness.

## 9. Protocol and agent

Field numbers are additive. FUG-82 (framerate autoscale, #55) took
`ClientMessage` 46 and `ServerMessage` 25 while this was in flight; 47 and 26
stay unused. The driver VM arms take the next numbers.

| Message | Arm | Notes |
|---|---|---|
| `GetSensors {}` | client 48 | Reply `sensor_state`. Answers with any firmware that advertises the `sensors` feature, sensor or not |
| `CalibrateSensors { Action action }` | client 49 | `ACTION_GYRO_BIAS` / `ACTION_LEVEL` / `ACTION_RESET`. Reply `sensor_state` (before the action is applied); poll until `calibration_seq` advances |
| `SensorState` | server 27 | Status enum, part, address, WHO_AM_I, pins, the vectors (accel, gyro, quat, gravity, linear_accel, gyro_bias), temperature, shake, tap and shake counts, at_rest, rate, samples, FIFO overflow and bus error counts, fifo, calibrated, accel_scale_corrected, fusion_cycles, calibration_seq / result |

The firmware encodes `SensorState` **zero-copy** (`write_arm`). Its micropb
profile skips the vectors and strings, so the by-value `ServerMessage` on the
handler stacks does not grow; `envelope_size_test` passes unchanged.

**Agent / MCP:**

- `read_sensors` returns status, euler degrees, tilt, vectors and counters.
  With `samples` and `interval_ms` it returns a short series; that is the
  request/reply form of "stream".
- `calibrate_sensors {action}` waits for `calibration_seq` to advance.
- The CLI has `read-sensors` and `calibrate-sensors`.
- The skill doc explains the pool names and when to calibrate.

**Next protocol steps:**

- **Push stream.** `SetSensorStream { rate_hz }` would make the device push
  `SensorState` (or a compact `SensorSample`) on the open socket, coalesced on
  the loop task like the perf push. Agents can then subscribe, and the app can
  draw a live 3D attitude widget.
- **Config.** `SetHardwareConfig` gains an `i2c { sda, scl, enabled }` block,
  persisted to the same NVS keys, which re-probes live by tearing down the task
  and bus and calling `sensor_begin` again. Like `set_hardware_config`, it stays
  in the agent's `FORBIDDEN_TYPES`; the app owns hardware.
- **Mount.** `SetSensorMount { quat, quality, timestamp }` comes with §7.

## 10. Toward the Splanc sensor suite

- **More sensor types.** The hub pattern generalizes to a small `Driver` trait
  (`probe`, `start`, `poll`, `snapshot`) with a registry probed in address
  order: BMP280/BMP580 baro at 0x76/0x77/0x46, MAX17048 fuel gauge at 0x36,
  INA226, VEML7700 light, ICM-42670-P (the `splanc-mini` IMU at 0x68,
  WHO_AM_I 0x67). Native drivers suit the high-rate or fused ones (IMUs). The
  driver VM (§8) suits the long tail of slow sensors an AI can write from a
  datasheet. Both publish into the uniform pool.
- **Magnetometer** (QMC5883L/HMC5883L via the MPU's aux bypass, as on the
  indoor_localization nodes). It gives absolute yaw (fixing yaw drift), it is a
  third way to resolve the §7 extrinsic, and it is where `swarm_core`'s
  `update_mag` comes in, via the attitude ESKF.
- **Multiple fixtures.** Each player publishes its own pool. The room frame
  (`set_fixture_pose`) already places fixtures in a shared world, so the
  orientation can be expressed in room coordinates (`fixture_pose ∘ R_fi ∘ q`).
  The agent, or the relay, can fan one fixture's sensor out to other fixtures'
  uniforms ("shake lamp A, ripple the room"). That is an agent-side binding
  today (`read_sensors` → `set_uniforms`) and a relay-side subscription once the
  push stream exists.
- **Sync.** Samples carry device time, and the player already has
  `set_time_base` and time-sync ping. Stamping pushed samples in the shared
  time base lets the relay align several fixtures' sensors.

## 11. Testing and validation

- **Host** (`bazel test //firmware/sensor:sensor_test`, 24 tests):
  - driver: identify and clone ids; probe of absent, AD0-high and unknown
    devices; never writing an unknown device; register programming per family;
    write-verify; parsing and scaling.
  - hub: non-blocking reset, FIFO drain at the IMU clock, overflow resync, dead
    FIFO fallback, unplug → fault → replug.
  - fusion: static tilt at 4 poses, tilt convergence, known-rate rotation about
    3 axes (< 1°), yaw-rate integration (< 1%), gyro bias learned at rest
    (60 s yaw drift < 0.5° against 86° unlearned), Mahony integral bias, shake
    gating.
  - gestures; calibration record round-trip and corruption rejection; level and
    gyro-bias calibration and re-seeding; the accel scale error learned;
    euler/atan2.
- **C ABI** (`//firmware/player_app:sensor_pool_test`): a fake MPU through
  `LmI2cOps` → `get_sensors` (zero-copy encode decoded by the host profile) →
  an effect's `imu_gravity` uniform driven by the pool (with the default kept
  when no sensor is present) → `calibrate_sensors(LEVEL)` applied, persisted and
  levelled.
- **Agent** (`//agent:sensors_test`, `//agent:examples_test`): tools against the
  fake player; `imu_tilt.fx` compiles and previews.
- **Image:** `//firmware/player_app:esp32c6_netstack` builds.
  `stack_bound_test` includes the sensor task. `iram_to_flash_test`,
  `sysmode` and `envelope_size_test` pass.
- **On hardware (pending the PixieLamp wiring):**
  - the boot log shows `[sensor] IMU found` and the probe µs;
  - `read_sensors` shows `running`, ~100 Hz, `fifo`;
  - tilt tracks; a still lamp converges to `at_rest`;
  - `fusion_cycles` is within the estimate;
  - heap `min` with and without the IMU;
  - `fx_bench` and TLS reconnects show no regression with the IMU streaming;
  - a keypoint save during sampling causes at most one bus error;
  - tap and shake thresholds tuned.
