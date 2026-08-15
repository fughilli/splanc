# FUG-122 fixed-vs-float perf A/B

The same hue plasma written two ways — a full-float baseline
(`plasmaHueF32.fx`) and its fully-fixed native-datatype twin
(`plasmaHueFixed.fx`, zero soft-float: `LoadCtxFix` input, `FractFix`,
`Hsv2RgbFix`, `RetRgbFix` output). Use them to measure the per-frame cycle win
of the FUG-122 native-datatype ISA on a real ESP32-C6.

## Deterministic host proof (no hardware)

`bazel run //tools/fx_profile` profiles both in its corpus (`plasma_hue_f32` /
`plasma_hue_fixed`): soft-float share drops **74% → 0%**, op count 2817 → 2561.
The `//fx_compiler:fx_compiler_test` `ab_plasma_fixed_twin_is_softfloat_free`
test enforces the fixed twin stays soft-float-free.

## On-device measurement (HITL)

Needs the tailnet + a free rig (see the `hitl` skill / `pi/hitl`). `fx_bench`
reserves a rig, flashes the current firmware, provisions, and reports the frame
cycles per effect (pass an ABSOLUTE `--benchmarks-dir`; the sandbox cwd is not
the source tree):

```sh
bazel run //pi/hitl/harness:fx_bench -- \
  --benchmarks-dir "$PWD/pi/hitl/harness/ab_demo" \
  --out /tmp/fug122-ab.json
```

To measure against firmware already on the board, add `--no-bundle`; to target a
reachable player socket directly, `--device-ws ws://<dut>/ws`.

### Measured result (esp32c6 @ 160 MHz, 256 LEDs)

After cutting the per-LED framing overhead (resident VM scratch + uv gating), the
datatype win is no longer diluted by fixed framing:

| effect                                          | float (frame cyc) | fixed native | speedup           |
| ----------------------------------------------- | ----------------- | ------------ | ----------------- |
| `swirlF32` / `swirlFixed` (6 sin/cos + hsv)     | 4,077,126         | 848,034      | **4.8×** (−79 %)  |
| `plasmaHueF32` / `plasmaHueFixed` (fract + hsv) | 1,571,722         | 848,942      | **1.85×** (−46 %) |

The compute-heavy swirl is **4.8× faster** in fixed — its six soft-float
`sin`/`cos` + `hsv2rgb` collapse to integer LUT ops. Light effects (plasma) are
framing-bound (both ~848 k), so ~1.85×. The residual ~848 k floor is the per-LED
framing + the FastLED transmit, shared by both.

(For reference, before the framing cut the fixed path was diluted: plasma was
only −17.8 %. The framing hill-climb — resident scratch, no per-LED state/uniform
copies, uv gating — dropped the pure-overhead floor ~25 %: `empty` 490 k → 366 k.)
