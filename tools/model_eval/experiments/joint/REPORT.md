# Joint stack — final validation report

**Question:** composing the three winning strategies from the five prior experiments,
what fraction of authoring asks does qwen2.5-3b-instruct get **compiled AND correct**
(judge ≥ 0.5) fully offline?

**Answer: 3/8 (37.5%) — vs 0/8 baseline.** Comp 5/8 (63%) vs 4/8 baseline; mean judge
0.44 vs 0.05 baseline. Every compiled cell compiled at round 1. This lands inside the
"roughly ⅓–½" prediction in `../SYNTHESIS.md`.

Runner: `src/exp_joint.ts` → `results.json` (metric of record) + `results-pass1.json`
(first pass, see "Conflicts found"). Model: qwen2.5-3b-instruct Q4_K_M only; all 8 tasks
from `src/tasks.ts`; 3-round repair loop against the real `fx_compile`; Opus judge
(`src/judge.ts`); sampling identical to all prior experiments (temp 0.7, topK 20,
topP 0.8, seed 42, repeatPenalty 1.1, ctx 8192).

## The stack as composed

1. **Template routing** (from `exp_template`): deterministic keyword retrieval over the
   verified template library (`exp_template_lib.ts`). **Near = retrieval score ≥ 2**
   (a strong weight-2 keyword hit, or two independent weak hits). This threshold
   reproduces the template experiment's behavior exactly: the tasks it transformed
   (breathing-red 4, rainbow-sweep 4, comet 3, two-tone-gradient 3) all clear it and all
   picks are gold-acceptable; the tasks its report calls FAR (pinwheel/fire/twinkle,
   plus color-wipe) score ≤ 1 — generic-word matches only — and route to from-scratch.
   Near → template-modification turn (template as the current editor script, ask phrased
   as "modify it to satisfy this request"). Far → from-scratch turn (STARTER_SOURCE).
2. **Grammar envelope** (from `exp_grammar`, variant `envelope`): GBNF forcing the
   `<tool_call>{"name":"set_script",...}</tool_call>` JSON envelope, applied to **every
   generation turn on BOTH routes** — the grammar constrains output shape only, so it
   composes with the template-modification turn with no technical conflict (this run is
   the demonstration: both template wins came through grammar-constrained turns).
   One tightening over exp_grammar's envelope: `source ::= schar schar*` (non-empty) —
   see "Conflicts found".
3. **Combined prompt** (from `exp_prompt`, variant `combined`): DIVERSE_EXAMPLES
   (atan2 pinwheel / state-var breathing / comet tail) replacing the single moving-band
   example + ANTIPATTERNS never-do block, spliced into `CHAT_SYSTEM_COMPACT`; enriched
   repair feedback (`parseDiags`/`hintFor`: offending line + caret + hint + full current
   script). Same system prompt on both routes.

Composition adjustments (both documented in the runner header):

- **Only `set_script` is advertised** and the repair message drops its `edit_script`
  clause — the grammar cannot emit `edit_script`, and exp_grammar's coherence rule
  (never advertise an uncallable tool) carries over. This is the one real interaction
  between the prompt stack (which had shipped `edit_script`) and the grammar.
- `exp_grammar.ts` runs its `main()` on import (no entrypoint guard), so its
  grammar/session code is copied, not imported; DIVERSE_EXAMPLES/ANTIPATTERNS are
  copied verbatim from `exp_prompt.ts` (not exported there); `parseDiags`/`hintFor`
  are imported.

## Routing (deterministic, logged before any generation)

| task              | score | route    | template        | gold-ok |
| ----------------- | ----- | -------- | --------------- | ------- |
| pinwheel          | 1     | scratch  | —               | —       |
| breathing-red     | 4     | template | breathing-pulse | yes     |
| rainbow-sweep     | 4     | template | rainbow-sweep   | yes     |
| comet             | 3     | template | comet           | yes     |
| fire              | 1     | scratch  | —               | —       |
| twinkle           | 1     | scratch  | —               | —       |
| color-wipe        | 1     | scratch  | —               | —       |
| two-tone-gradient | 3     | template | color-test      | yes     |

## Per-task results (pass 2 = metric of record)

| task              | route (tpl)                | compiled  | judge    | sec | notes                                                                    |
| ----------------- | -------------------------- | --------- | -------- | --- | ------------------------------------------------------------------------ |
| pinwheel          | scratch                    | **ok@r1** | **1.00** | 22  | ≈ the DIVERSE_EXAMPLES atan2 example (speed default changed)             |
| breathing-red     | template (breathing-pulse) | **ok@r1** | **0.85** | 23  | genuinely modified (sim 0.60): sin update + mix-to-white                 |
| rainbow-sweep     | template (rainbow-sweep)   | FAIL (3r) | 0.40     | 42  | rewrote shade with odd atan2, trailing `};` never fixed                  |
| comet             | template (comet)           | **ok@r1** | **1.00** | 24  | kept template uniforms, swapped in EXAMPLE 3 tail math (sim 0.67)        |
| fire              | scratch                    | ok@r1     | 0.00     | 24  | compiles but cool/blue palette + imu.gyro misuse                         |
| twinkle           | scratch                    | ok@r1     | 0.00     | 22  | compiles but global blink, no per-LED hash                               |
| color-wipe        | scratch                    | FAIL (3r) | 0.00     | 39  | `led.count` in update() + undeclared `trail` + braceless for             |
| two-tone-gradient | template (color-test)      | FAIL (3r) | 0.30     | 53  | broke template: global `float x` + `+=` (both in the ANTIPATTERNS block) |

**Headline: compiled-and-correct 3/8 (baseline 0/8) · comp 5/8 = 63% (baseline 50%) ·
mean judge 0.44 (baseline 0.05) · rounds-to-compile: 1 for every compiled cell ·
~31 s/cell mean on an idle box (22–53 s) · no truncation, tool-call% 100%.**

## Conflicts found (and what was done)

1. **Empty-source degenerate mode (pass 1)**: exp_grammar's envelope allows
   `source ::= schar*` — zero characters. In the joint config the model closed the
   source string immediately on 2/8 tasks (pinwheel, two-tone-gradient), emitting
   `"source":""` in all 3 rounds (never observed in exp_grammar's own runs). Pass 1
   scored **2/8** (`results-pass1.json`). Fix, faithful to the envelope's intent (an
   empty program is not a program): grammar requires ≥1 source char, plus a targeted
   "source was EMPTY" repair message if a blank still slips through. Pass 2 flipped
   pinwheel to 1.00@r1 (real content on the first try) and two-tone-gradient to a real
   (still failing) attempt. Everything else reproduced pass 1 exactly (seed 42).
2. **edit_script vs grammar** (anticipated): resolved by advertising `set_script` only
   and trimming the repair text, per exp_grammar's precedent. No other conflict between
   the combined prompt splices and grammar-constrained decoding.
3. **Template route can regress grammar-alone wins**: rainbow-sweep judged **1.0
   compiled** under grammar-alone (`../grammar/REPORT.md`) but FAILED here on the
   template route — the model broke the template while modifying it (the template
   report's finding 3, reproduced). Net across 8 tasks routing still pays (comet and
   two of three other template cells won), but per-task routing is not uniformly ≥
   the from-scratch path.

## Attribution (from transcripts/sources)

- **Diverse examples** drove pinwheel (source ≈ EXAMPLE 1) and comet's shade body
  (EXAMPLE 3 math inside the template's uniform frame) — consistent with exp_prompt,
  where examples accounted for essentially all semantic gain.
- **Template routing** drove breathing-red (0.85, genuinely modified) and supplied
  comet's compiling frame; both near-route wins were r1, ~25 s — the "near-library asks
  are reliable" claim holds in composition.
- **Grammar** delivered 100% tool-call compliance (8/8 cells, every round, zero JSON
  breakage or prose recoveries) and is why every win landed at round 1; its one gap
  (empty source) was closed by the schar+ tightening.
- **Enriched repair feedback** was the weak link: all three FAIL cells burned both
  repair rounds without fixing a one-line diagnostic (trailing `};`, braceless `for`,
  `+=`). Two of the three offending constructs are named in the ANTIPATTERNS block —
  the model violates them anyway, and `hintFor` has no case for `expected '{'` /
  `expected '('`.
- The two compiled-but-wrong cells (fire, twinkle) are the pure **semantics wall**:
  the repair loop never engages on a compiling-but-wrong program, and nothing in the
  stack pushes per-LED randomness (hash-by-index).

## Offline expectations (honest)

On this evidence, a fully offline qwen2.5-3b Q4_K_M authoring path lands **about a
third of asks compiled-and-correct end-to-end (3/8 here), roughly half if the user
accepts near-misses** (rainbow-sweep 0.40 and two-tone-gradient 0.30 are visually
"almost"), versus zero for the unharnessed baseline. The wins are exactly the
predicted classes: asks near the template library and asks near a worked example;
both land in one round, which on a phone CPU (~2–4 tok/s) still means minutes, not
seconds, per turn — though the grammar's short, envelope-only outputs (~31 s/cell on
this box, vs minutes previously) help latency too. What offline does NOT get you:
novel texture/randomness semantics (fire, twinkle) and reliable repair of
non-compiling attempts — 0/3 rescues in 2 extra rounds each. Product framing should
stay "reliable for library-adjacent asks and simple pattern-class effects; cloud for
the rest." Growing the template library (a fire/twinkle entry would likely have
flipped both) is the cheapest lever, since near-template routing is the most reliable
path in the stack; the repair loop is the least productive place to spend further
effort at 3B.

## Files

- Runner: `/workspace/tools/model_eval/src/exp_joint.ts`
- Metric of record: `/workspace/tools/model_eval/experiments/joint/results.json` (+ `run.log`)
- Pass 1 (pre-tightening): `results-pass1.json` (+ `run-pass1.log`)
- Baseline: `/workspace/tools/model_eval/results.json`; strategy reports:
  `../{grammar,prompt,template,skeleton,bestofn}/REPORT.md`; synthesis: `../SYNTHESIS.md`
