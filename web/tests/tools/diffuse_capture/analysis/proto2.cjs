// proto2.cjs <rawdir> <out.json> <configs.json>: luma + chroma two-branch adaptive detector prototypes.
const fs = require("fs"), path = require("path");
const D = require("./dist2/cv/diffuseDetect.js");
const { reducedToBlobs } = require("./dist2/cv/detect.js");
const [rawdir, outPath, cfgPath] = process.argv.slice(2);
const cfgs = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const W = 720, H = 1280;

function branch(plane, w, h, c) {
  const s = D.box3(plane, w, h, c.spotBoxRadius), b = D.box3(plane, w, h, c.bgBoxRadius);
  for (let i = 0; i < s.length; i++) s[i] -= b[i];
  return s;
}
function run(rgb, w, h, c) {
  const n = w * h;
  const raw = new Float32Array(n), chroma = new Float32Array(n), plane = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    raw[i] = Math.max(r, g, b); chroma[i] = raw[i] - Math.min(r, g, b);
  }
  const dog = [];
  for (let ch = 0; ch < 3; ch++) { for (let i = 0; i < n; i++) plane[i] = rgb[i * 3 + ch]; dog.push(branch(plane, w, h, c)); }
  const rl = new Float32Array(n);
  for (let i = 0; i < n; i++) rl[i] = Math.max(dog[0][i], dog[1][i], dog[2][i]);
  const rc = c.chroma ? branch(chroma, w, h, c) : null;
  const keepOf = (resp, k) => {
    const nf = D.noiseFloor(D.statSample(resp, w, h, c.statStride), k);
    const cl = new Float32Array(n); for (let i = 0; i < n; i++) cl[i] = Math.max(0, resp[i]);
    const pk = D.maxFilter(cl, w, h, c.peakRadius);
    const keep = new Uint8Array(n);
    for (let i = 0; i < n; i++) keep[i] = cl[i] >= nf.floor && cl[i] >= c.peakFrac * pk[i] ? 1 : 0;
    return keep;
  };
  const kl = c.luma === false ? new Uint8Array(n) : keepOf(rl, c.kSigma);
  const kc = rc ? keepOf(rc, c.kChroma ?? c.kSigma) : new Uint8Array(n);
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    if (!kl[i] && !kc[i]) continue;
    let dr = Math.max(0, dog[0][i]), dg = Math.max(0, dog[1][i]), db = Math.max(0, dog[2][i]);
    let resp = Math.max(dr, dg, db);
    if (!(resp > 0)) { const mn = Math.min(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]); dr = rgb[i * 3] - mn; dg = rgb[i * 3 + 1] - mn; db = rgb[i * 3 + 2] - mn; resp = Math.max(dr, dg, db); }
    D.encodePixel(out, i, dr, dg, db, resp, raw[i]);
  }
  return out;
}
const res = {};
for (const c of cfgs) {
  const P = { ...D.DEFAULT_ADAPTIVE_DIFFUSE, ...c };
  const r = {};
  for (const f of fs.readdirSync(rawdir).filter((f) => f.endsWith(".rgb") && !f.startsWith("dark")).sort()) {
    const { rgb, w, h } = D.boxReduceRgb8(fs.readFileSync(path.join(rawdir, f)), W, H, 2);
    r[f.slice(0, -4)] = reducedToBlobs(run(rgb, w, h, P), w, h, 2, H, false, { minArea: 2, maxArea: 4000, maxBlobs: 2048, maxAspect: 3 })
      .map((b) => [+b.u.toFixed(2), +b.v.toFixed(2), +b.intensity.toFixed(3), b.area | 0, b.split ? 1 : 0]);
  }
  res[c.name] = r;
}
fs.writeFileSync(outPath, JSON.stringify(res));
