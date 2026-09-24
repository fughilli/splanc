# Seed connectivity restoration investigation

Native reads of every immutable pogo114 phase establish a genuine guard failure.
Local invalidation splits eight seed groups. Early power and native routing
restore five; final TP1.5 (p5v-hv), TP1.14 (scl), TP1.8 (board-fault) remain
separated from their seed-connected islands. Final non-TP1 connectivity remains
preserved. The final preservation rejection is correct and must not be waived.

Root scheduling omission: the seed partition was inspected only after the run,
so intermediate routing optimized total open count without knowing which opens
must be repaired to make a relocation admissible. Stage transactions preserve
their post-invalidation baseline, and cannot catch this on their own.

`full_iteration.py` and `native_loop.py` are explicit candidate versions based
on unchanged incremental112 runtime, with adjacent unified diffs. They add a
pre-routing seed inventory in candidate-local rules, choose seed-restoring edges
first within each net's island spanning tree, and prioritize restoration among
equally attempted routing jobs. Attempt-count fairness, electrical phase order,
and all transaction/final connectivity, entry, reference and DRC guards remain.
Newly connected terminals may offer a shorter legal route into a seed island;
priority follows island membership rather than an arbitrary original pad pair.
The guard now reports complete split fragments and missing pad UUIDs.

For a new runtime copy these two candidate modules and live
`pnr/connectivity_restore.py`; do not mutate historical frozen trees. Live
native_loop has the same helper/ordering/diagnostic edits but predates other
incremental112 improvements and must not replace the whole newer runtime module.

Validation: five pure regressions pass. `check_native.py` reads the actual final
pogo114 board without modifying it and asserts its first three scheduled jobs
are exactly the three lost groups. Results: `output/preservation116/` includes
native-validation.json/log and stage-connectivity.json. Fixture code requires
KiCad Python and is run from repository root. This is inspection/scheduling
validation, not a routed result; whether those paths close needs the full run.
