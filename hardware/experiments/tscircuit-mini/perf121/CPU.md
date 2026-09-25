# CPU routing experiment 121

The 3,790 fresh119 grid-net profiles total 6,320.6 process CPU seconds across
concurrent workers, not elapsed run time. Cell construction/hashing and repeated
via/halo checks dominate. `PNR_PACKED_MAZE=1` now selects integer search keys and
invocation-local caches. Move/tie order, diagonal corners, all-layer through-via
checks, plated transitions, drill spacing and final native gates remain intact.
The default stays unchanged pending fresh full electrical qualification.

## Fixed-work evidence

The 853 KB workload reconstructs the exact fresh119 round-01 200×158×4 source grid
and escape geometry. Eight nets sampled across span ranks plus four hard-blocked
recoveries form 12 independent proposals. These are reduced source-grid workloads,
not a complete Mini iteration or the native power/keyhole router.

Three repetitions per configuration; configuration groups shuffled with seed121.
Worker readiness is checked before timing; setup is separate, serialization is
included. Every ordered path hash matches across every configuration.

| Kernel | Workers | Median wall seconds |
|---|---:|---:|
| Reference | 1 | 3.57254 |
| Reference | 2 | 2.11856 |
| Reference | 4 | 2.08405 |
| Packed, refined | 1 | 0.71361 |
| Packed, refined | 2 | 0.44004 |
| Packed, refined | 4 | 0.42939 |

The first packed version took1.19358s serial. Its new profile exposed halo pricing
as the next hotspot: 1.166 profiled self seconds,9.29million max calls and10.07million
dictionary lookups. Empty prices now return the exact constant1; through-via price
caches use one XY key across layers; hole-clear checks are shared across destinations
for one expanded state. The refined result is5.01× faster serial and8.12× with two
workers versus original serial. Two workers are the efficient choice here; four
only gain2.4%. Neither comparison is an8-worker full-pipeline baseline. Dominant
single-net work limits scaling; final serial fusion/conflict retries are outside
these independent-proposal timings.

Validation includes seeded exact paths, raw out-of-bounds blockers, plated holes,
geometry-change invalidation, full negotiated result parity and conflicting
snapshot proposals retried against accumulated copper. Existing grid/maze/joint
regressions pass. Actual spawn pools at2/4workers also preserve all hashes.
Per-job wall/CPU/PID evidence and fresh profiles are retained; parent waits are
never added to child CPU. Process peak RSS is not per-job allocated memory.

Artifacts: `output/perf121/cpu/{workload.json,workload.pkl,benchmark-results.json,
confirmation.json,profile-packed,refined}`. Source capture/benchmark/confirmation
scripts are adjacent. Run with the PnR numerical runtime, PYTHONPATH=hardware/pnr.
`cpu_capture.py DIAGNOSTICS --out OUTPUT` reconstructs the workload;
`cpu_benchmark.py OUTPUT/workload.pkl --out RESULTS` runs the worker matrix;
`cpu_confirm.py OUTPUT/workload.pkl RESULTS` runs reversed serial confirmation and
separate profiling. Pickles are trusted local experimental inputs only.

## Native rollback ownership

Unmove clones now rebind their net to the destination BOARD after insertion.
Five fresh-process tiny transactions pass; three archived C42 replays also exit0
with output SHA identical to the reference. The reference also exited0, so the
fresh119 SIGSEGV was NOT reproduced and this is defensive hardening, not a proven
root-cause fix. Keep the intermittent lifecycle crash unresolved.

No board is promoted, no active frozen run changed, no publication performed.
Output cap3GiB and free-space floor25GiB; actual evidence is small.
