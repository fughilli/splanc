# Native PnR regression ladder

A circuit manifest becomes an unrouted native KiCad board using real library
footprints. The ordinary `pnr.ingest`, `route_and_place`, `writeback` and `planes`
stages run, followed by a fresh native KiCad DRC on the exact saved result. No
pre-routed geometry, hand-selected final component locations, DRC exclusions,
expected failures or mocked routing are used. Only the supply connector is fixed.
This tests the PnR backend from native circuit inputs, not atopile compilation or
SPICE behavior. The fixtures are small engineering test circuits, not qualified
manufacturing designs.

| Case | Parts | Added difficulty |
| --- | ---: | --- |
| Connector + LED | 2 | Basic connection; supply must be externally current limited |
| Resistor + LED | 3 | Movable series current limiter |
| Two LEDs | 5 | Shared, branched supply and return |
| Inverter indicators | 8 | SOT-23-5 pin escapes, an intentionally unused pad, 3-pin connector |
| TLC555 blinker | 10 | 8-pin IC, RC timing and control, bypass and bulk capacitors |
| Two-stage chaser | 14 | TLC555 + CD4017B, cross-IC clock/reset, fanout |
| Five-stage chaser | 20 | Five LED/resistor outputs, shared rails and dense routing |
| Five-stage chaser with plane | 20 | Four copper layers, ground plane attachment/refill |

Signal width is 0.25 mm, supply/return width at least 0.4 mm, clearance 0.2 mm,
and vias 0.6/0.3 mm. Resolved supply policy includes a 0.1 A current budget.
Each manifest retains explicit intentionally unused pins. Pin mappings and timer
connections were checked against [TLC555](https://www.ti.com/lit/ds/symlink/tlc555.pdf),
[CD4017B](https://www.ti.com/lit/ds/symlink/cd4017b.pdf), and the KiCad library
footprints. The chaser uses a Johnson counter rather than requiring a separate
serial-data generator. Direct decoded-output reset is a test topology; power-up
phase/timing and analog performance require separate electrical qualification.

## Run

Use a numerical Python with PyTorch, NumPy and PyYAML, and a separate KiCad Python
with pcbnew. The Mac mini's durable local environment is
`output/pnr-regression-runtime/bin/python`. Its resolved dependencies are recorded
in `requirements-macos-py312.lock`; NumPy 1.26 is used with the repository's
PyTorch 2.3.1 because that Torch wheel predates the NumPy 2 ABI.

```sh
output/pnr-regression-runtime/bin/python hardware/pnr/regression/run.py \
  --out output/pnr-regression118/new-run --seed 0 --seed 1
```

The output must not exist. `--case NAME` selects a fixture; `--rounds` and
`--timeout` bound PnR search and individual stages. `--python`, `--kicad-python`,
`--kicad-cli` and `--library` make the runner portable to another configured host.
The Bazel entry point is `//hardware/pnr:native_regression` (manual host integration;
KiCad and its footprint installation are required). Contract and algorithm tests
are `regression_contract_test`, `joint_access_test`, `search_footprint_test`, and
`initial_pool_test`. These can also run directly with Python/unittest.

The runner exits nonzero for any failure, including unavailable dependencies.
Every run copies its numerical/native Python sources into `source-freeze`, records
hashes, versions, seeds, fixture/netlist/library fingerprints and individual stage
logs. It writes `summary.json`, per-case `result.json`, and CI-readable `junit.xml`.
Concurrent source editing cannot change the running frozen Python modules. Native
KiCad and source libraries must remain installed and unchanged during execution.

Acceptance requires legal placement, complete grid routing with no deferred nets,
exact original pin/net assignments, source-width tracks, qualified existing SMD
track contacts, zero native unconnected items, and zero native DRC findings
(including warnings). Zone-only contacts still rely on native DRC; the pad-entry
witness is a local track-contact check, not current/thermal qualification. Logs
retain opens, DRC types, copper length, vias, wall time and joint escape diagnostics.

Verify the installed native oracle itself using a passed two-part case:

```sh
PYTHONPATH=hardware/pnr /Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3 \
  hardware/pnr/regression/check_native_oracle.py OUTPUT/01-connector-led-2-seed-0 \
  --kicad-cli /Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli
```

It saves deliberately open and shorted copies in `negative-controls`; the passed
board is hash-checked unchanged. Both faults must be detected. KiCad workers use
separate processes and initialize wx to avoid invalid SWIG wrappers during board
reuse. Deliberately corrupted boards are diagnostic, never promoted or fabricated.

## Each hill-climb

1. Preserve an initial failing run, form a specific hypothesis, change the router,
   then rerun the complete ladder with the same budgets and fixed seed set.
2. Keep failed cases visible. Do not fix a test by deleting pins, lowering widths,
   expanding only that fixture's outline, hardcoding a placement, or ignoring DRC.
3. Export all enabled layers of the saved diagnostic/final boards using
   `hardware/tools/export_mini_review.py`; inspect actual page images, record only
   genuinely reviewed pages, and run `verify_mini_review.py`. Copper and annotated
   copper pages need individual inspection; technical pages can use contact sheets.
4. Every case gets a 5 mm via-proximity scan. Review changed clusters using actual
   contacts; proximity alone does not prove a redundant via.
5. Update the transfer-root HANDOFF-PROGRESS.md with run paths, exact native results,
   visual observations and remaining failures. Small-board success is a prerequisite
   for a new full Splanc trial, not evidence that Splanc itself is routed.

The paused full116 run and protected fresh28 board are not touched by this suite.

## Initial placement exploration

Use `--initial-pool --initial-starts 8 --initial-finalists 3` to generate and
legalize distinct whole-board starts, score their multilayer capacity, and route
three finalists under equal detail budgets. The legacy first legal placement and
a legal source incumbent are retained. Pool diagnostics and each candidate pose
live in `CASE/rounds/initial-pool/`. These are screening results; only the saved
final board through all native stages can pass this regression. Ambient pool
variables do not silently enable this mode in the runner.

See [RESULTS-118.md](RESULTS-118.md) for the frozen ladder, native comparisons,
actual PDF review evidence and remaining placement/route-quality findings.
