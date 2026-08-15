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

| effect                          | frame cycles | vs float                        |
| ------------------------------- | ------------ | ------------------------------- |
| `plasmaHueF32` (float)          | 1,603,536    | —                               |
| `plasmaHueFixed` (fixed native) | 1,318,320    | **−17.8 %** (~10.0 ms → 8.2 ms) |

~285 k cycles / frame (~1114 cycles / LED) saved — the shader's soft-float
`sin` + `hsv2rgb` + output, removed by the fixed path. The residual frame cost is
the per-LED framing and the FastLED transmit, shared by both.
