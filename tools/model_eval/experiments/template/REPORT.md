# Template retrieval + modification — experiment report

**Strategy:** never author from scratch. Retrieve the closest verified builtin
effect (library built from the app's seed effects, each compile-verified), present
it as the current editor script, and phrase the user turn as a modification
request. Multi-turn compile-repair loop (3 rounds), same sampling as baseline,
Opus judge; `unmodified` flag detects a template returned ~verbatim
(similarity threshold). Implementation: `src/exp_template.ts` +
`src/exp_template_lib.ts`.

**Run notes:** original sweep OOM-killed after 3 qwen3-0.6b cells
(`results-qwen3-partial.json`); qwen2.5-3b cells from a memory-gated resume
(`results-3b.json`). Heuristic (keyword) retrieval picked the right/nearest
template 4/4 on the resume run; asking the 0.6b MODEL to retrieve failed 7/8
(returned null or wrong) — retrieval must be heuristic, not model-driven.

## Results (4 tasks; near-template = breathing-red, rainbow-sweep, comet; far = pinwheel)

| model      | arm                | comp% | judge | notes                                                                                 |
| ---------- | ------------------ | ----- | ----- | ------------------------------------------------------------------------------------- |
| qwen3-0.6b | baseline           | 0%    | 0.03  |                                                                                       |
| qwen3-0.6b | template (3 cells) | 33%   | 0.50  | breathing-red **1.0** but UNMODIFIED; rainbow 0.5                                     |
| qwen2.5-3b | baseline           | 50%   | 0.00  |                                                                                       |
| qwen2.5-3b | template           | 25%   | 0.40  | breathing-red **1.0** (genuinely modified, r1); pinwheel/rainbow/comet failed compile |

## Findings

1. **Near-template asks are transformed**: breathing-red scored **1.0 on both
   models** — the only task any strategy has fully solved on 0.6b (though there
   by returning the template unmodified, which the honesty flag caught; the 3b
   modified it genuinely). When the ask is close to a library entry, small
   models produce correct results basically immediately (compiled r1, ~8 min).
2. **Far-from-template asks are NOT rescued** (pinwheel: failed on both models;
   judge 0) — modification skill doesn't extend to structural rewrites.
3. **Surprise negative**: on the 3b, template-start LOWERED comp% vs from-scratch
   (25% vs 50%) — editing someone else's program is harder to keep compiling
   than writing fresh (models broke the template while modifying: sim 0.58–0.71,
   compile FAIL). The judge lift (0.00→0.40) comes entirely from the one
   near-template hit.
4. Slow failing cells (up to ~2 h under box contention) burn all 3 repair rounds.

## Verdict

**Adopt as a product shape, not as a codegen fix.** Template-start doesn't make
small models better programmers — it makes MANY USER ASKS not require programming.
The right productization is: (a) heuristic retrieval over the builtin/user library,
(b) when a template is close, offer it (possibly as-is — "unmodified" is often the
correct answer, e.g. breathing-red ≈ breathing-pulse), (c) parameter-tweak asks
(colors/speeds/uniforms) are the sweet spot for the model-modification turn;
(d) far-from-library asks should be routed to grammar-constrained from-scratch
(see ../grammar/REPORT.md) or to a cloud model. Combine with the grammar envelope
for the modification turn — the strategies compose.
