# Uniforms: the knobs

A uniform is a parameter the user (and you) can change while the effect runs,
without redeploying. Declare one for every quality a person might want to tune —
speed, colour, density, intensity — with a sensible default and a tight range.

```glsl
uniform float speed : 0.0 .. 5.0 = 1.0;          // slider: min .. max = default
uniform float tilt  : -1.0 .. 1.0 = -0.25;       // signed ranges are fine
uniform vec3  tint  : color = 0.2, 0.6, 1.0;     // colour picker (linear RGB 0..1)
uniform vec3  dir   : -1 .. 1 = 0.0, -1.0, 0.0;  // numeric vector: one range for every component
uniform vec4  plane : vec4(-1,-1,-1,-5) .. vec4(1,1,1,5) = 0, 1, 0, 1;  // per-component range
uniform mat4  pose;                              // matrix (identity default): set by API / OSC
uniform int   mode  : {"fire", "ice"} = 0;       // dropdown (index)
uniform bool  invert = false;                    // toggle
```

A `vec3`/`vec4` with no annotation (or `: color`) is a colour 0..1. Give it a
range and it is a plain numeric vector instead (per-component sliders, any sign)
— use that for directions, offsets, planes. A `mat3`/`mat4` (column-major) takes
an optional range (`: -10 .. 10`, default ±1000) and is usually streamed from a
controller or tracker rather than set by hand.

The Splanc app builds its controls from these declarations, so the same knobs
appear for the user on their phone.

## Setting them through the bridge

`set_uniforms` / `ramp_uniforms` take values by NAME:

| Declared as   | Pass                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------- |
| float slider  | a number inside the range                                                                                        |
| `vec3` color  | `[r, g, b]`, each 0..1                                                                                           |
| ranged vecN   | `[x, y, ...]`, each in its range (signed)                                                                        |
| `mat4`/`mat3` | 16 / 9 numbers, COLUMN-major (GLSL order: `[c0.x, c0.y, c0.z, c0.w, c1.x, ...]`; translation is the last column) |
| dropdown      | the option string (`"ice"`) or its index                                                                         |
| bool toggle   | `true` / `false`                                                                                                 |

Out-of-range or wrong-width values are refused with the allowed range, so read
`list_uniforms` first.

- Ramps interpolate numbers and colours; dropdowns and toggles switch at the end.
  Vectors and matrices ramp component by component (a matrix lerp is not a
  rotation interpolation: ramp between nearby poses, or stream the pose).
- Ramp steps are not persisted; the final value is committed once (on firmware
  that supports `commit`; older firmware persists on its own schedule).
- `commit: true` on `set_uniforms` asks the player to persist across reboots.

## Design advice

- Name uniforms for what the user perceives (`warmth`, `rain`, `calm`), not the
  math (`k2`).
- Ranges should be useful end to end: every slider position should look good.
- A mood is a set of uniform values: to "make it stormy", ramp several at once.

## OSC (udp/9000)

The player also takes OSC for every uniform, by name. A uniform is a run of
`width` floats (a matrix column-major):

| Address            | Args                 | Sets                                                                       |
| ------------------ | -------------------- | -------------------------------------------------------------------------- |
| `/<name>`          | up to `width` floats | from the first component: `/speed ,f`, `/plane ,ffff`, `/pose` + 16 floats |
| `/<name>/x` … `/w` | floats               | from that component (`/tint/x ,f`)                                         |
| `/<name>/<i>`      | floats               | from flat component `i`: `/pose/12 ,fff` = a mat4's translation            |
| `/<name>/<c>/<r>`  | 1 float              | matrix element column `c`, row `r` (`/pose/3/1` = translation y)           |

Only the components a message names change; the rest keep their values.
