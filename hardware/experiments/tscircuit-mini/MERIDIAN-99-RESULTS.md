# Positive-cell meridian expansion

User explicitly authorized growing the arbitrary outline and moving all component
centres to test whether unconstrained space expansion helps routing. Current best
full28 remains untouched. This is a separate mechanical experiment.

`pnr.place.meridian.expand` implements the requested operator directly. For every
positive feedback cell at (cx,cy), add step*sign(x-cx) to X and step*sign(y-cy) to Y
for every component. Apply all cuts simultaneously using the old coordinates.
Rebase the lower-left corner by N*step in each axis; width and height each grow by
2*N*step. Values exactly on a meridian get zero signed motion for that meridian.
Footprints, pads, rotations and sides stay rigid. Mount centres receive the same
field; relative copper keepouts follow parent footprints. Old native pair-path
witnesses are discarded because traces must be regenerated.

Experiment starts at the fresh29 first source placement and cached signal-routing
result, including corrected pad rotations and physical pad/silk extents. Four
cycles total, three expansions, 0.025mm per side per positive cell, 12 detailed
router passes each reroute. No score-magnitude weighting or overall growth cap.
Fresh-cycle feedback replaces the old map; stale coordinates are not accumulated.
Electrical widths, clearances, via/source-array rules are unchanged. Specialized
15 power/USB nets remain deferred in this signal-stage experiment. This does not
establish end-to-end completeness or electrical/layout qualification.

Scripts: meridian99/run.py and review_watch.py. Runtime wrapper is
/private/tmp/pnr-runtime.py. Outputs:
output/fresh-pnr-20260919/meridian99/expansion/round-NN.
Per round: placed/routes/rules/source, pressure events, congestion SVG/JSON, native
writeback/source arrays/refill/DRC, 5mm via scan. Layer PDFs exported concurrently
to output/pdf/mini-meridian99-20260921/round-NN/all-layers.pdf; cycle report updates
atomically at mesh-comparison.pdf. Review ledgers stay pending until actual image
inspection. Previous and new outlines are centred together in motion maps so
origin rebasing does not hide westward/southward displacements.

Four deformation regression cases pass under the supported PnR runtime and Bazel
meridian_test. Covers exact signed step and outline growth, midpoint handling,
locked-centre participation, binary weighting/superposition, no-feedback identity,
partial edge cells, input nonmutation and invalid score rejection.

## Completed four-cycle experiment

| Cycle | Outline mm | Area change | Missing signal connections | Native opens | DRC violations | Surface escape score |
|---|---|---|---|---|---|---|
| 1 cached | 70 x 55 | 0% | 55 | 208 | 0 | 101.00 |
| 2 | 73.8 x 58.8 | +12.71% | 48 | 199 | 0 | 71.92 |
| 3 | 76.75 x 61.75 | +23.10% | 51 | 202 | 0 | 56.31 |
| 4 | 79.65 x 64.65 | +33.75% | 42 | 188 | 0 | 44.21 |

Three expansions moved all 137 component centres in the signed pre-rebase frame.
Maximum per-cycle movement was 2.687, 2.086, 2.051 mm. The respective maps had
76, 59, 58 active input cells. Cycle4 output still has58 positive feedback cells.
The loop stopped at its four-cycle experiment budget, not convergence.
Signal reroutes took281.79,185.84,317.00seconds. The cached baseline elapsed
field is copying time, not original routing time.

Signal deficits fell23.6%; native opens fell9.6%; area grew33.75%. Cycle3
regressed despite lower surface shortage: that proxy does not predict exact
route success. Paths are rerouted from scratch, with grid alignment and route
order sensitivity. Footprint-internal pin pitch is unchanged by expansion.
Failure events remain predominantly obstructed corridors; the diagnostic
categories do not prove whether the underlying cause is escape, route choice,
or true capacity. Do not label every such failure placement congestion.

The generic deformation module is exercised by a separate driver calling the
existing detailed router and native pipeline stages. It is not yet wired into
the full production source controller, and the 15 deferred electrical nets
are not covered by the signal gain. Next: continue controlled expansions,
retain the best candidate while exploring, and include the specialized
power/USB pass in a fresh source-to-board validation before promotion.

Native boards and matching projects/table, DRC reports and per-cycle rules
are in the round directories listed above. analysis.json records exact board
hashes and metrics. All147 captured runtime Python hashes stayed unchanged
against the supplemental AFTER-launch manifest; this is not a pre-run freeze.
Executed temporary adapters/runtime wrapper and test/build logs are archived
under meridian99/executed-tools for provenance. No additional full source build
was started during this experiment.

Prior full29 finished and was archived before this experiment:113 native opens,
1silk-edge violation; completion gate failed. All586 frozen inputs verified
unchanged. Its shorter search budgets prevent a direct comparison with full28.
Best full28 remains48opens/0violations, untouched and not replaced by these
early signal-stage diagnostic boards.

## Visual review

All nine final comparison PDF pages actually viewed. Expansion clearly separates
U18/U19 and the right-hand circuitry, including formerly fixed centres. The left
surface-shortage heatmap fades, while router feedback remains near U5/U19,
sensors and buttons. Same color scales; figures fit to page and are not at one
physical print scale. Purple dots are prior centres; labeled dark dots are new
centres, with lines joining them in centred frames.

Round1-4 all62pages actually reviewed: eight copper pages individually, all54
technical pages via five contacts, dense U18/U19 annotation crop each. Ground
plane antenna/mount voids follow new poses, pogo footprint stays rigid. Long
In2/B diagonal routes and short endpoint jogs persist. Sparse courtyards and
large native fabrication graphics are not proof of assembly clearance. The
partial power routing is visually obvious. All four review ledgers complete. Round4 In1.Cu has a strip of copper above the antenna void after growth; this is an RF/mechanical consequence to revisit before qualification.

Five-mm scans:143/135/142/145vias,205/159/142/132pairs,15/18/20/25clusters.
Round1-4 cluster contact images actually viewed. Short FB1 inner excursions and
cycle3 MIC1 two-via bridge are future same-layer/coalescing candidates, not
proven necessary just because they have layer ports. Source arrays and separate
plane stubs remain. These early outputs have not run final coalescing or strict
pad-entry/electrical qualification; no proximity-only deletions.

Concrete geometry check: U18/U19 centre deltas changed from6.0x3.5mm to6.95x5.525mm; U10/U12 horizontal centre separation6.0->7.3mm. These are centre distances, not free copper channel widths.
