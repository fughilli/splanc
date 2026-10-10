# Parallel routing restart
User requested replacing full106 serial routing with parallel single-track work.
Full106 stopped after its610-predecessor607input freeze was verified unchanged;
partial checkpoints/profiles retained; termination is user-requested, not plateau.
Full108 freezes610production inputs and archived driver/wrapper/Rust binary/source.
Same checkpoint source and seed104, full electrical phases, K4/N4/samples4,
2candidate workers x2route workers (maximum4search workers across candidates).
OMP/OpenBLAS/MKL threads1 avoid numerical-library oversubscription; KiCad native
validation may still use its own threads. PDFwatcher and live viewer point here.

Signal grid: persistent spawned processes share an immutable pickled grid, route
nets against one occupancy snapshot, commit in deterministic order, reroute
conflicts against updated occupancy. Negotiation/leftover routing use batches;
multi-net rip-up and forest recovery remain serial transactions. Native refinement:
repeated additive ordinary-signal batches, exact existing-copper preservation,
refill and native DRC/connectivity/pad-entry/reference gates for every merge.
Rejected/stale proposals fall back to serial routing. Power/pairs remain coupled.

Validation:11maze tests with actual process workers PASS;3speculative scheduler/
stale delta tests PASS; native fusion fixture2->1->0opens/0violations; crossing
fixture yields tracks_crossing and is rejected. Fixed SWIG read-only UUID and
constructor-overload hazards with explicit signature-checked geometry copying.
Whole-board detail acceptance test still running at restart; log
/private/tmp/parallel107-detail-tests.log, session39199. No measured end-to-end
speedup or routing completeness claim. Rust/profile hooks remain active. Run to
observed plateau, retain all failures; review PDFs and5mmvia scans each round.
