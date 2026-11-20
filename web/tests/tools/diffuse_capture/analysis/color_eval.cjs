// color_eval.cjs <rawdir> <out.json>: blobs WITH colour for legacy (CPU copy of the top-hat shader) and adaptive.
const fs = require("fs"), path = require("path");
const D = require("./dist2/cv/diffuseDetect.js");
const { reducedToBlobs } = require("./dist2/cv/detect.js");
const [rawdir, outPath] = process.argv.slice(2);
const W = 720, H = 1280;
function legacy(rgb, w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = [0, 0, 0];
    for (let c = 0; c < 3; c++) { let bg = 0;
      for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) { const sx = Math.min(w - 1, Math.max(0, x + i * 4)), sy = Math.min(h - 1, Math.max(0, y + j * 4)); bg += rgb[(sy * w + sx) * 3 + c]; }
      v[c] = Math.max(0, rgb[(y * w + x) * 3 + c] - bg / 25); }
    const lum = Math.max(...v); if (lum < 0.18) continue; const o = (y * w + x) * 4;
    out[o] = Math.round(Math.min(1, v[0]) * 255); out[o + 1] = Math.round(Math.min(1, v[1]) * 255); out[o + 2] = Math.round(Math.min(1, v[2]) * 255); out[o + 3] = Math.round(Math.min(1, lum) * 255);
  }
  return out;
}
const res = { legacy: {}, adaptive: {} };
for (const f of fs.readdirSync(rawdir).filter((f) => f.endsWith(".rgb") && !f.startsWith("dark")).sort()) {
  const { rgb, w, h } = D.boxReduceRgb8(fs.readFileSync(path.join(rawdir, f)), W, H, 2);
  for (const [k, buf] of [["legacy", legacy(rgb, w, h)], ["adaptive", D.adaptiveDiffuseReduce(rgb, w, h).detect]]) {
    res[k][f.slice(0, -4)] = reducedToBlobs(buf, w, h, 2, H, false, { minArea: 2, maxArea: 4000, maxBlobs: 2048, maxAspect: 3 })
      .map((b) => [+b.u.toFixed(2), +b.v.toFixed(2), +b.intensity.toFixed(3), b.area | 0, b.split ? 1 : 0, +b.r.toFixed(4), +b.g.toFixed(4), +b.b.toFixed(4)]);
  }
}
fs.writeFileSync(outPath, JSON.stringify(res));
