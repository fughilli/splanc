# Track graph consolidation — 2026-09-18

The coalescer now removes redundant paths between pads, vias and branch junctions.
This is in the normal PnR stage, not a manual U18 edit. `pnr.track_graph` builds
a same-net/layer multigraph, subdividing at centerline crossings, collinear
endpoints and pad/via contact projections. It contracts unanchored degree-two
chains, then proposes deletion only when the retained graph supplies a path of
at least the same width and no greater length. Proposals remove whole original
tracks only, preserving continuations beyond interior junctions. Every accepted
transaction refreshes the graph and passes fresh-process refill, native pad
partition, qualified pad-entry preservation and native DRC.

Default scope is chains up to 3 mm; arcs, source-protected power/thermal/local
return nets, plane nets, wider net classes, differential and length-matched nets
are excluded. Locked tracks cannot be removed. This is conservative cycle and
duplicate-track cleanup, not unrestricted trace relaxation or ampacity proof.
Source current intents resolve by atopile instance address, not PCB reference.

Accepted checkpoint: `work/mini-routing/keyhole-track-graph-53/candidate.kicad_pcb`
with its matching project and footprint table. SHA256:
`3083bd22824a61cd73cfe08b95cb084e8c8061e598f0364e6215b0276098a5ad`.
Baseline is keyhole-via-coalesce-53; originals are untouched.

U18 pin 10: removed the two segments forming the redundant side of the diamond;
the other path to the existing three-layer via remains. Board-wide removal:
26 segments (11.969 mm of summed centerline length) in 25 native-gated
transactions; most other deletions were exact
overlapping duplicates. Net totals: 1:1, A5:4, COMP:1, DRAIN:1, FSW:1, ILIM:1,
board-1-5:1, board-en:1, board.pd-1:2, sda:13.

Native KiCad 10.0.6 on the exact saved board: 53 opens, 11 dangling tracks, one
dangling via, zero other violations. All pads/footprint placement, remaining
copper geometry, prior pad connectivity and qualified pad entries unchanged;
no copper added. Via count 271, 5 mm scan 210 pairs / 26 clusters (unchanged).
Repeat pass: zero edits, byte-identical board.

Evidence: `output/track-graph-20260918-03/{result.json,validation.json,trials/}`,
`output/track-graph-20260918-repeat/result.json`, and
`output/track-graph-20260918-scan/scan.json`.
33 targeted native tests pass: graph, via coalescence, pad entry, power array,
plane intent and refill. Tests cover translated/renamed U18 geometry, interior
branches/terminals, narrower alternatives, locks, duplicates, cross-layer
separation, source intent, diff pairs, serialized worker transactions, and
coalescence followed by simplification while preserving three-layer access.
Bazel target query and Python compile/diff checks pass. Full fresh production
PnR build not run; prior strict pad-entry policy findings remain unresolved.

The saved native wrappers for removed copper are retained until SaveBoard;
earlier isolated diagnostic runs exposed a KiCad wrapper-lifetime crash and
JSON tuple/list proposal mismatch. Neither failed run became a checkpoint.

Layer review: `output/pdf/mini-round-20260918-01/all-layers.pdf`, 62 pages.
All copper pages viewed individually and other pages on contact sheets 2-11;
enlarged U18/U19 raster and four-layer cluster detail confirm the diamond is
gone while In2/B.Cu access remains. Other duplicate deletions leave the visible
copper envelope unchanged. Mounting/pogo and technical layers retain their
geometry; labels and page furniture are aligned. Review ledger/coverage checks
pass. Broad images do not prove power or USB compliance.

Remaining work: 53 opens, original dangling copper, source neck/current policy,
USB coupled routing and standalone redundant-via/stub cleanup (FB), plus broader
route relaxation. No manufacturing or publication was performed.
