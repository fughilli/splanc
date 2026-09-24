# Board-wide same-net via scan and cleanup

Best board: `work/mini-routing/keyhole-via-53/candidate.kicad_pcb` in the transfer root, with matching project and footprint table. SHA256 `0051ece85119ba27a1f78afa81c8bec07d5aca7ceb2478d252d2eb0a50c88025`.

Scanner: `hardware/tools/scan_via_proximity.py BOARD --radius-mm 2 --out-dir NEW_DIRECTORY`, run using native KiCad Python. Enumerates every same-net pair within the radius (inclusive), including via-to-plated-pad neighbors but excluding pure footprint-hole pairs. Distances are center-to-center. Transitive clusters can span more than the radius. JSON includes UUIDs, coordinates, all pair distances, native per-layer track/pad contacts, and source SHA. Per-cluster SVGs show four copper layers; filled zones are explicitly omitted.

The full inventory and all 35 visual assessments are in [REVIEW.md](artifacts/via-proximity-01/REVIEW.md). All four non-ground cluster images were reviewed on all four copper layers. Ground clusters were reviewed in eight F.Cu contact sheets, checked against native per-layer contacts, then the final native copper PDF pages were individually reviewed. Proximity is a diagnostic, not proof of redundancy.

| Metric | Before | Accepted result |
|---|---:|---:|
| PCB vias, all nets | 322 | 300 |
| lv PCB vias | 161 | 139 |
| Nearby pairs (2 mm) | 151 | 113 |
| Proximity clusters | 35 | 24 |
| Native opens | 53 | 53 |
| Dangling tracks / vias | 11 / 1 | 11 / 1 |
| Other DRC violations | 0 | 0 |

Removed 21 duplicate leaf branches at C1, C3, C6, C11, C12, C15, C37, C40, C45, C49, C50, C52, C53, C58, LED1, R4, R5, R7, R11, R22 and R29. Also removed U19's router via at (46.6202, 69.8962) overlapping its exposed ground pad, retaining its F.Cu track and all four drilled footprint pad-39 holes. U19's external pad-26 return remains. The remaining ground-hole count around U19 is therefore four footprint holes plus one external router via.

Kept independent local pad returns, genuine F/In2/B transitions, and power/thermal/ESD candidates whose capacity cannot be established by connectivity. C56/C64, D1, Q2 and U6 deserve a separate return-current/thermal review; they are not certified necessary merely because this cleanup retained them. MIC1's divided annular pad access also remains. The scan exposed misleading nearest-pad labels at C55/C57, C26/C35 and R19; cleanup uses native contacts rather than those labels.

PnR changes:
- `consolidate_ground.py --reviewed-scan` consumes explicit reviewed cluster actions, verifies the board SHA, retains shared pad access and rejects real inner/back track ports. It now recognizes shared vias overlapping surface pads, which previously hid C49's redundant branch.
- Exposed-pad via-only cleanup is distinct from deleting a via+track leaf: the original track and footprint holes survive, with native pad-connectivity/DRC checks.
- `keyhole_loop.py --reviewed-via-scan` integrates this stage before detailed routing. A separate gate accepts fewer vias at equal opens; routing success still requires fewer opens.
- Existing writeback prevention reuses connected through access and checked same-package surface ground before creating new fanouts. Added a native thermal-pad regression for the U19 failure pattern.
- The persistent round-trip workflow now requires a proximity scan and assessment of new/changed clusters, in addition to all-layer PDF review.

Validation: scanner radius/net/thermal-hole regression passes; four native plane/fanout tests pass; repair-loop integration reproduces all 22 removals; repeat cleanup removes zero. Native pad partition preserves all original manual22 connections. Structural audit retains all 141 footprints/578 pads, all previous pad geometry (only historical U18 translation), 2,034 protected copper items, project rules and board drawings. Final saved board independently DRC-checked.

Artifacts: `via-consolidation-04` accepted source; `via-loop-control-02` integration replay; `via-repeat-control-01` idempotence control; `via-proximity-02/scan.json` fresh residual inventory with inherited assessments separately mapped in `residual-assessments.json`. Residual diagnostic images are not falsely marked as individually re-reviewed. The final native PDF is `output/pdf/mini-round-20260911-06/all-layers.pdf`, 31 pages, all actually inspected and ledger-verified.

Remaining: 53 native opens, dangling copper, dense U18/U19 escapes and long In2 corridors. General placer feedback and native keyhole failures still require full integration; this cleanup does not close that architectural gap or constitute electrical/manufacturing signoff. No publication or merge.
