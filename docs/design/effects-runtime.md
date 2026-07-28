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

`float` is fine here (`fract`/`palette_lookup` are float built-ins). Reach for
`int`/`fixed` in the arithmetic-heavy inner math that *doesn't* go through a
float built-in — counters, indices, and smooth Q16.16 ramps you fold yourself:

```glsl
// integer stripe index + Q16.16 ramp, no soft-float in the hot path
vec3 shade(Led led) {
    int   stripe = int(led.pos.x * 8.0) % 3;      // native int math
    fixed t      = fixed(led.pos.y) * fixed(0.5);  // Q16.16 mul
    return vec3(float(stripe) / 2.0, float(t), 0.0);
}
```

- **Types**: `float`, `vec2/3/4`, `int`, `fixed`, `bool`. Colors are `vec3`/`vec4`.
  - `int` is a native 32-bit integer with real integer opcodes (`+ - * / %`),
    not float-emulated — cheap on the FPU-less core.
  - `fixed` is **Q16.16 fixed-point**: use it for the smooth quantities (phase,
    positions, palette coords) that would otherwise pay soft-float cost. `+`/`-`
    are plain integer adds; `*`/`/` use the Q16.16 mul/div opcodes. Literals like
    `0.5` become `fixed` in a `fixed` context; convert explicitly with
    `fixed(x)` / `float(x)` / `int(x)`.
  - **Mixed-type arithmetic promotes** `int → fixed → float` (widest operand
    wins), so `fixed * float` yields `float`. Keep a hot expression all-`fixed`
    (or all-`int`) to stay off soft-float.
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
- **Vector/scalar broadcast**: a scalar combines with a `vecN` element-wise
  (`c + 0.1`, `1.0 - c`), operand order preserved for `-`/`/`.
- **User functions**: `float f(float x) { ... }` (any scalar/vec params + return)
  — plain, no recursion (bounded stack). Defined before use; called with
  `CALL`/`RET_FN`, a small return-address stack, and locals allocated disjointly
  across functions (no per-call frame). Control flow: `if/else`, `for` with a
  C-style header (`for (int i=0; i<n; i=i+1) { ... }`).
- **Structs & arrays**: user `struct Name { float a; vec3 b; };` (scalar/vec
  fields) and fixed-size arrays `Type name[N];` in `state`/locals, with `.field`
  and `a[i]` access. A struct/array is a contiguous slot range; `a[i].field`
  compiles to base + `i`*stride + field-offset, and a runtime (non-constant)
  index emits the `*_IDX` load/store ops (one dynamic index per access path, the
  index clamped in-bounds at runtime). This is what lets a script keep an array
  of agents in `state` and simulate them in `update()`. Slot budgets: `state`
  and locals are each ≤128 slots (`MAX_STATE`/`MAX_LOCALS`).

## Bytecode / VM

Stack-based, **32-bit slots** (a `vecN` is N contiguous slots). Every slot is a
raw 32-bit word: `float` bits, an `int`, a Q16.16 `fixed`, or a `bool` (1.0/0.0).
The VM is untyped at runtime — the **compiler types every operation** and picks
the matching opcode, so the word is always interpreted correctly. Chosen over a
register VM for compiler simplicity; revisit if profiling demands it.

Opcode families:
- float element-wise `Add/Sub/Mul/Div/Neg`, `Dot/Cross/Length/Normalize`, unary
  math (`Sin`…) — soft-float.
- **integer** `AddI/SubI/MulI/DivI/ModI/NegI/CmpI` — native RV32IM, no soft-float.
- **fixed-point (Q16.16)** `MulFix/DivFix` (adds/subs/neg/compares reuse the int
  ops since the representation is a scaled integer).
- **conversions** `I2F/F2I/Fix2F/F2Fix/I2Fix/Fix2I` — emitted by casts and by
  mixed-type promotion.
- data/flow: `PushConst`, `LoadUniform(idx,size)`, `LoadCtx(id)` (time/led.*/imu),
  `LoadState/StoreState(idx,size)`, `LoadLocal/StoreLocal`, `MakeVec(n)`,
  `Swizzle(mask)` (also used for scalar→vec broadcast), `Swap` (operand reorder
  for promotion/broadcast), compares + `BrFalse/Jmp`, `Call/RetFn` (user
  functions, with a 16-deep return-address stack), `Return`.

**The C6 (RV32IMAC) has no FPU → floats are soft-float.** Budget: 256 LEDs × ~30
ops × 30 fps ≈ 230k ops/s ≈ low-single-digit % CPU even in soft-float. `int`/
`fixed` run natively, so hot paths written against them are effectively free —
`fixed` (Q16.16) is the recommended type for smooth per-LED quantities. The ISA
carries both, so a script chooses its precision/speed tradeoff without any VM
change.

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
- `for` bound: currently a plain C-style loop (runtime trip count). Still open
  whether to hard-bound frame time via a global per-frame **instruction budget**
  (favored) vs a compile-time max-iterations cap. Not yet enforced.
  DECISION: include bounded execution (instruction count) in the impl. Also support
  bounded-time execution via continuation; save thread context on invocation and
  set up hardware timer to trigger at deadline (with some margin before frame)
  which cancels execution and resumes to timeout error branch at callsite.

Additional guidance:
Come up with a few effects as candidates to explore the design space and requirements.
As a few examples:
- chaser effects that are topology-aware, such as the current "agentic pulse" effect
- 3D volumetric effects (plane waves traveling along 3D vectors, spherical waves propagating outwards from spawn points, "hue field" function paramterized over 3D coordinates
- 2D video mapping: stream bitmap frames from client, sample bitmap in uv space like `texture()`

The effects runtime should have a dedicated arena allocator for any data structures needed so as to prevent the firmware from locking up because of heap exhaustion.
