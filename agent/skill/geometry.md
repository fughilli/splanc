# Using the fixture's shape

What makes Splanc different: the effect knows where every LED is.

## The map frame

- Units are **meters**. `led.pos` is `[x, y, z]`.
- **+Y is up** (gravity-levelled maps align −Y with measured gravity).
- The origin is wherever the mapping put it (positions can be negative). For a
  normalized position use `led.uv`: X and Y scaled over the map's extent to
  0..1, so **`led.uv.y` is height, 0 = lowest LED, 1 = highest** — no bounds
  needed (see `examples/height_gradient.fx`).
- For absolute measures (a 30 cm wave, "the top half metre") use `led.pos`
  with sizes from `splanc://fixture/summary` (`bounding_box_m`). Uniform ranges
  can't have negative bounds, so expose sizes/offsets as positive uniforms.

## Topology: the fixture as a graph

The map's topology splits the fixture into **segments** (runs of LEDs along a
strip, wire or branch) joined at **branch points**:

- `led.seg` — which segment; `led.s` — 0..1 along it. Pulses along strips:
  `fract(led.s - time * speed)`.
- `led.dist` — geodesic distance 0..1 from the root, along the fixture (not
  straight-line). Waves that flow through the structure: `fract(led.dist - time)`.
- `flood_from(node)` (in `update()`) re-roots `led.dist`; `term_count()` /
  `term(k)` enumerate the endpoints, for waves that start at a random tip.
- `seg_len(seg)` is a segment's length (compare segments; don't assume units).

Without topology (a fixture mapped but not segmented), `led.seg`/`led.s`/`led.dist`
carry no structure — the summary's `topology` is null. Use `led.pos` instead.

## Choosing coordinates

| The user wants...                     | Use                    |
| ------------------------------------- | ---------------------- |
| "rising", "sunset", "fill from below" | `led.uv.y` (0..1)      |
| "flowing along the branches/strips"   | `led.dist` or `led.s`  |
| "ripples from the centre"             | `distance(led.pos, c)` |
| an image / video on the fixture       | `sample(img, led.uv)`  |
| sparkle, randomness per LED           | `hash(float(led.idx))` |

Preview with `preview_effect` to check the effect reads well on THIS shape — a
gradient along X on a fixture that is tall and narrow shows almost nothing.
