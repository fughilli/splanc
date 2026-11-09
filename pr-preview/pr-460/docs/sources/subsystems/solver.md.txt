# The solver (`solver/`)

The visual-inertial solver in Rust — a port of the Python reference in
`pi/reconstruction`. It builds to both native (a Pi subprocess, `-c opt`) and
wasm (a phone Web Worker). At startup it runs a synthetic placement benchmark:
the phone solves if it is decisively faster than the Pi, otherwise the Pi solves.
JSON in, JSON out.

## Key files

- `solver/src/lib.rs` — the VIO solver (SO3, IMU preintegration, LSMR, LM, bundle
  adjustment).
- `solver/bin/` — the native CLI binary.
- `solver/worker.js` — the phone-side Web Worker launcher.

## Build

```sh
bazel build //solver:solver_cli          # host CLI
bazel build -c opt //solver:solver_cli_opt   # optimized, deployed to the Pi
bazel build //solver:solver_wasm_pkg      # wasm package for the phone
bazel test  //solver:rust_parity_test     # parity vs the Python reference
```

The math and the joint pose+LED formulation are covered in
{doc}`../design/index` (VIO exploration) and the reconstruction reference below.

---

The solver's own README (interface, placement algorithm, parity):

```{include} ../solver/README.md
:heading-offset: 1
```
