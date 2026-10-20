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
