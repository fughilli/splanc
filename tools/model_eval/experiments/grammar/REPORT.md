# Grammar-constrained decoding (GBNF) — experiment report

**Strategy:** constrain node-llama-cpp sampling with a GBNF grammar so the model can
ONLY emit a valid `<tool_call>{"name":"set_script","arguments":{"summary":…,"source":…}}</tool_call>`
envelope (variant `envelope`), plus a second variant (`dsl`) that additionally
constrains the start of the `source` string toward DSL-legal openings (uniform/void/
vec3/state/buffer/texture; no `#`). Multi-turn compile-repair loop (3 rounds), same
sampling as baseline (temp 0.7 / topK 20 / topP 0.8 / seed 42 / repeatPenalty 1.1),
Opus judge. Implementation: `src/exp_grammar.ts`.

**Run notes:** the original full sweep was OOM-killed partway (5 concurrent
experiments on an 11GB box); qwen3-0.6b cells are from the first run
(`results-qwen3-partial.json`), qwen2.5-3b cells from a memory-gated resume
(`results.json`). qwen2.5-1.5b was not run (box contention); the 0.6b/3b bracket
answers the question. Grammar-constrained cells are SLOW under contention
(8–60 min/cell) — constrained sampling adds real overhead on failing cells that
burn all 3 rounds.

## Results (4 tasks: pinwheel, breathing-red, rainbow-sweep, comet)

| model      | arm             | tool%    | eff% | comp%   | judge    |
| ---------- | --------------- | -------- | ---- | ------- | -------- |
| qwen3-0.6b | baseline        | 62%      | 100% | 0%      | 0.03     |
| qwen3-0.6b | envelope        | **100%** | 100% | 0%      | 0.00     |
| qwen3-0.6b | dsl (2/4 cells) | **100%** | 100% | 0%      | 0.00     |
| qwen2.5-3b | baseline        | 75%      | 100% | 50%     | 0.00     |
| qwen2.5-3b | envelope        | **100%** | 100% | **75%** | **0.40** |
| qwen2.5-3b | dsl             | **100%** | 100% | **75%** | **0.47** |

Per-cell (3b): rainbow-sweep judge **1.0** (both variants, compiled r1);
pinwheel 0.6/0.7 (right approach, never compiled in 3 rounds); breathing-red
compiled but judge 0 (wrong behavior); comet 0/0.2.

## Findings

1. **Compliance is solved by construction** — tool% = 100% always, JSON breakage
   eliminated. The envelope grammar alone removes the entire narrate-instead-of-
   tool-call failure class without any prompt change.
2. **On a model with real capability (3B), removing the format burden buys
   correctness**: comp 50%→75% and judge 0.00→0.40+. Interpretation: format
   errors were consuming repair rounds and truncating usable programs; grammar
   spends the model's capacity on the program itself.
3. **On 0.6b it moves nothing but compliance** (0% compile either way) — grammar
   cannot create DSL knowledge that isn't there.
4. `dsl` (source-prefix constraints) ≈ `envelope` (0.47 vs 0.40 judge; same
   comp%) — the cheap envelope grammar captures most of the win; deeper DSL
   grammar constraints are marginal.

## Verdict

**Adopt.** The strongest single lever found in this investigation for ≥3B models:
+25pt compile, +0.4 judge, and it composes with every other strategy (prompt,
template-start, repair loop). Productization path: wllama supports llama.cpp
grammar (`grammar` field in its completion params — verify in the wllama 3.6.1
API); ship the envelope grammar for the CPU path. Skip the `dsl` variant
(complexity for ~no gain). Do nothing for ≤0.6b — grammar doesn't rescue it.
