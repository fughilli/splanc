# Incremental placement candidate evaluation

Clones the incumbent routed PCB, not the original unrouted source. The requested
run is seeded from full109's completed round01 (85 native opens, zero violations;
153 subwidth tracks and one unqualified pair remain). No baseline reroute.

incremental_place.py peels copper leaves touching moved pads back to the first
shared junction/stationary pad, preserves shared trunks, then invalidates exact
layer-aware pad/drill clearance conflicts at the destination. It retains all
unaffected track/via UUIDs and normalized geometry, plane definitions, outline,
and native footprint/pad identities. Bodies do not blanket-delete inner copper.
Locked copper and source-sized power arrays fail closed. Affected pairs are
invalidated together and their stale reference witnesses removed. The prototype
rejects outline changes and source-array/keepout owner relocation.

Full electrical phases continue against retained copper. Existing arrays are
retained; planes refill. Staged signals use fixed copper. Final candidate guards
compare original pad connectivity and qualified entries with the repaired board;
open-count improvement cannot conceal loss of a previously connected group.
The winner becomes the routed seed for the next round only on acceptance.
Each phase is captured, including the routed seed and local invalidation with
removed UUID/reason metadata. Batch111 deferred native DRC validation is included.

Tests: three native geometry regressions (shared T trunk/layer separation,
destination conflict, no-op exact copper). Real first-round C1 translation keeps
2043/2048 copper items. Real no-op keeps all2048 and native85opens/0violations.
Controller preflight resumes round2 with one completed round. Full experimental
routing and final visual/electrical qualification remain in progress.
