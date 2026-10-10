# Mesh98: localized feedback and refreshed channel relationships

The mesh now moves components collectively, but the routing proxy still does not
predict completed routing well enough. No candidate replaces full28 (48 native
opens, zero violations).

Implemented opt-in `PNR_LOCAL_PRESSURE=1`: reconstruct disconnected terminal
forests, probe obstructed planar corridors, and charge only their blockers or
unresolved endpoints. Weight each missing link by width plus clearance. This is
not a three-dimensional capacity model or a proof of a routing cut. Deferred
power/USB nets still require specialized routing and are excluded from this
signal pressure. Dynamic channel relationships refresh every 20 optimizer steps.

Three cycles with equal 12-iteration routing budgets, same starting placement and
corrected individual-pad rotations:

| Model | Estimated missing signals | Native opens | Native violations | Moved parts |
|---|---|---|---|---|
| Frozen relationships / broad boxes | 50,49,53 | 205,200,205 | 0,2,1 | 0,82,81 |
| Refreshed relationships / local probes | 50,55,53 | 205,204,204 | 0,0,1 | 0,82,82 |

All violations in this comparison are silkscreen. Native diagnostics include
source-derived power arrays and plane construction. These are early signal
boards, not fully electrically routed boards. Candidate channel score improves
92.67 -> 89.59 -> 85.83 mm2 while routing does not. Merely scaling that objective
harder is therefore not justified by this result.

The 13-page comparison PDF contains actual movement vectors and heatmaps for
all six cycles. Raw feedback units differ between the two models; the common
37-unit scale makes local probes pale. This is not evidence of less congestion.
Images show movement around U5 and U18/U19, while many fixed right-side anchors
remain stationary. The smooth mesh transfers movement but cannot release those
anchors. All pages were actually viewed; the final summary records these limits.

Sources were captured before launch in mesh98-baseline-source and
mesh98-candidate-source; all 57/58 module hashes verified unchanged afterwards.
The fixture candidate predates two later fixes: access-only via topology seeding
and pad/silkscreen extents beyond an undersized library courtyard. The latter
excludes large F.Fab drawings and text, reserves actual silk graphics and pads,
and has a native regression. These are in the fresh29 source run.

Six targeted Bazel tests pass; ten native ingest tests pass. Fresh29 uses a new
experimental source-to-native target with three placement cycles and a 600-second
native search budget, all final quality/completeness gates retained. Its 586
repository inputs were frozen before launch. Full29 first-round diagnostic has
55 estimated missing signals, 208 native opens and zero violations. Its diagnostic
rules are provisionally from full28 and must be compared with generated full29
rules after placement completes. Full29 remains active; do not edit its inputs.

Fresh 62-page best-board PDF reviewed across all layers and dense U18 crop;
unchanged SHA 81ed33e04e74336da39614733900f3a2e293d713f23717fb0a61642877f543d7.
Fresh 5mm scan: 307 vias,343 pairs,50 clusters, identical geometry to prior reviewed
scan. Source29 diagnostic export is separate and never labeled the best board.

Next: complete source29, preserve source verification and all stage diagnostics;
use native failure/blocker evidence to replace the still-poor channel objective.

Full29 source placement completed: 55,51,52 missing signals; 0,82,81 moved parts.
Native first two early rounds: 208/0 and 200/1, where the only violation is Q1's
silk circle exactly tangent to Edge.Cuts. Generated rule values match the
provisional full28 rules after excluding provenance paths and old routed-pair
witnesses (not consumed by early writeback/planes).

An isolated `mesh98-edge-source` proposal gives movable bodies a 0.01 mm inward
projection margin. In this fixture only Q1 moves 0.01 mm. Native diagnostic using
the same routes remains 200 opens and removes the silk warning: zero violations.
This is a geometry regression fixture, not a fresh routing improvement. The
boundary regression fails the live baseline and passes the isolated candidate;
actual imported module paths were printed. An initial test invocation accidentally
loaded the candidate for both runs because of script-directory precedence; that
comparison was discarded and rerun with `python -c`/runpy and verified imports.
Do not integrate while full29 is active. Still needs source integration/full rerun.

Source29 first-round PDF: all62pages actually viewed (8 copper individually,
54 technical in five contacts), plus dense U18 crop. Thin/incomplete signal routes,
long inner diagonals, intact pogo/outline geometry. Native208/0. Via scan143vias,
205pairs,15clusters; all15 images actually viewed. Signal inner-layer excursions
and separate ground stubs remain before normal consolidation. These early-stage
counts are not comparable to full28 after electrical routing and cleanup.

Fixed-pair audit of actual resolved mesh anchors: 55 fixed refs. In full29 cycles
2 and 3, 70.2603 mm2 of channel score is entirely between fixed parts: 68.5% and
71.5% of totals. The current congestion JSON's both_fixed fields do not reflect
the resolved mesh anchor set; audit uses event.fixed_refs instead. Save artifact:
output/fresh-pnr-20260919/mesh98-fixed-channel-audit.json. Many anchors originate
in fixed/layout_array templates for internal circuitry. Distinguish seed placement
preferences from mechanical/electrical hard constraints before increasing forces;
do not move connectors, pogo, mounts or electrically constrained power groups
without preserving their actual requirements.
