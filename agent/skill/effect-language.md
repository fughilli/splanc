# The effect language

GLSL-flavoured, compiled to bytecode for a small stack VM. The full reference
is EFFECTS.md in the Splanc repo; this is what you need to write effects.

## Shape of a program

```glsl
uniform float speed : 0.0 .. 4.0 = 1.0;   // knobs (uniforms-and-ui.md)
state fixed phase;                       // persists across frames; written in update()

void update() {                          // optional: once per frame
  phase = fract(phase + fixed(dt * speed));
}

vec3 shade(Led led) {                    // required: once per LED, linear RGB 0..1
  // fixed point end to end: the cheap form on the device (see Performance)
  return hsv2rgb(fract(fixed(led.dist) + phase), fixed(0.9), fixed(1.0));
}
```

- No recursion; every `for` loop needs a compile-time trip count.
- Every invocation has an instruction budget (100k); a `shade` that blows it
  returns black.

## Rate controls: integrate, never `time * speed`

The most common authoring bug. A uniform that sets a RATE (speed, frequency,
drift, spin, rate, period) must not multiply `time` inside a phase:

```glsl
float p = fract(led.s - time * speed);   // WRONG: jumps when `speed` moves
```

`time * speed` is the whole elapsed time rescaled, so moving the slider from
`s0` to `s1` moves the phase by `(s1 - s0) * time` — after ten minutes of uptime
that is dozens of cycles, and the effect stutters wildly while the knob turns.
Integrate the rate once per frame instead; a knob change then only changes how
fast the phase advances from where it is:

```glsl
uniform float speed : 0.0 .. 4.0 = 1.0;   // cycles per second
uniform float spin  : 0.0 .. 2.0 = 0.3;
state float ph;                          // one phase PER rate knob
state float spin_ph;
state float wobble;

void update() {
  ph      = fract(ph + dt * speed);        // fract keeps it in 0..1 (float precision)
  spin_ph = fract(spin_ph + dt * spin * 0.5);   // constant factors go inside
  wobble  = sin(spin_ph * 6.2832);         // oscillator: sin(phase * TAU), once per frame
}

vec3 shade(Led led) {
  float band = fract(led.s - ph);          // scrolling along a strip
  return hsv2rgb(fract(led.dist + ph), 0.9, 0.5 + 0.5 * wobble) * band;
}
```

- `dt` is seconds since the last frame (the device measures it; the preview
  steps it). `fract(phase + dt * rate)` wraps a periodic phase so it never loses
  float precision; use `phase * 6.2832` for float `sin`/`cos` (radians).
- Scrolling NOISE or any non-periodic offset: integrate without wrapping,
  `drift = drift + dt * speed;` (see `examples/noise_field.fx`).
- Epochs (`floor`/`hash` of a moving phase): wrap by hand and count the wraps,
  `ph = ph + dt * rate; if (ph >= 1.0) { ph = ph - 1.0; epoch = epoch + 1.0; }`.
- Fixed point: `state fixed ph;` with `ph = fract(ph + fixed(dt) * fixed(speed));`,
  then `sin(fixed16(ph))` is the integer LUT in TURNS (no `* 6.2832`).
- `time` alone is fine when nothing scales it: `fract(led.s - time)`,
  `sin(time * 0.7)` — a literal rate can't jump. So is `time` plus a uniform
  offset. Only rate × time is the bug.
- Several fixtures that must stay in lockstep (`align_time`) share `time`, not
  integrated phases; there, prefer a fixed rate on `time` over a rate knob.

`compile_effect` reports this pattern as a `warning:` with the line; treat it
like an error.

## Types

`float vec2 vec3 vec4 int bool`, fixed-point `fixed` (Q16.16 — integer maths,
the fast type for per-LED work), `fixed16` (Q1.14) and `fixed8` (Q1.6) (range
±2; mostly for compact buffer storage), `struct`s and fixed-size arrays
(`Type name[N]`). Casts: `fixed(x)`, `float(x)`, `int(x)`.

## Inputs

| Name                   | Meaning                                                           |
| ---------------------- | ----------------------------------------------------------------- |
| `time`, `dt`, `frame`  | seconds since start, seconds since last frame, frame counter      |
| `led.pos`              | LED position in METERS, map frame, +Y up                          |
| `led.idx`, `led.count` | LED index, live LED count                                         |
| `led.seg`, `led.s`     | segment id; position along it 0..1 (from endpoint a)              |
| `led.branch`           | branch id                                                         |
| `led.dist`             | geodesic distance 0..1 from the topology root (or a `flood_from`) |
| `led.uv`               | top-down texture coordinate 0..1                                  |

## Storage

- `state float x;` — per-frame state; written by `update()`, read-only in `shade()`.
- `buffer vec3 trail;` — one element per LED, persists; `trail[led.idx]` may be
  written from `shade()` (trails, feedback).
- `texture vec3 img(64, 64);` — a W×H texture; `sample(img, uv)` (bilinear),
  `paint(img, uv, color);`. Can be fed live by `stream_texture`.
- `: fixed8` / `: fixed16` on a buffer/texture element saves device RAM.

## Builtins

Math `sin cos tan abs floor ceil fract sqrt exp log sign min max pow mod step atan2`;
vectors `clamp mix smoothstep dot cross length normalize distance`; colour
`hsv2rgb(h, s, v)` (all 0..1) and `palette0/1/2`; noise `hash(x)` / `hash(vec3)`
→ 0..1; textures `sample paint`; topology `seg_count seg_len seg_node node_deg
node_seg node_side term_count term flood_from(node)`.

## Performance (the player has no FPU)

The player is an ESP32-C6 at 160 MHz with no floating-point unit. `shade()` runs
once per LED per frame: at 500 LEDs and 30 fps that is ~10,600 cycles per LED,
and the runtime already spends ~2,600 of them. Every opcode pays ~70 cycles of
interpreter dispatch, even a local load or an integer add, so a fast `shade()`
is a few dozen cheap operations. Measured cycles per call (dispatch included):

| class                    | examples                                                                                              | cycles    |
| ------------------------ | ----------------------------------------------------------------------------------------------------- | --------- |
| int / `fixed` arithmetic | `+ - * min max abs clamp fract floor mix step mod`                                                    | 100–150   |
| `fixed` maths            | `sin`/`cos` of a fixed angle in TURNS 150, `exp` 170, `atan2` 350, `sqrt` 480, `hsv2rgb` 370          | 150–720   |
| float arithmetic         | `+ - *` 195, `/` 350; a `vec3` op pays every lane (`vec3 + vec3` 440)                                 | 195–440   |
| float maths              | `floor` 260, `fract` 340, `sin` 570, `cos` 650, `sqrt` 680, `exp`/`log` 850, `atan2` 1040, `pow` 1800 | 260–1800  |
| float vector / colour    | `smoothstep` 700 per lane, `length(vec3)` 1000, `distance` 1200, `normalize` 1600, `hsv2rgb` 1300     | 700–1600  |
| noise                    | `hash(x)` 185; 3-D value noise from 8 hashes + mixes ≈ 9,000                                          | 185–9,000 |
| conversions, storage     | int/fixed ↔ float 320; buffer read/write 130; `sample(tex, uv)` ≈ 3,800                              | 130–3,800 |

So eight float transcendentals per LED already fill the frame. What keeps an
effect cheap (the fixed-point examples show each technique —
`rainbow_spin.fx`, `plasma_fixed.fx`, `noise_field.fx`):

- **Per-LED maths in `fixed`** (Q16.16; `int` for indices). Read LED inputs as
  fixed — `fixed(led.uv.x)`, `fixed(led.s)`, `fixed(led.pos.y)` load directly
  (the first one costs ~1,200 cycles per LED once, covering all of them) — and
  wrap every literal: `x * fixed(0.6)`. One float operand turns the expression
  back into soft-float plus two 320-cycle conversions; `compile_effect` warns
  about it.
- **Phases in turns.** Keep `state fixed` phases advanced in `update()`
  (`ph = fract(ph + fixed(dt * speed))`); `sin`/`cos` of a fixed argument is an
  integer LUT with 1.0 = one full turn (not 2π). `atan2` of two fixed arguments
  returns turns too (-0.5..0.5).
- **Colour**: `hsv2rgb(h, s, v)` with all three arguments the same fixed type is
  the integer path; return that colour directly from `shade()`. For float colour
  maths keep scalars and build the `vec3` once at the end.
- **Hoist.** Anything that depends only on time/uniforms/state belongs in
  `update()` → `state`. The compiler also hoists frame-invariant expressions
  written in `shade()` and caches up to four per-LED-invariant scalars
  (`atan2`/`length` of `led.pos`, `hash(float(led.idx))`) once per LED — only
  expressions written directly in `shade()` and assigned once to a local, never
  inside your helper functions. For more, fill a `buffer` on the first frame.
- **No float `pow`/`exp`/`smoothstep`/`length` per LED** where a cheap form
  works: `x * x`; in fixed, `clamp((x - a) * k, fixed(0.0), fixed(1.0))` for a
  smoothstep; `dot(d, d) < r * r` for a distance test; multiply by a
  reciprocal instead of dividing by a constant. (`exp` of a fixed argument only
  covers -2..0.69.)
- **No per-LED loops over many items and no per-LED multi-octave noise**: a loop
  multiplies its body by its trip count. Precompute into `state`/buffers, or use
  a fixed-point lattice (`noise_field.fx`).
- `sqrt atan2 pow log tan hsv2rgb` have integer paths only when every argument
  is the same fixed type; `smoothstep hash dot length distance normalize cross`
  are always float (fixed arguments are converted).
- `: fixed8` / `: fixed16` on buffer/texture elements saves RAM.

`estimate_effect` returns the frame estimate and the top cost findings — what
to change and roughly how many cycles per LED each would save. Apply them, then
confirm with `measure_effect`.
