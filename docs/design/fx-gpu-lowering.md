# Lowering the FX engine onto GPUs and accelerators

Status: **design + host feasibility prototype (this PR).** No device code ships.
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

| layout | N | wire ms (fps ceiling) | min SPI Mbit/s | SPI ms @ 22.2 MHz | frame bytes | fits spidev 4096? | FPGA (in-tree 8-port / #370 20-port) |
|---|---:|---:|---:|---:|---:|:-:|---|
| 1×500 | 500 | 15.0 (66) | 0.8 | 0.54 | 1,501 | yes | ok / ok |
| 1×2048 | 2,048 | 61.3 (16) | 0.8 | 2.2 | 6,145 | **no** | **overflows**: 2048 LEDs on one 1,659 B FIFO, peak ≈ 3,074 B at the player's r = 2 / ok |
| 4×550 | 2,200 | 16.5 (60) | 3.2 | 2.4 | 6,601 | **no** | ok / ok |
| 4×1024 | 4,096 | 30.7 (32.6) | 3.2 | 4.4 | 12,289 | **no** | peak ≈ 1,538 of 1,659 B at r = 2 (7% margin; overflows at r > 2.17) / ok |
| 8×1024 | 8,192 | 30.7 (32.6) | 6.4 | 8.9 | 24,577 | **no** | as 4×1024 / ok |
| 16×1024 | 16,384 | 30.7 (32.6) | 12.9 | 17.7 | 49,153 | **no** | needs 16 ports / ok |
| 20×1024 | 20,480 | 30.7 (32.6) | 16.1 | 22.1 | 61,441 | **no** | needs 20 ports / ok (20/26 BSRAM, 83 MHz) |

The table is *computed* from the core and protocol constants. The wire timing is
validated in sim (#370). On hardware, the logic analyzer covers 4 channels; the
16- and 20-channel rows are **extrapolation** until a 20-pin bitstream exists.

**Render + readback** (the GPU vs VM question) are the Pi 3 measurement,
pending. The payload is `fx_gpu/pi3bench` and the results go in §5. For the GPU,
render + readback is at most a few ms at 20k LEDs if vc4 behaves like its
llvmpipe self-test, so the **wire ceiling (32.6 fps at 1024/channel) is the
bottleneck at every MAX scale**. The VM's cost grows linearly with N on one A53
core, so it is the bottleneck wherever `VM ms > 30.7`; the measurement locates
that crossover per effect.

**Where the bottleneck sits** (render column pending the Pi 3 numbers):
- ≤ 4×550: the wire (16.5 ms) or the VM for heavy effects.
- 4×1024 – 20×1024: the **wire, at 32.6 fps**, if render + readback < 30 ms.
  With the GPU that holds for every lowered effect. With the VM it holds only
  for cheap effects at the low end.
- SPI is never the limit once it runs at ≥ 16.7 MHz at 20 channels. It is a
  *hard failure* below the drain rate (underrun, see #370) or if a frame doesn't
  fit spidev's buffer.

### MAX image changes this needs (proposals)

1. **Raise `spidev.bufsiz`.** spidev rejects any single write larger than
   `bufsiz` (default **4,096 bytes**). The player writes each STREAM frame in one
   `write_all`, which must stay one transfer because CS-high latches. So any
   frame over **1,365 LEDs fails**, including today's 4×550 (6,601 bytes) unless
   the running image already overrides it. The payload's `env` line reads the
   live value. Proposal for `pi/provisioning`:
   `boot.kernelParams = [ "spidev.bufsiz=65536" ];` if spidev is built in, or
   `boot.extraModprobeConfig = "options spidev bufsiz=65536";` if it's a module.
   65,536 bytes covers 20×1024 (61,441). The bcm2835 SPI DMA handles a single
   transfer that size (*to verify on the rig*). Above 21,845 LEDs the codec would
   need to split frames with CS held, which the current `write_all` can't do.
2. **Pin the VideoCore core clock on the Pi 3.** The Pi 3's SPI clock divides
   `core_clk`, which drops with frequency scaling (400 → 250 MHz). That would take
   a 22.2 MHz SCK down to ~13.9 MHz, *below* the 20-channel drain. Set
   `core_freq=400` + `core_freq_min=400` (or a fixed 250 with the divider retuned)
   in `config.txt`. This matters only from ~16 channels up, but it silently
   breaks frames when it does.
3. **20 channels on the FPGA:** the in-tree Tang Nano bitstream drives **8**
   outputs (`NUM_WS = 8`, `ws[0..7]` on pins 70–77) with **553 LEDs/port** FIFOs.
   20 × 1024 needs `MAX_PORTS = NUM_WS = 20`, 12 more `.cst` pins (Tang Nano 9K
   header I/O to be chosen), `FIFO_DEPTH = 2048` (one BSRAM/port; full-frame FIFOs
   need 40 of the 26 BSRAMs), and SPI ≥ 16.7 MHz. Draft **#370** adds that variant
   internal-only (no pin map) and verifies it in place-and-route (2145 LUT4, 1415
   DFF, 20/26 BSRAM, 83 MHz vs 54) and in a 20×1024 Verilator sim. It also fixes
   the core README's stale "~2 bytes of buffer per port" claim; the core has had
   per-port BSRAM FIFOs since the double-buffer was replaced.
4. **Start-of-frame gap guard.** The FIFOs absorb mid-frame SPI pauses of
   hundreds of µs. Right after a frame starts, though, the only slack is
   `PREFILL × 10 µs` (20 µs by default), and a longer Pi-side pause latches the
   strip mid-frame. `PREFILL = 64` absorbs 600 µs at zero resource cost (sim,
   #370). It needs the one-LUT "start on CS-end" fix for frames under 64
   bytes/port. The SPI-tap capture on rig-1 will show whether the Pi 3 actually
   pauses there.

## 5. Expected speedups

From the study (`fx-perf-study.md` Q1), per-LED VM cost at 2048 LEDs runs
29–456 ms/frame; the heaviest (noise, particles, plasma, rain) are 200–456 ms —
unusable. A GPU evaluates all LEDs in parallel: the per-LED ALU work that costs
the VM ~15–35 k cycles *serially* is one SIMD lane on the GPU, and Pi 4/5 V3D
has dozens of lanes at ~500–900 MHz. Order-of-magnitude expectation:

* **Pi 4/5 (V3D compute):** the whole shade pass for 2048 LEDs in **well under a
  frame** regardless of effect complexity; the bottleneck moves to readback +
  SPI + WS2812 refresh (§4), i.e. **30–60 fps for every effect**, including the
  ones the VM can't run at all.
* **Pi 3 (VideoCore IV, GLES2 fragment):** float-only effects (92 of the 132
  that lower — §Prototype) at similar frame rates; the prior-art existence proof
  (§7) hit ~90 Hz WS2812 refresh driving 900 LEDs from GPU visuals on a Pi 3.
* **Measured device numbers are an open item.** The reservable `pi-ledmapper-1/2`
  (Pi 3B+) units can host a GLES2 offscreen-render + readback microbenchmark;
  this was **not run in this PR** (see Prototype/HITL). The host prototype gives
  the correctness and lowering-coverage numbers; the ms/frame on real VC4 is the
  first thing the staged plan measures.

## 6. Multi-generation tiering and fallback

| Board | GPU | API | Tier |
| --- | --- | --- | --- |
| **Pi 5** | V3D 7.1 | Vulkan 1.3 / GLES 3.1 | **compute (SPIR-V)**, highp, int exact (class-1), tol ≤ 2/255 |
| **Pi 4** | V3D 4.2 | Vulkan 1.1 / GLES 3.1 | **compute (SPIR-V)**, same as Pi 5 |
| **Pi 3 / Zero 2 W** | VideoCore IV (vc4) | **GLES 2.0 only**, no compute | **fragment (GLSL ES 1.00)**, float-only subset, mediump, tol ≤ 6/255 |
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

### Pi 3 measurement (step 2): payload ready, run pending

`fx_gpu/pi3bench/` builds a self-contained aarch64 payload, 37 MB; see its
README. It contains:
- an LLVM-free lean Mesa (vc4+v3d), relocated with RUNPATHs stripped, plus the
  glibc loader;
- `gles2bench`: surfaceless EGL, render and readback timed separately, readback
  formats compared (RGBA8, the driver's preferred format, RGB565), a pipelined
  loop, and a byte-exact check against VM goldens;
- a static `fxvm_bench` VM baseline;
- 8 kernels × 7 layouts, from 1×500 to 20×1024.

`run.sh` reports whether vc4 and a render node are present, and the live
`spidev.bufsiz`. It unpacks into a temp dir that a trap removes. The operator
runs it on `pi-ledmapper-2`/`-1` through an atomic HITL reservation (the agent
does not handle the Pi key). **Results: pending; they fill §5 and the
render/readback column of the §4 scaling model.**

## 11. Staged plan

1. **(this PR)** Host IR + lowering + legalize + GLSL/SPIR-V emit + conformance
   harness. Design + numerics policy + P4 survey + prior art.
2. **Pi 3 GLES2 microbenchmark (HITL/Pi):** payload built and host-validated
   (`fx_gpu/pi3bench`; vertex-shader kernel, 1×500 … 20×1024, VM goldens). Run on
   `pi-ledmapper-1/2` pending. **Decides whether Pi 3 GLES2 is worth shipping.**
3. **Pi 4/5 compute path:** `naga` SPIR-V, V3D compute over an SSBO, highp,
   class-1 exact; golden tolerance tests per tier.
4. **Player integration:** glibc GPU helper process (musl player stays), a
   load-time per-effect probe (lower → tolerance-check → cache the verdict),
   readback → `FpgaCodec` → SPI; keep the VM fallback.
5. **Image:** lean Mesa overlay (§8) into `pi/provisioning`, add Pi 4 / Zero 2 W
   board targets; measure closure growth. Also `spidev.bufsiz=65536` and a
   pinned Pi 3 `core_freq` (§4 proposals).
5b. **20-channel FPGA:** #370's internal-only variant → pin map → a flashable
   20-port target; `PREFILL` + "start on CS-end"; logic-analyzer validation on 4
   channels.
6. **GPU-native textures/decks** (`SampleTex`/blending) and **shader-emulated
   LUT sine** for class-3 exactness, if measured need.
7. **(parallel track)** P4: PIE SIMD tier (shortlist #1) via the AOT path;
   PARLIO+BitScrambler output; JPEG/PPA texture pipeline.

## 12. Decisions the user needs to make

1. **Numerics tolerance per tier** (§3): accept **≤ 2/255 (Pi 4/5 highp), ≤
   6/255 (Pi 3 mediump)** as the golden-test bound? And for class-3
   transcendental-heavy effects: **ship the VM's LUT sine in-shader** (makes the
   common case exact, ~1 KB) or **keep those effects on the VM**?
2. **Pi 3 GLES2: ship or skip?** 92/132 lowered effects are GLES2-capable, but
   only at mediump and with no integer effects (hash/fixed stay on VM), and the
   static-musl player needs a glibc GPU helper. Option A: Pi 4/5 only (compute,
   clean, exact ints) and Pi 3 stays on the VM/NEON. Option B: also do Pi 3
   GLES2 for the float-only effects. Recommendation: **gate on step 2's measured
   readback cost** — if VC4 readback is a few ms, Pi 3 GLES2 is worth it; if it's
   ≫ a frame, skip it.
3. **Readback vs direct DPI scan-out** (§4): start with readback (recommended)?
   DPI is a later optimisation that costs GPIO pins and a frame-sync redesign.
4. **P4 priority** (§9): is the PIE SIMD tier (shortlist #1) the P4 track to fund
   first, built on the AOT path, with PARLIO+BitScrambler output second?
5. **MAX image** (§4): add `spidev.bufsiz=65536` (needed for any frame over 1,365
   LEDs, including today's 4×550) and pin the Pi 3 `core_freq`? Both are small
   `pi/provisioning` changes, best as their own PR.
6. **20-channel pin map** (#370): pick the 12 extra Tang Nano 9K header pins. And
   should `PREFILL` go to 64, with the one-LUT "start on CS-end" fix, to tolerate
   600 µs Pi-side pauses at frame start?
