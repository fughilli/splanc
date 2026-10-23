// The app/agent offline estimate + the top cost findings (what estimate_effect
// returns) for compiled programs, from this tree's web/src (node >= 22, type
// stripping; no npm deps).
//
//   node estimate.mjs <leds> <in.json>   in.json = [{name, fxb: <base64>, source, warnings}]
//   -> stdout JSON [{name, frameMs, totalMs, findings: [line...], rules: [...]}]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(here, "..", "..", "web", "src");
const [ledsS, inPath] = process.argv.slice(2);
const leds = Number(ledsS);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fxagest-"));
for (const d of ["effects", "store"]) fs.mkdirSync(path.join(tmp, d));
const fix = (s) => s.replace(/from "(\.{1,2}\/[^"]+)"/g, (m, p) => `from "${p}.ts"`);
for (const f of ["effects/costModel.ts", "effects/perfFindings.ts", "store/costTableStore.ts"]) {
  fs.writeFileSync(path.join(tmp, f), fix(fs.readFileSync(path.join(web, f), "utf8")));
}
const cm = await import(path.join(tmp, "effects/costModel.ts"));
const pf = await import(path.join(tmp, "effects/perfFindings.ts"));
const table = (await import(path.join(tmp, "store/costTableStore.ts"))).defaultCostTable();
const out = [];
for (const r of JSON.parse(fs.readFileSync(inPath, "utf8"))) {
  const fxb = Uint8Array.from(Buffer.from(r.fxb, "base64"));
  const e = cm.estimateFrameTime({ bytecode: fxb, ledCount: leds, table });
  const f = pf.perfFindings(fxb, { table, source: r.source, warnings: r.warnings ?? [] });
  out.push({
    name: r.name,
    frameMs: +(e.phaseSplit.updateMs + e.phaseSplit.shadeMs).toFixed(2),
    totalMs: +e.totalMs.toFixed(2),
    findings: pf.findingsToLines(f, leds, table.cpuHz),
    rules: f.map((x) => x.rule),
  });
}
fs.rmSync(tmp, { recursive: true, force: true });
process.stdout.write(JSON.stringify(out));
