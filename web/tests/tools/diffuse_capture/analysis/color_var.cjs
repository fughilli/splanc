// color_var.cjs <rawdir> <out.json>: same adaptive mask, different OUTPUT colour sources.
const fs = require("fs"), path = require("path");
const D = require("./dist2/cv/diffuseDetect.js");
const { reducedToBlobs } = require("./dist2/cv/detect.js");
const [rawdir, outPath] = process.argv.slice(2);
const W = 720, H = 1280, P = D.DEFAULT_ADAPTIVE_DIFFUSE;
function run(rgb, w, h, mode) {
  const n = w * h, pl = new Float32Array(n), dog = [], bgs = [], spots = [], raw = new Float32Array(n);
  for (let i = 0; i < n; i++) raw[i] = Math.max(rgb[i*3], rgb[i*3+1], rgb[i*3+2]);
  for (let c = 0; c < 3; c++) { for (let i = 0; i < n; i++) pl[i] = rgb[i*3+c];
    const s = D.box3(pl, w, h, P.spotBoxRadius), b = D.box3(pl, w, h, P.bgBoxRadius); spots.push(Float32Array.from(s)); bgs.push(b);
    for (let i = 0; i < n; i++) s[i] -= b[i]; dog.push(s); }
  const resp = new Float32Array(n); for (let i = 0; i < n; i++) resp[i] = Math.max(dog[0][i], dog[1][i], dog[2][i]);
  const nf = D.noiseFloor(D.statSample(resp, w, h, P.statStride), P.kSigma);
  const cl = resp.map((v) => Math.max(0, v)); const pk = D.maxFilter(cl, w, h, P.peakRadius);
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    if (!(cl[i] >= nf.floor && cl[i] >= P.peakFrac * pk[i])) continue;
    let c;
    if (mode === "dog") c = [0,1,2].map((k) => Math.max(0, dog[k][i]));
    else if (mode === "raw") c = [0,1,2].map((k) => rgb[i*3+k]);
    else if (mode === "rawbg") c = [0,1,2].map((k) => Math.max(0, rgb[i*3+k] - bgs[k][i]));
    else if (mode === "spot") c = [0,1,2].map((k) => spots[k][i]);
    else if (mode === "rawmin") { const mn = Math.min(rgb[i*3], rgb[i*3+1], rgb[i*3+2]); c = [0,1,2].map((k) => rgb[i*3+k] - mn); }
    const r = Math.max(...c); D.encodePixel(out, i, c[0], c[1], c[2], r > 0 ? r : 1, raw[i]);
  }
  return out;
}
const modes = ["dog", "raw", "rawbg", "spot", "rawmin"], res = {};
for (const m of modes) res[m] = {};
for (const f of fs.readdirSync(rawdir).filter((f) => f.endsWith(".rgb") && f.startsWith("pal_")).sort()) {
  const { rgb, w, h } = D.boxReduceRgb8(fs.readFileSync(path.join(rawdir, f)), W, H, 2);
  for (const m of modes) res[m][f.slice(0, -4)] = reducedToBlobs(run(rgb, w, h, m), w, h, 2, H, false, { minArea: 2, maxArea: 4000, maxBlobs: 2048, maxAspect: 3 })
    .map((b) => [+b.u.toFixed(2), +b.v.toFixed(2), +b.intensity.toFixed(3), b.area | 0, b.split ? 1 : 0, +b.r.toFixed(4), +b.g.toFixed(4), +b.b.toFixed(4)]);
}
fs.writeFileSync(outPath, JSON.stringify(res));
