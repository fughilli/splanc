/**
 * EXPERIMENT: prompt surgery + better repair feedback for tiny CPU models.
 * (Own copy of the run.ts loop — shared harness files untouched.)
 *
 * Variants (--variant=):
 *   baseline3    — production compact prompt, raw diagnostics (3-round re-check)
 *   examples     — replace the single few-shot example with 3 tiny DIVERSE ones
 *                  (angle/radial via atan2+led.uv, time-oscillation via state,
 *                  moving head + fading tail via led.s) + "don't copy verbatim"
 *   antipatterns — append a NEVER-DO block distilled from the real observed
 *                  compile failures (verified against fx_compile: no #define,
 *                  no ++/+=/?:/while/const/globals, led only in shade, state
 *                  syntax, undeclared idents, raw source in tool JSON)
 *   feedback     — unchanged prompt; enrich the repair tool_response with the
 *                  offending source line + caret, a diagnostic→fix hint table,
 *                  and the full current script (so edits target reality)
 *   combined     — examples + antipatterns + feedback
 *
 * Usage: npx tsx src/exp_prompt.ts --variant=examples [--no-judge] [--rounds=3]
 * Writes experiments/prompt/results-<variant>.json
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  parseToolCalls,
  recoverSetScriptFromProse,
  stripCodeFence,
} from "../../../web/src/effects/ai/providers/wllamaProtocol";
import { formatToolInstructions } from "../../../web/src/effects/ai/providers/wllamaProtocol";
import { CHAT_SYSTEM_COMPACT } from "../../../web/src/effects/ai/chatPrompt";
import { TOOLS } from "../../../web/src/effects/ai/chatPrompt";
import type { ToolDef } from "../../../web/src/effects/ai/provider";
import { MODELS, type EvalModel } from "./models";
import { TASKS, type EvalTask } from "./tasks";
import { EDIT_TOOL, applyEdit, editorContext, STARTER_SOURCE } from "./prompt";
import { startSession, disposeBackend } from "./backend";
import { compile, fxCompileAvailable } from "./compile";
import { judge, judgeKey } from "./judge";

const here = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = resolve(here, "../models");
const OUT_DIR = resolve(here, "../experiments/prompt");

const EXP_MODELS = ["qwen3-0.6b", "qwen2.5-1.5b-instruct", "qwen2.5-3b-instruct"];
const EXP_TASKS = ["pinwheel", "breathing-red", "rainbow-sweep", "comet"];

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

// ---------------------------------------------------------------------------
// Variant prompt construction (string surgery on the production compact prompt)
// ---------------------------------------------------------------------------

/** 3 tiny DIVERSE worked examples (each verified to compile with fx_compile).
 * Chosen to span the pattern classes the tasks need: angle-from-center,
 * whole-map time oscillation, and a moving head with a decaying tail. */
const DIVERSE_EXAMPLES = `EXAMPLE 1 — rotating pinwheel (angle around the map center from led.uv):
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

These are PATTERNS, not answers: adapt the math to the actual request — never return an example unchanged, and never reference a variable an example declared unless YOU declare it too.`;

/** NEVER-DO block: every item is a real failure mode from results.json, and
 * every legality claim was verified against fx_compile. No backticks (the
 * block is spliced into a template literal downstream). */
const ANTIPATTERNS = `COMMON MISTAKES — each of these is a COMPILE ERROR, never do them:
- NO preprocessor: no #define / #include. Inline the number or declare a uniform.
- Every identifier must be DECLARED before use. Names like width, tint, phase do not exist unless you declare them (a 'uniform' at the top, or a local 'float x = 0.0;').
- 'led' exists ONLY inside shade(Led led). Never use led.* in update(). update() takes no arguments and returns nothing.
- Per-LED color logic goes in shade(), and shade() must return the final color. Do not return vec3(0.0, 0.0, 0.0) from shade() while doing the "real" work elsewhere.
- 'state' is a top-level declaration: 'state float glow;'. There is no 'state.x', no 'state a = {...}', and no state declared inside a function. Locals in update() are invisible to shade() — pass values through a state variable.
- Never index trail[...] or img[...] unless you declared 'buffer vec3 trail;' or 'texture vec3 img(64, 64);' at the top.
- NO ++, --, +=, -=, no ternary ?:, no while, no const, no plain global variables, and locals need an initializer. Write 'i = i + 1;', 'x = x + 1.0;', 'float x = 0.0;', and use if/else.
- hsv2rgb hue is 0..1, NOT degrees: a full rainbow is hsv2rgb(fract(t), 1.0, 1.0).
- The set_script "source" is RAW program text starting with a declaration — no markdown fences, no leading '|' or other decoration, and newlines inside the JSON string escaped as \\n.`;

export function buildSystem(variant: string): string {
  let sys = CHAT_SYSTEM_COMPACT;
  if (variant === "examples" || variant === "combined") {
    const a = sys.indexOf("EXAMPLE — a moving band");
    const b = sys.indexOf("REPAIR:");
    if (a < 0 || b < 0 || b < a) throw new Error("prompt splice anchors not found");
    sys = sys.slice(0, a) + DIVERSE_EXAMPLES + "\n\n" + sys.slice(b);
  }
  if (variant === "antipatterns" || variant === "combined") {
    const b = sys.indexOf("REPAIR:");
    if (b < 0) throw new Error("REPAIR anchor not found");
    sys = sys.slice(0, b) + ANTIPATTERNS + "\n\n" + sys.slice(b);
  }
  const tools: ToolDef[] = [
    ...TOOLS.filter((t) => t.name !== "capture_preview"),
    EDIT_TOOL,
  ] as unknown as ToolDef[];
  return sys + formatToolInstructions(tools);
}

// ---------------------------------------------------------------------------
// Enriched repair feedback
// ---------------------------------------------------------------------------

interface Diag {
  line: number;
  col: number;
  msg: string;
}

/** fx_compile emits: compile error: [Diagnostic { line: N, col: M, msg: "..." }, ...] */
export function parseDiags(diagnostics: string): Diag[] {
  const out: Diag[] = [];
  const re = /Diagnostic \{ line: (\d+), col: (\d+), msg: "((?:[^"\\]|\\.)*)" \}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(diagnostics)) !== null) {
    out.push({ line: Number(m[1]), col: Number(m[2]), msg: m[3]!.replace(/\\"/g, '"') });
  }
  return out;
}

/** Diagnostic-pattern → concrete-fix hint table, from the observed error modes. */
export function hintFor(d: Diag, lineText: string): string {
  const msg = d.msg;
  if (/Sym\('#'\)/.test(msg))
    return "this language has NO preprocessor — delete the #define/#include line and inline the value (or declare a uniform).";
  const unk = /unknown identifier(?: '(\w+)')?/.exec(msg);
  if (unk) {
    const atCol = /^\w+/.exec(lineText.slice(Math.max(0, d.col - 1)))?.[0];
    const name = unk[1] ?? atCol ?? "that name";
    if (name === "led")
      return "'led' only exists inside shade(Led led) — move per-LED logic into shade() (update() has no led).";
    const v = name === "that name" ? "x" : name;
    return (
      `'${name}' is not declared and is not a built-in. Either declare it first ` +
      `(a uniform at the top like 'uniform float ${v} : 0.0 .. 1.0 = 0.5;', or a local 'float ${v} = 0.0;') ` +
      `or use a variable that exists. Note: locals in update() are NOT visible in shade() (and vice versa) — ` +
      `share values via 'state float name;'. And 'led' only exists inside shade().`
    );
  }
  const unf = /unknown function '(\w+)'/.exec(msg);
  if (unf) {
    if (unf[1] === "while") return "there is no 'while' loop — use a bounded 'for (int i = 0; i < N; i = i + 1)'.";
    return `'${unf[1]}' is not a built-in — use ONLY the functions listed in the system prompt (or define your own helper above update()).`;
  }
  if (/unknown type/.test(msg))
    return "valid types are: float, int, fixed, fixed16, fixed8, bool, vec2, vec3, vec4.";
  if (/expected '='/.test(msg))
    return "declarations need an initializer and there is no ++ / += / -=. Write 'float x = 0.0;', 'i = i + 1;', 'x = x + step;'.";
  if (/expected ';'/.test(msg))
    return "likely an unsupported operator on this line: no ternary '?:', no '++'/'+='. Use if/else and 'x = x + 1;'.";
  const tm = /type mismatch: (\w+) vs (\w+)/.exec(msg);
  if (tm)
    return `the two sides are ${tm[1]} vs ${tm[2]} — vector sizes must match. Build the vector explicitly (e.g. vec3(x, x, x)) and don't mix vec2 with vec3, or return a vec3 from shade().`;
  if (/comparison operands must be scalar/.test(msg))
    return "you can only compare scalars — compare a component (a.x < b.x) or a length, not whole vectors.";
  if (/unexpected token/.test(msg) && d.line === 1 && d.col === 1)
    return "the source must START with a declaration (uniform/state/void update...). Remove markdown fences, '|', '<', or any prose from the source string.";
  if (/unexpected token/.test(msg))
    return "syntax error here — top level may only contain uniform/state/buffer/texture/struct declarations and function definitions; statements go INSIDE update() or shade().";
  return "";
}

/** Build the enriched repair message: per-diagnostic offending line + caret +
 * hint, then the full current script so the model fixes REAL text. */
export function enrichedRepairMessage(source: string, diagnostics: string, edit: boolean, toolErr: string): string {
  const lines = source.split("\n");
  const diags = parseDiags(diagnostics).slice(0, 3);
  let body = "";
  if (diags.length === 0) {
    body = diagnostics + "\n";
  } else {
    for (const d of diags) {
      const lt = lines[d.line - 1] ?? "";
      body += `error at line ${d.line}: ${d.msg}\n`;
      if (lt) {
        body += `  line ${d.line} reads: ${lt}\n`;
        body += `  ${" ".repeat(`line ${d.line} reads: `.length + Math.max(0, d.col - 1))}^\n`;
      }
      const h = hintFor(d, lt);
      if (h) body += `  fix: ${h}\n`;
    }
  }
  return (
    `<tool_response>Compile FAILED.\n${body}` +
    (toolErr ? `Edit error: ${toolErr}` : "") +
    `CURRENT SCRIPT (this exact text is what you must fix):\n${source}\n` +
    `Fix the error(s): call set_script with the corrected full program, or edit_script ` +
    `with a \`find\` copied verbatim from the CURRENT SCRIPT above.</tool_response>`
  );
}

// ---------------------------------------------------------------------------
// Eval loop (structure copied from run.ts)
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
  usedEdit: boolean;
  compileDiag: string;
  judgeScore: number | null;
  judgeRationale: string;
  seconds: number;
  source: string;
  replyHeads: string[];
}

async function runCell(
  variant: string,
  system: string,
  model: EvalModel,
  task: EvalTask,
  key: string | null,
  rounds: number,
): Promise<Cell> {
  const modelPath = resolve(MODELS_DIR, model.file);
  const richFeedback = variant === "feedback" || variant === "combined";
  const user = `${editorContext(STARTER_SOURCE, "OK — compiles.")}\n\nUser: ${task.ask}`;
  const sess = await startSession(modelPath, system);

  let source = STARTER_SOURCE;
  let compiled = false;
  let compiledAtRound = 0;
  let roundsUsed = 0;
  let obtained: Cell["obtained"] = "none";
  let emittedToolCall = false;
  let usedEdit = false;
  let compileDiag = "";
  let seconds = 0;
  const replyHeads: string[] = [];
  let userMsg = user;

  try {
    for (let r = 1; r <= rounds; r++) {
      roundsUsed = r;
      const out = await sess.ask(userMsg);
      seconds += out.seconds;
      replyHeads.push(out.text.slice(0, 120));

      const { calls } = parseToolCalls(out.text);
      const setCall = calls.find((c) => c.name === "set_script");
      const editCalls = calls.filter((c) => c.name === "edit_script");
      let applied = false;
      let toolErr = "";

      if (setCall) {
        source = stripCodeFence(String((setCall.input as { source?: unknown }).source ?? ""));
        obtained = "tool_call";
        emittedToolCall = true;
        applied = true;
      } else if (editCalls.length > 0) {
        emittedToolCall = true;
        for (const e of editCalls) {
          const res = applyEdit(source, e.input);
          if (res.ok) {
            source = res.next;
            usedEdit = true;
            applied = true;
            if (obtained === "none") obtained = "tool_call";
          } else {
            toolErr += res.err + "\n";
          }
        }
      } else {
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
          "<tool_response>No script change detected. Call set_script with the full effect program" +
          " (or edit_script to change part of it).</tool_response>";
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
      if (richFeedback) {
        userMsg = enrichedRepairMessage(source, comp.diagnostics, true, toolErr);
      } else {
        userMsg =
          `<tool_response>Compile FAILED:\n${comp.diagnostics}\n` +
          (toolErr ? `Edit error: ${toolErr}` : "") +
          `Fix the error(s): call set_script with the corrected full program, or edit_script for a targeted fix.</tool_response>`;
      }
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
    usedEdit,
    compileDiag: compileDiag.slice(0, 300),
    judgeScore,
    judgeRationale,
    seconds,
    source,
    replyHeads,
  };
}

async function main(): Promise<void> {
  const variant = arg("variant") ?? "combined";
  if (!["baseline3", "examples", "antipatterns", "feedback", "combined"].includes(variant)) {
    throw new Error(`unknown variant ${variant}`);
  }
  if (!fxCompileAvailable()) throw new Error("fx_compile not available");
  const rounds = Number(arg("rounds") ?? "3");
  const key = flag("no-judge") ? null : judgeKey();
  const system = buildSystem(variant);
  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = resolve(OUT_DIR, `results-${variant}.json`);

  process.stdout.write(
    `variant=${variant} rounds=${rounds} judge=${key ? "on" : "off"} systemChars=${system.length}\n`,
  );

  const models = MODELS.filter((m) => EXP_MODELS.includes(m.id));
  const tasks = TASKS.filter((t) => EXP_TASKS.includes(t.id));
  const cells: Cell[] = [];
  const persist = (): void =>
    writeFileSync(outPath, JSON.stringify({ variant, rounds, system, cells }, null, 2));

  for (const model of models) {
    process.stdout.write(`\n=== ${model.id} ===\n`);
    for (const task of tasks) {
      const c = await runCell(variant, system, model, task, key, rounds);
      cells.push(c);
      const tc = c.emittedToolCall ? "TOOL" : c.obtained === "recovered" ? "recov" : "none ";
      const cp = c.compiled ? `ok@r${c.compiledAtRound}` : "FAIL";
      const js = c.judgeScore === null ? " - " : c.judgeScore.toFixed(2);
      process.stdout.write(
        `  ${task.id.padEnd(16)} ${tc}  ${cp.padEnd(6)} judge=${js}  ${c.seconds.toFixed(0)}s\n`,
      );
      persist();
    }
  }
  await disposeBackend();
  persist();

  const n = cells.length;
  const eff = cells.filter((c) => c.obtained !== "none").length;
  const comp = cells.filter((c) => c.compiled).length;
  const judged = cells.filter((c) => c.judgeScore !== null);
  const mj = judged.length ? judged.reduce((a, c) => a + (c.judgeScore ?? 0), 0) / judged.length : 0;
  process.stdout.write(
    `\n${variant}: eff ${eff}/${n}  comp ${comp}/${n}  judge(mean over judged) ${mj.toFixed(2)}\n` +
      `wrote ${outPath}\n`,
  );
}

// Only run when invoked as the entrypoint (helpers stay importable for tests).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
