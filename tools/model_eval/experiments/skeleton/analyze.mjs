// Compare baseline (whole-program set_script) vs skeleton fill-in on the same
// 12 cells. Usage: node experiments/skeleton/analyze.mjs  (from tools/model_eval/)
import { readFileSync } from "node:fs";

const MODELS = ["qwen3-0.6b", "qwen2.5-1.5b-instruct", "qwen2.5-3b-instruct"];
const TASKS = ["pinwheel", "breathing-red", "rainbow-sweep", "comet"];

const base = JSON.parse(readFileSync(new URL("../../results.json", import.meta.url))).cells.filter(
  (c) => MODELS.includes(c.model) && TASKS.includes(c.task),
);
const skel = JSON.parse(readFileSync(new URL("./results.json", import.meta.url))).cells;

const agg = (cells) => {
  const n = cells.length;
  const eff = cells.filter((c) => (c.extracted ? c.extracted !== "none" : c.obtained !== "none")).length;
  const comp = cells.filter((c) => c.compiled).length;
  const cc = cells.filter((c) => c.compiled);
  const rnds = cc.length ? cc.reduce((a, c) => a + c.compiledAtRound, 0) / cc.length : null;
  const judged = cells.filter((c) => c.judgeScore !== null && c.judgeScore !== undefined);
  const judge = judged.length ? judged.reduce((a, c) => a + c.judgeScore, 0) / judged.length : null;
  return { n, eff, comp, rnds, judge };
};

const fmt = (a) =>
  `eff ${a.eff}/${a.n}  comp ${a.comp}/${a.n} (${Math.round((100 * a.comp) / a.n)}%)  ` +
  `rnds ${a.rnds === null ? "-" : a.rnds.toFixed(1)}  judge ${a.judge === null ? "-" : a.judge.toFixed(2)}`;

console.log("== per-model: baseline -> skeleton ==");
for (const m of MODELS) {
  console.log(m);
  console.log("  baseline: " + fmt(agg(base.filter((c) => c.model === m))));
  console.log("  skeleton: " + fmt(agg(skel.filter((c) => c.model === m))));
}
console.log("\n== overall ==");
console.log("  baseline: " + fmt(agg(base)));
console.log("  skeleton: " + fmt(agg(skel)));

console.log("\n== per-cell ==");
for (const m of MODELS)
  for (const t of TASKS) {
    const b = base.find((c) => c.model === m && c.task === t);
    const s = skel.find((c) => c.model === m && c.task === t);
    const cell = (c, isSkel) =>
      c
        ? `${c.compiled ? "ok@r" + c.compiledAtRound : "FAIL"} j=${c.judgeScore ?? "-"}${isSkel ? " [" + c.diagClass + (c.protocolErrors ? ` proto=${c.protocolErrors}` : "") + "]" : ""}`
        : "n/a";
    console.log(`${m.padEnd(24)} ${t.padEnd(15)} base: ${cell(b, false).padEnd(16)} skel: ${cell(s, true)}`);
  }

console.log("\n== skeleton failure diags ==");
for (const c of skel.filter((c) => !c.compiled))
  console.log(`${c.model} / ${c.task} [${c.diagClass}]: ${c.compileDiag.slice(0, 160)}`);
