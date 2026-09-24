# Initial placement exploration, round 118

The old source P/R loop tries whole-board random global placement, then accepts
its first legal result. Other seeds are used when legalization fails, not as a
routability tournament. Consequently an initially legal but congested layout can
survive without comparing other broad arrangements. This is distinct from the
checkpoint-seeded full116 batch relocation loop, which remains frozen and paused.

`pnr.place.initial_pool` now offers a bounded opt-in tournament before source P/R
round 1. The default is eight starts, up to eight capacity-proxy evaluations and
three equally budgeted detailed signal-routing finalists. It retains the legacy
start and any legal source incumbent, explores board-wide stratified/Latin starts
and cardinal rotations, and retains geographic/pose diversity when shortlisting.
All candidates preserve source electrical geometry and hard placement rules.
Detailed screening metrics explicitly list deferred electrical nets; final native
all-net electrical acceptance, DRC and quality gates still apply downstream.
This pool is a finite initialization budget, not an observed plateau.

At most two starts may target a pad-rich movable footprint beneath a sufficiently
large body on the opposite copper side. These basins are chosen from geometry,
not component names. They respect drilled-body occupancy, hard groups and all
placement/RF keepouts. A temporary pose keeps the global optimizer from immediately
erasing the alternative. If that solve fails in an unrelated dense group, one
reported bounded legalization attempt reuses the first legal global arrangement
with the new basin. The temporary pose is not added to design constraints and
later P/R remains free to move it. Reports distinguish this fallback from an
independent successful global solve.

## Pogo source constraint

The user explicitly said “In this case, I think we can deconstrain the pogo pad
array,” subsequently requested moving it under the radio, and clarified that it
serves board-level EoL test before the enclosure. Live `mini-constraints.yaml`
still fixed `@board.eol` at `(45,13.5)`, 0°, bottom, despite separate checkpoint
experiments releasing it. That source position/orientation lock is now removed.
A general hard `side: {bottom: ['@board.eol']}` constraint preserves the required
side while allowing XY/cardinal orientation exploration. Unlike `side_pref`, it
is enforced: physical pad mirroring occurs before geometry calculations and
hard-side violations are rejected. No netlist, pad dimensions, source electrical
policy, LED layout templates, RF keepouts or frozen inputs were changed.

## Enable in the actual fresh Mini source pipeline

The actual `splanc_mini.fab` Bazel target calls `pnr.route --detail-loop`, which
uses this initial pool through `route_and_place`. The historical standalone
`place_splanc_mini.py` adapter is not that target's entry; it has merely been kept
compatible with the new hard-side rule. **The pool remains opt-in.** Use explicit
action environment values so a future build does not silently return to the
first-legal strategy:

```sh
bazel build //hardware/splanc_dev:splanc_mini.fab.board \
  --action_env=PNR_INITIAL_POOL=1 \
  --action_env=PNR_INITIAL_STARTS=8 \
  --action_env=PNR_INITIAL_FINALISTS=3 \
  --action_env=PNR_INITIAL_PROXY_BUDGET=8 \
  --action_env=PNR_INITIAL_PROXY_PITCH=2 \
  --action_env=PNR_INITIAL_PROXY_PASSES=2
```

Do not execute this against a running production build; capture/verify the full
input freeze and use the round-trip workflow. This command was documented, not
run here. A direct source CLI also accepts `--initial-pool --initial-starts 8
--initial-finalists 3 --initial-proxy-budget 8` with `--detail-loop`. Existing
`--iters`, `--route-pitch`, `--route-iters` apply equally to each finalist. The
chosen finalist's route is reused, not given an unreported second routing budget.

Diagnostics are written under `$PNR_ROUND_DIAGNOSTICS/initial-pool/`: original
starts, each legal placed graph, complete cost reports, finalists/routes, source
preservation failures, budget/elapsed times, explicit selection and pose diversity.
Programmatic `select_initial_placement(..., proxy_only=True)` routes no finalists;
it returns a recommendation with `selected=null`, never an accepted PCB.

## Mini placement-only evidence

All runs below use the preserved fresh-28 **atopile source board**, newly ingested
with current native geometry metadata (137 parts, 574 pads, 93 nets). This is not
a routed checkpoint or a new atopile build. Current source current/pair/plane
annotations and fabrication policy were compiled. Each probe used seed 0, eight
starts, 350 optimizer iterations per global attempt, 2 mm proxy cells, two coarse
passes, no detailed routing and no native DRC. Exact inputs/hashes are recorded in
each output's `provenance.json`; old results were preserved. No full116 process or
protected board was changed.

| Probe | Legal starts | Hard-fixed parts | Recommendation | Coarse unreachable | Overflow |
| --- | ---: | ---: | --- | ---: | ---: |
| Original restricted source | 4/8 | 55 | start-06, TP1 `(45,13.5)` | 7 | 34.12 |
| Released source, random/stratified only | 3/8 | 54 | start-00, TP1 `(33.75,31.25)` | 8 | 40.68 |
| Released source, informed basin retained | 4/8 | 54 | start-02, TP1 `(17.25,32)` | 8 | 34.50 |

The last probe took 33.7 seconds and its under-radio candidate is 0°/bottom. It
reduces overflow 15.2% against its released-input start-00, with unchanged coarse
unreachable count. The earlier restricted best still scores better overall. This
is evidence that the search can now retain the intended alternative, not proof of
better native routing. Four other starts failed hard capacitor-group legalization;
the report keeps those failures. Maximum normalized movable pose distance is
0.311. All 54 remaining hard-fixed parts and the full source geometry passed
checks in every accepted legal candidate.

Outputs (relative to repository):
- `output/initial-pool118-splanc/` — original restricted source.
- `output/initial-pool118-splanc-released/` — released, uninformed comparison.
- `output/initial-pool118-splanc-informed/` — preserved intermediate failure: global
  under-body attempt was lost in an unrelated capacitor group.
- `output/initial-pool118-splanc-final/` — final informed/bounded-fallback probe.

Each presented probe has `pool/report.json`, `initial-placement-contact.png`, and
individual legal-candidate PNGs under `placement-images/`. Their actual contact
images were inspected; `visual-review.json` records observations and image hashes.
Combined-side placement diagrams show the bottom pogo in magenta; graphical
superposition with a top footprint is not a copper or interference certificate.
No routed copper is shown, so these images do not replace all-layer PCB PDF review.
Regenerate with the document/Pillow Python runtime and `render_placements.py ROOT...`.

## Verification

67 tests passed after the final changes: 12 initial-pool tests, 23 source-constraint
tests and 32 existing two-sided geometry/relocation/elastic/feedback tests. Tests
cover deterministic global diversity, hard side and pad mirroring, conflicting
side-rule rejection, native lock preservation, bounded informed basins and
through-body rejection, truthful fallback, routing outvoting the proxy, equal
finalist budgets, cached winner reuse, source-pad rejection and zero routing in
proxy-only mode. Log: `output/initial-pool118-splanc-final/unit-tests.log`.

The parent separately ran native small-board A/B before the hard-side/informed-basin
extension. Both final native results passed zero opens/violations plus width/pad
entry gates: inverter-8 improved 7→4 vias and 90.91→72.93 mm; four-layer-20 improved
28→26 vias and 312.31→274.30 mm. Those source freezes and PDFs are separate evidence
under `output/pnr-regression118/initial-pool-native` and must not be described as a
full Mini run or a native test of this final source revision.
