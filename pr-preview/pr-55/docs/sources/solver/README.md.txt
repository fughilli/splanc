# solver — the native VIO solver (Rust)

Rust port of the visual-inertial joint pose+LED solver
(`pi/reconstruction/reconstruction/vio.py` + `vio_api.py`), built from one
crate into two deployments:

| Target             | What it is                                                                       |
| ------------------ | -------------------------------------------------------------------------------- |
| `:solver`          | the library (so3/IMU-preintegration/LSMR/LM/pipeline, unit-tested)               |
| `:solver_cli`      | host binary — the Pi server runs it as a subprocess (`server/native_solver.py`)  |
| `:solver_cli_opt`  | the same binary pinned to `-c opt` by transition — what the server actually runs |
| `:solver_wasm_pkg` | wasm32 + wasm-bindgen JS glue for the phone                                      |
| `:solver_web`      | phone-side deployment dir: `-c opt` wasm pkg + `worker.js`, served at `/solver/` |

## Interface

JSON in, JSON out — both carriers stay trivial:

```text
stdin/solve_json  {detections, imu, ledCount, mapId, createdAt,
                   options{maxKeyframes, maxNfev, pxSigma, rejectOutliers,
                           outlierSigma, minViews,
                           stripPrior, stripSpacingM, stripTolerance}}
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

## Strip prior (`options.stripPrior`, off by default)

Most fixtures are a strip, rope or string wired in id order, so LED `i` and
LED `i + k` are at most `k` pitches apart. Diffuse capture needs this most:
striding cuts each LED's observation rate N×, and bloomed blobs give poor ray
vergence. `src/strip.rs` adds, after the outlier-rejection loop:

1. **Pitch estimate** — median distance between consecutive mapped ids
   (confident pairs preferred; `stripSpacingM` overrides).
2. **Rope constraint** — a second VI-BA pass, warm-started, with one one-sided
   residual per consecutive mapped pair: zero within `gap · pitch · (1 +
stripTolerance)`, linear past it (a pitch of overshoot ≈ a 20σ pixel
   error). LEDs already off the chain are left out of the rope so their
   observations can't drag their neighbours, and a far jump between two LEDs
   that each agree with their other neighbour is a **break** (a jumper between
   strip segments, a raster row wrap) and is not linked.
3. **Demote + fill** — at assembly, an LED still too far from both
   neighbours (while they agree) is dropped, and every interior run of
   unmapped ids is placed on the straight segment between its mapped
   neighbours at equal spacing. End runs stay unmapped. Placed LEDs are
   emitted as ordinary entries with `nViews = 0, confidence = 0` (the web app's
   `geom/inferred.ts` keys on that), so any real measurement outranks them.

Rust-only: the Python reference doesn't implement it, and with the option off
(the default) the solve is unchanged, so `rust_parity_test` is unaffected. The
phone enables it on final solves from Settings ▸ Capture ▸ Strip prior; the
host-solve path doesn't carry the option yet (`stop_mapping` has no field for
it), so host-placed solves run without it.

## Build / test

```sh
bazelisk test //solver:solver_test                    # unit + e2e synthetic
bazelisk test //pi/reconstruction:rust_parity_test    # vs the Python solver
bazelisk run  //solver:solver_cli -- --benchmark
bazelisk build //solver:solver_web                    # phone bundle
```

The DEPLOYMENT targets (`:solver_cli_opt`, `:solver_web`) are pinned to
`-c opt` via a configuration transition (`tools/transitions/opt.bzl`) — an
unoptimized solve is ~10× slower, and the dev loop runs fastbuild. Unit
tests keep the invocation's mode for fast iteration; both deployed sides
transition identically, so the placement benchmark always compares opt
against opt. Format with `bazelisk run @rules_rust//:rustfmt`.
