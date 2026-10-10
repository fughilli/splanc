# Performance investigation 121

User-authorized parallel work, 2026-09-24. Baseline source d19d8b2; fresh119 stopped on a native unmove SIGSEGV, not convergence. Protected fresh-28 remains 48 opens / zero native findings. No production restart, publication, or promoted board is implied.

| Worktree | Hypothesis and implementation target | Evidence required |
| --- | --- | --- |
| codex/perf121-gpu | Batched wirelength, adjacency and multilayer capacity/cost evaluation may map to tensor kernels; measure Apple MPS against CPU batching before choosing a backend. | Actual Mini and larger batch workloads; upload/synchronization included; value and candidate-ranking parity; measured crossover or documented rejection. |
| codex/perf121-cpu | Worker/lifecycle overhead and repeated CPU geometry work may be reduced; parallelize independent proposals while preserving serial conflict resolution. Investigate fresh119 unmove crash. | Actual profile attribution; fixed work at 1/2/4 workers as applicable, source hashes, native correctness and ownership regression. |
| codex/perf121-epochs | Several provisional edits can use a conservative geometric proxy before a native DRC gate, reducing native launch frequency. | End-to-end edit+repair time, false-negative controls, native boundary rollback/bisection, no proxy-only accepted board; all electrical/reference guards retained. |
| Parent / drc120 | Keep initialized native KiCad and board data warm, update track geometry in memory. | Cold/warm benchmark, native negative controls, stale-state/policy checks, cold final acceptance and conservative CLI fallback. |

Each agent owns its worktree and compact artifacts under output/perf121/{gpu,cpu,epochs}. Main source and frozen runs are immutable during investigation. Each output budget is 3 GiB; stop bulk generation if disk free space drops below 25 GiB. Prune only experiment-owned proven-ineffective bulk, recording paths, aggregate size, reason, and retained evidence. Retain source, small metrics, test failures, final checkpoint and reproduction commands. No repeated full-board PDFs for unchanged kernel workloads; actual routing rounds keep the existing full-layer/5mm actual review requirement.

Sustained scored benchmarks are coordinated to avoid contention; report background load and do not add parent wait time to child CPU. Opt-in implementations only enter the main tree after tests, import/hash verification and review of interactions. Combined native ladder and focused fixed-work comparisons precede any fresh full pipeline run. Unsupported GPU/local-DRC ideas remain documented rejections or future work, not claimed acceleration.

Live dashboard port8774 links to individual experiments on8771/8772/8773. Progress phases and provisional geometry must remain distinguishable from accepted native results.


## Completed bounded investigation

The three worktree features are integrated locally. See [RESULTS.md](RESULTS.md)
for measured timings, rejected approaches, correctness evidence and qualification
limits. Production defaults remain unchanged. GPU endpoint scoring and native
acceptance epochs remain experiments; CPU maze/placement and warm DRC are opt-ins.
Before a fresh production run, complete native fixture qualification with the
chosen flags, freeze all inputs, preserve final cold/native electrical gates and
start the existing PDF/5 mm review workflow. Do not resume failed fresh119 or paused
full116 by modifying their frozen runtimes.
