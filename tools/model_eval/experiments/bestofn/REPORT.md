# Best-of-N sampling with a compile filter — experiment report

**Date:** 2026-09-08 · **Script:** `src/exp_bestofn.ts` (+ `src/exp_bestofn_backend.ts`) · **Raw data:** `experiments/bestofn/results.json` · **Run log:** `/tmp/bon_full.log`

## Hypothesis

For small local models, N cheap independent single-turn samples + the compiler as a
perfect verifier beat the baseline's sequential repair loop (1 sample + up to 4
in-session repair rounds, `src/run.ts`).

## Config

- Models: `qwen3-0.6b` (Q8_0), `qwen2.5-1.5b-instruct` (Q4_K_M), `qwen2.5-3b-instruct` (Q4_K_M)
- Tasks: `pinwheel`, `breathing-red`, `rainbow-sweep`, `comet`
- N_max = 8 candidates per cell, sequential; **N=4 analyzed as the first-4 prefix** of
  the same candidates (candidates are independent, so the prefix is an unbiased N=4 run)
- Seeds `1001 + 17·i`, temperature cycled `0.6 / 0.8 / 1.0`; base sampling matched the
  harness (topK 20, topP 0.8, repeatPenalty 1.1, maxTokens 2048, `/no_think`)
- Extraction identical to `run.ts` round 1 (`set_script` → `edit_script` applied to the
  starter → prose recovery); every extracted program compiled with the real `fx_compile`
- Hybrid arm: if nothing in the prefix compiles, ONE single-turn repair on the
  fewest-errors candidate (seed 4242, t=0.6)
- Judge: Opus scored **every unique compiling source** per cell (0 judge-API errors),
  giving first-compiling selection, judge-picked selection, and the oracle ceiling
- Runtime note: the box ran 3 other llama experiments concurrently (6 cores, 4
  processes); this run was capped at 3 eval threads (`BON_THREADS`, added to
  `exp_bestofn_backend.ts` — 6-thread candidates took 741 s, 3-thread ones 481 s under
  identical load). Mean generation time was **372 s/candidate**, vs ~5–30 s/generation
  for the uncontended baseline run — raw wall-clock across the two runs is therefore
  **not comparable**; generation counts are the fair compute unit.

## Results

### Comparison table (per model, averaged over the 4 tasks)

comp% = tasks with a compiling program · judge = mean judge score of the selected
(first-compiling) program · gens = mean generations per task (early-stop; hybrid repair
included) · wall-clock = mean seconds per task in that run's own environment.

| model                 | arm                    | comp%   | judge | oracle | gens/task | wall-clock/task |
| --------------------- | ---------------------- | ------- | ----- | ------ | --------- | --------------- |
| qwen3-0.6b            | baseline (1+4 repairs) | 0%      | 0.00  | —      | 5.00      | 36 s            |
|                       | best-of-N N=4 (hybrid) | 0%      | 0.00  | 0.00   | 5.00      | 2335 s\*        |
|                       | best-of-N N=8 (hybrid) | 0%      | 0.00  | 0.00   | 9.00      | 3947 s\*        |
| qwen2.5-1.5b-instruct | baseline (1+4 repairs) | 25%     | 0.00  | —      | 4.50      | 17 s            |
|                       | best-of-N N=4 (hybrid) | **75%** | 0.00  | 0.00   | **2.00**  | 664 s\*         |
|                       | best-of-N N=8 (hybrid) | 75%     | 0.00  | 0.00   | 3.00      | 953 s\*         |
| qwen2.5-3b-instruct   | baseline (1+4 repairs) | **50%** | 0.00  | —      | 4.25      | 28 s            |
|                       | best-of-N N=4 (hybrid) | **0%**  | 0.00  | 0.00   | 5.00      | 2210 s\*        |
|                       | best-of-N N=8 (hybrid) | 0%      | 0.00  | 0.00   | 9.00      | 3610 s\*        |

\* contended box (4 llama processes on 6 cores), ~12–20× slower per generation than the
baseline's environment. In compute units (generations), hybrid N=4 on the 1.5B is
**cheaper than the baseline** (2.0 vs 4.5 gens/task) _and_ 3× its compile rate.

Baseline judge on these 4 tasks is 0.00 for all three models — the headline baseline
averages (0.03 / 0.03 / 0.05) come from other tasks in the 8-task suite.

### Per-cell compile patterns (C = compiles, x = compile error, - = no program)

| model        | pinwheel     | breathing-red | rainbow-sweep | comet        |
| ------------ | ------------ | ------------- | ------------- | ------------ |
| qwen3-0.6b   | xxxx-xxx +r✗ | xxxxxxxx +r✗  | xxxxxxxx +r✗  | xxxxxxxx +r✗ |
| qwen2.5-1.5b | -x-xxxx- +r✗ | CCCxxxxC      | Cxxx--xx      | Cx-CCx-x     |
| qwen2.5-3b   | xxxxxxxx +r✗ | -xxxx-xx +r✗  | -xxxx-xx +r✗  | xx---xxx +r✗ |

Per-candidate compile probability: 0.6b **0/32**, 1.5b **8/32 (25%)**, 3b **0/32**.
All 8 hybrid repairs (one per non-compiling cell) failed too.

### Oracle ceiling

The judge scored **every** compiling candidate in every cell (8 unique compiling
sources, all from the 1.5B): **every score was 0.00**. The oracle ceiling — if
selection always picked the judge-best compiling candidate — is therefore **0.00
across the board**, identical to first-compiling selection. At this model scale the
selection policy is irrelevant: there is nothing of quality to select.

Why: the compile filter promotes degenerate programs. E.g. the 1.5B's "winning"
breathing-red candidate is the starter skeleton with the color changed to red — it
compiles, but is a static red (no breathing), so the judge correctly gives 0:

```
uniform float speed : 0.0 .. 5.0 = 1.0;
void update() {}
vec3 shade(Led led) { return vec3(1.0, 0.0, 0.0); }
```

### Failure modes

- **qwen3-0.6b:** rambles to the 2048-token cap; programs invent identifiers
  (`unknown identifier 'width'`) or break uniform syntax (`expected '='`). 0/32 + 0/4
  repairs. More samples can't fix a ~0% per-sample compile rate.
- **qwen2.5-3b (the surprise):** baseline 50% → best-of-N 0%. Its baseline wins came
  **from the repair rounds** (compiled at rounds 2–3, never round 1). Single-turn it
  usually emits `edit_script` calls whose payload doesn't parse/apply — 11 of its
  failures are `unexpected token Sym('|') at 1:1` (markdown-table/diff-shaped output
  swallowed whole). Independent resampling forfeits exactly the conversational
  scaffolding this model needs.
- **qwen2.5-1.5b:** the only model where the hypothesis holds — a genuine ~25%
  per-sample compile rate, so P(≥1 of 4 compiles) ≈ 68% ≈ observed 75%. All three
  successful cells already hit at candidate #0 (t=0.6, seed 1001); N=8 added compiling
  duplicates but no new cell and no quality.

## Verdict

**Best-of-N is not a general cheapest win; it is a targeted compile-rate win for the
1.5B only, and N=4 is enough.**

- Where it works (1.5B): comp 25% → 75% at **less** compute than the baseline
  (2.0 vs 4.5 generations/task with early-stop). N=8 doubles the budget for zero
  additional cells — everything N=8 found, N=4 had already found. Use N=4 with
  early-stop; the extra temps/seeds beyond the first few candidates bought nothing.
- Where it backfires (3B): sequential repair is strictly better (50% vs 0%). More
  samples do **not** beat more repair rounds here — the failure mode is format
  discipline, which repair fixes and resampling doesn't.
- Where nothing works (0.6B): 0% either way; 9 generations/task wasted.
- The judge-oracle ceiling is **0.00 everywhere**: even a perfect selector among
  compiling candidates gains nothing, because compile-filtered candidates at this
  scale are degenerate (starter-skeleton edits). "Compiles" is a nearly vacuous
  success metric for these models; any future selection work should gate on a
  cheap semantic check (e.g. does `shade` depend on time/position) before spending
  judge calls.

**Recommended next step:** a model-conditional policy — N=4 + compile filter +
early-stop for ~1.5B models, keep the repair loop for ≥3B — and attack the quality
ceiling (prompt/skeleton work) rather than the selection strategy, since the oracle
shows selection has no headroom.
