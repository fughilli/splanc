# Plane-access consolidation, 2026-09-14

Accepted board: transfer-root/work/mini-routing/keyhole-access-53/candidate.kicad_pcb
SHA256 f4c4c2e1ee4fef3ea91722222f288e148bef9bcf90928e9bde8cd06cdce1b160.
Native KiCad 10: 53 opens, 11 dangling tracks, one dangling via, zero other
violations. Original manual22 pad connectivity and structural checks pass.
300 -> 273 PCB vias; lv 139 -> 112. This is geometry improvement, not routing closure.

| Original reviewed group | Before | After |
|---|---:|---:|
| U18/C28 | 7 | 2, now separate surface groups |
| U6 | 7 | 0; 12 footprint holes retained |
| D1.1/2 + C56/C63 | 6 | 2 local capacitor accesses |
| Q2.1/2/3 | 6 | 3 in compact array |
| D1.3/7 | 3 | 1 |
| C16, C25, C57, C64, R19, U7 | 2 each | 1 each |

## Generalization

`pnr.plane_intent` parses explicit JSON annotations in atopile source, resolves
instance addresses to PCB refs/nets, and records source hash/line provenance.
This is a PnR comment extension, not native atopile compiler trait support.
Mini's source annotates converter.low_fet terminals with 5 A RMS / 16 A peak.
These are author-specified design envelopes, not automatically solved currents.
The algorithm contains no Q2 reference or Mini current constant.

Via count comes from explicit fabrication plating/thickness/resistivity and
per-barrel loss/array voltage-drop budgets in mini-plane-access-fab.json.
Current values yield three 0.3 mm drill / 0.6 mm diameter vias, 0.8 mm pitch,
with a 1.5 mm common bus. The loss/drop model is engineering screening, not
thermal qualification. Fabrication/current assumptions need validation before
manufacture. Unsupported geometries fail rather than silently applying this
row-array strategy: currently cardinal F.Cu rows with no external layer ports.

The Bazel PnR action now applies generated power-array intent after writeback
and before a separate native plane-fill process. Native mutation/fill in the
same Python process proved unreliable; persisted reload/fill was validated.
Bazel target query passes; a full fresh Bazel PnR build was not run this round.

Reviewed legacy cleanup is a separate native-gated hill climber:
`hardware/tools/optimize_plane_access.py` (run from repository root), using a
source-hash-bound inventory and explicit review policy. The trial worker checks
original pad connectivity; external native DRC gates each removal and newly
created dangling-track pruning. Its review policy is not automatically inferred
from source currents, nor is this whole cleanup yet a default fresh-PnR stage.
Existing fanout reuse and generated arrays prevent the tested duplicate cases.

## Validation and artifacts

Eight regression tests passed across test_plane_access_intent.py,
test_power_array.py and test_plane_refill.py: renamed designator resolution,
current scaling, missing data rejection, thermal access reuse, obstructed reuse,
and repeated generation/fill without duplicate fanout. Reapplying production
array CLI to the full accepted board gives identical copper geometry and 273
vias (`artifacts/array-cli-repeat/regression.json`).

Hill-climb evidence: artifacts/access-hillclimb-03/result.json (24 removals).
Array evidence: artifacts/current-array-10/ (six old vias replaced by three).
Fresh 5 mm scan: artifacts/access-after-scan5/scan.json, 213 pairs / 27 clusters.
Remaining >=2-via surface groups are the two intentional D1/cap and Q2 groups;
focused four-layer images under output/plane-access-20260914-after were viewed.

All 31 enabled layers: output/pdf/mini-round-20260914-01/all-layers.pdf.
Copper pages individually viewed; remaining pages reviewed in contact sheets.
review.json complete and verifier passes. Dense lower-left USB/PD escapes,
long In2 corridors, broad In1 plane and back pogo mask/no-paste pattern remain.
Next: use freed space for remaining 53 opens and extend annotated access policy
beyond power arrays, retaining local-return/thermal intent and native gates.
