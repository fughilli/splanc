# Annealed relocation convergence experiment

Run with the repository PnR runtime: `run.py`. Seed102, six warm trials cooling
linearly from relative placement-cost temperature0.15 to0, then six cold trials
without improving the best native open count. Improvements reset patience.
48-round/4-hour safety caps report budget exhaustion, never plateau. Candidate
pool exhaustion is distinct. Baseline is relocate101 round02 (200 native opens),
not a new source-to-final run. Pogo XY alone is released as in that experiment.

Each proposal samples a subset of six eligible components, then samples among
legal candidate translations using exp(-relative_cost/temperature). Cold trials
choose greedy cost reductions from varied component subsets. Metropolis acceptance
uses actual native opens with temperature scaled by50; any native violation
rejects the candidate. Equal native counts may advance exploration. Best board
is retained separately. The signal router still defers specialized power/USB nets.

Results, seed, acceptance, temperature, best-so-far and termination are persisted
under output/fresh-pnr-20260919/anneal102. No web result is presented before observed
plateau and actual layer review. Original/best final boards remain protected.
