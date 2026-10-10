# Speculative single-track routing
Separate runtime copy while full106 is frozen. Opt-in PNR_SINGLE_TRACK_WORKERS=2.
Each sweep selects up to4 distinct ordinary-signal nets, proposes additive paths
concurrently against one immutable native board, then serially merges additions.
Merge rejects changed/missing existing copper, mismatched UUIDs, moved footprints,
and unsupported copper. Refill, native DRC, connectivity, pad entries and reference
checks run on the accumulated board before accepting each delta. Failed/stale/
conflicting proposals return to normal serial routing. No shared mutable PCB.
Power/pairs/rip-up/component moves retain their existing coupled serial path.
Initial prototype parallelizes one bounded batch per sweep; not all routing stages.
CPU concurrency multiplies outer candidate workers, so default remains1 until
measured native tests; no global speedup claim. Do not promote without fixtures and
full pipeline regression. Test_speculative covers actual concurrent execution,
disjoint fusion, conflicting retry and stale/colliding delta rejection. Native
smoke output:output/parallel107/native-smoke; profile artifacts alongside.
