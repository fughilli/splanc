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
reserves a rig, flashes the current firmware, provisions, and reports
`measuredFrameCycles` per effect:

```sh
bazel run //pi/hitl/harness:fx_bench -- \
  --benchmarks-dir pi/hitl/harness/ab_demo \
  --out /tmp/fug122-ab.json
```

Then compare `measuredFrameCycles` for `plasmaHueF32` vs `plasmaHueFixed` in the
bundle (the fixed twin should be markedly lower — it runs no soft-float). To
measure against firmware already on the board, add `--no-bundle`; to target a
reachable player socket directly, `--device-ws ws://<dut>/ws`.
