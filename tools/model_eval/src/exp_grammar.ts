/**
 * EXPERIMENT: grammar-constrained decoding (GBNF) for the tool-call envelope.
 *
 * Hypothesis: small models fail mostly on PROTOCOL (narrating instead of tool-
 * calling, broken tool-call JSON, unescaped newlines), not on the program itself.
 * llama.cpp grammar sampling can force every generated token to stay inside
 *   <tool_call>{"name":"set_script","arguments":{"summary":"…","source":"…"}}</tool_call>
 * which should push tool% to ~100 and eliminate JSON breakage outright.
 *
 * Two variants:
 *   envelope — constrain ONLY the tool-call envelope; `source` is any valid
 *              JSON string body.
 *   dsl      — envelope + cheap DSL nudges inside `source`: it must START with a
 *              plausible top-level DSL token (uniform/void/vec3/state/buffer/
 *              texture/struct/float/int/bool/vec2/vec4-space or //-comment) and
 *              may never contain `#` (kills #define/#include GLSL-isms) or
 *              backticks (kills markdown fences).
 *
 * Same multi-turn repair loop as src/run.ts (up to 3 rounds), same sampling
 * (temp 0.7, topK 20, topP 0.8, seed 42, repeatPenalty 1.1). The repair turn is
 * ALSO grammar-constrained: the model cannot apologize in prose — it must emit
 * another full set_script call. edit_script is NOT advertised (the grammar only
 * admits set_script, so advertising an uncallable tool would be incoherent).
 *
 * Run (from tools/model_eval/):
 *   npx tsx src/exp_grammar.ts [--models=a,b] [--tasks=x,y] [--variants=envelope,dsl]
 *                              [--rounds=3] [--no-judge] [--smoke]
 * Writes experiments/grammar/results.json.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  getLlama,
  LlamaChatSession,
  type Llama,
  type LlamaModel,
  type LlamaGrammar,
} from "node-llama-cpp";
import {
  parseToolCalls,
  recoverSetScriptFromProse,
  stripCodeFence,
} from "../../../web/src/effects/ai/providers/wllamaProtocol";
import { MODELS, type EvalModel } from "./models";
import { TASKS, type EvalTask } from "./tasks";
import { buildAuthoringPrompt, STARTER_SOURCE } from "./prompt";
import { compile, fxCompileAvailable } from "./compile";
import { judge, judgeKey } from "./judge";

const here = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = resolve(here, "../models");
const OUT_DIR = resolve(here, "../experiments/grammar");
const BASELINE_PATH = resolve(here, "../results.json");

const DEFAULT_MODELS = ["qwen3-0.6b", "qwen2.5-1.5b-instruct", "qwen2.5-3b-instruct"];
const DEFAULT_TASKS = ["pinwheel", "breathing-red", "rainbow-sweep", "comet"];

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

// ---------------------------------------------------------------------------
// GBNF grammars
// ---------------------------------------------------------------------------

/** JSON-string character rule (from llama.cpp's json.gbnf), optionally with
 * extra forbidden raw characters. */
function jsonChar(extraForbidden = ""): string {
  return (
    `[^"\\\\\\x7F\\x00-\\x1F${extraForbidden}] | "\\\\" (["\\\\/bfnrt] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F])`
  );
}

/** Variant A: force the exact set_script tool-call envelope. summary first,
 * source LAST so a maxTokens truncation is still salvageable by the harness's
 * partial-JSON recovery. */
function envelopeGbnf(): string {
  return [
    String.raw`root ::= ws "<tool_call>{\"name\":\"set_script\",\"arguments\":{\"summary\":\"" summary "\",\"source\":\"" source "\"}}</tool_call>"`,
    `ws ::= [ \\t\\n]*`,
    `summary ::= schar*`,
    `source ::= schar*`,
    `schar ::= ${jsonChar()}`,
  ].join("\n");
}

/** Variant B: envelope + cheap DSL shaping of `source`:
 *  - must start with a plausible top-level DSL token (or a // comment) — blocks
 *    prose, markdown fences and "Here's your effect:" restarts;
 *  - `#` is banned everywhere (no #define/#include/#version GLSL-isms);
 *  - backticks are banned (no markdown fences inside the string). */
function dslGbnf(): string {
  const starters = [
    `"uniform "`,
    `"void "`,
    `"vec3 "`,
    `"vec2 "`,
    `"vec4 "`,
    `"state "`,
    `"buffer "`,
    `"texture "`,
    `"struct "`,
    `"float "`,
    `"int "`,
    `"bool "`,
    `"// "`,
  ].join(" | ");
  return [
    String.raw`root ::= ws "<tool_call>{\"name\":\"set_script\",\"arguments\":{\"summary\":\"" summary "\",\"source\":\"" starter source "\"}}</tool_call>"`,
    `ws ::= [ \\t\\n]*`,
    `summary ::= schar*`,
    `starter ::= ${starters}`,
    `source ::= dchar*`,
    `schar ::= ${jsonChar()}`,
    `dchar ::= ${jsonChar("#\\x60")}`,
  ].join("\n");
}

const VARIANTS: Record<string, () => string> = { envelope: envelopeGbnf, dsl: dslGbnf };

// ---------------------------------------------------------------------------
// Grammar-constrained session (adapted from src/backend.ts — kept separate per
// the no-touching-shared-files rule)
// ---------------------------------------------------------------------------

let llama: Llama | null = null;
let current: { path: string; model: LlamaModel } | null = null;

async function getLlamaInstance(): Promise<Llama> {
  if (!llama) llama = await getLlama({ logLevel: "error" as never });
  return llama;
}

async function getModel(modelPath: string): Promise<LlamaModel> {
  const l = await getLlamaInstance();
  if (current && current.path === modelPath) return current.model;
  if (current) {
    await current.model.dispose();
    current = null;
  }
  const model = await l.loadModel({ modelPath });
  current = { path: modelPath, model };
  return model;
}

interface GSession {
  ask(userText: string): Promise<{ text: string; seconds: number; stopReason: string }>;
  dispose(): Promise<void>;
}

async function startGrammarSession(
  modelPath: string,
  system: string,
  grammar: LlamaGrammar,
): Promise<GSession> {
  const model = await getModel(modelPath);
  const context = await model.createContext({ contextSize: 8192 });
  const session = new LlamaChatSession({
    contextSequence: context.getSequence(),
    systemPrompt: system + "\n\n/no_think",
  });
  return {
    async ask(userText: string) {
      const t0 = Date.now();
      const meta = await session.promptWithMeta(userText, {
        maxTokens: 2048,
        temperature: 0.7,
        topK: 20,
        topP: 0.8,
        seed: 42,
        repeatPenalty: { penalty: 1.1, lastTokens: 64 },
        grammar,
        // Belt-and-braces: a Qwen3 <think> segment would fight the grammar, so
        // zero the thought budget too (grammar already excludes the token).
        budgets: { thoughtTokens: 0 },
      });
      return {
        text: meta.responseText.trim(),
        seconds: (Date.now() - t0) / 1000,
        stopReason: meta.stopReason,
      };
    },
    async dispose() {
      await context.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Cell runner — same repair-loop structure as src/run.ts (set_script only)
// ---------------------------------------------------------------------------

interface Cell {
  variant: string;
  model: string;
  task: string;
  compiled: boolean;
  compiledAtRound: number;
  roundsUsed: number;
  obtained: "tool_call" | "recovered" | "none";
  emittedToolCall: boolean;
  compileDiag: string;
  judgeScore: number | null;
  judgeRationale: string;
  seconds: number;
  truncated: boolean; // any round hit maxTokens (grammar can't force brevity)
  source: string;
  replyHeads: string[];
}

async function runCell(
  variant: string,
  model: EvalModel,
  task: EvalTask,
  grammar: LlamaGrammar,
  key: string | null,
  rounds: number,
): Promise<Cell> {
  const modelPath = resolve(MODELS_DIR, model.file);
  // Same production prompt as the baseline, but WITHOUT the experimental
  // edit_script tool: the grammar only admits set_script.
  const { system, user } = buildAuthoringPrompt(task.ask, STARTER_SOURCE, { edit: false });
  const sess = await startGrammarSession(modelPath, system, grammar);

  let source = STARTER_SOURCE;
  let compiled = false;
  let compiledAtRound = 0;
  let roundsUsed = 0;
  let obtained: Cell["obtained"] = "none";
  let emittedToolCall = false;
  let compileDiag = "";
  let seconds = 0;
  let truncated = false;
  const replyHeads: string[] = [];
  let userMsg = user;

  try {
    for (let r = 1; r <= rounds; r++) {
      roundsUsed = r;
      const out = await sess.ask(userMsg);
      seconds += out.seconds;
      truncated = truncated || out.stopReason === "maxTokens";
      replyHeads.push(out.text.slice(0, 120));

      const { calls } = parseToolCalls(out.text);
      const setCall = calls.find((c) => c.name === "set_script");
      let applied = false;

      if (setCall) {
        source = stripCodeFence(String((setCall.input as { source?: unknown }).source ?? ""));
        obtained = "tool_call";
        emittedToolCall = true;
        applied = true;
      } else {
        // Only reachable on maxTokens truncation (grammar guarantees the shape
        // otherwise) — the partial-JSON recovery pulls `source` out anyway.
        const rec = recoverSetScriptFromProse(out.text);
        if (rec) {
          source = rec.input.source;
          applied = true;
          if (obtained === "none") obtained = "recovered";
        }
      }

      if (!applied) {
        if (r === rounds) break;
        userMsg =
          "<tool_response>No script change detected. Call set_script with the full effect program.</tool_response>";
        continue;
      }

      const comp = compile(source);
      if (comp.ok) {
        compiled = true;
        compiledAtRound = r;
        compileDiag = "";
        break;
      }
      compileDiag = comp.diagnostics;
      userMsg =
        `<tool_response>Compile FAILED:\n${comp.diagnostics}\n` +
        `Fix the error(s): call set_script with the corrected full program.</tool_response>`;
    }
  } finally {
    await sess.dispose();
  }

  let judgeScore: number | null = null;
  let judgeRationale = "";
  if (key && obtained !== "none" && source) {
    try {
      const j = await judge(task.ask, task.rubric, source, compiled, key);
      judgeScore = j.score;
      judgeRationale = j.rationale;
    } catch (e) {
      judgeRationale = `judge error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return {
    variant,
    model: model.id,
    task: task.id,
    compiled,
    compiledAtRound,
    roundsUsed,
    obtained,
    emittedToolCall,
    compileDiag: compileDiag.slice(0, 200),
    judgeScore,
    judgeRationale,
    seconds,
    truncated,
    source,
    replyHeads,
  };
}

// ---------------------------------------------------------------------------
// Baseline comparison + main
// ---------------------------------------------------------------------------

interface BaselineCell {
  model: string;
  task: string;
  compiled: boolean;
  obtained: string;
  emittedToolCall: boolean;
  judgeScore: number | null;
}

function summarize(cells: { emittedToolCall: boolean; obtained: string; compiled: boolean; judgeScore: number | null }[]): {
  n: number; tool: number; eff: number; comp: number; judge: number | null;
} {
  const n = cells.length;
  const judged = cells.filter((c) => c.judgeScore !== null);
  return {
    n,
    tool: cells.filter((c) => c.emittedToolCall).length,
    eff: cells.filter((c) => c.obtained !== "none").length,
    comp: cells.filter((c) => c.compiled).length,
    judge: judged.length ? judged.reduce((a, c) => a + (c.judgeScore ?? 0), 0) / judged.length : null,
  };
}

const pct = (n: number, d: number): string => (d === 0 ? "  - " : `${Math.round((100 * n) / d)}%`.padStart(4));

async function main(): Promise<void> {
  if (!fxCompileAvailable()) throw new Error("fx_compile not built");
  const rounds = Number(arg("rounds") ?? "3");
  const key = flag("no-judge") ? null : judgeKey();
  const modelIds = (arg("models") ?? DEFAULT_MODELS.join(",")).split(",");
  const taskIds = (arg("tasks") ?? DEFAULT_TASKS.join(",")).split(",");
  const variantIds = (arg("variants") ?? "envelope,dsl").split(",");
  const models = MODELS.filter((m) => modelIds.includes(m.id));
  const tasks = TASKS.filter((t) => taskIds.includes(t.id));

  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = resolve(OUT_DIR, "results.json");
  process.stdout.write(
    `grammar experiment: rounds=${rounds} judge=${key ? "on" : "off"} variants=${variantIds.join("+")} ` +
    `models=${models.length} tasks=${tasks.length}\n`,
  );

  const l = await getLlamaInstance();
  const grammars = new Map<string, LlamaGrammar>();
  for (const v of variantIds) {
    const build = VARIANTS[v];
    if (!build) throw new Error(`unknown variant ${v}`);
    grammars.set(v, await l.createGrammar({ grammar: build() }));
  }

  const cells: Cell[] = [];
  const persist = (extra: object = {}): void =>
    writeFileSync(outPath, JSON.stringify({ config: { rounds, variants: variantIds }, cells, ...extra }, null, 2));

  // models OUTER so each GGUF is loaded exactly once (backend evicts on switch).
  for (const model of models) {
    if (!existsSync(resolve(MODELS_DIR, model.file))) {
      process.stdout.write(`  ! missing model file for ${model.id} — skipping\n`);
      continue;
    }
    process.stdout.write(`\n=== ${model.id} ===\n`);
    for (const v of variantIds) {
      for (const task of tasks) {
        try {
          const c = await runCell(v, model, task, grammars.get(v)!, key, rounds);
          cells.push(c);
          const tc = c.emittedToolCall ? "TOOL" : c.obtained === "recovered" ? "recov" : "none ";
          const cp = c.compiled ? `ok@r${c.compiledAtRound}` : "FAIL   ";
          const js = c.judgeScore === null ? " - " : c.judgeScore.toFixed(2);
          process.stdout.write(
            `  [${v.padEnd(8)}] ${task.id.padEnd(15)} ${tc}  ${cp.padEnd(7)} judge=${js} ${c.truncated ? "TRUNC" : "     "} ${c.seconds.toFixed(0)}s\n`,
          );
        } catch (e) {
          process.stdout.write(`  ! cell ${v}/${model.id}/${task.id} failed: ${e instanceof Error ? e.message : String(e)}\n`);
        }
        persist();
      }
    }
  }
  if (current) {
    await current.model.dispose();
    current = null;
  }

  // ---- comparison vs baseline ----
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as { cells: BaselineCell[] };
  const baseCells = baseline.cells.filter((c) => modelIds.includes(c.model) && taskIds.includes(c.task));

  process.stdout.write("\n================== BASELINE vs GRAMMAR ==================\n");
  process.stdout.write("model                          arm       tool%  eff%  comp%  judge\n");
  const rows: object[] = [];
  for (const m of models) {
    const arms: [string, ReturnType<typeof summarize>][] = [
      ["baseline", summarize(baseCells.filter((c) => c.model === m.id))],
      ...variantIds.map((v): [string, ReturnType<typeof summarize>] => [
        v,
        summarize(cells.filter((c) => c.model === m.id && c.variant === v)),
      ]),
    ];
    for (const [arm, s] of arms) {
      process.stdout.write(
        `${m.id.padEnd(30)} ${arm.padEnd(9)} ${pct(s.tool, s.n)}  ${pct(s.eff, s.n)}  ${pct(s.comp, s.n)}  ${s.judge === null ? " - " : s.judge.toFixed(2)}\n`,
      );
      rows.push({ model: m.id, arm, ...s });
    }
  }
  persist({ rows });
  process.stdout.write(`\nwrote ${outPath}\n`);
}

void main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
