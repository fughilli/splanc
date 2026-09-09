/**
 * EXPERIMENT: template retrieval + modification for small-model effect authoring.
 *
 * Hypothesis: tiny models (0.6B–3B) can't author DSL programs from scratch
 * (baseline: comp 0–50%, judge ≤0.05) but ARE decent at *modifying* a working
 * program. So: retrieve the closest known-good builtin effect, present it as the
 * CURRENT editor script (the exact grounding format the app uses), and phrase
 * the user turn as a modification request toward the task. Keep the same
 * multi-turn compile-repair loop (3 rounds) and the same sampling as run.ts.
 *
 * Retrieval is a keyword heuristic (deterministic, measured against hand-labeled
 * gold "acceptable template" sets). We ALSO measure — but do not use — letting
 * each small model pick the template itself (one cheap extra completion), so the
 * report can compare the two retrieval options.
 *
 * Extra metric vs run.ts: `unmodified` — the model returned the template
 * essentially verbatim (normalized-equal). A compiling-but-unmodified comet is
 * NOT a pinwheel; the judge should catch these, and we count them explicitly.
 *
 * Usage (from tools/model_eval/):
 *   npx tsx src/exp_template.ts [--models=a,b] [--tasks=x,y] [--rounds=3]
 *                               [--no-judge] [--out=experiments/template/results.json]
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  parseToolCalls,
  recoverSetScriptFromProse,
  stripCodeFence,
} from "../../../web/src/effects/ai/providers/wllamaProtocol";
import { MODELS, type EvalModel } from "./models";
import { TASKS, type EvalTask } from "./tasks";
import { buildAuthoringPrompt, applyEdit } from "./prompt";
import { startSession, complete, disposeBackend } from "./backend";
import { compile, fxCompileAvailable } from "./compile";
import { judge, judgeKey } from "./judge";
import { TEMPLATES, GOLD_RETRIEVAL, heuristicPick, type Template } from "./exp_template_lib";

const here = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = resolve(here, "../models");

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

/** Whitespace/comment-insensitive equality: did the model actually change the
 * program, or hand the template back? */
function normalize(src: string): string {
  return src
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Crude similarity (shared normalized lines / max lines) so the report can
 * distinguish "tweaked one constant" from "rewrote it". */
function lineSimilarity(a: string, b: string): number {
  const la = a.split("\n").map((l) => l.trim()).filter(Boolean);
  const lb = new Set(b.split("\n").map((l) => l.trim()).filter(Boolean));
  if (la.length === 0) return 0;
  const shared = la.filter((l) => lb.has(l)).length;
  return shared / Math.max(la.length, lb.size);
}

// ---------------------------------------------------------------------------
// Model-choice retrieval (measured, not used for the pipeline)
// ---------------------------------------------------------------------------

const PICK_SYSTEM =
  "You match a user's LED-effect request to the closest starting template. " +
  "Reply with ONLY the id of the single best template, nothing else.";

function pickUser(ask: string): string {
  const list = TEMPLATES.map((t) => `- ${t.id}: ${t.description}`).join("\n");
  return `Templates:\n${list}\n\nUser request: "${ask}"\n\nReply with only the best template id.`;
}

function parsePick(text: string): string | null {
  const t = text.toLowerCase();
  // Prefer an exact-id token; fall back to the first template id mentioned.
  let best: { id: string; at: number } | null = null;
  for (const tpl of TEMPLATES) {
    const at = t.indexOf(tpl.id);
    if (at !== -1 && (best === null || at < best.at)) best = { id: tpl.id, at };
  }
  return best?.id ?? null;
}

// ---------------------------------------------------------------------------
// Modification cell (mirrors run.ts runCell, but starts from the template)
// ---------------------------------------------------------------------------

interface Cell {
  model: string;
  task: string;
  template: string;
  compiled: boolean;
  compiledAtRound: number;
  roundsUsed: number;
  obtained: "tool_call" | "recovered" | "none";
  emittedToolCall: boolean;
  usedEdit: boolean;
  unmodified: boolean; // final program ≈ template verbatim
  templateSimilarity: number; // 0..1 shared-line ratio vs template
  compileDiag: string;
  judgeScore: number | null;
  judgeRationale: string;
  hadThinking: boolean;
  seconds: number;
  source: string;
  replyHeads: string[];
}

async function runCell(
  model: EvalModel,
  task: EvalTask,
  template: Template,
  key: string | null,
  rounds: number,
): Promise<Cell> {
  const modelPath = resolve(MODELS_DIR, model.file);
  // Same system prompt + tools as the baseline (edit_script on, same as the
  // default run.ts config), but the grounding context is the TEMPLATE and the
  // user turn asks for a modification toward the task.
  const { system, user } = buildAuthoringPrompt(
    `Starting from the current script (keep whatever already helps), modify it to satisfy this request: ${task.ask}`,
    template.source,
    { edit: true },
  );
  const sess = await startSession(modelPath, system);

  let source = template.source;
  let compiled = false;
  let compiledAtRound = 0;
  let roundsUsed = 0;
  let obtained: Cell["obtained"] = "none";
  let emittedToolCall = false;
  let usedEdit = false;
  let compileDiag = "";
  let hadThinking = false;
  let seconds = 0;
  const replyHeads: string[] = [];
  let userMsg = user;

  try {
    for (let r = 1; r <= rounds; r++) {
      roundsUsed = r;
      const out = await sess.ask(userMsg);
      seconds += out.seconds;
      hadThinking = hadThinking || out.hadThinking;
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
          "<tool_response>No script change detected. Call set_script with the full modified program " +
          "(or edit_script to change part of it).</tool_response>";
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
        (toolErr ? `Edit error: ${toolErr}` : "") +
        `Fix the error(s): call set_script with the corrected full program, or edit_script for a targeted fix.</tool_response>`;
    }
  } finally {
    await sess.dispose();
  }

  const unmodified = normalize(source) === normalize(template.source);
  const templateSimilarity = lineSimilarity(source, template.source);

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
    template: template.id,
    compiled,
    compiledAtRound,
    roundsUsed,
    obtained,
    emittedToolCall,
    usedEdit,
    unmodified,
    templateSimilarity,
    compileDiag: compileDiag.slice(0, 200),
    judgeScore,
    judgeRationale,
    hadThinking,
    seconds,
    source,
    replyHeads,
  };
}

// ---------------------------------------------------------------------------

const pct = (n: number, d: number): string => (d === 0 ? "  - " : `${Math.round((100 * n) / d)}%`.padStart(4));

async function main(): Promise<void> {
  if (!fxCompileAvailable()) {
    process.stdout.write("FATAL: fx_compile not available\n");
    process.exit(1);
  }
  const rounds = Number(arg("rounds") ?? "3");
  const key = flag("no-judge") ? null : judgeKey();
  const modelFilter = (arg("models") ?? "qwen3-0.6b,qwen2.5-1.5b-instruct,qwen2.5-3b-instruct").split(",");
  const taskFilter = arg("tasks")?.split(",");
  const models = MODELS.filter((m) => modelFilter.includes(m.id));
  const tasks = TASKS.filter((t) => !taskFilter || taskFilter.includes(t.id));

  // Verify every template still compiles before relying on it.
  for (const t of TEMPLATES) {
    const c = compile(t.source);
    if (!c.ok) {
      process.stdout.write(`FATAL: template ${t.id} does not compile:\n${c.diagnostics}\n`);
      process.exit(1);
    }
  }
  process.stdout.write(`templates: ${TEMPLATES.length} verified compiling · rounds=${rounds} · judge=${key ? "on" : "off"}\n`);

  // Heuristic retrieval picks + accuracy (deterministic; used by the pipeline).
  const heuristic: Record<string, { pick: string; ok: boolean }> = {};
  for (const t of tasks) {
    const pick = heuristicPick(t.ask);
    heuristic[t.id] = { pick, ok: (GOLD_RETRIEVAL[t.id] ?? []).includes(pick) };
    process.stdout.write(`  retrieve[heuristic] ${t.id.padEnd(18)} → ${pick.padEnd(16)} ${heuristic[t.id]!.ok ? "ok" : "MISS"}\n`);
  }

  const outPath = resolve(here, "..", arg("out") ?? "experiments/template/results.json");
  mkdirSync(dirname(outPath), { recursive: true });
  const cells: Cell[] = [];
  const modelPicks: Record<string, Record<string, { pick: string | null; ok: boolean; seconds: number }>> = {};
  const persist = (): void =>
    writeFileSync(
      outPath,
      JSON.stringify(
        {
          config: { rounds, models: modelFilter, tasks: tasks.map((t) => t.id) },
          templates: TEMPLATES.map((t) => ({ id: t.id, description: t.description })),
          goldRetrieval: GOLD_RETRIEVAL,
          heuristicRetrieval: heuristic,
          modelPicks,
          cells,
        },
        null,
        2,
      ),
    );

  for (const model of models) {
    const modelPath = resolve(MODELS_DIR, model.file);
    if (!existsSync(modelPath)) {
      process.stdout.write(`  ! ${model.id}: model file missing, skipping\n`);
      continue;
    }
    process.stdout.write(`\n=== ${model.id} ===\n`);

    // (b) model-as-retriever, measured only (one cheap completion per task).
    modelPicks[model.id] = {};
    for (const t of tasks) {
      try {
        const r = await complete(modelPath, PICK_SYSTEM, pickUser(t.ask), { maxTokens: 96 });
        const pick = parsePick(r.text);
        const ok = pick !== null && (GOLD_RETRIEVAL[t.id] ?? []).includes(pick);
        modelPicks[model.id]![t.id] = { pick, ok, seconds: r.seconds };
        process.stdout.write(`  retrieve[model] ${t.id.padEnd(18)} → ${String(pick).padEnd(16)} ${ok ? "ok" : "MISS"} (${r.seconds.toFixed(0)}s)\n`);
      } catch (e) {
        modelPicks[model.id]![t.id] = { pick: null, ok: false, seconds: 0 };
        process.stdout.write(`  retrieve[model] ${t.id} error: ${e instanceof Error ? e.message : String(e)}\n`);
      }
      persist();
    }

    // Modification cells, using the HEURISTIC pick (deterministic across models).
    for (const t of tasks) {
      const tpl = TEMPLATES.find((x) => x.id === heuristic[t.id]!.pick)!;
      const c = await runCell(model, t, tpl, key, rounds);
      cells.push(c);
      const tc = c.emittedToolCall ? "TOOL" : c.obtained === "recovered" ? "recov" : "none ";
      const cp = c.compiled ? `ok@r${c.compiledAtRound}` : "FAIL   ";
      const js = c.judgeScore === null ? " - " : c.judgeScore.toFixed(2);
      process.stdout.write(
        `  ${t.id.padEnd(18)} tpl=${tpl.id.padEnd(16)} ${tc} ${cp.padEnd(7)} ${c.unmodified ? "UNMOD" : `sim=${c.templateSimilarity.toFixed(2)}`}  judge=${js}  ${c.seconds.toFixed(0)}s\n`,
      );
      persist();
    }
  }
  await disposeBackend();
  persist();

  // Summary
  process.stdout.write("\n===== TEMPLATE-START SUMMARY =====\n");
  process.stdout.write("model                         eff%  comp%  unmod%  judge\n");
  const byModel = new Map<string, Cell[]>();
  for (const c of cells) (byModel.get(c.model) ?? byModel.set(c.model, []).get(c.model)!).push(c);
  for (const [id, cs] of byModel) {
    const n = cs.length;
    const eff = cs.filter((c) => c.obtained !== "none").length;
    const comp = cs.filter((c) => c.compiled).length;
    const unmod = cs.filter((c) => c.unmodified).length;
    const judged = cs.filter((c) => c.judgeScore !== null);
    const mj = judged.length ? judged.reduce((a, c) => a + (c.judgeScore ?? 0), 0) / judged.length : null;
    process.stdout.write(
      `${id.padEnd(28)}  ${pct(eff, n)}  ${pct(comp, n)}  ${pct(unmod, n)}   ${mj === null ? " - " : mj.toFixed(2)}\n`,
    );
  }
  process.stdout.write(`\nwrote ${outPath}\n`);
}

void main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
