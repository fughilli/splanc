# solver — the native VIO solver (Rust)

Rust port of the visual-inertial joint pose+LED solver
(`pi/reconstruction/reconstruction/vio.py` + `vio_api.py`), built from one
crate into two deployments:

| Target             | What it is                                                                       |
| ------------------ | -------------------------------------------------------------------------------- |
| `:solver`          | the library (so3/IMU-preintegration/LSMR/LM/pipeline, unit-tested)                |
| `:solver_cli`      | host binary — the Pi server runs it as a subprocess (`server/native_solver.py`)   |
| `:solver_wasm_pkg` | wasm32 + wasm-bindgen JS glue for the phone                                       |
| `:solver_web`      | the phone-side deployment dir: wasm pkg + `worker.js`, served at `/solver/`       |

## Interface

JSON in, JSON out — both carriers stay trivial:

```text
stdin/solve_json  {detections, imu, ledCount, mapId, createdAt,
                   options{maxKeyframes, maxNfev, pxSigma, rejectOutliers,
                           gapSplitS, outlierSigma, minViews}}
stdout/return     §7.5 OutputMap JSON
stderr/progress   solve_status-shaped snapshots (JSON per line / JS callback)
```

`solver_cli --benchmark` runs the canned placement benchmark
(`src/synth.rs`) and prints `{"ms", "rms"}`.

## Solver placement (why the benchmark exists)

Host and phone run the SAME canned solve through the SAME Rust code (native
vs wasm) at startup; the host advertises its score in `welcome.solverBenchMs`
and the phone compares its own (`web/src/solver/placement.ts`). Phone-first:
the phone has the observations locally, so it keeps the final solve unless it
is decisively (4×) slower than the Pi. A phone-side solve stops the capture
with `stop_mapping{solveOnHost:false}`, solves in a worker, and uploads via
`submit_map`.

## Algorithm parity

The port keeps the Python reference's stage structure, gauge choices, weights
and thresholds (rotation seeds → known-rotation linear init with
down-weighted scale pins → gravity-constrained inertial alignment → sparse
VI bundle adjustment with pseudo-Huber reprojection → metric re-anchor →
consensus+MAD outlier rejection with best-state rollback). The optimizer is
Levenberg–Marquardt over damped LSMR with column-grouped finite differences —
the stand-in for scipy's TRF; `//pi/reconstruction:rust_parity_test` pins
that both implementations solve the same synthetic session to the same map.

Intentionally not ported: `refine_intrinsics` (never enabled in production —
a floating focal is a scale-drift channel; calibration studies keep the
Python solver, which also remains the automatic fallback when the binary is
missing from runfiles).

## Build / test

```sh
bazelisk test //solver:solver_test                    # unit + e2e synthetic
bazelisk test //pi/reconstruction:rust_parity_test    # vs the Python solver
bazelisk run  //solver:solver_cli -- --benchmark
bazelisk build //solver:solver_web                    # phone bundle
```

Production builds want `-c opt` (an order of magnitude faster solves — and
benchmark scores that reflect it); `bazelisk run -c opt //web:serve`.
Format with `bazelisk run @rules_rust//:rustfmt`.
