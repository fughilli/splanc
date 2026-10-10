# Hierarchical placement-capacity experiment 115

Implementation: `pnr/place/capacity_proxy.py`; opt-in integration in
`pnr/place/batch_relocate.py`. No native board changes in this experiment.
Protected best remains fresh-28-final (48 opens, zero violations).

## Hierarchy

1. Existing hard placement checks reject illegal whole configurations.
2. Width-weighted rectangular net demand and per-surface terminal pressure screen
   legal placements cheaply. Preserve baseline, cheap candidates, spatial diversity
   and legal opportunities under sufficiently large opposite-side SMD bodies.
   No component reference or specific coordinate is special-cased in the model.
3. Evaluate a bounded pool with a 2 mm four-layer graph, 0.25 mm geometry raster
   and three shared-demand negotiation passes. Capacity comes from rasterized
   pad/keepout cut widths, cell occupancy and through-via column availability.
   Power widths and via counts use compiled source electrical policy; source
   arrays and mounting clearances are reserved. Differential pairs are combined
   corridors. Plane demand includes layer access, with declared planes as sinks.
   Same-net branches reuse resources; distinct nets compete for shared capacity.
4. The existing full electrical pipeline and native preservation checks remain
   the only acceptance gate. The proxy never accepts a PCB or replaces DRC.

Single-component alternatives are permitted and explicitly enumerated alongside
large randomly sampled batch spaces. Proxy annealing uses the score spread,
not its common absolute penalty, to avoid nearly uniform sampling from a large
shared unreachable-branch offset.

Enable on a NEW source-frozen runtime with `PNR_CAPACITY_PROXY=1` and optionally
`PNR_PROXY_BUDGET=12`. Include the changed batch module and capacity module in
that new runtime. Existing incremental112/pogo114 frozen runtimes were not edited.
The integration remains opt-in because coarse-grid uncertainty is material.

## Measured calibration

Inputs: overnight113 round01 candidate00 evaluated graph/rules. Benchmark scripts
read these immutable inputs, change only an in-memory TP1 position, and never
invoke native routing or write a board. Output JSON records input/code hashes,
per-pass scores, runtime, failure nets and heatmaps.

| Placement | Overflow units | Saturation | Seconds at 2 mm |
|---|---:|---:|---:|
| Incumbent (49,27) | 31.56 | 53.22 | 1.09 |
| Old estimator favorite (51,27) | 33.32 | 56.47 | 1.08 |
| Under radio (17.25,34) | 28.67 | 48.92 | 1.08 |
| Legal sampled site (17,33) | 30.25 | 52.56 | 1.09 |

The under-radio fixture has 9.1% lower overflow and 8.1% lower saturation than the
incumbent. It ranks first among seven fixed test positions. These percentages are
proxy changes, not native connectivity predictions. All seven have eight common
coarse unreachable branches at this resolution.

Historical replay: 302 legal positions -> 12 proxy evaluations in 14.33 seconds
(0.39 seconds screening); (17,33) ranks second in this pool, versus rank220/302
under the old estimator. These are different pool sizes, not an exhaustive new
ranking. The normal N=4 options become incumbent, old favorite, (17,33), (31,11).
The actual joint-selection integration picks (17,33) first. This is a meaningful
change in candidate selection, not validation of a completed reroute.

Sensitivity: under-radio scores better at 1.5, 2 and 3 mm, but slightly worse at
2.5 mm. At 2 mm it reports eight unreachable coarse branches; at the other tested
resolutions zero. Thus these are discretization-sensitive estimates, NOT a count
of real opens. Raw scores must only be compared within one resolution/model.
Use this model to guide a diverse shortlist, not prune every disfavored region.

The prior physical fixture reached57 native opens, five dangling warnings and a
failed connectivity-preservation guard. It has not been promoted. A matched-budget
baseline reroute and broader held-out designs are needed before claiming predictive
correlation with native success. No model coefficient was fitted to the 57 count.

## Inspection and tests

23 tests passed across test_capacity_proxy, test_batch_relocate and test_relocate.
Coverage includes shared-width contention, all-layer barriers, own-pad attachment,
source electrical widths, paired corridors, same-side/body handling, reproducibility,
bounded proxy work, generic underside opportunities and singleton selection.

Actually inspected the local fixed-scale comparison.png: front demand remains
concentrated around dense electronics; relocation releases the old TP1 region and
adds demand beneath U6. Inner/back corridors redistribute, with a busy inner-layer
corridor remaining. Plane image has no planar demand because declared plane access
terminates there; this does not demonstrate a qualified reference plane.

Interactive report: output/capacity115/index.html, also copied to the existing
mechanical viewer at /capacity115/. Includes layer switching, component overlays,
hover utilization, candidate scores and sensitivity/replay tables. Browser automation
could not verify its administrative security policy; interactive rendering was not
browser-tested. The underlying rendered heatmaps were inspected locally.

Known approximations: rectangular 2/4-layer boards only; same-cell terminal collapse;
short portal rays rather than qualified pad entry; conservative whole-net power widths;
no detailed terminal necks, reference/skew or exact manufacturing qualification;
no retained-track reuse model (all net demand reconstructed to avoid double counting).
Do not compare this score with old routing-failure counts or claim zero overflow
means a manufacturable/routable board.
