# Full electrical batch placement experiment

`run.py --k 4 --n 4 --samples 4 --workers 2` runs batch Monte Carlo placement.
All K selected components vacate placement/pad occupancy together; all incident
net track/via geometry is removed from the probe substrate. External endpoints
use layered distance fields; internal-to-batch nets are scored at the complete
candidate's new positions via joint HPWL. Top N includes current placement.
The Cartesian product is exhaustively checked up to4096 combinations, otherwise
sampled; joint collisions and hard constraints reject combinations. Samples are
unique: one greedy combination plus Boltzmann alternatives. At least two parts
must move. Source-array and parent-keepout owners remain conservatively excluded.

Four candidates are independently evaluated, with two concurrent workers. Each
uses production phase order and explicit source current/fabrication rules via
`pnr.full_iteration`. The native subloops are route-only, including paired bootstrap.
Every baseline/candidate gets all phases and final audits. Blocked entries are
recorded as failed objective guards instead of terminating before audit. Unknown
stackup qualification remains unknown. Final guards outrank open-count gains.

Seed103; six warm batch iterations, then six cold iterations without improving
the best complete objective. 48iteration/48hour safety limits are not convergence.
This remains a checkpoint-seeded experimental controller, not production default
or a fresh source build. Paths live in output/fresh-pnr-20260919/full103, with
per-round alternatives/candidate-NN/phases, evaluation and feedback reports.

Regression tests: test_batch_relocate.py covers atomic swaps, joint collision
rejection, unique Cartesian sampling and removal of ALL batch pads/incident
copper before probes. test_full_iteration.py covers electrical failures outranking
signal-connectivity gains and missing final reports failing closed. Existing native
loop/relocation/two-sided Bazel targets pass. Actual board probe: held-out
R12,C40,C52,R9;256 combinations,86 legal multi-move choices,4 sampled.

Viewer has candidate/phase selectors, phase copper deltas, final mode-labeled
unconnected links, candidate shortlist positions/costs and selected-move overlay.
Internal historical UI fixture exercised switching; no fabricated new phase
result is presented. Real complete phases/exports must be reviewed before delivery.
