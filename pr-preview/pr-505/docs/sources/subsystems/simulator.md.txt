# The simulator (`shared/simulator/`)

The M9 synthetic ground-truth generator — the reason most of splanc can be tested
with no hardware at all. It builds a known fixture, flies a virtual camera around
it, projects the LEDs into each view, applies configurable degradations, and
emits detection records in exactly the shape `pi/reconstruction` consumes. Because
it shares the camera model with reconstruction, its output is guaranteed
in-distribution for the solver.

## Fixtures

```{figure} ../_generated/fixtures.png
:alt: line, grid, cube, helix fixtures
:width: 100%

The four built-in fixtures, rendered straight from `simulator.fixtures`.
```

- `line`, `grid`, `cube`, `helix` — `simulator/fixtures.py`.
- The virtual camera walk — `simulator/walk.py` (`arc_walk`).
- The noise model and presets — `simulator/degrade.py` (`NoiseModel`, `PRESETS`).
- Detection-log assembly — `simulator/detection_log.py` (`generate_log`).

## Run

```sh
# Generate a detection log (and optional ground truth) for a fixture:
bazel run //shared/simulator:simulate -- \
    --fixture helix --leds 64 --noise none --views 60 -o log.json --truth truth.json

# Round-trip test: simulate -> reconstruct -> compare to truth:
bazel test //shared/simulator:sim_recon_roundtrip_test
```

This same code path drives the generated figures in the {doc}`architecture
<../architecture>` page and the {doc}`reconstruction <reconstruction>` overview.
