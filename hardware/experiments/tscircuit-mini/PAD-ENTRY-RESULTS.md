# PnR minimum-width pad entry, 2026-09-14

New best: transfer-root/work/mini-routing/keyhole-pad-entry-53/candidate.kicad_pcb
SHA256 55058c30f8df443b0ce922728a579d04a8109d5fcd81738b2137cec5ae20df87.
Matching project and footprint table saved. Native KiCad 10.0.6 DRC on exact
saved board: 53 opens, 11 dangling tracks, one dangling via, no other violations.

## Algorithm change

`pnr.pad_entry` is a generic native PnR pad-entry completion/validation stage.
It never tests a reference designator. For rectangular, rounded-rectangular,
circular and oval pads touching straight tracks, it requires a disk of the
required diameter to fit in both pad copper and trace copper. Analytic signed
distance handles rounded pad edges; a broad bus can qualify without a pad-center
endpoint. A mere zero-clearance shape intersection does not qualify.

Requirement comes from the fabrication minimum and resolved net-class widths
(the existing constraints compiler derives current-dependent widths upstream).
There is no U18 current or pad-width exception in the algorithm. Short branches
run from pad center to the nearest touching trace centerline, at required width,
with foreign copper and rule-area collision checks. Native DRC remains required
for full board-edge, hole, zone and clearance validation.

PnR Bazel action invokes this after plane fanout, saves a pad-entry JSON report,
fails strict validation on unresolved findings, and refills zones in a fresh
process with `pnr.planes --refill-only` so no new fanouts follow the check.
Reviewed consolidation workers now reject loss of previously valid pad entries.
The reviewed hill-climb CLI now requires --rules; legacy leaf cleanup uses a
conservative 0.2 mm geometric entry guard (not full power qualification).

## Actual checkpoint run

Ran the generic CLI over the entire previous best with the existing Mini rules.
No --ref filter or hand-edited route geometry. Seven 0.2 mm lv branches added:
U18.1/.17/.18/.19, C56.2, SW1.4, D1.7. The U18 branches fix the reported grazing
contacts. Some additions inside broad pads improve explicit entry construction
without materially changing the copper union; seven branches is not seven opens.
No original copper removed or changed, no vias added (273 total).

Native before/after audit: every pad geometry and every preexisting track/via
unchanged, all original pad connectivity preserved. Repeat algorithm pass adds
zero tracks. Validation JSON and per-pad entries are beside the checkpoint and
under artifacts/pad-entry-02/. 5 mm scan: 213 pairs, 27 clusters, unchanged.

Six new native tests pass: actual U18.18 diagonal and .19 edge overlap, robust
bus entry without center endpoint, wide bus whose centerline lies outside pad,
resolved width too large to repair, and foreign-copper obstruction. The U18.19
case also checks repeatability and detecting loss after deleting its good branch.
Four existing native plane-refill tests pass. Bazel target query passes; full
fresh PnR build was not run and would currently fail the strict new gate.

## Explicit limits / next work

88 findings remain: 80 nominal width exceeds trace/pad, 8 button-pad geometries
blocked/unsupported. They are conservative findings, not 88 proven physical
failures. Net-wide routing width is not automatically a per-terminal neck
specification. Need source-derived per-terminal current/neck constraints rather
than blanket exemptions or narrowing to pad width. Custom pads, track arcs and
zone-only/plated-pad entries need additional witnesses; this pass does not
certify them. The disk witness proves local entry width, not end-to-end current
capacity or every bottleneck elsewhere on a net.

PDF output/pdf/mini-round-20260914-02/all-layers.pdf: all 31 enabled pages viewed
(copper individually; technical pages in contact sheets). Enlarged U18 F.Cu PDF
crop and 5 mm scan clusters 019/020/021 reviewed. New pad entries visible; broad
In1 plane, long In2 corridors, dense PD escapes, back pogo mask/no-paste pattern
and crowded front fabrication labels retained. Review ledger verifier passes.
