/**
 * Dense-fixture tracking: the radiolarian case (2026-11-12 captures).
 *
 * A dodecahedron panel carries 105 LEDs in concentric rings ~13.5 mm apart —
 * ~13 px in the image at the distances people capture from, against the
 * ~22 px the tracker's fixed 40 px gate was tuned on. Hand-held, the image
 * moves about a pitch between frames, and a gate that spans three neighbours
 * let a track whose own blob dropped out for a frame take the LED next door;
 * the decoder then stamped the wrong id on that position (capture 01-06:
 * 17.7% of detections inconsistent, a wrong map).
 *
 * This drives the production track/decode pipeline — dense VIO records,
 * pose-less frames, the capture path those captures used — with the real code
 * parameters, three adjacent faces of the fixture (a front face and two
 * foreshortened side faces at other depths), blob dropouts, unresolvable spots
 * merged as the detector would, and a hand-held camera: a slow sway (the
 * translation the accelerometer needs for metric scale) plus gaze and roll
 * jitter. Records are scored against the ground truth; the pre-fix tracker
 * settings are the control.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodeParams, DetectionRecord, Intrinsics, Pose, Vec3 } from "@ledmapper/protocol";
import { colorForFrame } from "../src/code/gray";
import { frameIndexAt } from "../src/code/timing";
import type { DecoderOptions } from "../src/cv/decoder";
import { MotionGuide } from "../src/cv/motionGuide";
import { CvPipeline } from "../src/cv/pipeline";
import type { TrackerOptions } from "../src/cv/tracker";
import type { Blob } from "../src/cv/types";
import { lookAtQuat, project } from "../src/geom/pinhole";

/** The radiolarian capture's negotiated code (capture bundle codeParams). */
const PARAMS: CodeParams = {
  ledCount: 1260,
  bits: 16,
  encoding: "hue",
  bitPeriodMs: 140,
  syncPattern: "on_off",
  cycleFrames: 18,
  fec: "secded",
  symbols: 2,
};
const FIRST_ID = 630; // panels 630–944: three of the faces 01-06 saw
const IMG_W = 720;
const IMG_H = 1280;
const K: Intrinsics = [921.6, 921.6, 360, 640];
const EPOCH = 10_000;
const OFFSET = 500;
const PITCH_M = 0.0135;
const INRADIUS_M = 0.105;
/** Spots closer than this merge into one blob at detection (2× downscale). */
const MERGE_PX = 5;

/** One pentagonal panel: 105 LEDs on concentric rings ~PITCH_M apart, z = 0. */
function panelLeds(): Vec3[] {
  const counts = [1, 6, 12, 18, 24, 44];
  const leds: Vec3[] = [];
  counts.forEach((n, ring) => {
    const r = ring * PITCH_M;
    for (let k = 0; k < n; k++) {
      const a = (2 * Math.PI * k) / n + ring * 0.3;
      leds.push([r * Math.cos(a), r * Math.sin(a), 0]);
    }
  });
  return leds;
}

/** Three adjacent dodecahedron faces (dihedral 116.57°: normals 63.43° apart),
 * panel centres at the inradius — what a camera in front of one face sees.
 * The side faces are foreshortened and sit at other depths, so roll and
 * parallax move them differently from the front: the image motion is NOT
 * one translation. */
function fixtureLeds(): Vec3[] {
  const leds: Vec3[] = [];
  for (const yaw of [0, 1.1071, -1.1071]) {
    const n: Vec3 = [Math.sin(yaw), 0, Math.cos(yaw)];
    const e1: Vec3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
    for (const [x, y] of panelLeds()) {
      leds.push([INRADIUS_M * n[0] + x * e1[0], y, INRADIUS_M * n[2] + x * e1[2]]);
    }
  }
  return leds;
}

/** What the detector does to spots it can't resolve (edge-on faces): one blob
 * at their centroid, colours mixed. */
function mergeClose(blobs: Blob[]): void {
  for (let i = 0; i < blobs.length; i++) {
    for (let j = i + 1; j < blobs.length; j++) {
      const a = blobs[i]!;
      const b = blobs[j]!;
      if (Math.hypot(a.u - b.u, a.v - b.v) >= MERGE_PX) continue;
      blobs[i] = {
        ...a,
        u: (a.u + b.u) / 2,
        v: (a.v + b.v) / 2,
        r: ((a.r ?? 0) + (b.r ?? 0)) / 2,
        g: ((a.g ?? 0) + (b.g ?? 0)) / 2,
        b: ((a.b ?? 0) + (b.b ?? 0)) / 2,
      };
      blobs.splice(j, 1);
      j = i;
    }
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Walk {
  /** Hand jitter: per-frame step of the gaze and roll random walks (rad). */
  jitterRad: number;
  /** Amplitude (m) of the slow side-to-side sway (0.25 Hz). */
  swayM?: number;
  seed?: number;
}

interface Result {
  /** Records > 4 px from their claimed LED. */
  wrongFrac: number;
  /** Records more than a front-face pitch (12 px) off: the errors that wreck
   * a solve (the rest are merges at the resolution limit of edge-on faces). */
  grossFrac: number;
  /** Correct records per LED per second. */
  goodPerLedSec: number;
  /** Frames the motion guide showed its jerky-motion hint on. */
  flaggedFrac: number;
}

const FRAME_MS = 40; // the CV loop's ~25 fps; dense records every 3rd frame
const DROP_P = 0.15; // per-frame chance a spot is missed (bloom, threshold)
const DURATION_MS = 40_000;

function run(walk: Walk, tracker: TrackerOptions = {}, decoder: DecoderOptions = {}): Result {
  const leds = fixtureLeds();
  const rand = mulberry32(walk.seed ?? 11);
  const gauss = (): number => (rand() + rand() + rand() + rand() - 2) * Math.SQRT2;
  const sway = walk.swayM ?? 0.12;
  const dist = 0.9 + INRADIUS_M;
  const pipeline = new CvPipeline(PARAMS, EPOCH, (t) => t + OFFSET, { tracker, decoder, denseRecords: true, denseStride: 3 });
  const guide = new MotionGuide();
  // Records are scored against the pose at THEIR capture time: ones held
  // until their id was confirmed arrive frames later.
  const records: DetectionRecord[] = [];
  const poseAt = new Map<number, Pose>();
  pipeline.onDetections((rs) => records.push(...rs));
  let gx = 0;
  let gy = 0;
  let roll = 0;
  let frames = 0;
  let flagged = 0;
  for (let t = 0; t < DURATION_MS; t += FRAME_MS * (0.85 + 0.3 * rand())) {
    const s = t / 1000;
    const eye: Vec3 = [sway * Math.sin(2 * Math.PI * 0.25 * s), 0.05 * Math.sin(2 * Math.PI * 0.11 * s), dist];
    // Hand jitter: mean-reverting random walks of the gaze point and roll.
    gx = 0.9 * gx + walk.jitterRad * dist * gauss();
    gy = 0.9 * gy + walk.jitterRad * dist * gauss();
    roll = 0.9 * roll + walk.jitterRad * gauss();
    const pose: Pose = { p: eye, q: lookAtQuat(eye, [gx, gy, 0], [Math.sin(roll), Math.cos(roll), 0]) };
    poseAt.set(t, pose);
    const frameIdx = frameIndexAt(t + OFFSET, EPOCH, PARAMS);
    const blobs: Blob[] = [];
    for (let i = 0; i < leds.length; i++) {
      const pr = project(pose, K, leds[i]!);
      if (pr.depth <= 0 || pr.u < 0 || pr.u >= IMG_W || pr.v < 0 || pr.v >= IMG_H) continue;
      if (rand() < DROP_P) continue;
      const c = colorForFrame(FIRST_ID + i, frameIdx, PARAMS);
      blobs.push({ u: pr.u + 0.4 * gauss(), v: pr.v + 0.4 * gauss(), intensity: 0.9, area: 20, r: c[0], g: c[1], b: c[2] });
    }
    mergeClose(blobs);
    pipeline.step(blobs, { tCaptureMs: t, pose: null, K, imgW: IMG_W, imgH: IMG_H });
    if (guide.update(pipeline.tracker.lastStats, t)) flagged++;
    frames++;
  }
  let wrong = 0;
  let gross = 0;
  for (const rec of records) {
    const xyz = leds[rec.ledId - FIRST_ID];
    const pr = xyz === undefined ? null : project(poseAt.get(rec.tCaptureMs)!, K, xyz);
    const err = pr === null ? Infinity : Math.hypot(pr.u - rec.u, pr.v - rec.v);
    if (err > 4) wrong++;
    if (err > 12) gross++;
  }
  const n = Math.max(1, records.length);
  return {
    wrongFrac: wrong / n,
    grossFrac: gross / n,
    goodPerLedSec: (records.length - wrong) / leds.length / (DURATION_MS / 1000),
    flaggedFrac: flagged / frames,
  };
}

/** The tracker/decoder as they were before the dense-fixture fix. */
const BEFORE: [TrackerOptions, DecoderOptions] = [
  { gatePx: 40, gateSpacingFrac: 0, ambiguityRatio: 1, globalMotion: false, localConsistencyFrac: 0 },
  { confirmCycles: 1 },
];

const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;
const fmt = (r: Result): string =>
  `wrong ${pct(r.wrongFrac)} (gross ${pct(r.grossFrac)}) · ${r.goodPerLedSec.toFixed(2)} good/LED/s · hint ${pct(r.flaggedFrac)}`;

test("the panel geometry is the dense case: ~13 px pitch at capture distance", () => {
  const pose: Pose = { p: [0, 0, 0.9], q: lookAtQuat([0, 0, 0.9], [0, 0, 0]) };
  const px = panelLeds().map((x) => project(pose, K, x));
  let sum = 0;
  for (let i = 0; i < px.length; i++) {
    let best = Infinity;
    for (let j = 0; j < px.length; j++) if (i !== j) best = Math.min(best, Math.hypot(px[i]!.u - px[j]!.u, px[i]!.v - px[j]!.v));
    sum += best;
  }
  const mean = sum / px.length;
  assert.ok(mean > 10 && mean < 16, `mean NN spacing ${mean.toFixed(1)} px`);
});

for (const [name, jitter] of [
  ["steady hands", 0.002],
  ["hand-held", 0.006],
  ["shaky", 0.012],
] as const) {
  test(`dense fixture, ${name}: the fixed 40 px gate's wrong ids are gone, with more good data`, () => {
    const before = run({ jitterRad: jitter }, ...BEFORE);
    const after = run({ jitterRad: jitter });
    console.log(`${name}: before ${fmt(before)} | after ${fmt(after)}`);
    assert.ok(before.wrongFrac > 0.5, "the control reproduces the failure");
    assert.ok(after.grossFrac < 0.01, `gross ${after.grossFrac}`);
    assert.ok(after.wrongFrac < 0.05, `wrong ${after.wrongFrac}`);
    assert.ok(after.goodPerLedSec > 1.5 && after.goodPerLedSec > 3 * before.goodPerLedSec, "good-data yield");
    if (jitter <= 0.006) assert.equal(after.flaggedFrac, 0, "ordinary hand-held capture is never told it's jerky");
  });
}

test("a big smooth sway — the translation IMU scale needs — tracks cleanly and is never flagged", () => {
  // 25 cm side to side: generous accelerometer excitation, but predictable.
  const r = run({ jitterRad: 0.002, swayM: 0.25 });
  console.log(`smooth 25 cm sway: ${fmt(r)}`);
  assert.equal(r.flaggedFrac, 0);
  assert.ok(r.grossFrac < 0.01 && r.wrongFrac < 0.03, fmt(r));
});

test("shaking the phone is flagged", () => {
  const r = run({ jitterRad: 0.02 });
  console.log(`shaking: ${fmt(r)}`);
  assert.ok(r.flaggedFrac > 0.5, `flagged ${r.flaggedFrac}`);
});
