# Design: Effects runtime (bytecode VM + language)

Status: **proposed / in progress**. The technical centerpiece of `next_steps.md`.
User-locked decisions: **hybrid** execution model (`update()` + `shade()`);
**GLSL-ish** shader language; programs **publish uniforms + ranges** that become
live UI controls.

## Goal

Users write small GPU-shader-style programs ("effects") that color a mapped
fixture from each LED's 3D position, the skelgraph topology, time and sensors.
Programs are compiled (in-browser, wasm) to a compact **bytecode**, pushed to the
device's LittleFS, and executed by a small no_std **interpreter** on the C6 in
the render loop. The same VM runs in the browser for an offline preview. A
program's declared **uniforms** drive auto-generated sliders/buttons/dropdowns
in the live control UI.

## Execution model (hybrid)

Each frame the runtime does:

1. `update()` — optional, runs **once/frame**. Evolves persistent `state`
   (integrators, phases, spawn logic). May read `time`, `dt`, `frame`, sensors,
   uniforms. Writes `state`.
2. `shade(led) -> vec3` — runs **once per LED**. Returns the LED's linear RGB
   (0..1). Reads `led.*` (position/index/topology), `time`, uniforms, and
   `state` (read-only). Pure per-LED → parallelizable, cache-friendly.

Rationale: `shade` alone (pure per-LED) covers most spatial effects; `update`
adds cheap global state (a wavefront position, a spawn list) without per-LED
recomputation. This mirrors the existing pulse/flood sim but as user scripts.

## Language (GLSL-ish)

```glsl
// uniforms → UI controls (name : range/kind = default)
uniform float speed : 0.0 .. 5.0 = 1.0;          // slider
uniform float width : 0.02 .. 1.0 = 0.2;         // slider
uniform vec3  tint  : color        = vec3(1,0,0); // color picker
uniform bool  mirror              = false;        // toggle
uniform int   palette : {"fire","ice","rainbow"} = 2; // dropdown

// persistent state (written by update, read by shade)
state float phase;

void update() {
    phase = phase + speed * dt;         // advance a phase each frame
}

vec3 shade(Led led) {
    float d = fract(led.pos.z * width - phase);   // moving band along z
    vec3  c = palette_lookup(palette, d);
    return c * tint;
}
```

- **Types**: `float`, `vec2/3/4`, `int`, `bool`. Colors are `vec3`/`vec4`.
- **Contexts** (built-in reads):
  - global: `time` (s, float), `dt` (s), `frame` (int)
  - `Led led`: `led.pos` (vec3, in the map's gravity-leveled frame, roughly
    normalized to a unit box), `led.idx` (int), `led.count` (int), and topology:
    `led.seg` (int segment id, -1 if none), `led.s` (float 0..1 along its
    segment), `led.branch` (bool at a junction).
  - sensors (when present): `imu.accel` (vec3), `imu.gyro` (vec3).
- **Built-ins**: `sin cos tan abs floor ceil fract mod min max clamp mix step
  smoothstep length distance dot cross normalize pow exp log sqrt sign` +
  `hash11/hash31` (cheap noise), `hsv2rgb`, `palette_lookup(int,float)`.
- **User functions**: `float f(float x) { ... }` — plain, no recursion (bounded
  stack). Control flow: `if/else`, `for` with a compile-time-bounded trip count
  (no unbounded loops on the hot path).

## Bytecode / VM

Stack-based, **f32 slots** (a `vecN` is N contiguous slots; `int`/`bool` ride in
f32 with compile-time typing, so the VM itself is untyped at runtime — the
compiler guarantees validity). Chosen over a register VM for compiler
simplicity; revisit if profiling demands it.

Opcode families: `PushConst`, `LoadUniform(idx,size)`, `LoadCtx(id)` (time/led.*/
imu), `LoadState/StoreState(idx,size)`, `LoadLocal/StoreLocal`, element-wise
`Add/Sub/Mul/Div/Neg`, `Dot/Cross/Length/Normalize`, unary math (`Sin`…),
`MakeVec(n)`, `Swizzle(mask)`, compares + `BrFalse/Jmp`, `Call/Ret`, `Return`.

**Values are `f32`. The C6 (RV32IMAC) has no FPU → soft-float.** Budget: 256 LEDs
× ~30 ops × 30 fps ≈ 230k float ops/s ≈ low-single-digit % CPU — fine for v1.
Fixed-point (Q16.16) is a later optimization if profiling shows it's needed;
the ISA is value-width-agnostic so it can be swapped without language changes.

## File format (`.fxb`)

A flat, mmap-friendly container so the VM executes **directly from the flash
range** LittleFS stored it in (no per-frame fs calls; open once, keep the
mapped/pointer, run bytecode in place):

```
magic "FXB1" | version | flags
uniforms manifest: [ {name, type, ui_kind, min, max, step, default|options} ]
consts: [f32...]
entry offsets: update, shade
code: [u8 bytecode...]   (little-endian, 4-byte aligned)
```

The manifest is what the app turns into controls and what the device echoes on
request (`get_effect_uniforms`). Uniform values live in a separate small buffer
set live via protocol (`set_uniform`/`set_uniforms`) — no recompile to tweak a
slider.

## Uniforms → UI

`ui_kind` ∈ {slider(min,max,step), color, toggle, dropdown(options)}. The webapp
renders these generically (replacing today's hard-coded effect knobs). The same
manifest is used offline (preview) and online (device control), so a slider does
the identical thing in both.

## Firmware integration

- New arms: `submit_effect` (upload `.fxb` → LittleFS, like `submit_map`),
  `set_effect` (select the active script), `set_uniforms`. `get_effect_uniforms`
  returns the manifest for UI hydration.
- The render task, when an effect is active, runs `update()` then `shade()` per
  LED into the FastLED buffer (replacing/added alongside the built-in
  pulse/flood). Persist the active effect + uniforms to LittleFS (auto-resume,
  like the current playback).
- Crate layout: `//firmware/fx_vm` (no_std interpreter + `.fxb` reader, host
  test build), reused by the wasm preview.

## Webapp integration

- `//fx_compiler` (Rust) → `fx_compiler_web` wasm (like the pulse/solver wasm):
  `compile(src) -> {bytecode, manifest, diagnostics}`.
- Editor: start with a `<textarea>` + compile-on-idle + diagnostics; upgrade to
  CodeMirror + syntax highlight later (see effects-compiler doc).
- Preview: run the **same VM** compiled to wasm (`fx_vm` → `fx_vm_web`) over the
  current map's LED positions each rAF tick → `MapView.setLedColors()` (already
  exists). Works with no device connected.
- Auto uniform panel from the manifest; values drive both the preview and (when
  connected) `set_uniforms` to the device.

## Milestones

1. **VM + ISA** (`fx_vm`), host tests: hand-assembled bytecode → correct LED
   colors; a golden shader vs a reference implementation.
2. **Compiler** (`fx_compiler`): lexer/parser/typecheck/codegen; host tests
   (source → bytecode → VM → expected). Uniform manifest extraction.
3. **wasm**: `fx_compiler_web` + `fx_vm_web`; a minimal editor + auto uniform
   panel + `MapView` preview (offline).
4. **Firmware**: `.fxb` upload/select/uniforms protocol + render-loop execution
   + persistence.
5. Perf counters (see perf-monitoring doc).

## Open questions

- Topology built-ins (`led.seg/s/branch`): exact set — start minimal, extend.
- Palette source: built-in tables vs user-provided — start with a few built-ins.
- `for` bound: a fixed compile-time max iterations vs a global instruction
  budget per frame (favor an **instruction budget** to hard-bound frame time).
