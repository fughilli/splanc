# Small-model offline effect authoring — five-strategy synthesis

Question: is on-device (phone-CPU GGUF) effect authoring limited by the models, or
fixable with harnessing? Five strategies were built and measured against the same
baseline (qwen3-0.6b / qwen2.5-1.5b / qwen2.5-3b × pinwheel, breathing-red,
rainbow-sweep, comet; multi-turn compile-repair loop; real fx_compile; Opus judge).
Baseline on these 4 tasks: comp 0%/25%/50%, judge 0.00 everywhere.

## Scoreboard

| Strategy                       | Best result                                                                                                          | Verdict                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Grammar envelope (GBNF)**    | 3b: comp 50→75%, judge 0.00→**0.40–0.47** (rainbow 1.0)                                                              | **ADOPT** (≥3B)                                                    |
| **Diverse few-shot examples**  | judge 0.01→**0.31** alone (3b **0.55**); combined stack: multiple compiled-AND-correct incl. 3b pinwheel **1.00**@r1 | **ADOPT**                                                          |
| **Skeleton fill-in**           | comp 0.6b **0→100%**, 3b **50→100%**, all @r1 — but judge ~0                                                         | ADOPT as substrate (kills structure errors; doesn't add semantics) |
| **Template retrieval+mod**     | near-template asks judge **1.0** (even 0.6b); far asks unrescued; model-driven retrieval fails                       | ADOPT as routing layer                                             |
| **Best-of-N + compile filter** | oracle ceiling 0.00; 3b regressed 50→0%                                                                              | **REJECT**                                                         |

## The two walls (now cleanly separated)

1. **Format/structure wall** — narrating instead of tool-calling, broken JSON,
   invalid program shape. **Fully solved mechanically**: grammar envelope or
   skeleton fill-in eliminates it by construction, at any model size. This was
   the user-visible failure ("printed a program into chat") and it is harnessing.
2. **Semantics wall** — programs that compile but don't do the task. Unmoved by
   structure fixes and unmovable by sampling (BoN oracle = 0). Moved ONLY by:
   diverse examples (+0.3–0.55 judge), grammar freeing capacity (+0.4 on 3b),
   and template routing (sidesteps it entirely for near-library asks). Scales
   with model size; ~3B is the floor for from-scratch authoring.

## Recommended stack (composable; compositions not yet jointly measured)

1. Route the ask: heuristic retrieval over the effect library → if near-template,
   offer template / parameter-tweak turn (works even on 0.6b, judge 1.0 class).
2. From-scratch (far) asks: ≥3B model + grammar-constrained tool-call envelope +
   the DIVERSE_EXAMPLES prompt (3 pattern-diverse few-shots incl. the atan2
   pinwheel) + enriched repair feedback, in the existing repair loop.
3. Drop qwen3-0.6b as the authoring default (0% compile in every configuration
   tested); it remains fine for template selection/param tweaks only.
4. Do not ship best-of-N; do not ship bare antipattern lists (judge 0.00 —
   models retreat to constant-color programs).

## ON-DEVICE LATENCY (phone spot-check — the binding constraint)

Container timings do NOT transfer to a phone. Measured on a Pixel 10 Pro Fold:

- **qwen3-0.6b + grammar + diverse-examples prompt ran 50 MINUTES with no result**,
  then a second repair round ("fixing compile error"), before the user killed it.
- Mechanism: the 0.6b compiles 0% → every turn fails → repair loop; each round
  generates up to `n_predict:2048` tokens under grammar at ~2–4 tok/s. Failing
  turns compound to tens of minutes. (Grammar per-token overhead is modest; a 3B
  round-1 SUCCESS was ~31s in the container — but ~5–10× that on a phone, and
  failures multiply it by rounds.)
- **Required fix before any on-device productization:** cap `n_predict`≈512
  (programs are ~150–400 tokens; 2048 is a latency footgun) and rounds≈2. Bounds a
  worst-case failing turn from ~50 min → ~5 min.

Implication: on-device latency, not quality, is the wall. From-scratch authoring
that misses round-1 is impractical on a phone even at 3B. The honestly-shippable
offline capability is the SHORT, ROUND-1 path: near-library/template asks and
parameter tweaks.

## Offline performance expectations (honest)

- Phone-CPU model: qwen2.5-3b-instruct Q4_K_M (~1.9GB download, ~2.5GB RAM);
  decode ~2–4 tok/s on a flagship phone → **minutes per authoring turn**.
- Near-library asks (colors/speed/known patterns): **reliable** (judge 1.0 class,
  round 1) — this should be the advertised offline capability.
- From-scratch simple effects w/ full stack: expect roughly **⅓–½ of asks
  compiled-and-correct** within a few repair rounds (measured components:
  grammar 75% comp/0.4+ judge; examples 0.55 judge on 3b; joint stack untested).
- Complex/novel effects offline: not honest to promise at ≤3B today.

## Evidence

experiments/{grammar,prompt,skeleton,template,bestofn}/REPORT.md + results JSONs;
baseline: ../results.json. Harness: src/run.ts + src/exp\_\*.ts.
