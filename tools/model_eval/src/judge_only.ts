/**
 * Judge-only pass: read a results.json produced by run.ts (which saved every
 * generated program), score each cell's source with Opus, and rewrite the file
 * with judge scores + a refreshed leaderboard. Decouples the cheap judging from
 * the expensive CPU inference sweep, so a key that arrives AFTER the sweep
 * doesn't force a re-run.
 *
 * Usage (from tools/model_eval/):  npx tsx src/judge_only.ts results.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { MODELS } from "./models";
import { TASKS } from "./tasks";
import { judge, judgeKey } from "./judge";

interface Cell {
  model: string;
  task: string;
  compiled: boolean;
  obtained: string;
  source: string;
  judgeScore: number | null;
  judgeRationale: string;
  [k: string]: unknown;
}

async function main(): Promise<void> {
  const file = resolve(process.cwd(), process.argv[2] ?? "results.json");
  const key = judgeKey();
  if (!key) {
    process.stdout.write("no Anthropic key (credentials/anthropic_api_key.txt or ANTHROPIC_API_KEY) — nothing to do\n");
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(file, "utf8")) as { cells: Cell[] };
  const rubric = new Map(TASKS.map((t) => [t.id, t]));

  let done = 0;
  for (const c of data.cells) {
    if (c.obtained === "none" || !c.source) {
      c.judgeScore = 0;
      c.judgeRationale = "no program produced";
      continue;
    }
    const t = rubric.get(c.task);
    if (!t) continue;
    try {
      const j = await judge(t.ask, t.rubric, c.source, c.compiled, key);
      c.judgeScore = j.score;
      c.judgeRationale = j.rationale;
      done++;
      process.stdout.write(`  judged ${c.model}/${c.task}: ${j.score.toFixed(2)}\n`);
    } catch (e) {
      c.judgeRationale = `judge error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  process.stdout.write(`\njudged ${done} programs\n`);

  // Recompute the leaderboard with judge scores.
  const byModel = new Map<string, Cell[]>();
  for (const c of data.cells) {
    const arr = byModel.get(c.model) ?? [];
    arr.push(c);
    byModel.set(c.model, arr);
  }
  process.stdout.write("\nmodel                         comp%  judge\n");
  const rows = [...byModel.entries()].map(([id, cs]) => {
    const comp = cs.filter((c) => c.compiled).length;
    const judged = cs.filter((c) => typeof c.judgeScore === "number");
    const meanJudge = judged.length ? judged.reduce((a, c) => a + (c.judgeScore ?? 0), 0) / judged.length : null;
    const params = MODELS.find((m) => m.id === id)?.params ?? 0;
    return { id, params, n: cs.length, comp, meanJudge };
  });
  rows.sort((a, b) => (b.meanJudge ?? -1) - (a.meanJudge ?? -1));
  for (const r of rows) {
    const cp = `${Math.round((100 * r.comp) / r.n)}%`.padStart(4);
    process.stdout.write(`${r.id.padEnd(28)}  ${cp}   ${r.meanJudge === null ? " - " : r.meanJudge.toFixed(2)}\n`);
  }
  (data as { rows?: unknown }).rows = rows;
  writeFileSync(file, JSON.stringify(data, null, 2));
  process.stdout.write(`\nupdated ${file}\n`);
}

void main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
