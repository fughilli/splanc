/**
 * FINAL EXPERIMENT: the JOINT STACK — the three winning strategies composed,
 * on qwen2.5-3b-instruct, all 8 tasks. One number: fraction of authoring asks
 * that end compiled AND judged >= 0.5 fully offline.
 *
 * Composition (see experiments/SYNTHESIS.md):
 *   1. TEMPLATE ROUTING (exp_template): deterministic keyword retrieval over the
 *      verified template library. NEAR (score >= 2 — a strong weight-2 keyword
 *      hit or two weak hits; reproduces the template run's 4/4-correct picks on
 *      its near tasks while leaving the gold-labeled FAR asks, which only match
 *      on generic words at score <= 1, to from-scratch) → template-MODIFICATION
 *      turn (template as the current editor script, ask phrased as modification).
 *      FAR / weak pick → from-scratch turn (STARTER_SOURCE).
 *   2. GRAMMAR ENVELOPE (exp_grammar, variant `envelope`): GBNF-constrained
 *      sampling forcing the <tool_call> set_script JSON envelope — applied to
 *      EVERY generation turn on BOTH routes (the grammar constrains output shape
 *      only; no conflict with either path). Consequence carried over from
 *      exp_grammar: only set_script is advertised (the grammar cannot emit
 *      edit_script, and advertising an uncallable tool would be incoherent), and
 *      the repair message drops its edit_script clause.
 *   3. COMBINED PROMPT (exp_prompt, variant `combined`): DIVERSE_EXAMPLES
 *      (atan2 pinwheel / state-var breathing / comet tail) replacing the single
 *      moving-band example, + ANTIPATTERNS never-do block, + enriched repair
 *      feedback (offending line + caret + hint table + full current script).
 *      Same system prompt on both routes.
 *
 * Repair loop: 3 rounds against the real fx_compile (stdin). Sampling identical
 * to every prior experiment: temp 0.7, topK 20, topP 0.8, seed 42,
 * repeatPenalty 1.1, context 8192. Judge: Opus (src/judge.ts).
 *
 * NOTE: grammar/session code is COPIED from exp_grammar.ts (that file runs its
 * main() on import — unguarded — so it cannot be imported); DIVERSE_EXAMPLES /
 * ANTIPATTERNS are copied verbatim from exp_prompt.ts (not exported there).
 * parseDiags/hintFor ARE imported from exp_prompt.ts.
 *
 * Usage (from tools/model_eval/):
 *   npx tsx src/exp_joint.ts [--tasks=a,b] [--rounds=3] [--no-judge]
 * Writes experiments/joint/results.json incrementally.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  formatToolInstructions,
} from "../../../web/src/effects/ai/providers/wllamaProtocol";
import { CHAT_SYSTEM_COMPACT, TOOLS } from "../../../web/src/effects/ai/chatPrompt";
import type { ToolDef } from "../../../web/src/effects/ai/provider";
import { MODELS, type EvalModel } from "./models";
import { TASKS, type EvalTask } from "./tasks";
import { editorContext, STARTER_SOURCE } from "./prompt";
import { compile, fxCompileAvailable } from "./compile";
import { judge, judgeKey } from "./judge";
import { TEMPLATES, GOLD_RETRIEVAL, type Template } from "./exp_template_lib";
import { parseDiags, hintFor } from "./exp_prompt";

const here = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = resolve(here, "../models");
const OUT_DIR = resolve(here, "../experiments/joint");

const MODEL_ID = "qwen2.5-3b-instruct";

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

// ---------------------------------------------------------------------------
// 1. Template routing (scoring loop from exp_template_lib.heuristicPick, but
//    returning the score so the joint stack can gate on it)
// ---------------------------------------------------------------------------

/** near iff score >= NEAR_MIN_SCORE. score >= 2 means a strong (weight-2)
 * keyword hit or two independent weak hits — exactly the template experiment's
 * transformed tasks (breathing-red 4, rainbow-sweep 4, comet 3, gradient 3)
 * versus its gold-FAR ones (pinwheel/fire/twinkle <= 1, generic-word hits). */
const NEAR_MIN_SCORE = 2;

function heuristicPickScored(ask: string): { id: string; score: number } {
  const a = ask.toLowerCase();
  let best: { id: string; score: number } = { id: "breathing-pulse", score: 0 };
  for (const t of TEMPLATES) {
    let score = 0;
    for (const [kw, w] of Object.entries(t.keywords)) if (a.includes(kw)) score += w;
    if (score > best.score) best = { id: t.id, score };
  }
  return best;
}

// ---------------------------------------------------------------------------
// 2. Grammar envelope (copied from exp_grammar.ts, variant `envelope`)
// ---------------------------------------------------------------------------

function jsonChar(extraForbidden = ""): string {
  return (
    `[^"\\\\\\x7F\\x00-\\x1F${extraForbidden}] | "\\\\" (["\\\\/bfnrt] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F])`
  );
}

function envelopeGbnf(): string {
  return [
    String.raw`root ::= ws "<tool_call>{\"name\":\"set_script\",\"arguments\":{\"summary\":\"" summary "\",\"source\":\"" source "\"}}</tool_call>"`,
    `ws ::= [ \\t\\n]*`,
    `summary ::= schar*`,
    // schar+ (NOT schar*, as exp_grammar had it): pass 1 of this experiment hit
    // a degenerate mode where the model closed `source` after ZERO characters
    // (all 3 rounds, 2/8 tasks) — an empty program is not a program, so the
    // envelope now requires at least one source character.
    `source ::= schar schar*`,
    `schar ::= ${jsonChar()}`,
  ].join("\n");
}

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
// 3. Combined prompt (splices copied VERBATIM from exp_prompt.ts — not exported
//    there). Tool ads: set_script ONLY (grammar admits nothing else).
// ---------------------------------------------------------------------------

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

/** Combined system = CHAT_SYSTEM_COMPACT with the exp_prompt `combined` splices,
 * advertising ONLY set_script (grammar coherence — see header). */
function buildJointSystem(): string {
  let sys = CHAT_SYSTEM_COMPACT;
  const a = sys.indexOf("EXAMPLE — a moving band");
  const b0 = sys.indexOf("REPAIR:");
  if (a < 0 || b0 < 0 || b0 < a) throw new Error("prompt splice anchors not found");
  sys = sys.slice(0, a) + DIVERSE_EXAMPLES + "\n\n" + sys.slice(b0);
  const b1 = sys.indexOf("REPAIR:");
  if (b1 < 0) throw new Error("REPAIR anchor not found");
  sys = sys.slice(0, b1) + ANTIPATTERNS + "\n\n" + sys.slice(b1);
  const tools = TOOLS.filter((t) => t.name === "set_script") as unknown as ToolDef[];
  return sys + formatToolInstructions(tools);
}

/** Enriched repair feedback (enrichedRepairMessage from exp_prompt.ts with the
 * edit_script clause removed — the grammar only admits set_script). Uses the
 * imported parseDiags/hintFor so hints can't drift from the prompt experiment. */
function jointRepairMessage(source: string, diagnostics: string): string {
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
    `CURRENT SCRIPT (this exact text is what you must fix):\n${source}\n` +
    `Fix the error(s): call set_script with the corrected full program.</tool_response>`
  );
}

// ---------------------------------------------------------------------------
// Honesty metrics for the template route (copied from exp_template.ts)
// ---------------------------------------------------------------------------

function normalize(src: string): string {
  return src
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function lineSimilarity(a: string, b: string): number {
  const la = a.split("\n").map((l) => l.trim()).filter(Boolean);
  const lb = new Set(b.split("\n").map((l) => l.trim()).filter(Boolean));
  if (la.length === 0) return 0;
  const shared = la.filter((l) => lb.has(l)).length;
  return shared / Math.max(la.length, lb.size);
}

// ---------------------------------------------------------------------------
// Cell runner
// ---------------------------------------------------------------------------

interface Cell {
  model: string;
  task: string;
  route: "template" | "scratch";
  template: string | null;
  retrievalScore: number;
  compiled: boolean;
  compiledAtRound: number;
  roundsUsed: number;
  obtained: "tool_call" | "recovered" | "none";
  emittedToolCall: boolean;
  unmodified: boolean | null; // template route only
  templateSimilarity: number | null; // template route only
  compileDiag: string;
  judgeScore: number | null;
  judgeRationale: string;
  seconds: number;
  truncated: boolean;
  source: string;
  replyHeads: string[];
}

async function runCell(
  model: EvalModel,
  task: EvalTask,
  route: "template" | "scratch",
  template: Template | null,
  retrievalScore: number,
  system: string,
  grammar: LlamaGrammar,
  key: string | null,
  rounds: number,
): Promise<Cell> {
  const modelPath = resolve(MODELS_DIR, model.file);
  const startSource = route === "template" && template ? template.source : STARTER_SOURCE;
  const ask =
    route === "template"
      ? `Starting from the current script (keep whatever already helps), modify it to satisfy this request: ${task.ask}`
      : task.ask;
  const user = `${editorContext(startSource, "OK — compiles.")}\n\nUser: ${ask}`;
  const sess = await startGrammarSession(modelPath, system, grammar);

  let source = startSource;
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
      let emptySource = false;

      if (setCall) {
        source = stripCodeFence(String((setCall.input as { source?: unknown }).source ?? ""));
        obtained = "tool_call";
        emittedToolCall = true;
        applied = true;
      } else {
        // Only reachable on maxTokens truncation (grammar guarantees the shape
        // otherwise) — partial-JSON recovery pulls `source` out anyway.
        const rec = recoverSetScriptFromProse(out.text);
        if (rec) {
          source = rec.input.source;
          applied = true;
          if (obtained === "none") obtained = "recovered";
        }
      }

      // A blank program is not a script change — belt-and-braces with the
      // schar+ grammar, and gives the repair loop a targeted nudge.
      if (applied && source.trim() === "") {
        applied = false;
        emptySource = true;
        source = startSource;
      }

      if (!applied) {
        if (r === rounds) break;
        userMsg = emptySource
          ? "<tool_response>The \"source\" string was EMPTY. Call set_script again with the COMPLETE program text in \"source\" — every uniform/state declaration, update() and shade(), newlines escaped as \\n.</tool_response>"
          : "<tool_response>No script change detected. Call set_script with the full effect program.</tool_response>";
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
      userMsg = jointRepairMessage(source, comp.diagnostics);
    }
  } finally {
    await sess.dispose();
  }

  const unmodified =
    route === "template" && template ? normalize(source) === normalize(template.source) : null;
  const templateSimilarity =
    route === "template" && template ? lineSimilarity(source, template.source) : null;

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
    model: model.id,
    task: task.id,
    route,
    template: route === "template" && template ? template.id : null,
    retrievalScore,
    compiled,
    compiledAtRound,
    roundsUsed,
    obtained,
    emittedToolCall,
    unmodified,
    templateSimilarity,
    compileDiag: compileDiag.slice(0, 300),
    judgeScore,
    judgeRationale,
    seconds,
    truncated,
    source,
    replyHeads,
  };
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!fxCompileAvailable()) {
    process.stdout.write("FATAL: fx_compile not available\n");
    process.exit(1);
  }
  const rounds = Number(arg("rounds") ?? "3");
  const key = flag("no-judge") ? null : judgeKey();
  const taskFilter = arg("tasks")?.split(",");
  const tasks = TASKS.filter((t) => !taskFilter || taskFilter.includes(t.id));
  const model = MODELS.find((m) => m.id === MODEL_ID)!;
  if (!existsSync(resolve(MODELS_DIR, model.file))) throw new Error("model GGUF missing");

  // Verify every template still compiles before routing anything to one.
  for (const t of TEMPLATES) {
    const c = compile(t.source);
    if (!c.ok) {
      process.stdout.write(`FATAL: template ${t.id} does not compile:\n${c.diagnostics}\n`);
      process.exit(1);
    }
  }

  const system = buildJointSystem();
  process.stdout.write(
    `joint stack: model=${MODEL_ID} tasks=${tasks.length} rounds=${rounds} judge=${key ? "on" : "off"} ` +
      `nearMinScore=${NEAR_MIN_SCORE} systemChars=${system.length}\n`,
  );

  // Routing table (logged up front; deterministic).
  const routing: Record<
    string,
    { route: "template" | "scratch"; pick: string; score: number; goldOk: boolean | null }
  > = {};
  for (const t of tasks) {
    const p = heuristicPickScored(t.ask);
    const route = p.score >= NEAR_MIN_SCORE ? "template" : "scratch";
    const goldOk = route === "template" ? (GOLD_RETRIEVAL[t.id] ?? []).includes(p.id) : null;
    routing[t.id] = { route, pick: p.id, score: p.score, goldOk };
    process.stdout.write(
      `  route ${t.id.padEnd(18)} score=${p.score} → ${route.padEnd(8)}` +
        (route === "template" ? ` tpl=${p.id} ${goldOk ? "(gold-ok)" : "(GOLD MISS)"}` : "") +
        "\n",
    );
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = resolve(OUT_DIR, "results.json");
  const cells: Cell[] = [];
  const persist = (): void =>
    writeFileSync(
      outPath,
      JSON.stringify(
        {
          config: {
            model: MODEL_ID,
            rounds,
            nearMinScore: NEAR_MIN_SCORE,
            stack: [
              "template-routing",
              "grammar-envelope (source non-empty: schar+)",
              "combined-prompt+enriched-repair",
            ],
            tasks: tasks.map((t) => t.id),
          },
          routing,
          cells,
        },
        null,
        2,
      ),
    );
  persist();

  const l = await getLlamaInstance();
  const grammar = await l.createGrammar({ grammar: envelopeGbnf() });

  for (const task of tasks) {
    const r = routing[task.id]!;
    const tpl = r.route === "template" ? TEMPLATES.find((x) => x.id === r.pick)! : null;
    try {
      const c = await runCell(model, task, r.route, tpl, r.score, system, grammar, key, rounds);
      cells.push(c);
      const cp = c.compiled ? `ok@r${c.compiledAtRound}` : "FAIL   ";
      const js = c.judgeScore === null ? " - " : c.judgeScore.toFixed(2);
      const mod =
        c.route === "template" ? (c.unmodified ? " UNMOD" : ` sim=${(c.templateSimilarity ?? 0).toFixed(2)}`) : "";
      process.stdout.write(
        `  ${task.id.padEnd(18)} ${c.route.padEnd(8)}${(c.template ?? "-").padEnd(16)} ${cp.padEnd(7)} judge=${js}${mod} ${c.truncated ? " TRUNC" : ""} ${c.seconds.toFixed(0)}s\n`,
      );
    } catch (e) {
      process.stdout.write(
        `  ! cell ${task.id} failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
    persist();
  }
  if (current) {
    await current.model.dispose();
    current = null;
  }
  persist();

  // Headline
  const n = cells.length;
  const comp = cells.filter((c) => c.compiled).length;
  const good = cells.filter((c) => c.compiled && (c.judgeScore ?? 0) >= 0.5).length;
  const judged = cells.filter((c) => c.judgeScore !== null);
  const mj = judged.length ? judged.reduce((a, c) => a + (c.judgeScore ?? 0), 0) / judged.length : 0;
  const meanAll = n ? cells.reduce((a, c) => a + (c.judgeScore ?? 0), 0) / n : 0;
  process.stdout.write(
    `\n===== JOINT STACK (${MODEL_ID}) =====\n` +
      `compiled-and-correct (judge>=0.5): ${good}/${n}\n` +
      `comp ${comp}/${n} (${n ? Math.round((100 * comp) / n) : 0}%)  ` +
      `mean judge (judged cells) ${mj.toFixed(2)}  mean judge (null→0) ${meanAll.toFixed(2)}\n` +
      `wrote ${outPath}\n`,
  );
}

void main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
