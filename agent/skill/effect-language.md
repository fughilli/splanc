# The effect language

GLSL-flavoured, compiled to bytecode for a small stack VM. The full reference
is EFFECTS.md in the Splanc repo; this is what you need to write effects.

## Shape of a program

```glsl
uniform float speed : 0.0 .. 4.0 = 1.0;   // knobs (uniforms-and-ui.md)
state float phase;                       // persists across frames; written in update()

void update() {                          // optional: once per frame
  phase = fract(phase + dt * speed);
}

vec3 shade(Led led) {                    // required: once per LED, linear RGB 0..1
  return hsv2rgb(fract(led.dist + phase), 0.9, 1.0);
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

`float vec2 vec3 vec4 int bool`, fixed-point `fixed` (Q16.16), `fixed16` (Q1.14),
`fixed8` (Q1.6), `struct`s and fixed-size arrays (`Type name[N]`).

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

The device budget is a frame time; `measure_effect` reports the cost. To stay
inside it:

- Hoist anything that doesn't depend on the LED into `update()` / `state`.
- `smoothstep`, `distance`, `pow`, `exp` are the most expensive; `sin`/`cos` are
  cheap LUTs; `hash` is an integer mix (cheap).
- Prefer `int`/`fixed` on hot per-LED paths (native opcodes, no soft-float).
- Avoid per-LED loops over many items; keep `for` trip counts small.
