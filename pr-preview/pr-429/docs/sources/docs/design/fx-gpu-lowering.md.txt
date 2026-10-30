# Lowering the FX engine onto GPUs and accelerators

> **Prototype not in tree.** The host prototype and Pi 3 GLES2 bench this doc refers to
> (`fx_gpu/…`) live on the closed draft PR #368 (branch `agent/fx-gpu-lowering`); the
> decisions here are implemented for Splanc MAX in #370.

Status: **design + host feasibility prototype + Pi 3 measurements (this PR).**
No device code ships. **Target (owner): Splanc MAX at up to 120 fps on short
runs, with GPU lowering as the primary path** (§0).
The prototype (`//fx_gpu`) lowers a meaningful subset of the effects IR to GLSL
ES 1.00 / 3.10 + SPIR-V and proves, against the real `fx_vm` over the test
corpus, that the lowering is numerically faithful within tolerance. Pi and P4
work is staged behind owner decisions (end of doc).

Background: [fx-perf-study.md](fx-perf-study.md), [fx-native-aot.md](fx-native-aot.md),
[fx-memoization.md](fx-memoization.md), and the `fx_vm` module docs. The VM is
and stays the semantic reference; everything here is a *translation* of the
`.fxb` bytecode it already runs, checked against it.

## Why

The study's headline: through the VM a non-trivial effect costs 5–35 k cycles
per LED on the C6, and at 2048 LEDs only a solid fill fits a 33 ms frame. The
AOT path (PR #341) buys 3–20× on the same core. The GPU is a different lever:
Splanc MAX already carries a Raspberry Pi whose VideoCore/V3D GPU sits idle
while the CPU runs the VM. An effect is a per-LED kernel — embarrassingly
parallel across LEDs — which is exactly what a fragment/compute shader is for.
On Pi 4/5 a V3D compute pass over 2048 LEDs is a sub-millisecond job; the only
real questions are *which* of the kernel maps to the GPU, how close the GPU's
float gets to the VM's soft-float, and how the result gets back out to the
FPGA/SPI LED path without the readback eating the win.

This document answers those, with a working prototype and measured conformance
numbers, and surveys the ESP32-P4 accelerators as a separate (non-GPU) track.

## 0. Target: Splanc MAX at up to 120 fps (owner direction)

**Direction:** GPU lowering is the **primary MAX path**. The multi-threaded VM
is the **fallback** for effects that can't lower: hash on the Pi 3 (GLES2), and
buffers, user functions and loops on every tier. The goal is 120 fps on runs
short enough for the wire to allow it, not 30 fps.

### Fps vs strip length (the wire sets the ceiling)

Wire time per frame = `L` LEDs per channel × 30 µs (24 bits × 1.25 µs) + the latch
(reset LOW). All channels drive in parallel, so the frame rate depends only on
`L` and the latch, not on the channel count. The latch is a **parameter**
(`led_type` CSR, #370): 0 = classic WS2812/WS2812B (spec > 50 µs; the core
uses 80 µs), 1 = WS2812B-V5 / SK6812-class (≥ 280 µs; the core uses 300 µs).

Max LEDs per channel, `floor((1/fps − reset) / 30 µs)`, datasheet timing:

| fps | period | reset 50 µs | reset 280 µs | × 20 channels (50 / 280 µs) |
|---:|---:|---:|---:|---:|
| 30 | 33.33 ms | 1,109 | 1,101 | 22,180 / 22,020 |
| 60 | 16.67 ms | 553 | 546 | 11,060 / 10,920 |
| 90 | 11.11 ms | 368 | 361 | 7,360 / 7,220 |
| **120** | **8.33 ms** | **276** | **268** | **5,520 / 5,360** |

In the spi_ws281x core the bit is 1.2407 µs, so a byte takes 9.963 µs and an LED
29.89 µs. With the core's 80/300 µs latches and ~40 µs of prefill latency, the
120 fps limit is **274 LEDs/channel at 80 µs** and **267 at 300 µs**. The
#370 sim runs 20 × 270 and 20 × 266 at a 120 fps cadence.

**120 fps cap: 260 LEDs per channel (owner decision, 2026-10-26).** It keeps
margin below the theoretical 267/274. 260 LEDs = 780 bytes × 9.963 µs = 7.771 ms
of emission; with ~40 µs of prefill and the latch the frame is done at 7.89 ms
(80 µs) or 8.11 ms (300 µs). That leaves **≥ 220 µs per period** at the
worst-case latch (~440 µs at 80 µs) for the host: the frame-done GPIO wake-up,
the CSR write and scheduling jitter. The cap is enforced in the player
(`wire::check_frame_rate`: above 60 fps, at most `MAX_LEDS_PER_PORT_120FPS` =
260 LEDs per port; nothing above 120 fps) and documented in the FPGA README
(#370). Verilator, frame-done paced at 260 LEDs with a modelled 100 µs host
wake-up: 7.99 ms periods at 80 µs and 8.21 ms at 300 µs, both within 8.333 ms.

**SPI demand is set by the port count, not the fps.** While strips stream, the
FPGA drains 0.8 Mbit/s per port, so 20 ports need ≥ 16.06 Mbit/s sustained
(#370 sim: SCK 16.7–27 MHz works at a 54 MHz core). At 120 fps the strips stream
~97% of each period, so the link runs at that rate almost continuously. One
20 × 270 frame is 16,201 bytes, 5.8 ms at 22.2 MHz SCK, inside the period. Per
frame the FPGA also needs the latch plus ~40 µs of prefill between frames. The
host must start each CS no earlier than *previous start + emission + latch* (see
pacing below).

### The 8.33 ms budget at 120 fps

Render, readback and SPI handoff run as a **pipeline**, one stage per frame
period, with double or triple buffering:
- frame n+2 renders on the GPU;
- frame n+1 is read back and encoded;
- frame n goes out over SPI and the wire.

Each stage must fit one period. The stages run concurrently, so only the
slowest one sets the rate.

| stage at 20 × 270 (5,400 LEDs) | Pi 3 GPU (GLES2) | Pi 3 VM, 4 threads | notes |
|---|---:|---:|---|
| render + readback | **0.84–0.94 ms** pipelined, for every lowered effect | solid 1.36, sweep 1.83, gradient 2.28, imu 2.57, pulses 2.98, cylinder 3.05, plasma 4.69, **noise 7.84 ms** | **Measured** on `pi-ledmapper-2` (run 3). VM 1 thread: 2.2–28.3 ms. GPU ≤ 2/255, VM bit-exact. |
| SPI (16,201 B) | 5.8 ms @ 22.2 MHz (DMA) | same | concurrent with the wire |
| wire + latch | 8.15 ms (270 @ 80 µs) | same | the ceiling |

- **The GPU fits with ~7 ms to spare** and leaves the CPU free for the player,
  networking and the output thread.
- **The 4-core VM fits most effects but not noise-class hash effects.** Noise
  takes 7.84 ms on all four cores, so it misses 8.33 ms as soon as anything else
  runs. The ones that fit still take 16–56% of all four cores' frame time
  (plasma 4.69 ms).
- **On a Pi 3, the effects that can't make 120 fps without the GPU** are the
  heaviest VM effects (noise, 7.84 ms measured). Those are also the hash class that
  GLES2 can't run, so on a Pi 3 they cap at ~80–100 fps on the VM. On Pi 4/5
  (V3D compute with real integers) they lower too.
- Effects that only fit on the VM by using the whole CPU are the reason the GPU
  is primary.

### Frame pacing and jitter on Linux

- **The FPGA is the timing master; the host only has to stay ahead.**
  - Since #370 the FIFO is latch-safe: a next-frame CS may land anywhere in the
    previous frame's latch without losing bytes.
  - It must not land during the previous frame's *emission*, or the frames merge
    (asserted in `spi_ws281x_120fps_sim` phase D).
  - Jitter slack is `period − (3L × 9.963 µs + 40 µs + latch)`: ~143 µs at
    270 LEDs / 80 µs, but only ~42 µs at 266 / 300 µs. At the 260-LED cap it is
    ~440 µs (80 µs latch) and ~220 µs (300 µs).
  - **Decided (owner, 2026-10-26): both.** Strips are capped at 260 LEDs per
    channel in the 120 fps mode, and the FPGA paces the host with a
    **frame-done** output (#370). `frame_done` is a level that goes HIGH when
    every port has shifted out its frame *and* the latch has elapsed, and LOW
    when the next STREAM starts. **Confirmed (owner, 2026-10-26):** a dedicated
    GPIO, Tang Nano 9K pin 28 → Pi GPIO 22 (header pin 15), 3.3 V both sides,
    not in-band SPI status and not FPGA double-buffering (20/26 BSRAM used).
  - **Pi-side use (implemented in #370, `pi/player_rs` pacing.rs / gpio_cdev.rs):**
    the output thread requests rising-edge events on that line (raw GPIO v2
    ioctls, since libgpiod can't link into the static-musl player). Each frame
    it renders, sleeps to the absolute deadline, then goes at once if the line
    is HIGH or waits for the edge, and sends CSR + STREAM as one SPI message.
    A timeout of one period + margin sends on the timer. Three in a row switch
    to timed pacing (one log line), and the line is re-checked every second. A
    broken wire degrades to today's behaviour instead of stalling. A frame started on frame-done can't merge
    with the previous one, so the host no longer has to model wire time, and
    Pi-side jitter only has to stay inside the cap's ≥ 220 µs slack instead of
    the ~42 µs of a 266-LED strip. Rendering keeps running ahead
    (triple-buffered), so only the SPI handoff waits on the edge.
- **Output thread** (userspace RT only, by owner decision: no kernel driver,
  no PREEMPT_RT; implemented in #370, measured in §0 "Output-thread latency"):
  - SCHED_FIFO 45 for the output thread only, below the IRQ threads (50) and the
    `spi0` message pump (raised to 46 by the unit), pinned to the last CPU.
    `mlockall`. The unit grants CAP_SYS_NICE + CAP_IPC_LOCK to the `ledmapper`
    user instead of running the whole process at FIFO 50. `isolcpus=3` is an
    opt-in `apps.nix` switch.
  - **Measured on the Pi 3B+ (`pi-ledmapper-2`, 2026-10-26, #370 README
    "Measured output-thread latency"):**
    - Bench: kernel 6.12.87 `PREEMPT_VOLUNTARY`, 120 fps, 20 × 66 LEDs. The
      frame-done wire isn't fitted, so these are timed-pacing numbers.
    - Timer wake-up, p50 / p99 / max:
      - idle: 84 / 91 / 256 µs without RT, **29 / 35 / 71 µs with RT**;
      - under CPU load: 146 / 4,318 / 10,303 µs without RT, **83 / 236 /
        622 µs with RT**;
      - RT with the load kept off the output CPU (≈ `isolcpus=3`): 31 / 78 /
        220 µs.
    - Wake → SPI ioctl ≤ 24 µs. The 3-byte CSR ioctl, which bounds ioctl → CS,
      is 46 / 183 / 317 µs with RT.
    - Frame period under load: p99 12.3 ms / max 18.5 ms without RT,
      **8.47 / 8.89 ms with RT**.
    - Edge → CS is estimated at ≈ 0.4 ms p99 (≈ 0.25 ms with the CPU kept
      clear). A late wake only stretches that one period; it can't merge frames.
    - Edge → wake gets measured directly (the kernel's edge timestamps) once
      pin 28 → GPIO 22 is wired.
  - **PREEMPT_RT:** not enabled.
    - The Pi kernel is 6.12.87 with `ARCH_SUPPORTS_RT=y`, so mainline
      `CONFIG_PREEMPT_RT=y` is a Kconfig change.
    - But it changes the nixos-raspberrypi kernel derivation, which means a
      from-source kernel build (hours, no binary cache since attic went away).
    - The remaining tail under load comes from non-preemptible kernel sections
      of other tasks on the output CPU, which `isolcpus` addresses without a
      rebuild. So PREEMPT_RT is the option to take only if wired edge → CS
      measurements still miss the budget.
  - Absolute-deadline sleeps (`clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME)`
    or `timerfd`), so periods don't accumulate drift.
  - The `performance` governor, to avoid DVFS latency spikes. On the Pi 3, also a
    pinned `core_freq`, because SPI SCK divides the core clock (§4).
- **GPU sync stays off the output thread.** `glReadPixels` blocks its caller
  (measured 1.4 ms at 20k LEDs, ~0.3–0.5 ms at 5k), and `glFinish` jitter lands on
  the render thread. With a triple-buffered handoff the output thread never
  waits on GL. Render jitter matters only if render + readback approaches a
  period; at ~1 ms of 8.33 it doesn't.
- **SPI: one DMA write per frame** (needs `spidev.bufsiz` ≥ frame bytes, set by
  #369). **Measured continuity**: `pi-ledmapper-1` on the #369 image, rig-1 FX2,
  `//pi/hitl/harness:spi_continuity` (#370). SCK 6.17–6.24 MHz, the valid region
  for a 24 MS/s analyzer (~3.9 samples/cycle). Pauses count when CLK is held
  ≥ 1 µs, cross-checked against CS:

  | LEDs (transfer) | STREAM transfers | pauses ≥ 1 µs inside a transfer | CS-high gap, CSR write → STREAM | frame period |
  |---:|---:|---:|---|---:|
  | 1,080 (3.2 KB) | 126 | **0** | 5–20 µs | 23.7 ms |
  | 2,200 (6.6 KB) | 101 | **0** | 5–20 µs | 29.7 ms |
  | 5,400 (16 KB) | 64 | **0** | 10–50 µs | 46.8 ms |
  | 8,192 (24.6 KB) | 49 | **0** | 20–50 µs | 61.5 ms |
  | 16,384 (49 KB) | 28 | **0** | 20–100 µs | 104.8 ms |
  | 20,480 (61 KB) | 24 | **0** | 50–100 µs | 126.8 ms |

  - **Verdict:** each frame is one gap-free CS-low DMA transfer up to 61 KB.
    Nothing approaches the PREFILL = 2 start-of-frame slack (20 µs), let alone 64.
  - The only gaps are between the player's per-frame CSR write and its STREAM:
    two separate `write()`s, outside the frame. They do cost up to 0.1 ms of frame
    period at 20k LEDs; one combined transaction would remove that.
  - Frame periods here are set by the 4-port player's 6.2 MHz SCK (r ≈ 1.94),
    not by the target fps.
  - **Assumption:** pauses are a DMA/software property, independent of SCK. The
    player's SCK is fixed by `--fpga-ports`, so 3.2 vs 6.4 MHz couldn't be
    compared. At 20 ports (SCK ~22–24 MHz, beyond the analyzer) the FPGA's
    `STATS` counters are the check (#370).
  - Rig note: the SPI tap is CS = D1, MOSI = D5. The station doc had them
    swapped; fixed in #370.

### End-to-end latency, input to photon, at 120 fps

WS2812s show new colours on the latch, so a frame's photons appear at the *end*
of its wire time:

| step | time |
|---|---|
| input sampled at the next render start | 0–8.3 ms (avg 4.2) |
| GPU render + readback | ~1 ms |
| wait for the SPI slot (double buffer) | 0–8.3 ms |
| prefill + emission + latch (270 LEDs; 7.9–8.1 ms at the 260 cap) | ~8.2 ms |
| **total** | **~10–26 ms, typically ~15–18 ms** |

For comparison, 1024 LEDs/channel at 30 fps comes to ~50–100 ms. Latency gets
shorter with a shallower pipeline (render just-in-time against the FPGA
frame-done signal, now in #370) and with shorter strips.

### FPGA support (#370)

- Back-to-back frames at a 120 fps cadence are verified in Verilator: 20 × 270
  at 80 µs and 20 × 266 at 300 µs (`led_type` 1), with one frame deliberately
  started inside the previous latch.
- A frame shorter than PREFILL bytes per port now starts when CS ends, where
  before it never started. So PREFILL can be raised for gap tolerance without
  breaking short frames.
- Self-instrumentation (`STATS`): underrun counts (total and per port), the
  minimum FIFO level, and the longest byte-to-byte gap with CS low. A sticky
  underrun flag is shown on `led[1]`.
- **Frame-done output** (`frame_done`), simulated in `spi_ws281x_120fps_sim`:
  never HIGH while any port drives, and every rising edge comes one latch after
  the last bit. Frame-done paced at 260 LEDs: 8/8 clean frames, one edge per
  frame.
- **Pinned 20-port top:** ports 0–7 on pins 70–77 (as the 8-port top), ports
  8–19 on 40 35 41 42 51 53 54 55 56 57 68 69 (owner's choice), frame-done on 28 →
  Pi GPIO 22 (confirmed). Place-and-route: 2354 LUT4, 1449 DFF, 20/26 BSRAM, 31 IOB, fmax
  75.4 MHz at the 54 MHz core. Pins 53–57 are Gowin dual-purpose configuration
  pins, built with the `*_as_gpio` flags; hardware bring-up is pending.

### Next measurement (Pi 3, for the operator)

**Done (run 3, `pi-ledmapper-2`).** At 4 × 270 the GPU is 0.34–0.36 ms per frame
and the 4-thread VM 0.28–3.2 ms (noise 3.2). At 20 × 270 the numbers are in the
table above. Raw data: `/workspace/.claude/fxgpu/pi3bench/pi3bench-120fps.jsonl`.

## 1. Partitioning: what maps to the GPU, what stays on the CPU

An effect is `update()` (once per frame, evolves `state`) + `shade(led)` (once
per LED, returns RGB) + optional buffers/textures/graph/user-functions. The GPU
target is **`shade()` only**, as a per-LED kernel. `update()` stays on the CPU:
it is one invocation per frame (not hot), it is where `state` is written, and it
is where sensors/I2C and graph/flood sweeps live.

The split, by IR construct (opcodes from `fx_vm::Op`):

| Construct | Target | Why |
| --- | --- | --- |
| scalar/vector float arith, `Scale`/`MulAdd`/`Dot`/`Cross`/`Length`/`Normalize`/`Distance` | **shader** | pure ALU |
| `UnMath`/`BinMath` (sin/cos/floor/exp/log/pow/atan2/min/max/mod/step), `Smoothstep`, `Clamp`, `Mix` | **shader** | map to GPU builtins (numerics §3) |
| `Hsv2Rgb`, `Palette` | **shader** | pure functions, inlined |
| `Hash1`/`Hash3` and integer/fixed ops (`*I`, `*Fix`, `MulFix`, rescales) | **shader (int-capable targets)** | exact as 32-bit integer ops; **not** on GLES2 (no ints) |
| `LoadUniform`, `LoadState` (read), `LoadCtx`/`LoadCtxFix` (time/pos/uv/s/idx/imu/room) | **shader input** | uniforms in a UBO; LED attributes per-invocation from an SSBO/position buffer |
| `BrFalse`/`BrCmpI`/`Jmp` forming `if/else` | **shader (if-conversion)** | both arms are pure, merged with `select` |
| straight-line locals (`LoadLocal`/`StoreLocal`/`TeeLocal`/`FillLocal`) | **shader** | SSA temporaries |
| per-LED memo cache (`LoadLedCache`/`StoreLedCache`) | **shader (recompute)** | the cache is a CPU-RAM optimisation; the GPU just recomputes — bit-identical to a cache-miss |
| per-frame prepare (`prep_entry`, hoisted LED-invariant work) | **CPU → uniforms** | computed once/frame on the CPU, uploaded as extra uniforms (the `Hoisted` input class) |
| `StoreState` in shade | — | never emitted in shade (shade is read-only on state) |
| loops with a data-dependent / unbounded trip count | **CPU (VM)** | no bounded unroll; fork model wouldn't terminate |
| `Call`/`RetFn` user functions | **CPU (VM)** for now | inlinable later; refused in the prototype |
| `LoadBuf`/`StoreBuf`/`SampleTex`/`PaintTex` (buffers, feedback, textures) | **CPU (VM)** for now; **GPU-native later** | textures are the GPU's home turf (§6/P4) but need the arena mapped to GL textures/SSBOs |
| `GraphQuery`/`FloodFrom` (topology, geodesic) | **CPU** | irregular graph walks; feed results in as a per-LED attribute (`led.dist`) |
| dynamic-index array/struct (`LoadStateIdx`, …) — agent sims | **CPU (VM)** | data-dependent addressing, usually in `update()` anyway |
| `I2cRead/Write`, drivers (`FLAG_DRIVER`) | **CPU** | hardware I/O |
| `JitCall` | — | refused (the RV32 JIT is a different backend) |

**How the split is wired (the prototype's model, extends to the device):**

* **Per-effect kernel extraction.** The CPU loads the `.fxb`, runs `update()` and
  the per-frame `prep`, then hands the GPU a kernel that is purely
  `shade(uniforms, state, led_attrs) -> rgb`. One kernel per loaded effect
  (two when two decks are active — §"decks").
* **Uniforms in a UBO/SSBO.** `uniforms[]`, the read-only `state[]` snapshot, the
  frame context (time/dt/frame/imu/room box) and the CPU-hoisted values go in
  one std430 buffer, rebound per frame (a few hundred bytes).
* **LED positions as a buffer, one invocation per LED.** `led.pos/uv/s/idx/seg/
  dist/room` and their Q16.16 mirrors are a per-LED record in an SSBO (compute:
  `indata[gid*stride + k]`) or a 1×N data texture (GLES2 fragment). These are
  computed once at map load, exactly as the VM's per-LED fixed cache already is,
  and only re-uploaded when the map changes.
* **Output.** The kernel writes one packed RGBA8 word per LED to an output SSBO
  (compute) or `gl_FragColor` into a 1×N RGBA8 render target (fragment). The CPU
  reads that back and frames it for SPI/FPGA (§4).

## 2. IR → SPIR-V / GLSL codegen

The prototype defines a small **kernel IR** (`fx_gpu/src/ir.rs`): a hash-consed
(CSE'd) SSA DAG of 32-bit-word nodes, each typed `F` (f32) / `U` (32-bit int) /
`B` (bool). Two layers:

* **Macro ops** carry exact `fx_vm` semantics (`MDiv0` = divide-by-zero→0,
  `MHash3` = the VM's bit-mixing hash, `MMulFix` = Q16.16 multiply, `MSel` =
  if-converted branch). `lower.rs` abstract-interprets the `.fxb` `shade()` body
  into macro ops: it mirrors `fx_vm::run` op-for-op but over node ids, so the
  correspondence is auditable. Branches are **if-converted** (fork both arms to
  their `Ret`, merge with `MSel` on the predicate — exact because shade is
  side-effect-free).
* **Primitive ops** are what a shader expresses directly. `legalize.rs` rewrites
  each macro op into primitives for a numerics **profile** (§3), reproducing the
  matching `fx_vm` helper inline (e.g. `clamp01`'s NaN rule, `normalize`'s
  `len>1e-9` guard, the `mix32` avalanche hash, Q16.16 `(a*b)>>16` via
  `mul`+`mulhi`+shift). Only primitives reach the emitters.

**Emitters.** `emit_glsl.rs` walks the primitive DAG to SSA statements:

* `Target::Es310Compute` — GLSL ES 3.10 compute, 64-wide workgroup, inputs from
  a std430 `float` SSBO (int inputs reinterpreted with `floatBitsToUint`), RGBA
  packed to a `uint` output SSBO. Real 32-bit ints → hash/fixed exact. **This is
  the Pi 4/5 path and the SPIR-V source.**
* `Target::Es100Fragment` — GLSL ES 1.00 fragment, one fragment per LED,
  `gl_FragColor`. No integers on VideoCore IV, so a graph needing an int op is
  **refused** (`Err`) and the effect stays on the VM / an int-capable tier
  (§Tiering).

**SPIR-V.** The prototype does **not** hand-write SPIR-V; it emits GLSL ES 3.10
and lets `glslang -G` produce SPIR-V, validated by `spirv-val` — the exact
toolchain td-deploy uses (`compiler/translate_gles.py`), and the path Pi V3D's
`v3dv` consumes. For the **production** backend use **`naga`** (wgpu's IR): it
ingests our module (or a WGSL/GLSL print) and emits SPIR-V, GLSL ES 1.00/3.10
*and* Metal/HLSL from one place, with validation built in. `naga` is the
recommended crate; `rspirv` is the fallback if we ever want to emit SPIR-V
directly without a GLSL hop. We keep the GLSL ES 1.00 emitter regardless,
because `naga`'s GLSL-100 output for VideoCore needs the same int-free
guarantees we already enforce. (Neither crate is in the repo's offline Bazel
universe yet; adding `naga` is a MODULE.bazel change staged for the device PR.)

A sample of emitted ES 3.10 compute (`noise_field`), machine-generated:

```glsl
#version 310 es
layout(local_size_x = 64) in;
layout(std430, binding = 0) readonly buffer In  { float indata[]; };
layout(std430, binding = 1) writeonly buffer Out { uint outp[]; };
layout(location = 0) uniform uint led_count;
layout(location = 1) uniform uint n_inputs;
int mulhi_s(int a, int b) { int hi; int lo; imulExtended(a, b, hi, lo); return hi; }
void main() {
  uint gid = gl_GlobalInvocationID.x;
  if (gid >= led_count) return;
  float v0 = indata[gid * n_inputs + 0u];  // led.pos.x
  ...
  outp[gid] = R | (G << 8) | (B << 16);
}
```

## 3. Numerics policy (owner decision)

The GPU's float is **not** bit-exact with the VM's. The VM is deterministic
soft-float with deliberately crude helpers: `sinf` is a 256-entry LUT + lerp,
`atan2f`/`expf`/`logf`/`powf` are low-order polynomials, `f2i`/`floor` are
bit-twiddles. A GPU computes `sin`/`exp`/etc. in hardware to its own (often
mediump on VC4) precision. So a GPU tier **cannot** be a drop-in replacement
under the "bit-exact across host and device" rule the current tests assume.

The policy is a **three-class conformance model**, enforced per numerics
profile and measured over the corpus (§Prototype):

1. **Exact (must match bit-for-bit), reproduced on int-capable targets.** The
   integer/fixed world: `Hash1`/`Hash3` (the `mix32` avalanche — pure 32-bit
   int ops), the integer compares, `MulFix`/`*FixN`, `f2i`, rescales, and the
   `RetRgb8`/`RetRgbFix`/`unit_u8` quantization. The prototype reproduces these
   as the VM's exact integer sequences and the harness confirms **0 error**.
   These require real integers → **GLES 3.1 / SPIR-V only** (Pi 4/5). On GLES2
   they can't be made exact, so an effect that uses them stays on the VM / an
   int-capable tier.
2. **Tolerance-bounded (native transcendentals).** `sin/cos/floor/fract/exp/
   log/pow/atan2/sqrt` and float divide map to GPU builtins. These differ from
   the VM's approximations, but for the vast majority of effects the visible
   result is within a small 8-bit tolerance. **Decision needed: set the
   per-tier tolerance.** Proposed: **≤ 2 / 255 max channel error on Pi 4/5
   (highp), ≤ 6 / 255 on Pi 3 (mediump)**, as golden tests per tier.
3. **Must-emulate-exactly-or-refuse.** A few effects are dominated by a
   transcendental where the VM's approximation and the hardware's diverge
   enough to see (notably `tan` near its asymptote, and heavy `pow`/`log`
   stacks): measured max error up to the full 255. For these the options are
   (a) keep them on the VM, or (b) emit the VM's *own* approximation in the
   shader — the LUT sine as a constant texture, the exact polynomials inline —
   so the GPU reproduces the VM bit-closely. The prototype flags these; the
   recommendation is **(b) for `sin`/`cos`** (cheap: a 257-entry LUT, and it
   makes the common case exact too), **(a) keep on VM** for `tan`/`pow`/`log`
   -heavy effects until measured need.

**Measured conformance** (prototype, `--profile exact`, 64 LEDs × 6 frames, max
abs channel error vs `fx_vm`, 0..255):

* 132 of 197 corpus effects lower; **125 (95%) are within 2/255**; integer hash
  is exact (0).
* The 7 over tolerance are all transcendental-stress microbenchmarks:
  `tanM`/`tan2M` (255, `tan` asymptote), `sparkle` (245), `powfM`/`powf2M` (43),
  `logfM`/`logf2M` (14). Every one is a known class-3 case, not a lowering bug.

The policy keeps the VM bit-exact as today; a GPU tier is **opt-in per effect**
and gated by its measured tier tolerance, with class-1 work staying exact.

## 4. Readback and the FPGA/SPI path; frame budget

The GPU result must reach the Tang FPGA over SPI (the `pi/player_rs` sink,
`wire::FpgaCodec`). Two transports:

* **Readback (recommended first).** `glReadPixels` (GLES2) / an SSBO map
  (compute) pulls the 1×N RGBA8 (≈ N×4 bytes; 2048 LEDs = 8 KB) to CPU, the
  player repacks to the FPGA codec and writes it over spidev exactly as today.
  Bandwidth is trivial; the cost is the pipeline **drain** (`glFinish`), which on
  VideoCore is sub-ms to a few ms and **must be measured** (open item — see
  Prototype/HITL). Keep the readback small: render an LED-count target, never a
  full screen. Do GRB order + gamma + brightness **in the shader** so the
  readback is nearly the SPI payload. PBOs don't exist in GLES2 and buy little
  at these sizes; on GLES3 a persistent-mapped SSBO with a fence avoids the full
  stall.
* **Direct scan-out (later, if readback is the bottleneck).** Render the LED grid
  to a KMS plane and let the display controller stream it to the FPGA over
  **DPI** (24-bit parallel RGB) — no CPU readback, and vsync gives exact frame
  sync. Costs: DPI uses GPIO 0–27 (collides with SPI0/I2C), needs ~28 FPGA input
  pins and a faked display mode, and requires proving 1:1 pixel values (no plane
  scaling/dither). **SMI** (`bcm2835-smi`) is a middle option but still needs a
  CPU-visible buffer, so it doesn't avoid readback. The prior-art baseline (§7)
  used plain SPI at 15.6 MHz and never needed this.

### End-to-end scaling model, 500 LEDs → 20 × 1024 (MAX target)

Per frame the stages are: render (GPU or VM) → readback → SPI to the FPGA → FPGA
streaming → WS wire. SPI, FPGA and wire run concurrently with each other: the
core streams while SPI is still arriving. They're decoupled from render by the
player's render thread. The frame rate is set by the slowest stage:
`fps ≈ 1 / max(render + readback, SPI, wire)`.

**Wire (hard ceiling).** Per channel, `L` LEDs × 3 bytes × 9.963 µs (the core's
54 MHz bit period of 1.2407 µs, plus 2 clocks per byte) + 80 µs latch. All
channels run in parallel, so this depends only on LEDs per channel.

**FPGA FIFO** (#370): with SPI at `r ×` the drain rate, each port's FIFO peaks at
about `3L·(1 − 1/r) + PREFILL` bytes. The in-tree core has 1,659 B/port (553
LEDs); #370's 20-port variant has 2,048 B/port.

**SPI.** One frame is `3N + 1` bytes in a single spidev write (CS low for the whole
frame; CS-high latches). It must sustain ≥ the drain rate
`channels × 0.803 Mbit/s` and finish within the wire time. The player asks for
`min(2 × channels × 0.8 MHz, 24 MHz)`.
- The Pi 3's SPI clock is `core_clk / even divisor`. At 400 MHz the 24 MHz request
  rounds to ~22.2 MHz (`/18`; *to confirm on the capture*).
- So 20 channels run at r ≈ 1.38 over the 16.06 Mbit/s drain. The FPGA sim
  (#370) passes 16.7–27 MHz with peak FIFO fill ≈ `L·(1−1/r)`.

| layout | N | wire ms (fps ceiling) | min SPI Mbit/s | SPI ms @ 22.2 MHz | frame bytes | fits spidev 4096 (main)? (#369: 65536) | FPGA (in-tree 8-port / #370 20-port) |
|---|---:|---:|---:|---:|---:|:-:|---|
| 1×500 | 500 | 15.0 (66) | 0.8 | 0.54 | 1,501 | yes | ok / ok |
| 1×2048 | 2,048 | 61.3 (16) | 0.8 | 2.2 | 6,145 | **no** | **overflows**: 2048 LEDs on one 1,659 B FIFO, peak ≈ 3,074 B at the player's r = 2 / ok |
| 4×550 | 2,200 | 16.5 (60) | 3.2 | 2.4 | 6,601 | **no** | ok / ok |
| 4×1024 | 4,096 | 30.7 (32.6) | 3.2 | 4.4 | 12,289 | **no** | peak ≈ 1,538 of 1,659 B at r = 2 (7% margin; overflows at r > 2.17) / ok |
| 8×1024 | 8,192 | 30.7 (32.6) | 6.4 | 8.9 | 24,577 | **no** | as 4×1024 / ok |
| 16×1024 | 16,384 | 30.7 (32.6) | 12.9 | 17.7 | 49,153 | **no** | needs 16 ports / ok |
| 20×1024 | 20,480 | 30.7 (32.6) | 16.1 | 22.1 | 61,441 | **no** | needs 20 ports / ok (20/26 BSRAM, 75 MHz pinned) |

The table is *computed* from the core and protocol constants. The wire timing is
validated in sim (#370). On hardware, the logic analyzer covers 4 channels; the
16- and 20-channel rows are **extrapolation** until the pinned 20-port bitstream
(#370) is brought up on a board.

**Render + readback, measured on a Pi 3B+ (vc4; §5).** At each layout:
- GPU (render + readback, pipelined): ≈ 0.3 ms at 1×500, 0.6 ms at 4×550, 0.9 ms
  at 4×1024, 1.5 ms at 8×1024, 2.8 ms at 16×1024, **3.2–3.5 ms at 20×1024**. It is
  the same for every lowered kernel.
- VM: grows linearly at 0.33–5.3 µs/LED on one A53 core. At 20×1024 that is
  **6.8–108 ms**.

| layout | wire ms | GPU pipelined ms | VM 1-core ms (solid … plasma; noise) | VM 4-core ms (solid … plasma; noise) | bottleneck, GPU | bottleneck, VM 1-core |
|---|---:|---:|---|---|---|---|
| 1×500 | 15.0 | 0.29 | 0.16 … 1.25; 2.6 | *≤ 1 (est.)* | wire | wire |
| 1×2048 | 61.3 | 0.97 | 0.66 … 5.1; 10.8 | *≤ 4 (est.)* | wire | wire |
| 4×550 (today) | 16.5 | 0.62 | 0.70 … 5.6; 11.6 | *≤ 4 (est.)* | wire | wire |
| 4×1024 | 30.7 | 0.87 | 1.3 … 10.3; 21.7 | **1.2 … 3.0; 7.5** (1.5–3.8×) | wire | wire |
| 8×1024 | 30.7 | 1.5 | 2.7 … 20.7; 43.4 | *≤ 12 (est.)* | wire | wire, except noise-class (**VM**) |
| 16×1024 | 30.7 | 2.8 | 5.4 … 41.4; 86.3 | *≤ 23 (est.)* | wire | **VM** for plasma and noise (cylinder at the limit) |
| 20×1024 | 30.7 | 3.4 | 6.8 … 51.9; 108 | **2.2 … 13.3; 27.1** (3.1–3.97×) | wire | **VM** for all but solid/sweep (gradient/imu at the limit) |

**Where the bottleneck sits.**
- **GPU:** the wire, at every scale. Render + readback uses ≤ 11% of the
  30.7 ms frame even at 20×1024. SPI (22.1 ms at 22.2 MHz) also fits under the
  wire, concurrently.
- **VM on one core:** fine through 4×1024. From 8×1024 the heavier effects become
  the bottleneck. At 20×1024 every non-trivial effect misses the 32.6 fps ceiling:
  cylinder 37.5 ms, pulses 33.3, plasma 51.9, noise 108.
- **VM on four cores (measured, `--vm-threads 1,4`):** at 20×1024 *every*
  measured effect fits under the wire: plasma 13.3 ms, noise 27.1 ms. 4 threads
  are 3.1–3.97× faster than 1. But it takes all four A53 cores. At 4×1024 the
  gain is only 1.5–3.8×, because the fixed per-frame cost dominates small
  frames. The 8×1024 and 16×1024 rows are interpolated.

### MAX image changes this needs (proposals)

1. **`spidev.bufsiz`: handled by the MAX OTA PR #369.** spidev rejects any
   single write larger than `bufsiz` (default **4,096 bytes**). The player writes
   each STREAM frame in one `write_all`, which must stay one transfer because
   CS-high latches. So on `main` every frame over **1,365 LEDs** fails, including
   today's 4×550 (6,601 bytes). #369 found that this failed *silently* with
   EMSGSIZE and makes the error visible. Its image sets `spidev.bufsiz=65536`,
   which covers 20×1024 (61,441 bytes). #369 also fixes a player crash-loop on
   `main` (stack overflow in an 8 MiB thread). Nothing more is needed here beyond
   landing #369. Above 21,845 LEDs the codec would have to split frames with CS
   held, which `write_all` can't do. The bcm2835 SPI DMA handling a single
   61 KB transfer is *to verify* on the #369 test image (the planned SPI-tap
   capture on `pi-ledmapper-1`).
2. **Pin the VideoCore core clock on the Pi 3.** The Pi 3's SPI clock divides
   `core_clk`, which drops with frequency scaling (400 → 250 MHz). That would take
   a 22.2 MHz SCK down to ~13.9 MHz, *below* the 20-channel drain. Set
   `core_freq=400` + `core_freq_min=400` (or a fixed 250 with the divider retuned)
   in `config.txt`. This matters only from ~16 channels up, but it silently
   breaks frames when it does.
3. **20 channels on the FPGA:** the in-tree Tang Nano bitstream drives **8**
   outputs (`NUM_WS = 8`, `ws[0..7]` on pins 70–77) with **553 LEDs/port** FIFOs.
   20 × 1024 needs `MAX_PORTS = NUM_WS = 20`, 12 more `.cst` pins,
   `FIFO_DEPTH = 2048` (one BSRAM/port; full-frame FIFOs need 40 of the 26
   BSRAMs), and SPI ≥ 16.7 MHz. Draft **#370** adds the pinned 20-port top
   (owner's pins 40 35 41 42 51 53 54 55 56 57 68 69 for ports 8–19, plus a
   frame-done output on pin 28) and verifies it in place-and-route (2354 LUT4,
   1449 DFF, 20/26 BSRAM, 75.4 MHz vs 54) and in a 20×1024 Verilator sim. It also fixes
   the core README's stale "~2 bytes of buffer per port" claim; the core has had
   per-port BSRAM FIFOs since the double-buffer was replaced.
4. **Start-of-frame gap guard: not needed at the measured behaviour.** The Pi 3
   sends each frame as one gap-free DMA transfer up to 61 KB (no CLK pause
   ≥ 1 µs; §0). The in-tree `PREFILL = 2` (20 µs of slack) is enough, so raising
   it is optional insurance. Keep the `STATS` underrun counters as the production
   health signal (#370).

## 5. Measured speedups: Pi 3B+ (VideoCore IV), GLES2 vs the VM

Run 1 setup:
- `fx_gpu/pi3bench` on `pi-ledmapper-2` (Pi 3 Model B Plus Rev 1.4, kernel
  6.12.87, stock `pi-v1` MAX image), one reservation.
- The image has vc4 KMS on (`dtoverlay=vc4-kms-v3d`, render node present, CMA
  256 MB). It ships no Mesa of its own, so the payload's lean Mesa was used.
- Renderer **"VC4 V3D 2.1", OpenGL ES 2.0 Mesa 26.2.4**: max texture 2048,
  8 vertex attributes.
- The player was running, at load 1.0 and 1.3 GHz.
- 60 GPU frames per point, and the VM until ≥ 3 frames and 1.5 s.
- Raw data: `/workspace/.claude/fxgpu/pi3bench/pi3bench-results-run1.jsonl`.

**20×1024 (the MAX target, 20,480 LEDs), ms per frame:**

| kernel | VM, 1 A53 core | GPU render | GPU readback (RGBA8) | GPU pipelined | speedup vs VM | GPU error vs VM |
|---|---:|---:|---:|---:|---:|---|
| solid_fill | 6.76 | 1.50 | 1.41 | 3.15 | 2.1× | 0 (bit-exact) |
| sweep | 19.5 | 1.72 | 1.41 | 3.44 | 5.7× | 0 (bit-exact) |
| gradient | 29.5 | 1.73 | 1.42 | 3.42 | 8.6× | ≤ 1/255 on 4.0% of LEDs |
| imu_tilt | 29.8 | 1.73 | 1.38 | 3.50 | 8.5× | 0 (bit-exact) |
| cylinder | 37.5 | 1.72 | 1.39 | 3.43 | 10.9× | ≤ 1/255 on 4.8% |
| plasma | 51.9 | 1.72 | 1.42 | 3.50 | 14.8× | ≤ 2/255 on 40.9% |
| pulses (hash: VM only) | 33.3 | — | — | — | — | — |
| noise (hash: VM only) | 108.0 | — | — | — | — | — |

The VM reproduced the host goldens with 0 errors on every point, confirming
cross-platform bit-exactness on real hardware.

**What the numbers say:**
- **GPU time is set by LED count, not the effect.** Render is 1.50–1.73 ms at
  20k LEDs, from `solid_fill` (3 IR nodes) to `plasma` (54). vc4's per-vertex
  fixed cost dominates, and kernel ALU is noise at these sizes. So the GPU cost is
  flat: ~0.08 µs/LED render + ~0.07 µs/LED readback. The VM's is 0.33–5.3 µs/LED.
- **Readback is cheap but not free:** 1.4 ms for 80 KB at 20×1024 (~58 MB/s,
  a synchronous `glReadPixels` from the tiled framebuffer).
  - The driver's preferred read format *is* RGBA8, so no faster format exists.
  - An RGB565 target halves readback to 0.65 ms but makes render slower
    (2.3–3.4 ms) and is lossy. Not worth it.
  - Pipelined draw + read (no explicit `glFinish`) is 3.2–3.5 ms.
- **Accuracy is well inside the Pi 3 tolerance proposed in §3** (≤ 6/255): max
  2/255, and 100% of LEDs within 2. Effects built on float add/mul/compare are
  **bit-exact** on vc4. The 1–2/255 differences come only from native
  `sin`/divide (class 2).
- **Speedup at 20×1024: 2.1× (solid fill) to 14.8× (plasma)** end to end. At
  today's 4×550 the GPU is 0.62 ms against a VM 0.70–5.6 ms (11.6 for noise),
  both far under the 16.5 ms wire. **At today's scale the GPU isn't needed; at
  MAX scale it is the only Pi 3 path that keeps non-trivial effects at the wire
  ceiling.**
- **VM threading (measured, run 2).** `fxvm_bench` and today's player run the VM
  on **one** core. With `--threads 4` (LEDs split across lockstepped workers,
  golden-checked bit-exact) at 20×1024:

  | | plasma | noise | cylinder | pulses | sweep | solid |
  |---|---:|---:|---:|---:|---:|---:|
  | 1 thread | 52.7 | 107.3 | 36.6 | 33.3 | 19.6 | 6.9 |
  | 4 threads | **13.3** | **27.1** | 9.3 | 8.6 | 5.1 | 2.2 |
  | GPU pipelined | 3.5 | — | 3.4 | — | 3.4 | 3.2 |

  - So a **4-core VM keeps every measured effect, hash/noise included, under
    the 30.7 ms wire at 20×1024.** Noise has the least margin, at 27 ms.
  - It costs **all four cores** of a Pi 3 that also runs the player, networking
    and SPI, under the 3B+'s thermal throttle.
  - The GPU does the float effects in about 3.4 ms with the cores free. CPU time
    on the GPU path was *not* measured; it is mostly a wait on the GPU.
- **Pi 4/5 (V3D compute) is not measured here.** Expect the same flat per-LED
  cost at a fraction of vc4's, plus exact integer ops, so hash effects run there
  too.

### GLES2 coverage: what still can't go to the Pi 3 GPU

Of the 132 corpus effects that lower, **100 run on GLES2 / vc4.** The hsv fix
moved cylinder-style effects across; it had been 92. **All remaining 32 are
blocked by `hash`**: `noise`, `noise_field`, `pulses`, `sparkle`,
`segment_pulses`, `rain_naive` and others. The VM's `hash` is an integer
avalanche (`mix32`) over the operand's **f32 bit pattern**. GLSL ES 1.00 has
neither integers nor bit casts, so it can't be expressed there. The other 65
corpus effects don't lower at all yet (buffers/textures, unimplemented fixed
ops, loops, user functions; §1) and stay on the VM on every tier. Options for the
hash class:

| option | exact vs VM? | cost on vc4 | cost elsewhere | verdict |
|---|---|---|---|---|
| **(a) Emulate `mix32` in float math.** Rebuild the f32 bits via log2/exp2, do 32-bit mod-2³² multiply/xor in ≤ 24-bit limbs. | yes | ~10³ ALU ops per hash; noise does 24 `mix32`/LED, so ~5×10⁸ ops per 20×1024 frame ≈ 25–30 ms (*estimate*). Kernels this big are ALU-bound, unlike the measured ones. | none | **No**: no better than a 4-core VM |
| **(b) A float-native hash builtin** (e.g. a sine-free `fract(p·k)` chain, ~8–10 ops) that authors opt into | **no**: different values, a statistically similar look | ≈ plasma: ~3.5 ms at 20×1024 | VM on the C6: soft-float `fract`/mul cost more than the integer `mix32` it replaced (FUG-122) | Only as an opt-in for Pi-targeted effects; never a silent replacement |
| **(c) Hoist on the CPU.** When the hash argument is LED-static (`hash(led.idx)`, `hash(led.pos)`), compute it once, exactly, and pass it as a vertex attribute. | yes | free (one attribute) | none | **Yes**, automatic. It helps seeded sparkle/twinkle effects, not time-varying lattice noise like `noise`/`noise_field`. |
| **(d) Pi 4/5 tier** (GLES 3.1 / Vulkan, real integers) | yes | n/a on Pi 3 | — | **Yes**: the clean path for hash effects |

So on a Pi 3, hash-heavy effects stay on the VM (4-core when that lands), with (c)
picking off the static-seed cases. Exact GPU noise is a Pi 4/5 feature.

## 6. Multi-generation tiering and fallback

| Board | GPU | API | Tier |
| --- | --- | --- | --- |
| **Pi 5** | V3D 7.1 | Vulkan 1.3 / GLES 3.1 | **compute (SPIR-V)**, highp, int exact (class-1), tol ≤ 2/255 |
| **Pi 4** | V3D 4.2 | Vulkan 1.1 / GLES 3.1 | **compute (SPIR-V)**, same as Pi 5 |
| **Pi 3 / Zero 2 W** | VideoCore IV (vc4) | **GLES 2.0 only**, no compute | **vertex-shader kernel (GLSL ES 1.00)**, float-only subset (100/132 lowered), highp vertex stage; measured max error 2/255, so tol ≤ 2/255 is achievable (≤ 6/255 proposed) |
| any / unsupported effect | — | — | **CPU VM** (+ NEON later), always correct |

The **fallback is the VM**, which is why correctness is never at risk: an effect
is promoted to a GPU tier only when (a) it lowers, (b) the target supports its
ops (GLES2 rejects integers), and (c) it passes the tier's golden tolerance.
Anything else runs on the VM exactly as today. A per-effect probe at load time
(lower → legalize → tolerance-check against a VM reference pass over the map)
decides this; the result is cached with the compiled effect.

**NEON/native CPU path:** the AOT translator (`firmware/fx_aot`, #341) already
targets RV32 for the C6. The same bytecode→native lowering retargeted to
aarch64 + NEON gives the Pi a fast CPU tier for effects that don't go to the GPU
(buffers, user functions, loops). That is a separate workstream; the GPU tier
and the VM fallback stand on their own.

## 7. Prior art: ledsuitdisplaydriver + ledsuit-fpga (2019–2020)

Two of the user's earlier repos drove ~900 WS2812B LEDs from GPU visuals on a
Pi 3 + FPGA. The user's framing: *"an existence proof, but not a
guaranteed-best method."* Key finding from reading them: **the Pi side did NOT
run a per-LED GPU shader.** It captured a separately-rendered window with the
Broadcom **DISPMANX** snapshot API (`vc_dispmanx_snapshot` +
`vc_dispmanx_resource_read_data` in `vc_capture_source.cc`) into an RGB888 CPU
buffer, then **point-sampled** it per LED on the CPU from a 50×50 raster
(`led_driver.cc`, nearest-neighbour via `x*(w-1)`). The README itself calls out
"extreme spatial aliasing from the sampling scheme." CPU post-processing did
threshold, a crude power limiter, gamma 2.8, and GRB swap.

* **Transfer:** `/dev/spidev0.0`, mode 0, 15.6 MHz, one burst per frame; framing
  is a 2-byte `[w|addr15]` header + raw bytes auto-incrementing into FPGA BRAM
  (`spi_memory.v`). 900×3 bytes ≈ **1.39 ms on the wire** (computed), ~10×
  headroom.
* **FPGA (`ledsuit-fpga`):** iCE40 LP8K (TinyFPGA BX, yosys/arachne-pnr),
  SB_PLL40 to 50 MHz, an SPI slave into a **single** BRAM frame buffer (7,200
  bytes), a priority `bus_arbiter`, and 8 parallel `strip_driver` WS2812 engines
  (300 LEDs each, 1,400 ns/bit). Computed refresh ≈ **11.1 ms ≈ 90 Hz** per
  300-LED strip, all strips in parallel. The strips free-run from the buffer.
* **No measured fps/latency in either repo**; every number above is computed
  from constants. No frame sync: render, capture, SPI and strip refresh are four
  free-running clocks; the single-buffered BRAM can tear mid-strip.

**Keep:** the Pi-renders / FPGA-owns-timing split; the free-running parallel
WS2812 engines; the address+burst SPI framing; channel-major memory layout
(strip *k* at base `k×LEDs`); mapping data kept separate from the renderer;
gamma + per-channel peak-brightness calibration + a power limiter (port as
shader math or an FPGA LUT).

**Do differently, with reasons:**

* **Evaluate effects per LED; don't sample a picture.** Splanc effects are
  functions of each LED's position, so render one fragment/invocation per LED
  (FBO width = LEDs/channel, height = channels; each row = one strip's address
  range). This removes the aliasing *and* the CPU sampling loop. Our prototype
  is exactly this per-LED kernel.
* **Surfaceless EGL over GBM/`/dev/dri`, not X11 + DISPMANX.** DISPMANX is a
  firmware API that only works under legacy/fkms and is gone under full
  `vc4-kms-v3d` on current Pi OS. td-deploy's surfaceless-EGL path (§Toolchain)
  is the supported route and needs no display.
* **Do GRB/gamma/brightness on the GPU** so the readback is nearly the SPI
  payload (they did it on the CPU).
* **Double-buffer in the FPGA** + a commit/swap on CS-rising and a frame
  sequence number + CRC in the header — the old single-buffer tore.
* **Pace to one clock** (FPGA "ready" GPIO or a timer), not four free-running
  loops.
* **Mind SPI limits:** spidev's default `bufsiz` is 4 KB, so ≥1366 LEDs needs
  chunking or a module param; and the FPGA's SPI oversampling margin is ~clk/4,
  so check before pushing SCK past ~12 MHz.

**Readback vs direct scan-out** is weighed in §4. The existence-proof baseline to
beat: ~1.39 ms SPI/900 LEDs and ~90 Hz WS2812 refresh/300-LED strip.

## 8. Pi toolchain: reuse from td-deploy

td-deploy already solved the hard image/toolchain parts; reuse directly
(`/workspace/.claude/siblings/td-deploy`):

* **`deploy/nix/mesa-lean.nix`** — Mesa restricted to `galliumDrivers=["vc4"
  "v3d"]` + `vulkanDrivers=["broadcom"]` and, the load-bearing part,
  `-Dllvm=disabled` (plus rusticl/vdpau/va/xa/teflon off). This is what keeps the
  **507 MB LLVM** out of the image (td-deploy's whale). **Reproduced on this
  host in this PR:** a lean Mesa 26.2.4 with vc4+v3d+broadcom and **zero LLVM in
  the closure**. Mesa itself is **35 MB** on disk (an earlier draft said 118 MB,
  a misread of the closure size). The whole relocatable runtime set (Mesa +
  libglvnd + libdrm + X/wayland client libs + glibc) is ~125 MB, ~37 MB
  compressed. In an image that already ships glibc, Mesa adds ~40–60 MB. Mesa 26
  needs extra knobs vs td-deploy's pin (`-Dtools=`, `-Dvideo-codecs=`,
  `-Dvulkan-layers=`, `install-mesa-clc`/`install-precomp-compiler`/`intel-rt`
  off, no `gallium-vdpau`/`xa` options, and dropping the rusticl `postFixup`);
  captured in `fx_gpu/pi3bench/mesa-lean.nix`.
* **Surfaceless EGL context** (`runtime_rs/src/main.rs make_gl`):
  `eglGetPlatformDisplay(EGL_PLATFORM_SURFACELESS_MESA)`, dlopen libEGL via
  `khronos-egl`'s `dynamic` feature, no display; target chosen per board
  (`gles2` for vc4, `gles` ES 3.1 for V3D).
* **The `makeWrapper` env** (`__EGL_VENDOR_LIBRARY_DIRS`, `GBM_BACKENDS_PATH`,
  `LIBGL_DRIVERS_PATH`, `EGL_PLATFORM=surfaceless`) and the `video`/`render`
  groups for `/dev/dri/renderD128`.
* **The offline shader toolchain** (`compiler/translate_gles.py`,
  `check_gles2.py`): glslang → SPIR-V → `spirv-cross --es --version 100`, and a
  host check that compiles every shader under a real Mesa ES2 surfaceless
  context in CI. We validate the same way (this PR: glslang + spirv-val).
* **Boards** via sbc-deploy's `sbc_board` (`raspberry-pi-5/4/3/02`); splanc's
  `pi/provisioning` has only Pi 5 + Pi 3 targets today, so **add `raspberry-pi-4`
  and `raspberry-pi-02` (Zero 2 W)**.

**Avoid:** `toxc-service.nix`'s llvmpipe default; relying on llvmpipe as a
fallback (use `softpipe` if ever needed — no LLVM); leaving `-Dllvm` on auto;
full-frame CPU readback / dumb-buffer copies; assuming float render targets on
vc4 (td-deploy never tested them — a real gap for data-in-texture effects).

**Blocker to note:** `pi/player_rs` is a **static-musl** binary and cannot
`dlopen` glibc Mesa. The GPU tier needs either a glibc dynamic player build
(td-deploy's `runtime_rs/cross` link pattern: nixpkgs cross clang + autoPatchelf)
or a **separate glibc GPU helper process** the musl player talks to. The helper
is the lower-risk first step.

## 9. ESP32-P4 accelerator survey

The P4 (dual-core RV32IMAFC + custom SIMD, up to 400 MHz, 768 KB L2 SRAM, 16/32
MB PSRAM) has **no 3D GPU and no shader core** — so there is **no GLSL/SPIR-V
target on P4**. "GPU lowering" on P4 means the integer SIMD plus the fixed-
function pixel blocks. Each accelerator mapped to a concrete use or a reason it
is not useful (sources: ESP32-P4 datasheet/TRM, ESP-IDF esp32p4 docs, esp-dsp/
esp-dl; items marked *unverified* need bring-up confirmation):

| Surface | What / specs | IDF driver, maturity | Splanc use / not useful |
| --- | --- | --- | --- |
| **PIE SIMD (Xai)** | 8×128-bit regs; 16×i8 / 8×i16 / 4×i32 lanes; 256-bit QACC + 40-bit ACCX; post-inc / unaligned 128-bit load-store; sat/round. **Integer only** (no float lanes). esp-dsp shows ~16× on int16 MAC, ~0 on f32. | asm / `asm volatile`; no C intrinsics found (*unverified*); used by esp-dsp/esp-dl; esp-dl ships a PIE skill. | **Primary FX lowering target.** Vectorise the per-LED kernel across LEDs in SoA: 8 LEDs/op (Q15/i16) or 4/op (Q16.16/i32), with hardware loops; split LED ranges across both cores. Maps straight onto the VM's fixed-point (`fixed()`) semantics and the AOT fixed path. |
| HP FPU | RV32 **F** single-precision; no D (doubles soft). | GCC default. | Scalar fallback for float-heavy ops; never use `double` in the VM. |
| **PPA SRM** | scale (bilinear) / rotate 90s / mirror; ARGB8888/RGB888/RGB565/YUV; output cache-line-aligned; mem-to-mem. | `esp_driver_ppa`, IDF ≥ 5.3, young but stable. | **Textures/video**: resize+convert decoded frames to texture res/RGB888. N×1 LED rows untested (min block size *unverified*). |
| **PPA Blend/Fill** | two equal layers; fixed/scaled/inverted alpha; colour-key; 2×256 CLUT. | `esp_driver_ppa`. | **Deck crossfade** at *texture* scale (uniform alpha). Per-LED (few KB) it loses to PIE: transaction + cache-sync overhead. L8+CLUT palette textures. |
| 2D-DMA / GDMA-AXI | macroblock reorder + colour-space convert; 3TX/3RX; 8 outstanding. | internal to PPA/JPEG; standalone API `esp_private` (*unverified*); `esp_async_memcpy`. | **PSRAM→L2MEM tiling**: double-buffer per-tile working sets so the PIE tier isn't memory-bound; free YUV→RGB in the PPA/JPEG paths. |
| **JPEG codec** | HW encode+decode baseline; decode 720p >100 fps, 480×320 ~571 fps; up to 4K still. | `esp_driver_jpeg`. | **Texture/video source**: JPEG assets in flash, MJPEG over Ethernet/USB, decoded ~free. Far stronger than the H.264 path. |
| H.264 | HW **encoder only** (1080p30); decode is software (tinyH264, 640×480@25). | `esp_h264` 1.4.1. | Encoder: only for streaming a preview. Decoder: low-res only → prefer MJPEG. |
| ISP + MIPI-CSI | demosaic/CCM/gamma/AE/AWB/histogram; **RAW8/10/12 input only**. | `esp_driver_isp/cam`. | **Camera-driven effects** (camera texture + AE/AWB/histogram as free uniforms). **Cannot** be abused as an LED colour/gamma engine (input must be Bayer RAW, not RGB). |
| **PARLIO TX** | 1/2/4/8/16-bit, ≤40 MHz IO clk, GDMA-fed, loop TX. | `esp_driver_parlio`; BitScrambler decorate. | **Best WS2812 output: 16 parallel strips** from one DMA stream; 800 kHz caps ~32 fps at 1024/strip regardless of count; frame ≈147 KB fits L2MEM. |
| **BitScrambler** | 32 b/DMA clock; **8-instruction** program; 2 KB LUT; attaches to PARLIO/RMT/LCD/I2S/SPI. 1→N expansion needs **die rev v3.x**. | `esp_driver_bitscrambler`, `.bsasm`, IDF ≥5.5. | **WS2812 bit-expansion in DMA**: transpose + 3-slot expand so the CPU never builds the expanded buffer; gamma via LUT possible (*unverified*). Risk: fitting the encoder in 8 instructions. |
| RMT | 4TX/4RX, only TX ch3 has DMA. | `esp_driver_rmt`, mature. | ≤4 strips or bring-up only; not the multi-channel path. |
| LCD_CAM (I80/RGB) | 8/16/24-bit parallel; GDMA from PSRAM. | `esp_lcd`, mature. | Alternative **24 parallel strips** (the S3 I2S/LCD trick) when >16 needed. |
| MIPI-DSI | 2-lane D-PHY. | `esp_lcd` DSI. | Not for LEDs; fine for an on-device preview screen. |
| Dual-core HP / L2MEM / PSRAM | 2×400 MHz ≈ 800 Mcyc/s; 768 KB L2 @200 MHz; 16/32 MB PSRAM ~0.8–1 GB/s shared. | — | Budget: ~800 cyc/LED-eval at 16 k LEDs × 60 fps across both cores; keep hot data tiled in L2MEM. |
| **LP core** | RV32IMAC ≤40 MHz, 32 KB SRAM, LP-I2C. | `ulp` LP-core, mature. | **IMU poller**: read the MPU-6050 over LP-I2C into a shared ring, off the render cores. |
| EMAC / USB-HS | 10/100 MII; USB 2.0 HS. | `esp_eth`, TinyUSB. | **Art-Net/sACN + control ingest** (P4 has no radio); UVC camera / video-in / bulk map uploads. |
| not present | no CORDIC/trig unit; crypto irrelevant. | — | Transcendentals as PIE poly/LUT in Q15. |

### P4 shortlist (ranked)

1. **PIE SIMD tier for `fx_vm`** — the only thing that speeds the *kernel*.
   Lower (via the AOT path, extended) to SoA batches of 8×i16 / 4×i32 LEDs with
   hardware loops, split across both cores. esp-dsp shows ~16× on int16 MAC-heavy
   loops; expect ~4–6× from clock+dual-core over the C6 and a further 4–10×/core
   from SIMD on fixed-point effects. *The P4 analogue of this doc's GPU tier.*
2. **PARLIO 16-bit + BitScrambler WS2812 output** — 16 strips at ~1–2% CPU;
   BitScrambler does the bit-transpose/expand in DMA. Needs die **v3.x** for the
   length-changing program; the 8-instruction limit is the first prototype gate.
3. **PSRAM→L2MEM tiled streaming (AXI GDMA / async memcpy)** — keeps the PIE
   tier from going memory-bound on texture/buffer-heavy effects; double-buffered
   tiles, cache-line aligned.
4. **JPEG HW decode + PPA SRM** — the texture/video pipeline: JPEG/MJPEG decoded
   and PPA-resized/converted at ~zero CPU. Replaces the refused `SampleTex`/video
   path on P4.
5. **PPA Blend for deck crossfade / layer compositing at texture scale** —
   small-to-moderate; per-LED crossfade stays in PIE.
6. **Camera (CSI+ISP) + LP-core IMU poller** — new features (camera-reactive
   effects, AE/AWB/histogram as uniforms), not speed.

Not worth chasing: ISP-as-colour-engine (RAW-only), H.264 encode, DSI for LEDs,
RMT beyond 4 strips.

## 10. Prototype (`//fx_gpu`, this PR)

Host-only crate (not linked into firmware or the player). Pipeline: `.fxb` →
`lower` (macro IR) → `legalize` (primitives for a profile) → `eval` (host model
of the GPU result) or `emit_glsl` (ES 1.00 / 3.10 → SPIR-V via glslang).

* **Lowering coverage:** 132 / 197 corpus `shade()` kernels lower to the pure
  per-LED subset (arithmetic, trig, colour, fixed-point, `if/else`, locals,
  memo-recompute). Refused (→ stay on VM): buffers/textures 27, unimplemented
  fixed vec/transcendental ops 26, dynamic-index 6, loops 3, user-fn 1,
  inc-local 1, driver 1.
* **Conformance (`eval` vs real `fx_vm`, 64 LEDs × 6 frames):** 125/132 (95%)
  within 2/255; integer hash bit-exact (0); 7 over-tolerance are all class-3
  transcendental-stress cases (§3).
* **Codegen validated externally:** all **132** ES 3.10 compute shaders compile
  to **valid SPIR-V** (`glslang -G` + `spirv-val`); the **92** float-only effects
  also compile as **valid GLSL ES 1.00** fragment shaders. The 40 int-needing
  effects are GLES 3.1 / SPIR-V only → the Pi-3-vs-Pi-4/5 tiering line, measured.
* **CI test** `//fx_gpu:fx_gpu_conform_test`: inline effects (gradient, trig,
  hsv/palette, hash, if/else) lowered + compared to `fx_vm` within tolerance,
  plus refusal checks (loops and integer-on-GLES2 must fall back).
* **Run the corpus sweep:**
  `bazel run //fx_gpu:fxgpu_conform -- --profile exact --emit /tmp/shaders $(find … -name '*.fx')`.

* **GLES2 for vc4 = kernel in the vertex shader** (`Target::Es100Vertex`). One
  `GL_POINTS` vertex per LED into a *LEDs-per-channel × channels* RGBA8 target
  (row = channel = one FPGA output's address range), so 20×1024 is 1024×20 and
  needs no tiling under vc4's 2048 limit. The vertex stage guarantees highp, and
  per-LED inputs ride as float attributes (vc4 has no float textures). Output is
  quantized like the VM epilogue (`floor(clamp01(x)·255)`) and written as `q/255`,
  so the RGBA8 store yields exactly `q`. (An early draft wrote `(q+0.5)/255`,
  which sits on the rounding tie, off by one.)
* **hsv2rgb on GLES2:** the sextant pick uses float `floor` compares instead of
  `f2i`. That is exact for `h6 ∈ [0,6]` (NaN → 0 as in the VM), and it moved
  hsv-based effects (e.g. `cylinder`) onto the GLES2 tier.
* **Host GLES2 run (llvmpipe, harness check only):** the relocated payload
  renders under `env -i`. `solid_fill`/`imu_tilt` match the VM goldens
  **exactly**; `plasma`/`cylinder` (native `sin` vs the VM's LUT sine) are within
  **1/255 on 1–14% of LEDs**. The VM bench reproduces its goldens with 0 errors.

### Pi 3 measurement (step 2): done, run 1

`fx_gpu/pi3bench` builds a self-contained aarch64 payload, 37 MB. It contains:
- an LLVM-free lean Mesa (vc4+v3d), relocated, plus the glibc loader;
- `gles2bench`: surfaceless EGL, render and readback timed separately, readback
  formats compared, a pipelined loop, and a byte-exact check against VM goldens;
- a static `fxvm_bench` VM baseline, now with `--threads`;
- 8 kernels × 7 layouts, 1×500 … 20×1024.

The operator ran it on `pi-ledmapper-2` through an SSH tunnel over the
reservation (`Reservation.forward(addr, 22)`; the rig container has no `tar`).
The agent never handled the Pi key. **Results are in §5**: 100 JSON lines, all
`ok`, VC4 renderer, GPU error ≤ 2/255, VM bit-exact. Run 2 measured the 4-thread VM
(`--vm-threads 1,4`; §5). Open: the SPI-tap capture on `pi-ledmapper-1` (#369 image).

## 11. Staged plan

1. **Done (this PR):** IR, lowering, legalize, GLSL/SPIR-V emit, conformance
   harness; design, numerics, P4 survey, prior art.
2. **Done:** Pi 3 GLES2 bench (§5). 20×1024 in 3.2–3.5 ms for every lowered
   effect, ≤ 2/255. 4-thread VM measured.
3. **Pi 3 at 120 fps:** the 20 × 270 / 4 × 270 bench is **done** (§0: GPU
   0.84–0.94 ms; noise 7.84 ms on a 4-core VM). Logic-analyzer continuity: **done** (0 pauses ≥ 1 µs in
   391 transfers up to 61 KB, §0). Still open: FPGA `STATS` on hardware (#370).
4. **GPU tier in the player (primary):**
   - a glibc GPU helper next to the static-musl player;
   - a load-time per-effect probe (lower → tolerance check → cache);
   - a triple-buffered render → readback → `FpgaCodec` → SPI pipeline;
   - ~~a SCHED_FIFO output thread paced on the FPGA's frame-done GPIO edge, with
     absolute-deadline pacing as the timeout fallback~~ **done in #370** (edge
     wait, fallback, RT settings, unit caps; on-wire edge latency pending the
     wire);
   - the 120 fps strip cap (260 LEDs/port) checked against the live map, not
     just the start-up strip (`wire::check_frame_rate`, #370).
5. **Multi-threaded VM in the player (fallback):** for effects that don't lower.
6. **Image:** the lean Mesa overlay (§8), Pi 4 / Zero 2 W board targets, a pinned
   Pi 3 `core_freq`, and `spidev.bufsiz` via #369.
7. **Pi 4/5 compute:** `naga` SPIR-V, V3D compute, exact integers (adds hash
   effects); golden tolerance tests per tier.
8. **FPGA (#370):** done in sim + P&R: the 20-port pin map and the frame-done
   output. Open: hardware bring-up of the 20-port bitstream; `PREFILL`; MISO CSR
   read-back for `STATS` (player-visible underruns); optional double-buffered
   FIFO banks, so frames can overlap emission.
9. **GPU-native textures/decks** and an in-shader LUT sine (class-3 exactness),
   if measurement shows a need.
10. **(parallel track)** P4: the PIE SIMD tier; PARLIO + BitScrambler; JPEG/PPA.

## 12. Decisions the user needs to make

1. **Numerics tolerance per tier** (§3): accept **≤ 2/255 (Pi 4/5 highp), ≤
   6/255 (Pi 3 mediump)** as the golden-test bound? And for class-3
   transcendental-heavy effects: **ship the VM's LUT sine in-shader** (makes the
   common case exact, ~1 KB) or **keep those effects on the VM**?
2. **Pi 3 tiering at 120 fps: GPU-primary (owner direction).** GLES2 on vc4
   renders every lowered effect at 20 × 270 in 0.84–0.94 ms (measured), with the
   CPU free.
   The **4-core VM is the fallback** for what can't lower: hash, buffers,
   loops. Measured at 20×1024, a 4-thread VM is 3.1–3.97× faster than one
   thread. At 120 fps (20 × 270) it fits most effects but takes 20–50% of all four
   cores, and noise-class effects (7.84 ms measured) miss the 8.33 ms period; Pi 4/5
   compute lowers those too. **Decided (2026-10-26):** the 120 fps mode caps
   strips at 260 LEDs/channel (theoretical 274 / 267), and the FPGA gets a
   frame-done pacing output (#370; pin 28 → Pi GPIO 22, confirmed, see §0).
3. **Readback vs direct DPI scan-out** (§4): start with readback (recommended)?
   DPI is a later optimisation that costs GPIO pins and a frame-sync redesign.
4. **P4 priority** (§9): is the PIE SIMD tier (shortlist #1) the P4 track to fund
   first, built on the AOT path, with PARLIO+BitScrambler output second?
5. **Pi 3 `core_freq` pin** (§4): fix the VideoCore core clock so the SPI clock
   can't drop below the 20-channel drain under frequency scaling? This is a small
   `config.txt` change. (`spidev.bufsiz` is already handled by #369.)
6. **20-channel pin map** (#370): **decided**: ports 8–19 on pins 40 35 41 42 51
   53 54 55 56 57 68 69. The frame-done pin is **decided** (28 → Pi GPIO 22). Still open: should `PREFILL` go to 64, with the one-LUT "start on CS-end" fix, to tolerate
   600 µs Pi-side pauses at frame start?
