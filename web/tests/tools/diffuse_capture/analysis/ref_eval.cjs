// ref_eval.cjs <rawdir> <out.json> [paramsJSON]: production reference (diffuseDetect.ts) + reducedToBlobs.
const fs = require("fs"), path = require("path");
const { adaptiveDiffuseReduce, boxReduceRgb8, DEFAULT_ADAPTIVE_DIFFUSE } = require("./dist2/cv/diffuseDetect.js");
const { reducedToBlobs } = require("./dist2/cv/detect.js");
const [rawdir, outPath, pj] = process.argv.slice(2);
const P = { ...DEFAULT_ADAPTIVE_DIFFUSE, ...(pj ? JSON.parse(pj) : {}) };
const W = 720, H = 1280, res = {};
for (const f of fs.readdirSync(rawdir).filter((f) => f.endsWith(".rgb") && !f.startsWith("dark")).sort()) {
  const { rgb, w, h } = boxReduceRgb8(fs.readFileSync(path.join(rawdir, f)), W, H, 2);
  const { detect } = adaptiveDiffuseReduce(rgb, w, h, P);
  res[f.slice(0, -4)] = reducedToBlobs(detect, w, h, 2, H, false, { minArea: 2, maxArea: 4000, maxBlobs: 2048, maxAspect: 3 })
    .map((b) => [+b.u.toFixed(2), +b.v.toFixed(2), +b.intensity.toFixed(3), b.area | 0, b.split ? 1 : 0]);
}
fs.writeFileSync(outPath, JSON.stringify({ ref: res }));
