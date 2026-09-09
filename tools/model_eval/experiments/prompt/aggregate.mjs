// Merge variant runs + the baseline subset (from ../../results.json) into
// experiments/prompt/results.json and print a comparison table.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MODELS = ["qwen3-0.6b", "qwen2.5-1.5b-instruct", "qwen2.5-3b-instruct"];
const TASKS = ["pinwheel", "breathing-red", "rainbow-sweep", "comet"];
const VARIANTS = ["baseline3", "examples", "antipatterns", "feedback", "combined"];

const baselineAll = JSON.parse(readFileSync(resolve(here, "../../results.json"), "utf8"));
const baseCells = baselineAll.cells
  .filter((c) => MODELS.includes(c.model) && TASKS.includes(c.task))
  .map((c) => ({ variant: "baseline(4r)", ...c }));

const runs = { "baseline(4r)": { cells: baseCells, note: "from results.json (4 repair rounds)" } };
for (const v of VARIANTS) {
  const p = resolve(here, `results-${v}.json`);
  if (existsSync(p)) runs[v] = JSON.parse(readFileSync(p, "utf8"));
}

function stats(cells) {
  const n = cells.length;
  const eff = cells.filter((c) => c.obtained !== "none").length;
  const comp = cells.filter((c) => c.compiled).length;
  const tool = cells.filter((c) => c.emittedToolCall).length;
  // judge over ALL cells (null → 0) so variants aren't rewarded for unjudged cells
  const judge = n ? cells.reduce((a, c) => a + (c.judgeScore ?? 0), 0) / n : 0;
  return { n, eff, comp, tool, judge };
}

const summary = {};
for (const [v, run] of Object.entries(runs)) {
  summary[v] = { overall: stats(run.cells), byModel: {} };
  for (const m of MODELS) summary[v].byModel[m] = stats(run.cells.filter((c) => c.model === m));
}

const pct = (a, b) => Math.round((100 * a) / b) + "%";
let table = "variant        model                    eff%   comp%  judge\n";
for (const [v, s] of Object.entries(summary)) {
  for (const m of MODELS) {
    const t = s.byModel[m];
    table += `${v.padEnd(14)} ${m.padEnd(24)} ${pct(t.eff, t.n).padStart(4)}  ${pct(t.comp, t.n).padStart(5)}  ${t.judge.toFixed(2)}\n`;
  }
  const o = s.overall;
  table += `${v.padEnd(14)} ${"ALL".padEnd(24)} ${pct(o.eff, o.n).padStart(4)}  ${pct(o.comp, o.n).padStart(5)}  ${o.judge.toFixed(2)}\n\n`;
}
console.log(table);

writeFileSync(
  resolve(here, "results.json"),
  JSON.stringify(
    {
      experiment: "prompt surgery + repair feedback",
      models: MODELS,
      tasks: TASKS,
      rounds: { baseline: 4, variants: 3 },
      summary,
      cells: Object.values(runs).flatMap((r) => r.cells),
    },
    null,
    2,
  ),
);
console.log("wrote", resolve(here, "results.json"));
