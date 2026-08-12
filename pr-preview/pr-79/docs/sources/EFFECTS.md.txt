# The splanc effects engine

Effects are small GLSL-ish shader programs that run **per-LED** across a fixture's
real 3D geometry. This document is the reference for the whole effects stack: the
language, the bytecode VM, the `.fxb` container, uniform/texture/MIDI plumbing,
measured performance on the ESP32-C6, and how the built-in AI writes effects.

For narrative design rationale see [`docs/design/effects-runtime.md`](./docs/design/effects-runtime.md)
and [`docs/design/effects-compiler.md`](./docs/design/effects-compiler.md); for the
perf model see [`docs/design/perf-monitoring.md`](./docs/design/perf-monitoring.md).

## Overview

Two Rust crates make up the engine:

- **`fx_compiler/`** (`ledmapper_fx_compiler`) — a single-pass, type-checking
  compiler from the source language to `.fxb` bytecode. Recursive-descent parse →
  precedence-climbing expression codegen, emitting bytecode directly with no AST.
- **`firmware/fx_vm/`** (`ledmapper_fx_vm`) — a `no_std`, no-alloc stack machine
  that executes `.fxb`. **The same crate is what runs on the ESP32-C6 and what
  compiles to wasm for the browser preview**, so the editor preview and the
  device render bit-for-bit identically.

Both compile to wasm (`fx_compile(src)` and the `FxPreview` class) and are loaded
by the web app at runtime. The authoring/preview/upload flow:

```text
source ──fx_compiler(wasm)──▶ .fxb ──┬─▶ FxPreview (fx_vm wasm)  → live preview in the editor
                                      └─▶ submit_effect over wss  → fx_vm on the ESP32-C6
```

## The language

A program is plain text with two entry points:

```glsl
void update();            // runs once per frame; may write `state`
vec3 shade(Led led);      // runs once per LED; returns linear RGB in 0..1
```

`shade` is required; `update` is optional. There is no recursion, and every `for`
loop must have a compile-time-bounded trip count (the VM enforces a per-frame
instruction budget — see [Execution model](#execution-model)).

### Types

`float`, `vec2`, `vec3`, `vec4`, `int`, `bool`, plus fixed-point `fixed` (Q16.16),
`fixed16` (Q1.14) and `fixed8` (Q1.6), and user `struct`s and fixed-size arrays
(`Type name[N]`). At runtime everything is an `f32` slot; the compiler types every
operation so the VM stays untyped (integers and fixed-point values ride in the f32
slot bit-for-bit).

### Read-only contexts

Per-frame and per-LED inputs are exposed as globals (each compiles to a `LoadCtx`
opcode):

| Identifier                       | Type      | Meaning                                                                  |
| -------------------------------- | --------- | ------------------------------------------------------------------------ |
| `time`, `dt`, `frame`            | float     | seconds, delta seconds, frame counter                                    |
| `led.pos`                        | vec3      | LED position (x, y, z)                                                   |
| `led.idx`, `led.count`           | int/float | LED index, total live LED count                                          |
| `led.seg`, `led.s`, `led.branch` | int/float | segment id, position along segment, branch id                            |
| `led.dist`                       | float     | geodesic distance 0..1 from the topology root (or a `flood_from` source) |
| `led.uv`                         | vec2      | per-LED texture coordinate (top-down projection to 0..1)                 |
| `imu.accel`, `imu.gyro`          | vec3      | device IMU (when driven)                                                 |

### Declarations

- **Uniforms** — live-tunable parameters with UI hints:

  ```glsl
  uniform float speed : 0.0 .. 5.0 = 1.0;      // slider
  uniform vec3  tint  : color      = 0.2, 0.6, 1.0;   // color picker
  uniform int   mode  : {"fire","ice"} = 0;    // dropdown
  uniform bool  invert = false;                // toggle
  ```

- **State** — `state` variables persist across frames; written by `update()`,
  read-only in `shade()`. Good for phases/integrators.
- **Buffers** — `buffer vec3 trail;` is a hidden per-LED buffer (one element per
  LED) that persists across frames. Indexed `trail[led.idx]`; unlike `state` it
  _may_ be written from `shade()` (each LED owns its slot). Ideal for
  trails/persistence-of-vision feedback.
- **Textures** — `texture vec3 img(64, 64);` is a hidden W×H 2D texture. Sample
  with `sample(img, uv)` (bilinear, edge-clamped) and write with
  `paint(img, uv, color)` (nearest texel). This is the target for
  [video-texture streaming](#textures-and-video-texture-streaming).

A `: fixed8` / `: fixed16` annotation on a buffer/texture element compresses its
storage (dequantized to float on access) to save arena bytes on-device.

### Built-in functions

Math (`sin cos abs floor ceil fract sqrt exp log sign tan`, `min max pow mod step
atan2`), vector ops (`clamp mix smoothstep dot cross length normalize distance`),
color (`hsv2rgb`, `palette0/1/2`), noise (`hash`), texture (`sample`, `paint`),
and topology graph queries (`seg_count seg_len seg_node node_deg node_seg
node_side term_count term`, plus `flood_from(node)` to re-root `led.dist`).

On `int` and fixed-point (`fixed`/`fixed16`/`fixed8`) arguments, the arithmetic
builtins run **natively** — `min max abs clamp mod sign step floor ceil fract mix`
each have integer/fixed opcodes, and `sin`/`cos`/`exp` use a compile-time LUT
(angle in **turns**) — instead of coercing to soft-float. Everything that stays
float-valued converts its int/fixed args (never reinterpreting the bits). This is
the main lever for keeping hot paths off the FPU-less C6's soft-float.

### Example

A decaying comet chasing the geodesic distance field, with live controls:

```glsl
uniform float decay : 0.5 .. 0.98 = 0.85;
uniform float speed : 0.0 .. 4.0  = 1.2;
uniform float width : 0.02 .. 0.3 = 0.08;
uniform vec3  tint  : color       = 0.2, 0.8, 1.0;
uniform float rainbow : 0.0 .. 1.0 = 0.6;
buffer float trail;
state  float head;

void update() { head = fract(time * speed * 0.2); }

vec3 shade(Led led) {
  float spark = smoothstep(width, 0.0, abs(led.dist - head));
  float v = max(trail[led.idx] * decay, spark);
  trail[led.idx] = v;
  vec3 hue = hsv2rgb(led.dist, 0.85, 1.0);
  vec3 col = tint * (1.0 - rainbow) + hue * rainbow;
  return col * v;
}
```

The compiler entry point is `compile(src) -> Result<Compiled, Vec<Diagnostic>>`
where `Compiled { fxb: Vec<u8>, uniforms: Vec<UniformInfo> }`; `disassemble(fxb)`
produces a readable op listing (exposed to the editor as `fx_disassemble`).

## Execution model

The VM (`firmware/fx_vm/src/lib.rs`) is a **stack machine over `f32` slots** — a
`vecN` is N contiguous slots. Everything is fixed-size and allocation-free:
`MAX_STACK = MAX_STATE = MAX_LOCALS = MAX_UNIFORM_SLOTS = 128`, call stack depth 16.

- A compiled `Program` carries an `update_entry` and a `shade_entry`
  (`0xFFFF` = absent). `run_update` executes `update()` once per frame, evolving
  `state`; `run_shade` executes `shade(led)` per LED and returns `Rgb`. `shade`
  runs against a copy of `state`, so it can't mutate frame state.
- Per-LED/per-frame inputs come from `Frame` (time, dt, frame, led_count, imu) and
  `Led` (pos, idx, seg, s, branch, dist, uv) structs, read via `LoadCtx`.
- **No libm.** Transcendentals use small polynomial approximations (deterministic
  across host/wasm/device); the narrow-fixed `SinFix`/`CosFix`/`ExpFix` ops use
  256-entry LUTs with linear interpolation.
- **Bounded execution.** Every invocation runs under a `Budget`: a hard
  instruction count (`DEFAULT_BUDGET = 100_000`) plus an optional wall-time
  deadline flag a hardware timer raises (polled every 1024 ops). Outcomes are
  `Ok`/`Budget`/`Timeout`; a timed-out `shade` returns black. `Counters` (instrs
  retired, stack high-water) feed the perf stream.
- **Topology tables** (`MAX_SEG = 64`, `MAX_NODE = 96`, `MAX_NODE_DEG = 6`) are
  populated by `set_graph` and read by `GraphQuery`; `FloodFrom` runs a
  single-source geodesic (Bellman-Ford) sweep whose result persists across frames.

## Opcode reference

The authoritative enum is `Op` (`#[repr(u8)]`, contiguous `0..=79`) in
`firmware/fx_vm/src/lib.rs`; the compiler mirrors and asserts these discriminants.
Operands follow inline in the code stream, little-endian.

| #     | Opcode                                                        | Operands                | Semantics                                          |
| ----- | ------------------------------------------------------------- | ----------------------- | -------------------------------------------------- |
| 0     | `PushConst`                                                   | u16 idx                 | push `consts[idx]`                                 |
| 1     | `LoadUniform`                                                 | u8 slot, u8 n           | push n uniform slots                               |
| 2     | `LoadState`                                                   | u8 slot, u8 n           | push n state slots                                 |
| 3     | `StoreState`                                                  | u8 slot, u8 n           | pop n into state                                   |
| 4     | `LoadLocal`                                                   | u8 slot, u8 n           | push n locals                                      |
| 5     | `StoreLocal`                                                  | u8 slot, u8 n           | pop n into locals                                  |
| 6     | `LoadCtx`                                                     | u8 id                   | push a context value (see context ids)             |
| 7–10  | `Add` `Sub` `Mul` `Div`                                       | u8 n                    | element-wise arithmetic over n (÷0 → 0)            |
| 11    | `Neg`                                                         | u8 n                    | negate n components                                |
| 12    | `Scale`                                                       | u8 n                    | n-vec × scalar                                     |
| 13    | `UnMath`                                                      | u8 fn, u8 n             | unary math per component                           |
| 14    | `BinMath`                                                     | u8 fn, u8 n             | binary math per component                          |
| 15    | `Clamp`                                                       | u8 n                    | clamp(x, lo, hi)                                   |
| 16    | `Mix`                                                         | u8 n                    | a + (b − a)·t                                      |
| 17    | `Smoothstep`                                                  | u8 n                    | smoothstep(e0, e1, x)                              |
| 18    | `Dot`                                                         | u8 n                    | → scalar                                           |
| 19    | `Cross`                                                       | u8 (=3)                 | vec3 × vec3                                        |
| 20    | `Length`                                                      | u8 n                    | → scalar                                           |
| 21    | `Normalize`                                                   | u8 n                    | normalize (no-op if len < 1e-9)                    |
| 22    | `Distance`                                                    | u8 n                    | → scalar                                           |
| 23    | `Swizzle`                                                     | u8 srcN, u8 dstN, idx…  | reorder components                                 |
| 24    | `Cmp`                                                         | u8 kind                 | scalar compare → bool (lt/le/gt/ge/eq/ne)          |
| 25    | `Logic`                                                       | u8 kind                 | and/or/not                                         |
| 26    | `BrFalse`                                                     | i16 rel                 | pop bool; branch if 0                              |
| 27    | `Jmp`                                                         | i16 rel                 | relative jump                                      |
| 28    | `Hash1`                                                       | —                       | scalar → [0,1)                                     |
| 29    | `Hash3`                                                       | —                       | vec3 → scalar                                      |
| 30    | `Hsv2Rgb`                                                     | —                       | vec3(h,s,v) → vec3 rgb                             |
| 31    | `Palette`                                                     | u8 id                   | scalar t → vec3 (0 fire, 1 ice, else rainbow)      |
| 32    | `Pop`                                                         | u8 n                    | drop n slots                                       |
| 33    | `Ret`                                                         | u8 n                    | return n slots (0 update, 3 shade)                 |
| 34    | `Swap`                                                        | u8 an, u8 bn            | swap top bn with the an below                      |
| 35–41 | `AddI`…`CmpI`                                                 | (`CmpI` u8 kind)        | i32 add/sub/mul/div/mod/neg/compare                |
| 42–43 | `MulFix` `DivFix`                                             | —                       | Q16.16 multiply / divide                           |
| 44–49 | `I2F` `F2I` `Fix2F` `F2Fix` `I2Fix` `Fix2I`                   | —                       | numeric conversions                                |
| 50    | `Call`                                                        | u16 target              | push return pc, jump                               |
| 51    | `RetFn`                                                       | —                       | return from a user function                        |
| 52–55 | `LoadStateIdx` `StoreStateIdx` `LoadLocalIdx` `StoreLocalIdx` | base,stride,off,n,count | indexed array access (clamped)                     |
| 56    | `GraphQuery`                                                  | u8 kind                 | topology query (seg/node/term kinds)               |
| 57–58 | `LoadBuf` `StoreBuf`                                          | u8 id                   | per-LED buffer element read/write                  |
| 59–60 | `SampleTex` `PaintTex`                                        | u8 id                   | 2D texture bilinear sample / nearest write         |
| 61    | `FloodFrom`                                                   | —                       | re-root the geodesic field at a node id            |
| 62–66 | `MulFixN` `DivFixN` `FixRescale` `FixToF` `FixFromF`          | u8/i8 frac              | narrow fixed-point scaling/conversion              |
| 67–69 | `SinFix` `CosFix` `ExpFix`                                    | u8 frac                 | integer-LUT sin/cos/exp (angle in turns)           |
| 70–73 | `AbsI` `MinI` `MaxI` `ClampI`                                 | —                       | native integer abs / min / max / clamp             |
| 74–79 | `SignI` `StepI` `FloorFix` `CeilFix` `FractFix` `MixFix`      | u8 frac                 | native fixed-point sign/step/floor/ceil/fract/lerp |

Function ids for `UnMath`: `sin cos abs floor ceil fract sqrt exp log sign tan`
(0–10). For `BinMath`: `min max pow mod step atan2` (0–5). Context ids for
`LoadCtx`: time, dt, frame, led.pos(3), led.idx, led.count, led.seg, led.s,
led.branch, imu.accel(3), imu.gyro(3), led.dist, led.uv(2).

## The `.fxb` container

Magic `"FXB1"`, version 1. An 18-byte fixed header followed by variable sections
(all multi-byte fields little-endian):

| Offset | Field                               |
| ------ | ----------------------------------- |
| 0      | magic `"FXB1"` (4)                  |
| 4      | version = 1 (u8)                    |
| 5      | flags (u8; `FLAG_BUFFERS = 0x01`)   |
| 6      | `n_state` (u8)                      |
| 7      | `n_uniform_slots` (u8)              |
| 8      | `manifest_len` (u16)                |
| 10     | `n_consts` (u16)                    |
| 12     | `code_len` (u16)                    |
| 14     | `update_entry` (u16, 0xFFFF = none) |
| 16     | `shade_entry` (u16)                 |

Then: the manifest bytes (in practice **empty** — the uniform manifest travels
out-of-band as JSON), the constant pool (`n_consts × 4` bytes), the code stream
(`code_len` bytes), and — only if `FLAG_BUFFERS` is set — one `n_buffers` byte
followed by 7-byte descriptors `[kind:u8, elem:u8, comp:u8, w:u16, h:u16]`.
`kind = 0` is an LED-arity buffer (count = live LED count); `kind = 1` is a W×H
texture. `comp` selects component storage precision (`F32`, `FIX16`, `FIX8`,
`I16`, `I8`, `FIX16F`, `FIX8F`, `I32`) so 8-bit formats cost one byte per
component instead of a 4-byte slot.

## Uniform plumbing

Uniforms are addressed by **numeric slot**, not name (a `vec3` consumes 3 slots;
the compiler assigns slots sequentially by width). The name↔slot mapping is _not_
in the `.fxb`; the compiler returns it as `Vec<UniformInfo>` and serializes it to
JSON via `manifest_json` (fields per uniform: `name`, `slot`, `width`, `ui`,
`default`). The web app parses that JSON to build the control panel.

- **VM:** `Vm::set_uniform(slot, vals)` writes `vals.len()` slots; programs read
  via `LoadUniform slot, n`.
- **Web:** the editor's slider/color/dropdown widgets call
  `FxPreview.setUniform(slot, vals)` (offline preview) and
  `client.setUniforms(...)` (to the device) — a knob move updates both identically.
- **Firmware:** a `SetUniforms` control message carries `UniformValue { slot,
repeated float value }` records; `firmware/player_app/ffi.rs` decodes them and
  calls `lm_fx_set_uniform(slot, vals, n)`. `get_effect_uniforms` returns the
  manifest bytes to the app.

## Textures and video-texture streaming

Textures are backed by an external byte arena bound per-program via `set_arena`
(size it to `Program::arena_bytes(led_count)`). `buf_base(id, led_count)` gives a
buffer's byte offset — deliberately public so the host can stream video frames
straight into a texture. Shaders read via `sample(tex, led.uv)`.

The web app can stream live video (a clip, a canvas, a camera) into a texture
uniform on the device:

1. **Encode (browser).** `effects/editor/videoTexture.ts` draws the source into a
   canvas at the texture's declared W×H, reads back RGBA, and quantizes it with the
   codec in `net/textureCodec.ts`. Supported formats: `rgb888`, `rgb565` (default),
   `rgb332`, `gray8`, `indexed8`, `gray4`, `mono`. Grayscale uses Rec.601 luma;
   `gray4` packs two texels per byte, `mono` eight per byte (LSB-first). Two
   compression flags apply: `FLAG_DELTA` (XOR against the previous quantized
   frame) and `FLAG_RLE` (zero-run/literal-run). `TextureStreamer` keeps the
   previous frame and emits deltas.
2. **Transport.** A fire-and-forget `set_texture` message
   (`{ texIndex, format, width, height, flags, data, palette? }`) goes over the
   wss control channel. Texture geometry is discovered by parsing the `.fxb`
   buffer table (`net/fxbTextures.ts`).
3. **Decode (device).** `firmware/player_app/ffi.rs handle_set_texture` reverses
   keyframe/XOR-delta/RLE and dequantizes packed bytes into the arena at the
   texture's precision using precomputed byte LUTs — **no per-texel float** on the
   FPU-less C6 (the "narrow arena" work). The region is then addressable as the
   texture uniform.

The gray4/mono formats and the delta/RLE codec came out of a codec/decoder
hill-climb for narrow arenas (see the WORKLOG entries and the `video_stream` HITL
test, which asserts a sustained ≥10 FPS on hardware).

## MIDI

**MIDI is a web-app feature; the VM and firmware are MIDI-agnostic.** A MIDI
control simply drives `set_uniform(slot, …)` like any other input. There are no
MIDI opcodes, uniforms, or context ids.

The web layer (`web/src/midi/`) wraps the Web MIDI API and maps controls to
uniforms in two layers (persisted in `store/midiStore.ts`):

- **Semantic (global):** a physical control (CC / note / pitch-bend, keyed by
  device+channel+number) is named once ("speed", "hue"), matched loosely by
  normalized name.
- **Binding (per-effect):** a `UniformBinding { uniform, semantic, min?, max?,
invert? }` wires a named control to a uniform, with optional sub-range and
  invert.

`midi/router.ts resolveControlUpdates(...)` is a pure function turning a physical
event into scaled `UniformUpdate`s (only scalar slider/toggle uniforms are
drivable; toggles threshold at 0.5). In the editor the resulting updates fork to
both the offline preview and the device. The AI can set MIDI bindings via its
`list_midi_controls` / `set_midi_mapping` tools without touching effect source.

## Performance on the ESP32-C6

The FX-VM is profiled on real hardware with the SoC's cycle counters, not FPS. The
`PerfReport` protobuf reports `frame_cycles_{min,mean,max}` (the FX-VM execution
cost) and `show_cycles_mean` (the LED transmit path). The HITL `fx_bench` harness
(`pi/hitl/harness/fx_bench.py`) runs a suite of calibration micro-programs on a
reserved rig and compares measured **frame cycles** to a committed golden. See
[DEVELOPERS.md → HITL testing](./DEVELOPERS.md#hardware-in-the-loop-hitl-testing)
for how to run it.

- **Golden baseline:** `web/tests/testdata/device-bench-esp32c6.json`
  (`deviceKey: esp32c6-hitl-golden`, `cpuHz: 160_000_000`; 65 fit programs + 7
  held-out). Regenerate with `fx_bench --emit-golden <path>`.
- **Regression gate:** a program fails if `abs(measured/golden − 1)` exceeds its
  margin — default **10%**, with `sweep16` at 15% (a deliberately safe band until
  per-effect run-to-run variance is characterized). **Only frame cycles are
  gated**; show cycles (transmit) are noisier and excluded.

Representative measured frame-cycle costs at 160 MHz (full set in the golden):

| Program                         | Frame cycles             | Notes                            |
| ------------------------------- | ------------------------ | -------------------------------- |
| `empty`                         | ~0.49 M                  | per-frame overhead floor         |
| `sweep16` / `sweep256`          | ~0.10 M / ~0.97 M        | per-LED anchors (16 / 256 LEDs)  |
| `addM` / `mulM` / `negM`        | ~2.5 M / ~2.5 M / ~1.8 M | cheap arithmetic                 |
| `sinM` / `cosM` / `tanM`        | ~3.9 M / ~4.1 M / ~6.8 M | LUT sin/cos (see the hill-climb) |
| `expfM` / `powfM`               | ~6.2 M / ~9.1 M          | exp still soft-float poly        |
| `hash12M` / `hash32M`           | ~2.9 M / ~4.2 M          | integer bit-mix hash             |
| `smoothstep32M` / `distance32M` | ~21.4 M / ~14.4 M        | heaviest float ops               |
| `hsv2rgbM` / `mix3M` (held-out) | ~7.1 M / ~6.7 M          | validation set                   |
| `lavalamp` (held-out)           | ~3.6 M                   | a realistic 200-LED effect       |

`show_cycles` cluster tightly at ~1.0–1.1 M across programs (transmit-bound, not
FX-bound). These numbers back the browser-side cost model
(`web/src/effects/costModel.ts`, `deviceProfile.ts`): a linear sum-of-op-costs fit
that predicts an effect's device budget headroom (green ≤70% / yellow / red >90%)
without a device present. The fit tracks expensive programs to ±3–7% but
over-predicts the cheapest ones; the software estimator test
(`web/tests/deviceProfileHardware.test.ts`) gates at 13%. Perf-model rationale and
the calibration methodology live in
[`docs/design/perf-monitoring.md`](./docs/design/perf-monitoring.md).

The full per-platform numbers — fitted opcode costs (cycles + ns), the estimator's
held-out predicted-vs-measured accuracy, and every raw measured benchmark — are
auto-generated from the goldens into
[`docs/fx-vm-performance.md`](./docs/fx-vm-performance.md) and pinned by a CI freshness
gate (`bazel run //web:gen_fx_vm_perf_doc` to regenerate).

These costs are the target of an ongoing FX-VM hill-climb (see `WORKLOG.md`):
sin/cos are now compile-time LUTs and `hash` is an integer bit-mix, which is why
they land far below the other transcendentals. A practical consequence of the
FPU-less C6: hoist per-frame constants out of the per-LED `shade()` into
`update()`/uniforms, and prefer int/fixed types (`fixed8`/`fixed16`) on hot paths
so the arithmetic builtins take their native opcodes instead of soft-float.

## AI effect generation

The editor can write and iterate on effects with Claude. The integration is a
**direct, keyless-server browser → Anthropic** call (BYO key): the request goes
straight to `https://api.anthropic.com/v1/messages` with the user's key from
`localStorage` (`ledmapper.anthropicKey`, set via the AI-key sheet) and the
`anthropic-dangerous-direct-browser-access` header. The model is **`claude-opus-4-8`**
(`web/src/effects/ai/generate.ts`).

The system prompt (`web/src/effects/ai/system-prompt.ts`) is **assembled from the
language spec at load time** — the built-in table, context table, and keyword list
are interpolated from the same `BUILTINS`/`CONTEXTS`/`KEYWORDS` the compiler uses,
so the prompt can never advertise a builtin the compiler lacks. It states the hard
constraints (two entry points, no recursion, bounded loops, all values f32),
documents uniform syntax, `state`, structs/arrays, buffers, topology sources, and
textures, includes four worked examples, and ends with a repair directive ("given
a previous script and compiler diagnostics, return a corrected script that fixes
every error; change as little else as possible"). It is also **perf-aware**: the
prompt teaches the fixed-point types and soft-float cost model, and the agent is
fed the binding device's per-builtin cost table (`builtinCostsToPrompt` in
`web/src/effects/perfContext.ts`) so it can optimize toward a real budget.

There are two call paths:

- **One-shot generation** — a streaming request with
  `output_config: json_schema` constraining the reply to `{ script, notes }`; the
  in-progress `script` field is surfaced live into the editor as it streams.
- **Interactive chat** (`chatTurn`, up to 8 rounds) — a tool-use loop where the
  model calls client-fulfilled tools: `set_script` (replace the editor content,
  compile, and return the compile result — ok/diagnostics/uniforms/disassembly so
  the model can self-repair), `capture_preview` (render the live `FxPreview` canvas
  to a PNG returned as a vision block), `estimate_performance` (run the cost model
  and report headroom), and `list_midi_controls` / `set_midi_mapping`. Each user
  turn includes the current source and the latest compile summary as context.

So every AI-authored effect is compiled by the real wasm compiler and (optionally)
previewed by the real VM before it ever reaches the device — the same path a
hand-written effect takes.

## Build targets

| Target                                                          | What                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------- |
| `//fx_compiler:fx_compiler`                                     | compiler library (`ledmapper_fx_compiler`)              |
| `//fx_compiler:fx_compile`                                      | CLI compiler                                            |
| `//fx_compiler:fx_compiler_web`                                 | wasm bundle consumed by the web editor (`/fx-compiler`) |
| `//firmware/fx_vm:fx_vm`                                        | the VM library (also linked into the firmware)          |
| `//firmware/fx_vm:fx_vm_web`                                    | VM wasm bundle for the browser preview (`/fx-vm`)       |
| `//firmware/fx_vm:fx_vm_test`, `//fx_compiler:fx_compiler_test` | unit tests (host)                                       |

The web app loads `fx_compiler_wasm_pkg.js` and `fx_vm_wasm_pkg.js` dynamically
(`web/src/fx/preview.ts`, `web/src/effects/editor/compile-worker.ts`).
