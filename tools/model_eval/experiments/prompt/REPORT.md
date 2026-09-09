# Prompt-surgery experiment — report

**Goal:** can prompt surgery and/or richer repair feedback make tiny CPU models (qwen3-0.6b,
qwen2.5-1.5b, qwen2.5-3b) author working effect-DSL programs? Runner:
`src/exp_prompt.ts` (own copy of the run.ts loop; shared harness untouched), 3 repair
rounds per cell, judged by Opus (`src/judge.ts`). Tasks: pinwheel, breathing-red,
rainbow-sweep, comet (the 4 cells the multi-turn baseline in `../../results.json` covers
for these models).

## Variants tested

| variant        | change vs production compact prompt                                                                                                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseline3`    | none — production prompt, raw diagnostics, 3 rounds (control for the 4-round baseline)                                                                                                                                |
| `examples`     | replace the single few-shot example with **3 tiny diverse worked examples** (angle-from-center via atan2+led.uv, time oscillation via state, moving head + fading tail via led.s) + "these are patterns, not answers" |
| `antipatterns` | append a **NEVER-DO block** distilled from the real observed compile failures (no #define, declare-before-use, led only in shade, state syntax, no ++/+=/?:/while/const, hue is 0..1, raw source in tool JSON)        |
| `feedback`     | prompt unchanged; **enrich the repair tool_response** with offending line + caret, diagnostic→fix hint table, and the full current script                                                                             |
| `combined`     | examples + antipatterns + feedback                                                                                                                                                                                    |

## Results (3 models × 4 tasks = 12 cells per variant)

`eff%` = produced a program (incl. prose recovery) · `comp%` = compiled within rounds ·
`judge` = mean Opus score over all cells (null → 0). Full merged data:
`experiments/prompt/results.json` (via `aggregate.mjs`).

| variant          | model        |     eff% |   comp% |    judge |
| ---------------- | ------------ | -------: | ------: | -------: |
| baseline(4r)     | qwen3-0.6b   |     100% |      0% |     0.00 |
| baseline(4r)     | qwen2.5-1.5b |     100% |     25% |     0.00 |
| baseline(4r)     | qwen2.5-3b   |     100% |     50% |     0.00 |
| **baseline(4r)** | **ALL**      | **100%** | **25%** | **0.00** |
| baseline3        | qwen3-0.6b   |     100% |      0% |     0.00 |
| baseline3        | qwen2.5-1.5b |     100% |     25% |     0.03 |
| baseline3        | qwen2.5-3b   |     100% |     50% |     0.00 |
| **baseline3**    | **ALL**      | **100%** | **25%** | **0.01** |
| examples         | qwen3-0.6b   |     100% |      0% |     0.07 |
| examples         | qwen2.5-1.5b |     100% |     50% |     0.30 |
| examples         | qwen2.5-3b   |     100% |      0% |     0.55 |
| **examples**     | **ALL**      | **100%** | **17%** | **0.31** |
| antipatterns     | qwen3-0.6b   |     100% |      0% |     0.00 |
| antipatterns     | qwen2.5-1.5b |     100% |     50% |     0.00 |
| antipatterns     | qwen2.5-3b   |     100% |      0% |     0.00 |
| **antipatterns** | **ALL**      | **100%** | **17%** | **0.00** |
| feedback         | qwen3-0.6b   |     100% |      0% |     0.05 |
| feedback         | qwen2.5-1.5b |     100% |     25% |     0.03 |
| feedback         | qwen2.5-3b   |     100% |     50% |     0.00 |
| **feedback**     | **ALL**      | **100%** | **25%** | **0.03** |
| combined         | qwen3-0.6b   |     100% |      0% |     0.23 |
| combined         | qwen2.5-1.5b |     100% |     50% |     0.21 |
| combined         | qwen2.5-3b   |      75% |     50% |     0.25 |
| **combined**     | **ALL**      |  **92%** | **33%** | **0.23** |

Note on the baseline judge figures: the headline baseline judges (0.03/0.03/0.05 per model)
are means over the _full_ task set in `results.json`; restricted to these 4 tasks every
baseline cell judged 0.00 — the programs that compiled were degenerate (constant color,
black output, wrong shape).

**Compiled AND judged ≥ 0.5** (the metric that matters — a working, correct effect):

- baseline(4r) / baseline3 / antipatterns / feedback: **0 cells**
- examples: **1 cell** (1.5b pinwheel ok@r1, judge 1.00)
- combined: **2 cells** (3b pinwheel ok@r1 judge 1.00; 1.5b breathing-red ok@r1 judge 0.85)

## Observations

- **Diverse examples are the one change that moves semantic quality.** Judge mean goes
  0.01 → 0.31 (examples) on identical tasks/rounds. The single-example production prompt
  anchors the models on band-effects; with three pattern classes shown, pinwheel (angle
  math) and comet (decaying tail) suddenly get plausible attempts (judge 0.9 on 3b for
  both).
- **The examples trade compile rate for correctness when used alone** — 3b comp dropped
  50% → 0% because it attempted the _right_ math and ran out of repair rounds, instead of
  shipping a trivially-compiling wrong program. Baseline's 50% comp on 3b was hollow
  (every compiled baseline program judged 0.00).
- **Antipatterns alone is harmful.** Judge 0.00 across the board; the models get
  conservative and emit minimal constant-color programs (e.g. 1.5b's compiled
  breathing-red was literally `return vec3(1.0, 0.0, 0.0);` — red, no breathing). A wall
  of "never do X" with no positive patterns steers tiny models toward doing nothing.
- **Enriched repair feedback alone is a wash** (comp 25%, judge 0.03 ≈ baseline3). The
  models' problem is not understanding the diagnostics — it's not knowing what good
  programs look like.
- **Combined is the best overall configuration**: highest compile rate (33% vs 25%
  baseline), judge 0.23, and the only variant with _two_ cells that both compiled and
  scored ≥ 0.85 — the antipatterns + caret/hint feedback convert the examples variant's
  semantically-right-but-broken attempts into compiling ones (both winners compiled at
  round 1). Cost: one eff% loss (3b comet emitted malformed nested-JSON in the tool call,
  nothing recoverable).
- **3 vs 4 rounds doesn't matter**: baseline3 reproduces baseline(4r) exactly on comp%
  (25%) — so the variant gains are not confounded by the round-count difference.
- **qwen3-0.6b stays unusable** (0% compile in every configuration), though combined
  lifted its judge mean to 0.23 — the thinking helps it aim at the right effect while
  still failing the DSL syntax.
- Runtime note: the `examples` variant ran under 4-way CPU contention with sibling
  experiments (~11.8 h; qwen3 cells up to 3 h each at max-token thinking); the remaining
  variants ran on an idle box (~5–12 min each). This affects only wall-clock `seconds`,
  not scores.
- Judge flakes: one transient Opus JSON-truncation on examples/1.5b/breathing-red was
  re-judged (score 0.0, patched into `results-examples.json`).

## Verdict

**Ship the `combined` prompt changes** (diverse examples + antipatterns + enriched repair
feedback): compile rate 25% → 33%, judge 0.00 → ~0.23–0.25 on the two usable models, and
it is the only configuration that produces multiple compiled-and-correct effects. If only
one change can land, land the **diverse-examples swap** — it accounts for essentially all
of the semantic gain (judge 0.31); never land the antipatterns block on its own.

## Winning prompt changes (verbatim, from `src/exp_prompt.ts`)

Replace the single `EXAMPLE — a moving band …` block in `CHAT_SYSTEM_COMPACT` (everything
up to `REPAIR:`) with:

```
EXAMPLE 1 — rotating pinwheel (angle around the map center from led.uv):
uniform float speed : 0.0 .. 5.0 = 0.5;
void update() {}
vec3 shade(Led led) {
  float ang = atan2(led.uv.y - 0.5, led.uv.x - 0.5) / 6.2832;
  float hue = fract(ang * 4.0 + time * speed);
  return hsv2rgb(hue, 1.0, 1.0);
}

EXAMPLE 2 — whole-map breathing glow (time oscillation via state):
uniform float rate : 0.1 .. 3.0 = 0.6;
uniform vec3 base : color = 1.0, 0.2, 0.1;
state float glow;
void update() { glow = 0.5 + 0.5 * sin(time * rate * 6.2832); }
vec3 shade(Led led) { return base * glow; }

EXAMPLE 3 — bright head moving along the strip with a fading tail (led.s):
uniform float speed : 0.0 .. 3.0 = 0.7;
void update() {}
vec3 shade(Led led) {
  float behind = fract(time * speed - led.s);
  return vec3(1.0, 0.8, 0.4) * exp(-8.0 * behind);
}

These are PATTERNS, not answers: adapt the math to the actual request — never return an example unchanged, and never reference a variable an example declared unless YOU declare it too.
```

Then (for the full `combined` configuration) insert before `REPAIR:`:

```
COMMON MISTAKES — each of these is a COMPILE ERROR, never do them:
- NO preprocessor: no #define / #include. Inline the number or declare a uniform.
- Every identifier must be DECLARED before use. Names like width, tint, phase do not exist unless you declare them (a 'uniform' at the top, or a local 'float x = 0.0;').
- 'led' exists ONLY inside shade(Led led). Never use led.* in update(). update() takes no arguments and returns nothing.
- Per-LED color logic goes in shade(), and shade() must return the final color. Do not return vec3(0.0, 0.0, 0.0) from shade() while doing the "real" work elsewhere.
- 'state' is a top-level declaration: 'state float glow;'. There is no 'state.x', no 'state a = {...}', and no state declared inside a function. Locals in update() are invisible to shade() — pass values through a state variable.
- Never index trail[...] or img[...] unless you declared 'buffer vec3 trail;' or 'texture vec3 img(64, 64);' at the top.
- NO ++, --, +=, -=, no ternary ?:, no while, no const, no plain global variables, and locals need an initializer. Write 'i = i + 1;', 'x = x + 1.0;', 'float x = 0.0;', and use if/else.
- hsv2rgb hue is 0..1, NOT degrees: a full rainbow is hsv2rgb(fract(t), 1.0, 1.0).
- The set_script "source" is RAW program text starting with a declaration — no markdown fences, no leading '|' or other decoration, and newlines inside the JSON string escaped as \n.
```

…and switch the repair tool_response to the enriched form (offending line + caret + hint
table + full current script) — implementation in `enrichedRepairMessage()` /
`hintFor()` in `src/exp_prompt.ts`.

## Files

- Runner: `/workspace/tools/model_eval/src/exp_prompt.ts`
- Per-variant raw results: `/workspace/tools/model_eval/experiments/prompt/results-{baseline3,examples,antipatterns,feedback,combined}.json`
- Merged summary + table: `/workspace/tools/model_eval/experiments/prompt/results.json` (from `aggregate.mjs`)
- Sweep log: `/workspace/tools/model_eval/experiments/prompt/run.log` (driver: `sweep.sh`)
- Baseline: `/workspace/tools/model_eval/results.json`
