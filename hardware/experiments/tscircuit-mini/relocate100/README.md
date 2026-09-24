# Board-wide placement re-evaluation

`pnr.place.relocate.propose` generates whole-board translations. It screens legal grid locations using pin-to-peer Manhattan wire length, retains both the best light candidates and spatially distributed candidates, then ranks them using 3D distance fields over the previous round's routed copper. The source P/R controller dispatches it with `PNR_PLACEMENT_MODE=relocate`. It routes every proposed placement and retains the best completed routing result independently of the exploration state.

The cost is 1 per mm travel, 3 per through-via transition, and 100 additional per mm of occupied-track conflict. Transitions require a clear aperture across **all** layers, including layers between the two routing layers. Static obstacles cannot be crossed. Existing foreign copper is an expensive potential rip-up, not a legal route. The substrate reuses the router's pad, plane, antenna/rule-area and source-array reservations. Widths come from compiled net policy, with fabrication clearance and via size. This is a coarse 0.8 mm surrogate with approximate terminal access, not a detailed routing or electrical feasibility certificate; differential-pair coupling and reference integrity remain the later native stages' responsibility.

Physical constraints are not weakened by the generic module. It leaves fixed/locked components, rotation, side and footprint-local pad geometry untouched; it checks hard groups, keepouts, outline and collisions. Moving source-array owners and relative copper-keepout owners are currently excluded because they require candidate-specific obstacle reconstruction. Nonrectangular outlines are rejected. Each round evaluates a bounded set of eligible parts; subsequent rounds can reconsider other components.

The separate `run.py` experiment starts from full29's first signal-stage placement, preserving the 70 x 55 mm board. It releases only `@board.eol` XY from the source constraint document and records the override in `constraints.yaml` and `constraint-change.json`. It searches TP1 first to isolate the user's scenario, then enables generic part selection. Bottom side and rotation remain unchanged by translation-only search. Production mini constraints and the best electrical checkpoint remain intact pending end-to-end qualification. The experiment is not a form-factor-board or mating-board co-optimization; the moved pogo interface must eventually be propagated to the mating design.

Run via the existing PnR Python runtime:

```
python3 /private/tmp/pnr-runtime.py hardware/experiments/tscircuit-mini/relocate100/run.py
python3 hardware/experiments/tscircuit-mini/relocate100/watch.py
```

The output directory must not exist; preserve old experiments. The watcher creates native checkpoints, DRC reports, PDFs, movement/congestion maps and via scans. PDF review ledgers remain pending until images are actually inspected. Rebuild the interactive viewer after native checkpoints exist using `hardware/tools/pnr_viewer/build.py` and `--title 'Constrained global relocation'`.
