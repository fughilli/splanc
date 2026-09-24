# Coordinated placement experiment 97

The mesh successfully moves groups of components, but this prototype did not
establish a native routing improvement. Keep it opt-in (`PNR_PLACEMENT_MODE=elastic`).
The validated best board remains full28: 48 native opens, zero violations.

## Implementation

`pnr.place.elastic` represents displacement using a bilinear 6 mm lattice. All
movable centers receive interpolated displacement; fixed and locked references
remain anchored. Facing-pad channel deficits weighted by accumulated routing
feedback drive a smooth deformation. Courtyard, boundary, keepout and hard group
penalties constrain the optimizer. A collective collision projection repairs the
proposal without globally repacking parts. Actual post-projection displacements,
mesh nodes, failed legalization attempts and channel scores are recorded.

The opt-in source feedback controller accumulates pressure relative to the first
round's scale (not each round's peak), escalates strength by 1.5 after a stalled
round, explores temporary regressions and retains the best routed candidate
separately. It does not modify existing routed copper. Every proposal is rerouted.
The native controller remains unchanged; this is an early-placement prototype.

`pnr.place.growth.propose_growth` proposes 5% growth after less than 5% improvement
across two subsequent rounds, capped at 10%. It is opt-in and exercised only in a
separate mechanical diagnostic. It is not wired to resize the production board.

## Controlled experiment

Outputs: `output/fresh-pnr-20260919/mesh97-comparison`.
Common fixture: full28 source round01 placement and compiled electrical rules.
Each reroute uses 12 detailed-router iterations. Both variants use sequential
exploration with their best score retained. Local control uses the existing
single-component feedback proposal; it is not a full replay of every production
fallback. These are estimated missing **signal grid connections**, not native opens.
Fifteen specialized electrical nets remain deferred to native routing.

| Cycle | Single-component control | Mesh | Mesh moved parts | Mesh max move |
|---|---:|---:|---:|---:|
| 1 | 50 | 50 | 0 | 0 |
| 2 | 57 | 48 | 81 | 1.060 mm |
| 3 | 56 | 56 | 81 | 0.843 mm |
| 4 | 51 | 57 | 80 | 1.272 mm |

The separate growth branch from mesh cycle3 uses 73.5 x 57.75 mm instead of
70 x 55 mm. It moved 82 components and finished at 57, matching fixed-outline
cycle4. Uniform center scaling failed hard-group legality; preserving original
centers before mesh deformation produced a legal diagnostic placement. Anchor
positions stayed fixed; enclosure/mount-to-edge compatibility is NOT qualified.

Mesh channel scores: 90.94 -> 101.78 -> 97.19 -> 98.83 mm2.
Control: 90.94 -> 90.04 -> 89.38 -> 88.41. Growth: 103.16.
The proxy and routing outcome do not vary monotonically together.

## Native validation and pad-model defect

Baseline early-stage writeback + source arrays + refill: 204 opens / 0 violations.
Original mesh cycle2: 204 opens / seven clearance violations / two silk overlaps.
Local cycle2: 210 opens / 0 violations. No candidate was promoted.

All seven mesh copper violations occur beside U18. Native inspection demonstrated
that individual pad rotations were discarded during ingestion: U18 has 0.2 x
0.8 mm lands with perpendicular local orientations. GetSize reports pad-local
axes; subtracting footprint orientation from pad orientation is necessary before
constructing the footprint-local envelope. Ingestion now applies this rotation
(conservative AABB for non-cardinal angles). Thirty-one pad extents in this board
change under the corrected model. Native regression fails baseline and passes
the fix at all four cardinal footprint rotations. All nine native ingestion tests
pass; six targeted Bazel targets pass, including the mesh controller test.

Corrected geometry reroutes use identical component poses and isolated sources;
see corrected-baseline and corrected-mesh folders for their results and native
DRC. They must not be compared as though the original 50/48 counts used the same
geometry model. The corrected mesh removes all seven copper-clearance findings;
two silk overlaps remain, so it is still not an accepted PCB. Corrected baseline: 50 grid missing / 205 native opens / zero violations. Corrected mesh: 51 grid missing / 204 native opens / two silk overlaps. The one-open native reduction does not satisfy the acceptance gate.

## Visual findings and next hypothesis

The 19-page mesh comparison PDF shows each cycle's deformation and heatmap.
Actual PDF pages were inspected. Coordinated movement is visible near U5/Q1,
U18/U19 and neighboring passives. Fixed mechanical and connector anchors remain
in place. Right-side groups have many fixed anchors, limiting deformation.
The routing-feedback field covers much of the central board: unresolved-net
bounding-box fallback dominates localized failure sites. The original 10-unit
color scale saturated; the report now uses one shared absolute 37-unit scale for
all cycles. No per-cycle normalization hides changes.

Next, replace broad net-box feedback with directional blocking/cut evidence and
width-aware demand versus usable layer capacity. Refresh interacting channel
pairs as deformation evolves; the current frozen-pair objective can create new
shortages absent from its initial pair set. Integrate native geometry/clearance
checks into candidate evaluation before expensive downstream routing. A full
fresh source-to-final-board comparison is still required before selecting this
prototype; these bounded fixture runs are not end-to-end validation.

## Artifacts and preservation

`output/pdf/mini-mesh97-comparison-20260921/mesh-comparison.pdf`.
`output/pdf/mini-mesh97-best-20260921/all-layers.pdf`: fresh export of unchanged
full28, all 62 pages actually reviewed; ledger verifier passes. The dense U18/USB
crop retains one U18.10 via and no former diamond. Front/back power detours and
long In2 diagonals remain. Fresh 5 mm scan: 307 vias, 343 pairs, 50 clusters;
all cluster geometries exactly match the already visually reviewed full28 scan.

The original experiment runtime modules stayed unchanged through local/mesh/growth
runs. The source manifest was captured after launch and is supplemental evidence,
not a pre-run freeze. Test-only changes are recorded in source-verification.json.
The isolated ingestion fix was integrated only after those runs completed.
Reproduction scripts are retained in `mesh97/`; no original board is overwritten.
