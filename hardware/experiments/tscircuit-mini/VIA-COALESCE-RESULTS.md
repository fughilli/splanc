# Multi-layer via reuse, 2026-09-15

Best checkpoint: transfer-root/work/mini-routing/keyhole-via-coalesce-53/candidate.kicad_pcb
and matching .kicad_pro/fp-lib-table. Previous checkpoint and manual22 untouched.

## Generic PnR change

`pnr.via_coalesce` runs after routing/plane fanout and before strict pad-entry
validation in pnr.bzl. It emits a .via-coalesce.json report. This is a native
post-routing optimization stage, not new placement-feedback scoring.

Same-net through-vias within 1.5 mm (configurable) are candidates only when an
existing same-layer copper path already joins them. A surviving barrel can serve
separate F.Cu, inner-layer and B.Cu branches. Branch endpoints stay fixed; the
pass adds cardinal/45-degree bridges at least as wide as each affected branch.
It can shorten a tail when the survivor lies on its centerline, provided no pad
or branch occupies the discarded tail. Newly dangling straight tails on the
edited net can be pruned; preexisting dangling items are excluded from pruning.
Candidates are refreshed after each acceptance, exposing further shared ports.

Source annotations resolve by atopile instance address, independent of reference
names. Nets with power-array, thermal-reuse or local-return annotations are
conservatively excluded. Plane nets, wider-than-minimum power/logic classes,
differential pairs and length-match groups are also excluded. Locked copper,
blind/microvias and smaller survivor barrels/pads are rejected. Thus this
complements existing plane-access cleanup rather than replacing its policies.
No special U18, FB or Q2 references occur in the implementation.

Each proposal runs in a saved isolated transaction. A fresh native process fills
zones, checks the original connected-pad partition and qualified pad entries;
KiCad DRC then requires no new non-dangling violation identities, no increase in
opens or dangling counts. Rejected candidates never replace the current board.
The source and fabrication/current annotations remain the authority for arrays.

## Actual board outcome

273 -> 271 vias; 53 -> 53 native opens. 11 dangling tracks, one dangling via and
zero other native violations remain. The three added trace segments and eight
removed items (two vias, six dead track tails) affect only board.pd-1 and FB.
Every pad/footprint geometry, every other net's copper (including USB and Q2's
current-sized array), and all prior pad connectivity/qualified entries are
unchanged. A repeated whole-board pass removes zero vias and is byte-identical.

- U18.10: retain via (48.5,68.2); remove (48.0,67.7). One 0.2 mm In2.Cu bridge
  carries the C59 branch to the same barrel used by the B.Cu branch. F.Cu access
  is retained. Attempts to merge C59's via too are blocked on F.Cu and rejected.
- FB around U3/R15/R16: one via removed, two 0.2 mm F.Cu bridge segments added,
  six newly dangling B.Cu tails pruned with connectivity and DRC preservation.

5 mm scan: 210 pairs / 26 clusters, down from 213 / 27. Changed U18 cluster009
and FB four-layer detail actually inspected. Other net copper is unchanged.

Evidence: output/via-coalesce-20260915-02/{result.json,validation.json,trials/},
output/via-coalesce-20260915-repeat/result.json, and
output/via-coalesce-20260915-scan/{scan.json,cluster-009.svg,FB-after.svg}.
Final layer review: output/pdf/mini-round-20260915-03/ (paired vector-clean and
300-dpi raster annotated pages; review.json records actual image inspection).

## Regression checks and limits

23 native tests pass across via reuse, pad entry, source intent, power arrays
and plane refill. Via tests cover renamed/translated three-layer branching,
mid-segment via contacts, persisted reload/repeatability, obstacle rejection,
branch-width preservation, locked/blind/smaller barrels, array annotation after
reference renaming, unrelated nearby vias, and actual native detection of losing
a required branch. Acceptance controls reject new violations/opens/entry loss.
Bazel target query passes. A complete fresh PnR build was not run; existing
strict pad-entry findings still require separate source-current/neck policy work.

This is bounded local coalescence, not a global routing optimum. It leaves the
preexisting U18 F.Cu diamond cycle intact. The FB survivor now appears to have
only a very short B.Cu stub after tail pruning; standalone redundant-barrel/stub
removal and closed-cycle simplification remain follow-up improvements. These
are not claimed as fixed by this change. Routing completion remains 53 opens.
