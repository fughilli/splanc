/**
 * Scoring for the diffuse_rope real-frame set (web/tests/testdata/diffuse_rope):
 * pure functions over the dataset's truth.json and a detector's blobs, shared by
 * the regression suite (tests/diffuseRope.test.ts, which loads frames with fs)
 * and the browser detector bench (tests/tools/detect_bench, which fetches them
 * and scores the production WebGL path against the same truth).
 *
 * Per frame, against the lit LEDs that are DETECTABLE (known-location response
 * > 5x noise — the dataset precomputes it): a blob within MATCH_PX of a lit
 * LED's centre matches it (greedy, nearest first); unmatched blobs near a lit
 * LED are splits; blobs near no lit LED are false positives.
 */

import { reducedToBlobs } from "../src/cv/detect";
import type { Blob } from "../src/cv/types";

export interface RopeFrame {
  file: string;
  brightness: number;
  exposure: number;
  exposureMs: number;
  kind: "stride3" | "stride2" | "palette";
  lit: [number, [number, number, number]][];
  detectable: number[];
}
export interface RopeTruth {
  crop: { x: number; y: number; w: number; h: number };
  centers: ([number, number] | null)[];
  frames: RopeFrame[];
}

/** A third of the adjacent-LED spacing. */
export const MATCH_PX = 15;

export interface RopeScore {
  frames: number;
  detectable: number;
  hits: number;
  fp: number;
  splits: number;
  errs: number[];
  byColor: Map<string, { n: number; hit: number }>;
  /** Matched blobs of 4-symbol palette colours: classified to the right hue? */
  hue4: Map<string, { n: number; ok: number }>;
}

export const emptyScore = (): RopeScore => ({
  frames: 0,
  detectable: 0,
  hits: 0,
  fp: 0,
  splits: 0,
  errs: [],
  byColor: new Map(),
  hue4: new Map(),
});

/** Hue in degrees of an RGB triple (channelQuality.ts hueSat, in degrees). */
export function hueDeg(r: number, g: number, b: number): number | null {
  const mx = Math.max(r, g, b);
  const c = mx - Math.min(r, g, b);
  if (mx <= 0 || c <= 0) return null;
  const h = mx === r ? ((g - b) / c) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4;
  return (h * 60 + 360) % 360;
}

/** The 4-symbol palette's hues (firmware/pattern symbol_color: blue, magenta,
 * yellow, red) — the decoder picks the nearest. */
export const HUE4: Record<string, number> = { "001": 240, "101": 300, "110": 60, "100": 0 };
const angDist = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180);

export const COLOR = new Map([
  ["100", "red"],
  ["001", "blue"],
  ["101", "magenta"],
  ["110", "yellow"],
  ["111", "white"],
  ["010", "green"],
]);

/** Blobs from a detect buffer at the dataset's detection resolution (row 0 = top). */
export function ropeBlobs(truth: RopeTruth, detect: Uint8Array): Blob[] {
  return reducedToBlobs(detect, truth.crop.w / 2, truth.crop.h / 2, 2, truth.crop.h, false, {
    minArea: 2,
    maxArea: 4000,
    maxBlobs: 2048,
    maxAspect: 3,
  });
}

/** Score one frame's blobs (crop-relative full-res px, as ropeBlobs returns) into `s`. */
export function scoreFrame(truth: RopeTruth, f: RopeFrame, blobs: readonly Blob[], s: RopeScore): void {
  s.frames++;
  const pts = blobs.map((b) => [b.u + truth.crop.x, b.v + truth.crop.y] as const);
  const lit = f.lit.filter(([i]) => truth.centers[i] !== null);
  const det = new Set(f.detectable);
  const pairs: [number, number, number][] = [];
  let unnear = 0;
  pts.forEach(([x, y], j) => {
    let near = false;
    for (const [i] of lit) {
      const [cx, cy] = truth.centers[i]!;
      const d = Math.hypot(cx - x, cy - y);
      if (d < MATCH_PX) {
        pairs.push([d, j, i]);
        near = true;
      }
    }
    if (!near) unnear++;
  });
  pairs.sort((a, b) => a[0] - b[0]);
  const usedB = new Set<number>();
  const usedL = new Set<number>();
  const nearB = new Set(pairs.map((p) => p[1]));
  const colorOf = new Map(f.lit.map(([i, rgb]) => [i, rgb.join("")]));
  for (const [d, j, i] of pairs) {
    if (usedB.has(j) || usedL.has(i)) continue;
    usedB.add(j);
    usedL.add(i);
    if (det.has(i)) {
      s.hits++;
      s.errs.push(d);
      const key = colorOf.get(i)!;
      const target = HUE4[key];
      const h = hueDeg(blobs[j]!.r!, blobs[j]!.g!, blobs[j]!.b!);
      if (target !== undefined && h !== null) {
        const nearest = Object.values(HUE4).reduce((a, b) => (angDist(h, a) <= angDist(h, b) ? a : b));
        const c = s.hue4.get(key) ?? { n: 0, ok: 0 };
        c.n++;
        if (nearest === target) c.ok++;
        s.hue4.set(key, c);
      }
    }
  }
  s.detectable += det.size;
  s.fp += unnear;
  s.splits += [...nearB].filter((j) => !usedB.has(j)).length;
  for (const [i, rgb] of lit) {
    if (!det.has(i)) continue;
    const key = rgb.join("");
    const c = s.byColor.get(key) ?? { n: 0, hit: 0 };
    c.n++;
    if (usedL.has(i)) c.hit++;
    s.byColor.set(key, c);
  }
}

export const median = (a: readonly number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[s.length >> 1]! : NaN;
};

export interface RopeSummary {
  recall: number;
  fpPerFrame: number;
  splitPerFrame: number;
  medErr: number;
}

export function summarize(r: RopeScore): RopeSummary {
  return {
    recall: r.hits / r.detectable,
    fpPerFrame: r.fp / r.frames,
    splitPerFrame: r.splits / r.frames,
    medErr: median(r.errs),
  };
}

/** One report line (what the suite logs). */
export function scoreLine(name: string, r: RopeScore): string {
  const m = summarize(r);
  const colors = [...r.byColor].map(([k, c]) => `${COLOR.get(k)} ${(c.hit / c.n).toFixed(2)}`).join(" ");
  return (
    `${name}: ${r.frames} frames, recall ${m.recall.toFixed(3)} (${r.hits}/${r.detectable}), fp/frame ${m.fpPerFrame.toFixed(1)}, ` +
    `split/frame ${m.splitPerFrame.toFixed(2)}, median err ${m.medErr.toFixed(2)} px${colors ? ` | ${colors}` : ""}`
  );
}

export const hue4Line = (x: RopeScore): string =>
  [...x.hue4].map(([k, c]) => `${COLOR.get(k)} ${(c.ok / c.n).toFixed(2)} (n=${c.n})`).join(" ");
