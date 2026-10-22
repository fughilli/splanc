// Run the app/agent offline cost model (web/src/effects/costModel.ts with the
// shipped DEFAULT table from web/src/store/costTableStore.ts — exactly what the
// MCP agent's estimate_effect / deploy gate use) over a list of compiled
// programs. Node >= 22 (type stripping); no npm deps.
//
//   node --experimental-strip-types tools/fx_perf/estimate.mjs <srcdir> <in.json> <out.json>
//
// <srcdir> holds costModel.ts + costTableStore.ts (main's, or another branch's
// via `git show`); in.json = [{label, fxb: <base64>, leds}]; out.json adds
// {frameCycles, updateCycles, shadeCyclesPerLed, totalMs, walkStopped}.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [srcdir, inPath, outPath] = process.argv.slice(2);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fxest-"));
fs.mkdirSync(path.join(tmp, "effects"));
fs.mkdirSync(path.join(tmp, "store"));
const fix = (s) => s.replace(/from "(\.{1,2}\/[^"]+)"/g, (m, p) => `from "${p}.ts"`);
fs.writeFileSync(path.join(tmp, "effects/costModel.ts"), fix(fs.readFileSync(path.join(srcdir, "costModel.ts"), "utf8")));
fs.writeFileSync(path.join(tmp, "store/costTableStore.ts"), fix(fs.readFileSync(path.join(srcdir, "costTableStore.ts"), "utf8")));
const cm = await import(path.join(tmp, "effects/costModel.ts"));
const ts = await import(path.join(tmp, "store/costTableStore.ts"));
const table = ts.defaultCostTable();
const rows = JSON.parse(fs.readFileSync(inPath, "utf8"));
const out = [];
for (const r of rows) {
  const fxb = Uint8Array.from(Buffer.from(r.fxb, "base64"));
  try {
    const e = cm.estimateFrameTime({ bytecode: fxb, ledCount: r.leds, table });
    // frame (update+shade) cycles, excluding the modelled show/transmit term.
    const frameMs = e.phaseSplit.updateMs + e.phaseSplit.shadeMs;
    out.push({
      ...r,
      fxb: undefined,
      frameCycles: Math.round((frameMs / 1000) * table.cpuHz),
      updateCycles: Math.round((e.phaseSplit.updateMs / 1000) * table.cpuHz),
      shadeCyclesPerLed: Math.round(((e.phaseSplit.shadeMs / 1000) * table.cpuHz) / Math.max(1, r.leds)),
      totalMs: e.totalMs,
      opsPerLed: e.opsPerLed,
      branched: e.branched,
      loopCapped: e.loopCapped,
    });
  } catch (err) {
    out.push({ ...r, fxb: undefined, error: String(err) });
  }
}
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
console.error(`estimated ${out.length} programs with ${srcdir}`);
