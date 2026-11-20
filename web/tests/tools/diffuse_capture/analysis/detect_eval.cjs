// detect_eval.cjs <rawdir> <config.json> <out.json>
// Runs the PRODUCTION CPU blob stage (reducedToBlobs, compiled from web/src/cv/detect.ts)
// on a tap-faithful CPU emulation of detect.ts's GL shader, over raw RGB frames
// (<name>.rgb, 720x1280x3 u8, written by to_raw.py). Variants of the GPU stage are
// selected by config.variant so candidate shader changes can be scored the same way.
const fs = require("fs");
const path = require("path");
const { reducedToBlobs } = require("./dist/cv/detect.js");

const [rawdir, cfgPath, outPath] = process.argv.slice(2);
const cfgs = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const W = 720, H = 1280;

// Bilinear sample of channel-planar float image at full-res pixel coords (texel
// centres at integer+0.5 in GL; here pixel i centre = i), clamp-to-edge.
function bilinear(img, x, y, c) {
  x = Math.min(W - 1, Math.max(0, x)); y = Math.min(H - 1, Math.max(0, y));
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
  const fx = x - x0, fy = y - y0, p = img[c];
  const a = p[y0 * W + x0], b = p[y0 * W + x1], d = p[y1 * W + x0], e = p[y1 * W + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
}

function load(file) {
  const u8 = fs.readFileSync(file);
  const img = [new Float32Array(W * H), new Float32Array(W * H), new Float32Array(W * H)];
  for (let i = 0, n = W * H; i < n; i++) { img[0][i] = u8[i * 3] / 255; img[1][i] = u8[i * 3 + 1] / 255; img[2][i] = u8[i * 3 + 2] / 255; }
  return img;
}

// Separable box/gaussian helpers for non-production variants (multi-pass shaders).
function blurPlane(p, w, h, sigma) {
  // Three box passes per axis ~ gaussian (box radius from sigma: 3 boxes of width
  // b have variance 3*(b^2-1)/12 = sigma^2). O(1)/px via running sums, clamp-to-edge.
  const b = Math.max(1, Math.round(Math.sqrt(4 * sigma * sigma + 1))), r = (b - 1) >> 1;
  let cur = p;
  for (let pass = 0; pass < 3; pass++) { cur = boxH(cur, w, h, r); cur = boxV(cur, w, h, r); }
  return cur;
}
function boxH(p, w, h, r) {
  const o = new Float32Array(w * h), n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w; let s = 0;
    for (let i = -r; i <= r; i++) s += p[row + Math.min(w - 1, Math.max(0, i))];
    for (let x = 0; x < w; x++) {
      o[row + x] = s / n;
      s += p[row + Math.min(w - 1, x + r + 1)] - p[row + Math.max(0, x - r)];
    }
  }
  return o;
}
function boxV(p, w, h, r) {
  const o = new Float32Array(w * h), n = 2 * r + 1;
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += p[Math.min(h - 1, Math.max(0, i)) * w + x];
    for (let y = 0; y < h; y++) {
      o[y * w + x] = s / n;
      s += p[Math.min(h - 1, y + r + 1) * w + x] - p[Math.max(0, y - r) * w + x];
    }
  }
  return o;
}

function reduce(img, cfg) {
  const ds = cfg.downscale ?? 2;
  const w = Math.max(1, Math.round(W / ds)), h = Math.max(1, Math.round(H / ds));
  const red = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)];
  const radius = cfg.radiusPx ?? 8, gain = cfg.lcGain ?? 0;
  const step = (radius * ds) / 2; // full-res px between the 5x5 background taps (detect.ts)
  for (let ry = 0; ry < h; ry++) for (let rx = 0; rx < w; rx++) {
    // Fragment centre in full-res pixel coords (uv*size - 0.5).
    const fx = ((rx + 0.5) / w) * W - 0.5, fy = ((ry + 0.5) / h) * H - 0.5;
    for (let c = 0; c < 3; c++) {
      let v = bilinear(img, fx, fy, c);
      if (cfg.variant === "prod" && gain > 0) {
        let bg = 0;
        for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) bg += bilinear(img, fx + step * i, fy + step * j, c);
        v = Math.max(v - gain * (bg / 25), 0);
      }
      red[c][ry * w + rx] = v;
    }
  }
  const mask = cfg.variant !== "prod" ? variantFilter(red, w, h, cfg) : null;
  const buf = new Uint8Array(w * h * 4), thr = cfg.threshold;
  for (let i = 0; i < w * h; i++) {
    const r = Math.min(1, red[0][i]), g = Math.min(1, red[1][i]), b = Math.min(1, red[2][i]);
    const lum = Math.max(r, g, b), m = mask ? mask[i] : lum >= thr ? 1 : 0;
    buf[i * 4] = (r * m * 255) | 0; buf[i * 4 + 1] = (g * m * 255) | 0; buf[i * 4 + 2] = (b * m * 255) | 0; buf[i * 4 + 3] = (m * lum * 255) | 0;
  }
  return { buf, w, h, ds };
}

// Candidate GPU-stage variants (all shader-implementable as 1-3 passes).
function variantFilter(red, w, h, cfg) {
  if (cfg.variant === "dog") {
    // Difference of gaussians at detection res: smooth at the spot scale, subtract a
    // wide background; then normalise by a noise floor so the threshold reads SNR-ish.
    for (let c = 0; c < 3; c++) {
      const s = blurPlane(red[c], w, h, cfg.sigmaSpot), b = blurPlane(red[c], w, h, cfg.sigmaBg);
      const g = cfg.lcGain ?? 1, k = cfg.outGain ?? 1;
      for (let i = 0; i < w * h; i++) red[c][i] = Math.max(0, (s[i] - g * b[i]) * k);
    }
  } else if (cfg.variant === "dognorm") {
    // DoG, then divide by a local max-envelope so dim and bright spots both reach ~1
    // at their peak (contrast-normalised); threshold is then a fraction of local peak.
    const lum = new Float32Array(w * h);
    for (let c = 0; c < 3; c++) {
      const s = blurPlane(red[c], w, h, cfg.sigmaSpot), b = blurPlane(red[c], w, h, cfg.sigmaBg);
      for (let i = 0; i < w * h; i++) { red[c][i] = Math.max(0, s[i] - b[i]); lum[i] = Math.max(lum[i], red[c][i]); }
    }
    const env = blurPlane(lum, w, h, cfg.sigmaEnv); // smooth envelope ~ local spot peak scale
    const floor = cfg.floor;
    for (let c = 0; c < 3; c++) for (let i = 0; i < w * h; i++) red[c][i] = red[c][i] / Math.max(floor, cfg.envK * env[i]);
  } else if (cfg.variant === "adapt") {
    // DoG spot response per channel; keep a pixel when its max-channel response
    // clears BOTH a frame noise floor (kSigma x robust sigma of the response, a
    // per-frame statistic the CPU can carry from the previous frame) AND a fraction
    // of the local peak (separable max filter, radius envR) -- the latter splits
    // touching neighbours at their saddle. Weights stay the raw response, rescaled
    // into the 8-bit range by a per-frame gain (also a carried statistic).
    const n = w * h, lum = new Float32Array(n).fill(-1), slum = new Float32Array(n).fill(-1);
    for (let c = 0; c < 3; c++) {
      const s = blurPlane(red[c], w, h, cfg.sigmaSpot), b = blurPlane(red[c], w, h, cfg.sigmaBg);
      for (let i = 0; i < n; i++) { const d = s[i] - b[i]; if (d > slum[i]) slum[i] = d; red[c][i] = Math.max(0, d); }
    }
    for (let i = 0; i < n; i++) lum[i] = Math.max(0, slum[i]);
    // Noise from the SIGNED response (a clamped one has MAD 0 on a dark frame).
    const sample = []; for (let i = 0; i < n; i += 7) sample.push(slum[i]);
    sample.sort((a, z) => a - z);
    const med = sample[sample.length >> 1];
    const dev = sample.map((v) => Math.abs(v - med)).sort((a, z) => a - z);
    const sigma = 1.4826 * dev[dev.length >> 1] + (cfg.sigmaFloor ?? 1e-4);
    const lmax = maxFilter(lum, w, h, cfg.envR);
    const mask = new Uint8Array(n);
    const floorT = med + cfg.kSigma * sigma;
    let top = 0; for (let i = 0; i < n; i++) if (lum[i] > top) top = lum[i];
    const gain = top > 0 ? 1 / top : 1;
    for (let i = 0; i < n; i++) mask[i] = lum[i] >= floorT && lum[i] >= cfg.frac * lmax[i] ? 1 : 0;
    for (let c = 0; c < 3; c++) for (let i = 0; i < n; i++) red[c][i] *= gain;
    return mask;
  }
  return null;
}
function maxFilter(p, w, h, r) {
  const t = new Float32Array(w * h), o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let m = 0; for (let i = Math.max(0, x - r); i <= Math.min(w - 1, x + r); i++) if (p[y * w + i] > m) m = p[y * w + i]; t[y * w + x] = m; }
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) { let m = 0; for (let i = Math.max(0, y - r); i <= Math.min(h - 1, y + r); i++) if (t[i * w + x] > m) m = t[i * w + x]; o[y * w + x] = m; }
  return o;
}

const files = fs.readdirSync(rawdir).filter((f) => f.endsWith(".rgb") && !f.startsWith("dark")).sort();
const out = {};
for (const cfg of cfgs) {
  const res = {};
  for (const f of files) {
    const img = load(path.join(rawdir, f));
    const { buf, w, h, ds } = reduce(img, cfg);
    const blobs = reducedToBlobs(buf, w, h, ds, H, false, { minArea: cfg.minArea ?? 2, maxArea: cfg.maxArea ?? 4000, maxBlobs: 2048, maxAspect: cfg.maxAspect ?? 3 });
    // CCL centroid is in detection px -> reducedToBlobs scales by ds; the GL fragment
    // centre offset (+0.5 det px -> full-res) is applied here so centres are comparable.
    res[f.slice(0, -4)] = blobs.map((b) => [+(b.u).toFixed(2), +(b.v).toFixed(2), +b.intensity.toFixed(3), b.area | 0, b.split ? 1 : 0]);
  }
  out[cfg.name] = res;
  process.stderr.write(`config ${cfg.name}: ${files.length} frames\n`);
}
fs.writeFileSync(outPath, JSON.stringify(out));
