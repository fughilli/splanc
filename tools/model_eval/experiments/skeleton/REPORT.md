# Skeleton / fill-in-the-blank DSL authoring — experiment report

**Question:** small (0.6B–3B) models mostly fail whole-program DSL authoring on
_structural_ grounds (code outside functions, `led` in `update()`, undeclared
buffers, invented library functions). If the harness owns the program skeleton
and the model only fills constrained holes, does the structural failure class
disappear — and does anything useful remain?

Run: 2026-09-08, `npx tsx src/exp_skeleton.ts` (defaults), 3 models x 4 tasks
(pinwheel, breathing-red, rainbow-sweep, comet), 4-round repair budget, judge on
(same rubric/judge as baseline). Raw cells: `experiments/skeleton/results.json`
(merged; the 3B cells were rerun into `results-3b.json` after an OOM — see Ops
notes). Comparison tool: `node experiments/skeleton/analyze.mjs`.

## The fill-in scheme (what the model sees)

The model never sees `set_script`/`edit_script` tools. It returns ONE JSON
object with exactly four fields:

```json
{
  "uniforms": ["float speed : 0.0 .. 5.0 = 1.0"],
  "state": ["float phase"],
  "update_body": "phase = phase + dt * speed;",
  "shade_body": "... return vec3(...);"
}
```

The harness assembles the final program from a fixed template
(`uniform ...;` lines, `state ...;` lines, `void update() { <update_body> }`,
`vec3 shade(Led led) { <shade_body> }`), normalizing model quirks along the way:
redundant `uniform`/`state` keywords and trailing `;` in decl entries are
stripped, state initializers dropped, bodies unwrapped if the model re-emits the
function header, code fences stripped. Extraction is deliberately lenient
(tolerant JSON parse -> balanced-object scan -> per-field salvage from truncated
JSON). Same repair loop as baseline: compile with the real `fx_compile`, feed
numbered source + diagnostics back, up to 4 asks. Same sampling (temp 0.7 /
topK 20 / topP 0.8 / seed 42 / repeatPenalty 1.1).

## Results: baseline vs skeleton

Baseline = whole-program `set_script` authoring from `results.json`, same 12
cells (same models/tasks/rounds/judge). (The model-level baseline rows quoted in
the task — judge 0.03/0.03/0.05 — average over all 8 tasks; on the matched
4-task subset every baseline cell judged 0.00.)

| model                 | eff% base->skel | comp% base->skel | mean rounds-to-compile base->skel | judge base->skel |
| --------------------- | --------------- | ---------------- | --------------------------------- | ---------------- |
| qwen3-0.6b            | 100 -> 100      | **0 -> 100**     | - -> 1.0                          | 0.00 -> 0.10     |
| qwen2.5-1.5b-instruct | 100 -> 100      | 25 -> 25         | 2.0 -> 1.0                        | 0.00 -> 0.00     |
| qwen2.5-3b-instruct   | 100 -> 100      | **50 -> 100**    | 2.5 -> 1.0                        | 0.00 -> 0.00     |
| **overall**           | 100 -> 100      | **25 -> 75**     | 2.3 -> 1.0                        | 0.00 -> 0.03     |

Protocol health: 12/12 cells extracted clean JSON on round 1 (`ext=json`
everywhere, 0 protocol errors, 0 salvage-path hits, no thinking spam). The JSON
fill contract is something even the 0.6B model can hold.

Every skeleton compile success happened at **round 1** — the repair loop never
rescued anything (in either direction: the three 1.5B failures burned all 4
rounds without converging).

## Where the failures moved

**Baseline failures (9/12 cells): structural + vocabulary.** 8 of 9 diagnostics
are `unknown identifier`; reading the sources, they are whole-program structure
errors the skeleton makes impossible by construction:

- `led` used inside `update()` (qwen3-0.6b pinwheel/rainbow, 1.5b breathing,
  3b rainbow/comet), plus `return` statements inside `void update()`;
- undeclared persistent buffers: `trail[led.idx] = ...` (0.6b, 3b — the DSL has
  no arrays);
- invented library calls: `palette1/palette2`, `seg_len`, `paint(img, ...)`;
- code outside any function (0.6b comet: top-level `for` loop);
- malformed state decls (`state a = {phase: 0, ...}`, `state T time;` inside
  update). 1 of 9 was top-level syntax (`expected '('`).

**Skeleton failures (3/12 cells, all qwen2.5-1.5b): pure expression-level
syntax.** No vocabulary-class failure remains; every diagnostic is
`expected '='` / `expected ';'` inside a hole:

- pinwheel: `phase += dt * speed` — compound assignment `+=` isn't in the DSL
  (also `pi`, `%`, `++i` further down);
- rainbow-sweep: `return vec3(v, 0.0, 0.0)` missing its trailing `;`;
- comet: uniform hole entry `vec3 color : vec3(0, 0, 1)` — invalid uniform
  syntax (should be `: color = r, g, b`), plus an undeclared `phase`.

So the relocation is exactly as hypothesized: the harness owning the structure
deleted the structural/vocabulary class, and what failure remains lives inside
individual expressions/statements. Note the 1.5B repair anomaly: it repeats the
same `+=`-style mistakes across all 4 repair rounds (it also _regressed_
vs baseline on pinwheel, the one task it used to compile), while 3B never needs
a repair round at all.

**But the failures that moved furthest went past the compiler.** Judge scores
barely moved (0.00 -> 0.03 overall). The compiled programs are semantically
wrong or trivial:

- qwen2.5-3b breathing-red compiles... to `return color;` — solid red, no
  breathing (judge 0).
- qwen3-0.6b's four round-1 compiles are near-verbatim copies of the system
  prompt's example fill (`0.5 + 0.5*sin(phase + led.s*6.2832)`, red channel
  only) regardless of task — its single non-zero score (0.4 on breathing-red)
  is the task the example happens to resemble. Example-anchoring, not ability.
- Typical judge rationales: no angle/atan2 for pinwheel, no hue variation for
  rainbow, no localized head+tail for comet.

## Verdict

**Harness-owned structure rescues _compilation_, not _competence_.** Compile
rate tripled (25% -> 75%), qwen3-0.6b went 0% -> 100%, qwen2.5-3b 50% -> 100%,
and everything that compiles does so on the first try — the structural failure
class provably disappears by construction, and the JSON fill protocol is
reliable even at 0.6B. That alone makes the scheme worth adopting: it converts
"model emits garbage that can't run" into "model emits a valid program you can
render, show the user, and iterate on", at 1 round instead of 2.3.

But it moves the bottleneck rather than removing it: on this 4-task set the
judge scores stay ~0 because the surviving failure mode is semantic (wrong
effect), and for the smallest model the compiling fills are mostly template
echoes. The 1.5B model shows the scheme's floor — it can't reliably write even
hole-sized DSL expressions (`+=`, missing `;`) and its repair rounds don't
converge. Skeleton fill-in is the right substrate, but getting actual effect
quality out of sub-3B models needs the next experiment on top of it (per-hole
grammar constraints for the 1.5B-style syntax residue; richer exemplars or
best-of-N + judge for the semantic gap).

## Ops notes

- Total on-device generation time ~15,000 s (heavily contended CPU, load ~21;
  the 1.5B failure cells burned 2,000-4,900 s each going through all 4 rounds).
- The original single-process sweep was OOM-killed at the 3B model load
  (container has ~11.6 GB; four concurrent model_eval experiments held
  ~8.5 GB anon). The 0.6b/1.5b cells persisted incrementally; the 3B cells were
  rerun via `experiments/skeleton/run3b.sh` (waits for >3.3 GB available, runs
  `--models=qwen2.5-3b-instruct --out=.../results-3b.json`, retries on OOM) and
  merged into `results.json`. Weights load into anonymous memory here (no
  usable mmap sharing), so budget ~3 GB free before launching a 3B run.

Files: `src/exp_skeleton.ts` (runner), `src/exp_skeleton.selftest.ts` (passes),
`experiments/skeleton/{results.json,results-3b.json,analyze.mjs,sweep.log,sweep-3b.log,run3b.sh}`.
