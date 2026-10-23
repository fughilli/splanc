# fx_agent_eval — agent authoring quality for the FX engine

Measures how well the two Splanc authoring paths write _fast_ effects for the
ESP32-C6 (no FPU), statically, from the source plus `fx_compile --disasm`.

- **A — in-app effect AI**: system prompt = `SYSTEM_PROMPT` from
  `web/src/effects/ai/system-prompt.ts` (rendered with node type stripping).
- **B — MCP agent skill**: `agent/skill/{SKILL,effect-language,geometry,uniforms-and-ui}.md`
  - `agent/skill/examples/*.fx`, plus a note that device tools are unavailable and
    the reply must be only the effect source.

Variants: `app` (A), `skill` (B), `app_perf` (A + `perf_addendum.txt` appended),
`app_lint` (the `app` program, then one revision round that feeds back this
tool's lint warnings; the revision is kept only if it compiles).

The committed `app` / `skill` / `app_perf` / `app_lint` runs are the
fx-perf-study baseline: their prompts are in `out/system/<variant>.txt`, from
before the R6 prompt fixes. `app2` / `skill2` render the same two paths from the
current tree (the after leg, same 15 prompts), and `app2_est` / `skill2_est`
close the estimate loop: take the `*2` program and, only if the offline
estimate is over the 33 ms frame, run one revision round fed what
`estimate_effect` returns — the estimate plus the top cost findings
(`web/src/effects/perfFindings.ts`, via `estimate.mjs`).

## Files

| file                                                              | what                                                                                                                                                                                                                               |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompts.json`                                                    | the 15 fixed requests (p01..p15) + the fixture context line appended to each                                                                                                                                                       |
| `gen.py`                                                          | calls `claude -p` (tools off, `--system-prompt-file`, `--model`), extracts the first code block, compiles it, up to 2 repair rounds (same session, `--resume`; message mirrors `repairTurn()` in `web/src/effects/ai/generate.ts`) |
| `estimate.mjs`                                                    | the app/agent estimate + top cost findings for compiled programs (node ≥ 22, this tree's `web/src`); `gen.py`'s `*_est` variants call it                                                                                           |
| `analyze.py`                                                      | per-LED / per-frame op counts, heavy builtins, fixed usage, loops, variance (hoistable / memoizable) analysis, perf lint, rough cycle estimate → `out/analysis.json` + `out/summary.md`                                            |
| `perf_addendum.txt`                                               | ≤25-line cost table + rules + one worked fast example (compiles), appended for `app_perf`                                                                                                                                          |
| `out/runs/*.json`                                                 | one record per generated program: raw replies, diagnostics, tokens, wall time, cost                                                                                                                                                |
| `out/system/*.txt`                                                | the rendered system prompts actually sent                                                                                                                                                                                          |
| `../../firmware/fx_perf_bench/agent/<variant>__<model>__<pid>.fx` | the final programs (2-line provenance header)                                                                                                                                                                                      |

## Rerun

Needs: `claude` CLI logged in, node ≥ 22, and a host `fx_compile`
(`bazel build //fx_compiler:fx_compile`). gen/analyze default to
`~/perf/fx_compile`; override with `--fx-compile` or `FX_COMPILE=`.

```sh
cd tools/fx_agent_eval
cp ../../bazel-bin/fx_compiler/fx_compile ~/perf/fx_compile   # stable copy
# A and B with two models (60 programs), A + addendum with opus (15)
python3 gen.py --plan app=opus+sonnet,skill=opus+sonnet,app_perf=opus --jobs 4
# lint-feedback revision of the app/opus programs (needs the app runs above)
python3 gen.py --plan app_lint=opus --jobs 4
# the after leg on the current prompts, then the estimate+findings round
python3 gen.py --plan app2=opus+sonnet,skill2=opus+sonnet --jobs 4
python3 gen.py --plan app2_est=opus+sonnet,skill2_est=opus+sonnet --jobs 4
python3 analyze.py            # all of firmware/fx_perf_bench/agent/*.fx
python3 analyze.py some.fx    # or individual files / dirs (e.g. ../../firmware/fx_perf_bench/effects)
```

Runs are cached: a program whose `out/runs/<name>.json` exists is skipped
(`--force` regenerates; `--prompts p01,p02` limits the set). At most 4 `claude`
processes run at once. Model short names: `opus`=claude-opus-5-5,
`sonnet`=claude-sonnet-4-6, `haiku`=claude-haiku-4-5. OpenAI was not run (no key
in the credentials store).

## How the analysis works (and its limits)

- **Counts** walk `shade` (+ called user functions) in bytecode; loops are
  multiplied by their trip count when the header is the compiler's
  `LOAD_LOCAL i; PUSH_CONST N; BR_CMP_I` shape (else 8, flagged
  `known_trip_count: false`). **All branch arms are counted** (upper bound),
  except the first-frame cache-fill idiom (`if (<frame-only cond>) { buf[i] = ... }`),
  which is excluded.
- **Cycle estimate** (`cost()`): ~70 dispatch per op + the measured soft-float
  costs (float add/mul ~100-200, sin/cos ~570, sqrt ~680, atan2 ~1040, pow ~1800,
  length/normalize/distance/smoothstep/hsv2rgb 700-1600, int/fixed 70-150). It is a
  rough ranking aid, not a replacement for `tools/fx_perf` on-device numbers.
- **Variance**: abstract interpretation of the operand stack and locals over the
  shade CFG (functions inlined context-sensitively), lattice
  const < frame | led < dynamic, with control taint from data-dependent branches.
  `frame` = time/dt/frame/uniforms/state/imu; `led` = led.*(except `led.dist`,
  which `flood_from` can re-root → dynamic); buffer/texture reads → dynamic.
  *hoistable* = compute ops whose result is const/frame (wasted 500×/frame);
  *memoizable\* = led-only results (could be cached per LED in a buffer).
- **Lint** source lines come from matching the k-th bytecode op of a builtin to
  the k-th textual call in the same function, so a line can be off when the
  optimizer folded a call away.
