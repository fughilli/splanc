# Performance investigation 121 — measured results

Three isolated worktree investigations are integrated locally, alongside the warm
DRC120 backend. No full PnR run was restarted or board promoted. The protected
fresh-28 checkpoint remains **48 native opens / zero violations**. Fresh119 stopped
on an intermittent native rollback crash; that was not a placement plateau.

| Change | Fixed-work result | Integration status |
|---|---|---|
| Packed CPU maze with refined halo caches | 3.573 → 0.714 s serial; 0.440 s with two workers | Opt-in `PNR_PACKED_MAZE=1`; exact paths preserved |
| CPU degree-bucketed wirelength | Complete continuous placer: 1.029 → 0.268 s | Opt-in `PNR_BATCHED_WIRELENGTH=1`; placement can differ |
| Metal endpoint scoring | 2,019 TP1 candidate costs: Python 299 ms, best CPU 34 ms, GPU 9.23 ms including transfers | Benchmark-only; legality and heavier routing costs excluded |
| Native acceptance epochs | Same 12 known-good signal edits: K1 16.915 s, K4 4.226 s, K8 2.826 s | Experimental transaction API; production scheduling unchanged |
| Warm native DRC120 | Mini repeated checks about 0.47 s versus cold CLI about 1.5 s | Opt-in private service; full DRC each time, cold final gate |

These speedups do not multiply into a measured whole-PnR improvement. Workloads,
coverage and baselines differ. Fixed-work timings exclude profiler overhead and
separate pool startup from steady work; CPU times across workers are not elapsed
time and must not be added to parent waits.

## What the profiling changed

Fresh119's 3,790 grid-net profiles pointed to Cell allocation/hashing, dictionary
lookups and repeated halo probes. Integer states first reduced the fixed workload
to 1.194 s. A fresh profile then identified halo pricing as the remaining hotspot.
Constant-price shortcuts, shared all-layer via-price cache keys and per-state hole
checks reduced it to 0.714 s. Two workers capture nearly all the measured parallel
benefit; four improve only another 2.4%. Existing serial conflict fusion remains.
New crossing-proposal tests exercise its retry and non-overlap behavior.

Padding every net to the largest net made larger placement batches slower. Degree
buckets fixed that; CPU beat Metal at every measured wirelength batch size. GPU
endpoint ranking is genuinely batchable, but observed float32 cost differences and
tie changes prevent treating it as an exact drop-in ranker. It remains an experiment.
A future integration should use resident arrays and exact CPU refinement at shortlist
boundaries. Partitioning a 137-component graph or moving heap-based negotiated search
to GPU is not justified by current evidence. Profile regular raster/dilation/cost-map
stages before adding another backend; batch entire independent placer starts if GPU
work is revisited.

## Correctness and limits

- All 12 ordered CPU proposal paths match for every kernel/worker configuration,
  including hard-blocked recovery. Reversed timing confirms the gain.
- The continuous placer used actual Mini source constraints, three seeds and repeated
  200-step runs. Fixed poses are unchanged and each backend repeats exactly. However,
  floating reduction order changes movable poses by up to 2.56 mm. This is not a
  legalized placement or evidence of better routing; keep the option disabled by default.
- Nine clean epoch trials restore identical original copper and native zero opens /
  zero violations. Fault controls reject subwidth and oversized tracks even with an
  intentionally permissive proxy. Bisection can cost more than serial checking: one
  missed fault in K4 takes five gates. The three salvaged edits retain eight intentional
  opens and 15 inherited dangling findings. Exact native acceptance, pad-entry and
  partition audits pass with zero new violation identities. Rollback is not repair.
- Native DRC already runs at transaction boundaries, not in each A* expansion. Actual
  epoch deployment needs provisional keyhole output plus every existing source-width,
  newly connected pad-entry, reference, current, pair and refill guard. Merely wrapping
  already accepted proposals will not deliver the replay gain.
- Warm DRC keeps initialized KiCad and updates cached copper with bounded lifetimes.
  It still runs whole-board native DRC. Unsupported/ambiguous/nonzero findings or changed
  policy use the original CLI. The native controller now explicitly forces CLI for its
  final saved checkpoint. Regional incremental DRC is not implemented.
- Rollback clones rebind their net to the destination board. Five fresh-process small
  regressions and three archived-case replays pass. The original archived-case replay
  also passed, so the intermittent SIGSEGV remains unresolved.

The integrated Bazel targets `packed_maze_test`, `batched_cost_test`,
`route_epoch_test` and `warm_native_drc_test` pass. Additional geometry/placement and
native process-shutdown tests pass. A full source-frozen native fixture ladder and
fresh all-electrical Mini run are still required before changing defaults. Retain
all final native/electrical/reference/pad-entry gates and the PDF/actual-image/5 mm
review workflow for those routing runs.

## Evidence and viewers

- [Live overview](http://mac-mini.tail6b8ad3.ts.net:8774/)
- [CPU routing](http://mac-mini.tail6b8ad3.ts.net:8772/): `output/perf121/cpu/refined`
- [CPU/Metal placement](http://mac-mini.tail6b8ad3.ts.net:8771/): `output/perf121/gpu`
- [Native epochs](http://mac-mini.tail6b8ad3.ts.net:8773/): `output/perf121/epochs`
- Warm DRC evidence: `output/drc120`, reproduction in `../drc120/README.md`.

All viewers return HTTP200. Automatic browser inspection is currently blocked by the
old symlinked writable-root setting; no app permissions or protections were changed.
Child tool calls also stalled on approvals, including patch calls. Agents supplied
code and review in parallel; the parent applied and executed it through normal
approval review in their isolated worktrees. Scored workloads ran sequentially to
avoid benchmark contention.

Generated results stay outside Git. Each investigation has a 3 GiB artifact cap and
25 GiB free-space floor. About 135 GiB remains free; no pruning was necessary.
All 635 archived frozen inputs and the protected PCB/project/manual22 hashes were
reverified unchanged. No publication, merge, manufacture or new promoted checkpoint.
