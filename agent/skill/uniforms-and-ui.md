# Uniforms: the knobs

A uniform is a parameter the user (and you) can change while the effect runs,
without redeploying. Declare one for every quality a person might want to tune —
speed, colour, density, intensity — with a sensible default and a tight range.

```glsl
uniform float speed : 0.0 .. 5.0 = 1.0;          // slider: min .. max = default
uniform vec3  tint  : color = 0.2, 0.6, 1.0;     // colour picker (linear RGB 0..1)
uniform int   mode  : {"fire", "ice"} = 0;       // dropdown (index)
uniform bool  invert = false;                    // toggle
```

Slider bounds must be non-negative literals (`-1.0 .. 1.0` doesn't parse): offset
the value in the shader instead (`0.0 .. 2.0 = 1.0`, then `x - 1.0`).

The Splanc app builds its controls from these declarations, so the same knobs
appear for the user on their phone.

## Setting them through the bridge

`set_uniforms` / `ramp_uniforms` take values by NAME:

| Declared as  | Pass                                     |
| ------------ | ---------------------------------------- |
| float slider | a number inside the range                |
| `vec3` color | `[r, g, b]`, each 0..1                   |
| dropdown     | the option string (`"ice"`) or its index |
| bool toggle  | `true` / `false`                         |

Out-of-range or wrong-width values are refused with the allowed range, so read
`list_uniforms` first.

- Ramps interpolate numbers and colours; dropdowns and toggles switch at the end.
- Ramp steps are not persisted; the final value is committed once (on firmware
  that supports `commit`; older firmware persists on its own schedule).
- `commit: true` on `set_uniforms` asks the player to persist across reboots.

## Design advice

- Name uniforms for what the user perceives (`warmth`, `rain`, `calm`), not the
  math (`k2`).
- Ranges should be useful end to end: every slider position should look good.
- A mood is a set of uniform values: to "make it stormy", ramp several at once.
