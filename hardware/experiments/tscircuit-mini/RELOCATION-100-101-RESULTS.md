# Constrained global relocation — 2026-09-21

Implemented opt-in `PNR_PLACEMENT_MODE=relocate` in the source feedback controller.
`pnr/place/relocate.py` searches board-wide legal translations, shortlists by
pin air-wire length plus spatial diversity, then ranks by a multi-layer distance
field using previous routing. Fixed/locked parts and hard relative constraints
remain enforced; side and rotation are preserved. The experiment releases only
`@board.eol` XY in a separate constraints file. Production Mini constraints remain
unchanged. The controller reroutes each proposal and retains the best completed
routing round separately from exploration.

Legal layer changes cost 3 mm equivalent per via; foreign copper costs an extra
100/mm. Via apertures must clear all crossed layers. This is a placement estimate
of potential rip-up difficulty, not permission to route shorts. Coarse 0.8 mm
fields and approximate terminal access can misrank candidates.

| Round | Whole-board relocation | Missing signal connections | Native opens | Native violations |
|---|---|---:|---:|---:|
| 1 | Cached fresh29 baseline | 55 | 208 | 0 |
| 2 | TP1 (45,13.5) → (49,27), 14.08 mm | 49 | 200 | 0 |
| 3 | D2 (16.25,23.25) → (9,11), 14.23 mm | 49 | 200 | 0 |

Each new candidate received 12 detailed-router passes. Round 3 did not improve
connectivity. Escape-channel proxy worsened 101.00 → 101.20 → 103.90 despite the
native improvement; it is not the selection acceptance metric.

An occupancy bug incorrectly reserved the entire radio body on both sides because
it contains thermal plated holes. Ingestion now preserves the native explicit SMD
body attribute. Placement reserves that body on its mounted side and individual
hole pads on the opposite side. Ordinary through-hole bodies remain conservative.
Legalizer and final overlap/translation checks honor these reservations.

Relocate101 reran the pogo search with this correction and exhaustive candidate
scoring. Several under-radio positions are legal: (17,33), (23,33), (11,33).
Their estimated costs are 1090.25, 1041.12, 1124.40 versus 764.96 at (49,27).
Positions on thermal holes remain illegal. The selected position and detailed
routes exactly match relocate100 rounds 1/2; native artifacts/PDFs were reused
only after geometry/rules/routes parity checks, recorded in
`output/fresh-pnr-20260919/relocate101/native-artifact-reuse.json`.
This does not prove globally optimal placement or jointly optimize the mating board.

Five targeted Bazel targets pass (relocate, two-sided placement, graph, elastic,
local feedback); 11 native ingest tests pass. Coverage includes legal versus
blocked layer escape, whole-board movement, fixed/relative constraints, SMD hole
reservations, and controller rerouting/best retention. Both experiment source
snapshots were frozen before launch and verified unchanged after completion.

Artifacts: `output/fresh-pnr-20260919/relocate100/relocation/round-01` through
`round-03`, including exact native board/project, DRC and scan. Aggregate counts
and hashes in `relocate100/analysis.json`; logs archived in `relocate100/logs`.
All three 62-page PDFs in `output/pdf/mini-relocate100-20260921/round-NN` were
actually reviewed (copper individually, technical contacts), with verified review
ledgers. All 15/9/10 via clusters and seven comparison pages were inspected.
The viewer `output/pnr-viewer/relocate100.html` contains all three rounds.

Visually the pogo moves north/right and releases its former area; long diagonals,
dense U18/U19 escapes, FB1 inner excursion and unfinished power/USB access persist.
These are early-stage diagnostics, not final electrical outputs. No new full
source-to-final build was run. Next: validate relocation through specialized
power/USB, coalescing, pad-entry and native completion gates in a fresh source run;
consider coordinated relative-group and mating-board placement search.
The protected fresh-28-final board remains the best final checkpoint (48 native
opens, zero violations); neither experiment is promoted or manufacture-qualified.
