/**
 * Diffuse-fixture capture, validated end-to-end against the REAL detector core
 * (design: diffuse_capture plan §"Stage A"). Renders actual camera frames of a
 * dense LED line through a screen-space bloom (the diffuser model), reduces them
 * exactly as detect.ts's shader would, and runs the production reducedToBlobs →
 * CvPipeline. Proves the three-way story:
 *
 *   - all-lit + bloom            → spots merge, decode yield collapses;
 *   - strided + bloom            → yield recovers materially;
 *   - strided + bloom + prefilter→ yield back near the no-bloom floor.
 *
 * The prefilter is the diffuse-mode `localContrast` high-pass hill-climbed here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodeParams, DetectionRecord, Pose, Vec3 } from "@ledmapper/protocol";
import { phaseCount, type StrideParams } from "../src/code/stride";
import { reducedToBlobs, type ReduceToBlobsOptions } from "../src/cv/detect";
import { CvPipeline } from "../src/cv/pipeline";
import { lookAtQuat, project } from "../src/geom/pinhole";
import { reduceToDetect, renderFrame, type LocalContrast, type RenderOptions } from "../src/sim/render";

// 32-LED strip, 2 symbols. Small image keeps the per-frame bloom + CCL cheap.
const PARAMS: CodeParams = {
  ledCount: 32,
  bits: 11, // ceil(log2(33))=6 data + 4 Hamming + 1 overall (SEC-DED)
  encoding: "hue",
  symbols: 2,
  bitPeriodMs: 100,
  syncPattern: "on_off",
  cycleFrames: 13,
  fec: "secded",
};
const IMG_W = 384;
const IMG_H = 216;
const FX = 340;
const K: [number, number, number, number] = [FX, FX, IMG_W / 2, IMG_H / 2];
const EPOCH = 10_000;
const OFFSET = 500; // tServer = tLocal + OFFSET
const FPS_DT = 1000 / 30;
const ARC_R = 1.4;
// Target projected inter-LED spacing at the arc center; pitch is derived so a
// resolution change doesn't silently change the difficulty.
const PITCH_PX = 8;
const PITCH_M = (PITCH_PX * ARC_R) / FX;

const DET: ReduceToBlobsOptions = { minArea: 2, maxArea: 4000, maxBlobs: 2048, maxAspect: 3 };
const STRIDE: StrideParams = { spacing: 3, anchorDensity: 3 };
const THRESHOLD = 0.6; // the production default (detect.ts)
// Focused LED spot (BEFORE the diffuser) — big enough to survive the 2× reduce,
// small enough that neighbors at PITCH_PX are distinct without a diffuser. Shared
// by every config so ONLY the diffuser differs between clean and diffused.
const SPOT = { spotSigmaWorld: (2.0 * ARC_R) / FX, spotSigmaMinPx: 1.8 };
// The diffuser: an energy-conserving convolution that spreads every spot (σ ≈ the
// LED pitch), lowering peaks and bleeding neighbors.
const DIFFUSE = { ...SPOT, diffuseSigmaPx: 2.5 };
// Diffuse-mode detector: a large-σ top-hat (local background subtraction, in
// DETECTION px) + a low threshold on the residual = local adaptive detection.
const PREFILTER: LocalContrast = { sigma: 8, gain: 1.0 };
const DIFFUSE_THRESHOLD = 0.18;

/** Dense line along X (PITCH_PX projected pitch at the arc center), centered. */
function lineLeds(): Vec3[] {
  const leds: Vec3[] = [];
  for (let id = 0; id < PARAMS.ledCount; id++) leds.push([(id - (PARAMS.ledCount - 1) / 2) * PITCH_M, 0, 0]);
  return leds;
}
/** Camera on a radius-ARC_R arc, slight elevation for a non-degenerate view. */
function arcPose(frac: number): Pose {
  const theta = (-22 + 44 * frac) * (Math.PI / 180);
  const eye: Vec3 = [ARC_R * Math.sin(theta), 0.15, ARC_R * Math.cos(theta)];
  return { p: eye, q: lookAtQuat(eye, [0, 0, 0]) };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface CaptureConfig {
  stride?: StrideParams | undefined;
  bloom?: Partial<RenderOptions> | undefined;
  prefilter?: LocalContrast | undefined;
  cyclesPerPhase?: number | undefined;
  threshold?: number | undefined;
}

interface CaptureResult {
  ids: Set<number>;
  records: DetectionRecord[];
  /** Median blobs-per-visible-lit-LED on a mid-capture data frame (merge signal). */
  sampleBlobRatio: number;
}

/** Run a full capture: each phase is its own epoch/pipeline; union the decoded ids. */
function runCapture(cfg: CaptureConfig): CaptureResult {
  const leds = lineLeds();
  const rng = mulberry32(7);
  const cycles = cfg.cyclesPerPhase ?? 4;
  const phases = cfg.stride ? phaseCount(cfg.stride) : 1;
  // Only the S coverage phases are needed for full LED coverage; bridges add
  // fusion overlap (validated structurally in stride.test.ts), not new ids.
  const runPhases = cfg.stride ? cfg.stride.spacing : 1;
  const ids = new Set<number>();
  const records: DetectionRecord[] = [];
  let sampleBlobRatio = 1;

  const cycleMsLen = PARAMS.cycleFrames * PARAMS.bitPeriodMs;
  const nFrames = Math.floor((cycles * cycleMsLen) / FPS_DT);

  for (let ph = 0; ph < runPhases; ph++) {
    const pipeline = new CvPipeline(PARAMS, EPOCH, (t) => t + OFFSET);
    pipeline.onDetections((r) => {
      records.push(...r);
      for (const x of r) ids.add(x.ledId);
    });
    for (let f = 0; f < nFrames; f++) {
      const tLocal = f * FPS_DT;
      const tServer = tLocal + OFFSET;
      const pose = arcPose(f / nFrames);
      const img = renderFrame(leds, pose, K, PARAMS, EPOCH, tServer, {
        imgW: IMG_W,
        imgH: IMG_H,
        stride: cfg.stride,
        phase: ph,
        rng,
        ...cfg.bloom,
      });
      const reduced = reduceToDetect(img, {
        downscale: 2,
        threshold: cfg.threshold ?? 0.6,
        localContrast: cfg.prefilter,
      });
      const blobs = reducedToBlobs(reduced.detect, reduced.w, reduced.h, reduced.ds, IMG_H, false, DET);
      pipeline.step(blobs, { tCaptureMs: tLocal, pose, K, imgW: IMG_W, imgH: IMG_H });
      // Sample merge on a mid-capture data frame of the first phase.
      if (ph === 0 && f === Math.floor(nFrames / 2)) {
        let visible = 0;
        for (let id = 0; id < leds.length; id++) {
          if (cfg.stride && ((id % cfg.stride.spacing) + cfg.stride.spacing) % cfg.stride.spacing !== ph) continue;
          const pr = project(pose, K, leds[id]!);
          if (pr.depth > 0 && pr.u >= 0 && pr.u < IMG_W && pr.v >= 0 && pr.v < IMG_H) visible++;
        }
        sampleBlobRatio = visible > 0 ? blobs.length / visible : 1;
      }
    }
  }
  return { ids, records, sampleBlobRatio };
}

/** Fraction of records whose pixel matches their claimed LED's projection (≤ tolPx). */
function centroidError(records: DetectionRecord[], tolPx: number): { median: number; badFrac: number } {
  const leds = lineLeds();
  const errs: number[] = [];
  let bad = 0;
  for (const r of records) {
    const pr = project(r.pose!, r.K, leds[r.ledId]!);
    const e = Math.hypot(pr.u - r.u, pr.v - r.v);
    errs.push(e);
    if (e > tolPx) bad++;
  }
  errs.sort((a, b) => a - b);
  return { median: errs[errs.length >> 1] ?? 0, badFrac: records.length ? bad / records.length : 1 };
}

const yield_ = (r: CaptureResult) => r.ids.size / PARAMS.ledCount;

test("diffuser breaks all-lit capture; striding + adaptive detector recover it", () => {
  // A 2×2 ablation (striding × the diffuse-mode prefilter) plus a clean floor.
  // The two symptoms map to two independent fixes: STRIDING isolates spots (kills
  // the color-bleed / merge) and the ADAPTIVE detector (top-hat + low threshold)
  // rescues the dimmed, low-derivative spots the fixed global threshold misses.
  const run = (stride: StrideParams | undefined, pf: boolean, sharp = false) =>
    runCapture({
      stride,
      bloom: sharp ? SPOT : DIFFUSE,
      prefilter: pf ? PREFILTER : undefined,
      threshold: pf ? DIFFUSE_THRESHOLD : THRESHOLD,
    });

  const clean = run(undefined, false, true); // no diffuser, all lit — the floor
  const allDef = run(undefined, false); // diffuser, all lit, default detector
  const allPf = run(undefined, true); // diffuser, all lit, adaptive detector
  const strDef = run(STRIDE, false); // diffuser, strided, default detector
  const strPf = run(STRIDE, true); // diffuser, strided, adaptive detector

  const y = {
    clean: yield_(clean),
    allDef: yield_(allDef),
    allPf: yield_(allPf),
    strDef: yield_(strDef),
    strPf: yield_(strPf),
  };
  console.log("diffuse-sim ablation:", JSON.stringify(y)); // --test_output=all

  // The clean, un-diffused strip decodes end to end.
  assert.ok(y.clean >= 0.95, `clean floor ${y.clean}`);
  // The diffuser collapses the all-lit capture — spots merge/bleed AND dim.
  assert.ok(y.allDef <= 0.1, `all-lit+default should collapse, got ${y.allDef}`);
  // The adaptive detector ALONE can't save all-lit: color bleed between merged
  // neighbors survives the top-hat, so striding is necessary.
  assert.ok(y.allPf <= 0.3, `prefilter alone (no striding) must stay poor, got ${y.allPf}`);
  // Striding ALONE can't save it either: the diffuser dims the now-isolated spots
  // below the fixed global threshold, so the adaptive detector is necessary.
  assert.ok(y.strDef <= 0.3, `striding alone (default detector) must stay poor, got ${y.strDef}`);
  // Both together recover to near the clean floor.
  assert.ok(y.strPf >= 0.9 * y.clean, `strided+adaptive ${y.strPf} should reach the floor ${y.clean}`);
  // Each fix is individually load-bearing (big margin over either alone).
  assert.ok(y.strPf >= y.strDef + 0.5 && y.strPf >= y.allPf + 0.5, "both striding AND the detector matter");

  // The recovered records land on the right LEDs (id/pixel consistency).
  assert.equal(centroidError(strPf.records, 4.0).badFrac, 0, "recovered records must be pose-consistent");
});
