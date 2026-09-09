/**
 * Model-in-the-loop eval runner (FUG-87 hill-climbing).
 *
 * For each (model × task) we run the SAME multi-turn tool-use loop the app does:
 * the model calls set_script (or the experimental edit_script), we compile with
 * the real fx_compile, and — on failure — feed the diagnostics back so the model
 * gets more turns to fix it, exactly like the editor's repair loop. We score:
 *   - tool_call  : did it ever emit a valid tool call? (compliance)
 *   - recovered  : if it narrated a program instead, did the fallback salvage it?
 *   - compiles   : did the program compile within --rounds turns?
 *   - rounds     : how many turns it took to compile (repair convergence)
 *   - editUse    : did it use the cheap targeted edit_script tool?
 *   - judge      : does Opus think it implements the request? (0..1)
 *
 * Usage (from tools/model_eval/):
 *   npx tsx src/run.ts [--models=id1,id2] [--tasks=id1,id2] [--rounds=4]
 *                      [--no-edit] [--no-judge] [--out=results.json]
 */

import { spawnSync } from "node:child_process";
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
import { buildAuthoringPrompt, applyEdit, STARTER_SOURCE } from "./prompt";
import { startSession, disposeBackend } from "./backend";
import { compile, fxCompileAvailable } from "./compile";
import { judge, judgeKey } from "./judge";

const here = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = resolve(here, "../models");

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

function ensureModel(m: EvalModel): boolean {
  const path = resolve(MODELS_DIR, m.file);
  if (existsSync(path)) return true;
  mkdirSync(MODELS_DIR, { recursive: true });
  process.stdout.write(`  ↓ downloading ${m.id} …\n`);
  const r = spawnSync("curl", ["-sSL", "--fail", "-C", "-", "-o", path, m.url], {
    stdio: "inherit",
    timeout: 900_000,
  });
  if (r.status !== 0) {
    process.stdout.write(`  ✗ download failed for ${m.id} (${m.url}) — skipping\n`);
    return false;
  }
  return true;
}

interface Cell {
  model: string;
  task: string;
  compiled: boolean;
  compiledAtRound: number; // 1-based; 0 = never compiled
  roundsUsed: number;
  obtained: "tool_call" | "recovered" | "none";
  emittedToolCall: boolean; // ever emitted a valid native tool call
  usedEdit: boolean;
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
  key: string | null,
  cfg: { rounds: number; edit: boolean },
): Promise<Cell> {
  const modelPath = resolve(MODELS_DIR, model.file);
  const { system, user } = buildAuthoringPrompt(task.ask, STARTER_SOURCE, { edit: cfg.edit });
  const sess = await startSession(modelPath, system);

  let source = STARTER_SOURCE;
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
    for (let r = 1; r <= cfg.rounds; r++) {
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
        if (r === cfg.rounds) break;
        userMsg =
          "<tool_response>No script change detected. Call set_script with the full effect program" +
          (cfg.edit ? " (or edit_script to change part of it)." : ".") +
          "</tool_response>";
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
        `Fix the error(s): call set_script with the corrected full program` +
        (cfg.edit ? ", or edit_script for a targeted fix." : ".") +
        `</tool_response>`;
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
    model: model.id,
    task: task.id,
    compiled,
    compiledAtRound,
    roundsUsed,
    obtained,
    emittedToolCall,
    usedEdit,
    compileDiag: compileDiag.slice(0, 200),
    judgeScore,
    judgeRationale,
    hadThinking,
    seconds,
    source,
    replyHeads,
  };
}

function pct(n: number, d: number): string {
  return d === 0 ? "  - " : `${Math.round((100 * n) / d)}%`.padStart(4);
}

async function main(): Promise<void> {
  if (!fxCompileAvailable()) {
    process.stdout.write("WARNING: fx_compile not built — run `bazel build //fx_compiler:fx_compile`.\n");
  }
  const rounds = Number(arg("rounds") ?? "4");
  const edit = !flag("no-edit");
  const key = flag("no-judge") ? null : judgeKey();
  process.stdout.write(
    `config: rounds=${rounds}  edit_tool=${edit ? "on" : "off"}  judge=${key ? "Opus" : "off"}\n`,
  );

  const modelFilter = arg("models")?.split(",");
  const taskFilter = arg("tasks")?.split(",");
  const models = MODELS.filter((m) => !modelFilter || modelFilter.includes(m.id));
  const tasks = TASKS.filter((t) => !taskFilter || taskFilter.includes(t.id));

  const outPath = resolve(process.cwd(), arg("out") ?? "results.json");
  const cells: Cell[] = [];
  const persist = (): void => writeFileSync(outPath, JSON.stringify({ cells }, null, 2));

  for (const model of models) {
    if (!ensureModel(model)) continue;
    process.stdout.write(`\n=== ${model.id} (${model.params}B) ===\n`);
    try {
      for (const task of tasks) {
        const c = await runCell(model, task, key, { rounds, edit });
        cells.push(c);
        const tc = c.emittedToolCall ? "TOOL" : c.obtained === "recovered" ? "recov" : "none ";
        const cp = c.compiled ? `ok@r${c.compiledAtRound}` : "FAIL   ";
        const js = c.judgeScore === null ? " - " : c.judgeScore.toFixed(2);
        process.stdout.write(
          `  ${task.id.padEnd(18)} ${tc}  ${cp.padEnd(7)} ${c.usedEdit ? "edit " : "     "} judge=${js}  ${c.seconds.toFixed(0)}s\n`,
        );
        persist();
      }
    } catch (e) {
      process.stdout.write(`  ! ${model.id} aborted: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  await disposeBackend();
  persist();

  // ---- Leaderboard -------------------------------------------------------
  process.stdout.write("\n\n===================== LEADERBOARD =====================\n");
  process.stdout.write("model                         tool%  eff%  comp%  rnds  edit%  judge\n");
  const byModel = new Map<string, Cell[]>();
  for (const c of cells) {
    const arr = byModel.get(c.model) ?? [];
    arr.push(c);
    byModel.set(c.model, arr);
  }
  const rows = [...byModel.entries()].map(([id, cs]) => {
    const n = cs.length;
    const tool = cs.filter((c) => c.emittedToolCall).length;
    const eff = cs.filter((c) => c.obtained !== "none").length;
    const comp = cs.filter((c) => c.compiled).length;
    const compiledCells = cs.filter((c) => c.compiled);
    const meanRounds = compiledCells.length
      ? compiledCells.reduce((a, c) => a + c.compiledAtRound, 0) / compiledCells.length
      : null;
    const editUse = cs.filter((c) => c.usedEdit).length;
    const judged = cs.filter((c) => c.judgeScore !== null);
    const meanJudge = judged.length
      ? judged.reduce((a, c) => a + (c.judgeScore ?? 0), 0) / judged.length
      : null;
    const params = MODELS.find((m) => m.id === id)?.params ?? 0;
    return { id, params, n, tool, eff, comp, meanRounds, editUse, meanJudge };
  });
  rows.sort((a, b) => (b.meanJudge ?? -1) - (a.meanJudge ?? -1) || b.comp / b.n - a.comp / a.n || a.params - b.params);
  for (const r of rows) {
    process.stdout.write(
      `${r.id.padEnd(28)}  ${pct(r.tool, r.n)}  ${pct(r.eff, r.n)}  ${pct(r.comp, r.n)}  ${(r.meanRounds ?? 0).toFixed(1).padStart(4)}  ${pct(r.editUse, r.n)}  ${r.meanJudge === null ? "  - " : r.meanJudge.toFixed(2)}\n`,
    );
  }
  process.stdout.write(
    "\ntool%=emitted a valid tool call · eff%=produced a program (incl. prose-recovery) · comp%=compiled within " +
      rounds +
      " rounds · rnds=mean rounds to compile · edit%=used edit_script · judge=mean semantic score\n",
  );

  writeFileSync(outPath, JSON.stringify({ rows, cells }, null, 2));
  process.stdout.write(`\nwrote ${outPath}\n`);
}

void main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
