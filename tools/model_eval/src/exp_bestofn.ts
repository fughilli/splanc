/**
 * Best-of-N sampling experiment (FUG-87 follow-up).
 *
 * Hypothesis: for SMALL models, N cheap independent samples + the compiler as a
 * perfect verifier beats N sequential repair rounds (the baseline run.ts loop).
 *
 * Design (per model × task cell):
 *   - Sample 8 single-turn candidates with the SAME prompt run.ts uses on round
 *     1 (edit tool advertised, starter source in context), varying seed per
 *     candidate and cycling temperature 0.6/0.8/1.0. Base sampling params match
 *     the harness: topK 20, topP 0.8, repeatPenalty 1.1.
 *   - Extract a program from each exactly like run.ts (native set_script →
 *     edit_script applied to the starter → prose recovery), compile each.
 *   - N=4 is analyzed as the first-4 prefix of the same 8 candidates (so both
 *     arms share generations; candidates are independent, so a prefix is an
 *     unbiased N=4 run).
 *   - Hybrid: if no candidate in the prefix compiles, ONE single-turn repair on
 *     the "closest" candidate (fewest compiler errors), with the failing source
 *     + diagnostics re-grounded in the prompt (best-of-N keeps no sessions).
 *   - Judge (Opus) scores every UNIQUE compiling candidate → lets us report
 *     first-compiling selection, judge-picked selection, and the oracle ceiling.
 *
 * Usage: npx tsx src/exp_bestofn.ts   (writes experiments/bestofn/results.json)
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  parseToolCalls,
  recoverSetScriptFromProse,
  stripCodeFence,
} from "../../../web/src/effects/ai/providers/wllamaProtocol";
import { MODELS } from "./models";
import { TASKS } from "./tasks";
import { buildAuthoringPrompt, applyEdit, editorContext, STARTER_SOURCE } from "./prompt";
import { compile, fxCompileAvailable } from "./compile";
import { judge, judgeKey } from "./judge";
import { sampleOnce, disposeExpBackend } from "./exp_bestofn_backend";

const here = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = resolve(here, "../models");
const OUT_DIR = resolve(here, "../experiments/bestofn");
const OUT = resolve(OUT_DIR, process.env.BON_OUT ?? "results.json");

// Env overrides (smoke tests): BON_MODELS/BON_TASKS = comma lists, BON_N, BON_OUT.
const MODEL_IDS = (process.env.BON_MODELS?.split(",") ?? ["qwen3-0.6b", "qwen2.5-1.5b-instruct", "qwen2.5-3b-instruct"]);
const TASK_IDS = (process.env.BON_TASKS?.split(",") ?? ["pinwheel", "breathing-red", "rainbow-sweep", "comet"]);
const N_MAX = Number(process.env.BON_N ?? "8");
const TEMPS = [0.6, 0.8, 1.0]; // cycled per candidate
const seedFor = (i: number): number => 1001 + i * 17;
const REPAIR_TEMP = 0.6;
const REPAIR_SEED = 4242;

interface Candidate {
  idx: number;
  seed: number;
  temp: number;
  seconds: number;
  hadThinking: boolean;
  obtained: "tool_call" | "recovered" | "none";
  compiled: boolean;
  errorCount: number; // compiler error count (Infinity if no program)
  diagnostics: string;
  source: string;
  judgeScore: number | null;
  replyHead: string;
}

interface Repair {
  fromIdx: number; // candidate repaired
  seconds: number;
  obtained: Candidate["obtained"];
  compiled: boolean;
  diagnostics: string;
  source: string;
  judgeScore: number | null;
}

interface CellResult {
  model: string;
  task: string;
  candidates: Candidate[];
  /** Repair run when nothing in the first 4 compiled (hybrid-4 arm). */
  repair4: Repair | null;
  /** Repair run when nothing in all 8 compiled (hybrid-8 arm); may be the same
   * generation as repair4 when the closest candidate coincides. */
  repair8: Repair | null;
  repair8SameAs4: boolean;
}

function countErrors(diagnostics: string): number {
  const m = diagnostics.match(/error/gi);
  if (m && m.length > 0) return m.length;
  const lines = diagnostics.split("\n").filter((l) => l.trim().length > 0);
  return Math.max(1, lines.length);
}

/** run.ts round-1 extraction, verbatim in behavior: set_script wins, else
 * edit_script(s) applied to the base source, else prose recovery. */
function extractProgram(
  text: string,
  base: string,
): { obtained: Candidate["obtained"]; source: string | null } {
  const { calls } = parseToolCalls(text);
  const setCall = calls.find((c) => c.name === "set_script");
  if (setCall) {
    return {
      obtained: "tool_call",
      source: stripCodeFence(String((setCall.input as { source?: unknown }).source ?? "")),
    };
  }
  const editCalls = calls.filter((c) => c.name === "edit_script");
  if (editCalls.length > 0) {
    let src = base;
    let applied = false;
    for (const e of editCalls) {
      const res = applyEdit(src, e.input);
      if (res.ok) {
        src = res.next;
        applied = true;
      }
    }
    if (applied) return { obtained: "tool_call", source: src };
    return { obtained: "tool_call", source: null }; // emitted a call but it didn't apply
  }
  const rec = recoverSetScriptFromProse(text);
  if (rec) return { obtained: "recovered", source: rec.input.source };
  return { obtained: "none", source: null };
}

function repairUser(ask: string, failSource: string, diagnostics: string): string {
  return (
    `${editorContext(failSource, `FAILED:\n${diagnostics}`)}\n\nUser: ${ask}\n\n` +
    `(The current script above is my attempt but it fails to compile with the ` +
    `errors shown. Fix the errors and call set_script with the corrected full program.)`
  );
}

/** Closest-to-compiling candidate among a prefix: fewest compiler errors, ties
 * broken by earliest. Returns null if no candidate produced a program at all. */
function closest(cands: Candidate[], n: number): Candidate | null {
  let best: Candidate | null = null;
  for (const c of cands.slice(0, n)) {
    if (c.source === "" || c.obtained === "none") continue;
    if (!best || c.errorCount < best.errorCount) best = c;
  }
  return best;
}

async function judgeSafe(
  ask: string,
  rubric: string,
  source: string,
  key: string,
): Promise<number | null> {
  try {
    const j = await judge(ask, rubric, source, true, key);
    return j.score;
  } catch (e) {
    process.stdout.write(`    judge error: ${e instanceof Error ? e.message : String(e)}\n`);
    return null;
  }
}

async function main(): Promise<void> {
  if (!fxCompileAvailable()) {
    process.stdout.write("FATAL: fx_compile not available\n");
    process.exit(1);
  }
  const key = judgeKey();
  process.stdout.write(
    `best-of-N: N_max=${N_MAX} temps=${TEMPS.join("/")} judge=${key ? "on" : "OFF"}\n`,
  );
  mkdirSync(OUT_DIR, { recursive: true });

  const models = MODEL_IDS.map((id) => MODELS.find((m) => m.id === id)!);
  const tasks = TASK_IDS.map((id) => TASKS.find((t) => t.id === id)!);
  const cells: CellResult[] = [];
  const persist = (): void =>
    writeFileSync(
      OUT,
      JSON.stringify(
        { config: { nMax: N_MAX, temps: TEMPS, seeds: [...Array(N_MAX)].map((_, i) => seedFor(i)), repairTemp: REPAIR_TEMP, repairSeed: REPAIR_SEED }, cells },
        null,
        2,
      ),
    );

  for (const model of models) {
    const modelPath = resolve(MODELS_DIR, model.file);
    process.stdout.write(`\n=== ${model.id} ===\n`);
    for (const task of tasks) {
      const { system, user } = buildAuthoringPrompt(task.ask, STARTER_SOURCE, { edit: true });
      const candidates: Candidate[] = [];

      for (let i = 0; i < N_MAX; i++) {
        const temp = TEMPS[i % TEMPS.length]!;
        const out = await sampleOnce(modelPath, system, user, { seed: seedFor(i), temperature: temp });
        const ext = extractProgram(out.text, STARTER_SOURCE);
        let compiled = false;
        let diagnostics = "";
        let errorCount = Number.POSITIVE_INFINITY;
        if (ext.source !== null && ext.source !== "") {
          const comp = compile(ext.source);
          compiled = comp.ok;
          diagnostics = comp.diagnostics;
          errorCount = comp.ok ? 0 : countErrors(comp.diagnostics);
        }
        candidates.push({
          idx: i,
          seed: seedFor(i),
          temp,
          seconds: out.seconds,
          hadThinking: out.hadThinking,
          obtained: ext.obtained,
          compiled,
          errorCount: Number.isFinite(errorCount) ? errorCount : -1, // -1 = no program (JSON-safe)
          diagnostics: diagnostics.slice(0, 400),
          source: ext.source ?? "",
          judgeScore: null,
          replyHead: out.text.slice(0, 100),
        });
        process.stdout.write(
          `  ${task.id} cand#${i} t=${temp} ${ext.obtained.padEnd(9)} ${compiled ? "COMPILES" : ext.source ? `${errorCount}err` : "-"} ${out.seconds.toFixed(0)}s\n`,
        );
      }

      // Hybrid repairs (closest = fewest errors; errorCount -1 means no program).
      const withErr = (cs: Candidate[]): Candidate[] =>
        cs.map((c) => ({ ...c, errorCount: c.errorCount < 0 ? Number.POSITIVE_INFINITY : c.errorCount }));
      const doRepair = async (fromCand: Candidate): Promise<Repair> => {
        const out = await sampleOnce(modelPath, system, repairUser(task.ask, fromCand.source, fromCand.diagnostics), {
          seed: REPAIR_SEED,
          temperature: REPAIR_TEMP,
        });
        const ext = extractProgram(out.text, fromCand.source);
        let compiled = false;
        let diagnostics = "";
        if (ext.source) {
          const comp = compile(ext.source);
          compiled = comp.ok;
          diagnostics = comp.diagnostics;
        }
        process.stdout.write(
          `  ${task.id} repair(of #${fromCand.idx}) ${ext.obtained} ${compiled ? "COMPILES" : "fail"} ${out.seconds.toFixed(0)}s\n`,
        );
        return {
          fromIdx: fromCand.idx,
          seconds: out.seconds,
          obtained: ext.obtained,
          compiled,
          diagnostics: diagnostics.slice(0, 400),
          source: ext.source ?? "",
          judgeScore: null,
        };
      };

      let repair4: Repair | null = null;
      let repair8: Repair | null = null;
      let repair8SameAs4 = false;
      const none4 = !candidates.slice(0, 4).some((c) => c.compiled);
      const none8 = !candidates.some((c) => c.compiled);
      const c4 = none4 ? closest(withErr(candidates), 4) : null;
      const c8 = none8 ? closest(withErr(candidates), 8) : null;
      if (c4) repair4 = await doRepair(c4);
      if (c8) {
        if (c4 && c8.idx === c4.idx && repair4) {
          repair8 = repair4;
          repair8SameAs4 = true;
        } else {
          repair8 = await doRepair(c8);
        }
      }

      // Judge every unique compiling source in the cell (candidates + repairs).
      if (key) {
        const scores = new Map<string, number | null>();
        const uniques: string[] = [];
        for (const c of candidates) if (c.compiled && !scores.has(c.source)) { scores.set(c.source, null); uniques.push(c.source); }
        for (const r of [repair4, repair8]) if (r?.compiled && !scores.has(r.source)) { scores.set(r.source, null); uniques.push(r.source); }
        for (const src of uniques) scores.set(src, await judgeSafe(task.ask, task.rubric, src, key));
        for (const c of candidates) if (c.compiled) c.judgeScore = scores.get(c.source) ?? null;
        for (const r of [repair4, repair8]) if (r?.compiled) r.judgeScore = scores.get(r.source) ?? null;
        const judged = candidates.filter((c) => c.judgeScore !== null);
        if (judged.length)
          process.stdout.write(
            `  ${task.id} judged ${uniques.length} unique: [${judged.map((c) => `#${c.idx}=${c.judgeScore?.toFixed(2)}`).join(" ")}]` +
              (repair4?.judgeScore != null ? ` r4=${repair4.judgeScore.toFixed(2)}` : "") +
              (repair8 && !repair8SameAs4 && repair8.judgeScore != null ? ` r8=${repair8.judgeScore.toFixed(2)}` : "") +
              "\n",
          );
      }

      cells.push({ model: model.id, task: task.id, candidates, repair4, repair8, repair8SameAs4 });
      persist();
    }
  }
  await disposeExpBackend();
  persist();

  // ---- Summary -------------------------------------------------------------
  process.stdout.write("\n================== BEST-OF-N SUMMARY ==================\n");
  process.stdout.write(
    "model                       arm        comp%  judge  oracle  s/task(full)  s/task(early)\n",
  );
  for (const mid of MODEL_IDS) {
    const mcells = cells.filter((c) => c.model === mid);
    for (const n of [4, 8]) {
      let comp = 0, firstJ = 0, oracleJ = 0, full = 0, early = 0, hybComp = 0, hybJ = 0, hybCost = 0;
      for (const cell of mcells) {
        const pre = cell.candidates.slice(0, n);
        full += pre.reduce((a, c) => a + c.seconds, 0);
        const fi = pre.findIndex((c) => c.compiled);
        if (fi >= 0) {
          comp++;
          early += pre.slice(0, fi + 1).reduce((a, c) => a + c.seconds, 0);
          firstJ += pre[fi]!.judgeScore ?? 0;
          oracleJ += Math.max(...pre.filter((c) => c.compiled).map((c) => c.judgeScore ?? 0));
          hybComp++;
          hybJ += pre[fi]!.judgeScore ?? 0;
          hybCost += pre.slice(0, fi + 1).reduce((a, c) => a + c.seconds, 0);
        } else {
          early += pre.reduce((a, c) => a + c.seconds, 0);
          const rep = n === 4 ? cell.repair4 : cell.repair8;
          hybCost += pre.reduce((a, c) => a + c.seconds, 0) + (rep?.seconds ?? 0);
          if (rep?.compiled) {
            hybComp++;
            hybJ += rep.judgeScore ?? 0;
          }
        }
      }
      const k = mcells.length;
      process.stdout.write(
        `${mid.padEnd(26)}  boN n=${n}    ${String(Math.round((100 * comp) / k)).padStart(3)}%  ${(firstJ / k).toFixed(2)}   ${(oracleJ / k).toFixed(2)}   ${(full / k).toFixed(0).padStart(6)}s      ${(early / k).toFixed(0).padStart(6)}s\n` +
          `${" ".repeat(26)}  hybrid n=${n} ${String(Math.round((100 * hybComp) / k)).padStart(3)}%  ${(hybJ / k).toFixed(2)}    -     ${(hybCost / k).toFixed(0).padStart(6)}s (early-stop)\n`,
      );
    }
  }
  process.stdout.write(`\nwrote ${OUT}\n`);
}

void main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
