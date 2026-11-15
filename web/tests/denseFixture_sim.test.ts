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
import {
  colorForFrame,
  DATA_FRAME_OFFSET,
  dataFrames,
  decodeCycleSymbols,
  FRAME_ALL_ON,
  isStaggered,
  staggerPhase,
  SYNC_STAGGER_GM,
  SYNC_STAGGER_PILOT,
  SYNC_STAGGER_WHITE,
  symbolAt,
  syncFrames,
  withSyncPattern,
} from "../src/code/gray";
import { cycleIndexAt, frameIndexAt } from "../src/code/timing";
import type { DecoderOptions } from "../src/cv/decoder";
import { AlphabetPlanner, formatPrediction } from "../src/cv/channelQuality";
import { planSymbolSwitch } from "../src/cv/exposure";
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
function mergeClose(blobs: Blob[], mergePx = MERGE_PX): void {
  for (let i = 0; i < blobs.length; i++) {
    for (let j = i + 1; j < blobs.length; j++) {
      const a = blobs[i]!;
      const b = blobs[j]!;
      if (Math.hypot(a.u - b.u, a.v - b.v) >= mergePx) continue;
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
  /** Sync bloom: on the all-white sync frame, spots closer than this (px)
   * merge into one blob (the white frame saturates and blooms). 0 = off. */
  bloomPx?: number;
  /** Per-channel colour noise (std, on [0, 1] channels): a dark room's
   * sensor noise on dim spots. 0 = off. */
  colorNoise?: number;
  /** Sync pattern the fixture runs (default v1 "on_off"). Under a staggered
   * pattern each LED blooms on ITS OWN white frame ("stagger_white"); the
   * pilot ("stagger_pilot") shows no white, so nothing blooms. */
  sync?: string;
  /** Camera → display latency (ms): the camera sees the frame shown this long
   * before its capture time (whole frames exercise the staggered phase lock). */
  latencyMs?: number;
}

/** Staggered bloom: a spot showing white swells to `bloomPx` and swallows the
 * spots it reaches (they merge at the bloom); other spots merge as usual. */
function mergeBloomed(blobs: Blob[], white: boolean[], bloomPx: number): void {
  for (let i = 0; i < blobs.length; i++) {
    for (let j = i + 1; j < blobs.length; j++) {
      const a = blobs[i]!;
      const b = blobs[j]!;
      const reach = white[i] || white[j] ? Math.max(MERGE_PX, bloomPx) : MERGE_PX;
      if (Math.hypot(a.u - b.u, a.v - b.v) >= reach) continue;
      blobs[i] = {
        ...a,
        u: (a.u + b.u) / 2,
        v: (a.v + b.v) / 2,
        r: ((a.r ?? 0) + (b.r ?? 0)) / 2,
        g: ((a.g ?? 0) + (b.g ?? 0)) / 2,
        b: ((a.b ?? 0) + (b.b ?? 0)) / 2,
      };
      white[i] = white[i]! || white[j]!;
      blobs.splice(j, 1);
      white.splice(j, 1);
      j = i;
    }
  }
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
  /** The pipeline after the run (decoder telemetry, channel measurement). */
  pipeline: CvPipeline;
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
  const params = withSyncPattern(PARAMS, (walk.sync ?? null) as CodeParams["syncPattern"] | null);
  const staggered = isStaggered(params);
  const latency = walk.latencyMs ?? 0;
  const pipeline = new CvPipeline(params, EPOCH, (t) => t + OFFSET, { tracker, decoder, denseRecords: true, denseStride: 3 });
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
    const frameIdx = frameIndexAt(t - latency + OFFSET, EPOCH, params);
    const blobs: Blob[] = [];
    const white: boolean[] = [];
    for (let i = 0; i < leds.length; i++) {
      const pr = project(pose, K, leds[i]!);
      if (pr.depth <= 0 || pr.u < 0 || pr.u >= IMG_W || pr.v < 0 || pr.v >= IMG_H) continue;
      if (rand() < DROP_P) continue;
      const c = colorForFrame(FIRST_ID + i, frameIdx, params);
      const n = walk.colorNoise ?? 0;
      const ch = (x: number): number => (n > 0 ? Math.min(1, Math.max(0, x + n * gauss())) : x);
      blobs.push({ u: pr.u + 0.4 * gauss(), v: pr.v + 0.4 * gauss(), intensity: 0.9, area: 20, r: ch(c[0]), g: ch(c[1]), b: ch(c[2]) });
      white.push(c[0] === 1 && c[1] === 1 && c[2] === 1);
    }
    if (staggered) mergeBloomed(blobs, white, walk.bloomPx ?? 0);
    else mergeClose(blobs, frameIdx === FRAME_ALL_ON ? Math.max(MERGE_PX, walk.bloomPx ?? 0) : MERGE_PX);
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
    pipeline,
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

/** Sync bloom at about one LED pitch: on the all-white sync frame each spot
 * swells into its neighbours, so the detector sees clumps, not LEDs, and
 * every track loses its own blob on the same frame (hue code v2 failure mode
 * 1, docs/design/hue-code-v2.md). */
const BLOOM_PX = 14;

test("sync bloom: the dense tracker keeps most identities where the fixed gate loses them all", () => {
  const before = run({ jitterRad: 0.006, bloomPx: BLOOM_PX }, ...BEFORE);
  const after = run({ jitterRad: 0.006, bloomPx: BLOOM_PX });
  console.log(`sync bloom ${BLOOM_PX} px: before ${fmt(before)} | after ${fmt(after)}`);
  assert.ok(before.wrongFrac > 0.9, "the control reproduces the failure");
  // Partial: the bloomed white window is still each record's anchor and
  // colour reference, so some records sit on a clump's centroid and yield
  // drops. Staggered sync (hue code v2 phase 2) is the fix for the rest.
  assert.ok(after.grossFrac < 0.08, `gross ${after.grossFrac}`);
  assert.ok(after.wrongFrac < 0.2, `wrong ${after.wrongFrac}`);
  assert.ok(after.goodPerLedSec > 0.3, `yield ${after.goodPerLedSec}`);
});

/**
 * A hop that stitches a valid codeword: a track that moves from LED `a` to its
 * neighbour `b` partway through a cycle reads `a`'s symbols, then `b`'s. On
 * the radiolarian code (16-bit SEC-DED, distance 4) some such stitches decode
 * cleanly to a THIRD id, which lands a record far across the fixture. Finds
 * the first pair of physical neighbours on a panel (adjacent on a ring, or
 * across rings) and split whose stitch does.
 */
function stitchedCodeword(): { a: number; b: number; split: number; c: number } {
  const n = dataFrames(PARAMS);
  const panel = panelLeds();
  for (let i = 0; i < panel.length; i++) {
    for (let j = 0; j < panel.length; j++) {
      const gap = Math.hypot(panel[i]![0] - panel[j]![0], panel[i]![1] - panel[j]![1]);
      if (i === j || gap > 1.5 * PITCH_M) continue;
      const [a, b] = [FIRST_ID + i, FIRST_ID + j];
      for (let split = 1; split < n; split++) {
      const syms = Array.from({ length: n }, (_, d) => symbolAt(d < split ? a : b, d, PARAMS));
      const { id } = decodeCycleSymbols(syms, PARAMS);
        if (id === null) continue;
        // A third id, not on the same patch of the panel.
        const pc = panel[id - FIRST_ID];
        const far = pc === undefined || Math.hypot(pc[0] - panel[i]![0], pc[1] - panel[i]![1]) > 3 * PITCH_M;
        if (far) return { a, b, split, c: id };
      }
    }
  }
  throw new Error("no stitched codeword");
}

const STITCH_CYCLE = 4;

/** One LED position whose track hops from `a` to `b` partway through cycle
 * STITCH_CYCLE (the stitched cycle), held still and never dropped: the hop is forced, so
 * only the decoder stands between it and a wrong record. Returns the ids of
 * the records it emitted. */
function runForcedHop(decoder: DecoderOptions = {}): { ids: number[]; hop: ReturnType<typeof stitchedCodeword> } {
  const hop = stitchedCodeword();
  const pipeline = new CvPipeline(PARAMS, EPOCH, (t) => t + OFFSET, { decoder });
  const ids: number[] = [];
  pipeline.onDetections((rs) => ids.push(...rs.map((r) => r.ledId)));
  const cycleMs = PARAMS.cycleFrames * PARAMS.bitPeriodMs;
  for (let t = 0; t < 2 * STITCH_CYCLE * cycleMs + cycleMs; t += 35) {
    const cycle = cycleIndexAt(t + OFFSET, EPOCH, PARAMS) - cycleIndexAt(OFFSET, EPOCH, PARAMS);
    const frame = frameIndexAt(t + OFFSET, EPOCH, PARAMS);
    const d = frame - DATA_FRAME_OFFSET;
    const led = cycle < STITCH_CYCLE ? hop.a : cycle > STITCH_CYCLE ? hop.b : d < hop.split ? hop.a : hop.b;
    const c = colorForFrame(led, frame, PARAMS);
    pipeline.step([{ u: 360, v: 640, intensity: 0.9, area: 20, r: c[0], g: c[1], b: c[2] }], {
      tCaptureMs: t,
      pose: null,
      K,
      imgW: IMG_W,
      imgH: IMG_H,
    });
  }
  return { ids, hop };
}

test("a hop that stitches a valid codeword doesn't put a third LED's id on the map", () => {
  // Hue code v2 failure mode 2 (docs/design/hue-code-v2.md): SEC-DED is the
  // only check on a cycle, and a stitched cycle can pass it.
  const before = runForcedHop(BEFORE[1]);
  const { a, b, c } = before.hop;
  console.log(`stitch ${a}→${b} decodes as ${c}; records before: ${before.ids.join(",")}`);
  assert.ok(before.ids.includes(c), "control: the unconfirmed decoder records the stitched id");
  const after = runForcedHop();
  console.log(`records after: ${after.ids.join(",")}`);
  assert.ok(!after.ids.includes(c), "the stitched id is never confirmed");
  assert.ok(after.ids.includes(a) && after.ids.includes(b), "both real ids still land");
});

/** Mean luma of a dark room (the old rule's upgrade gate is 0.12) and of a lit one. */
const DARK = { meanLuma: 0.04, clipFrac: 0 };
const LIT = { meanLuma: 0.3, clipFrac: 0 };

test("dark room, dense fixture: the alphabet is no longer stuck at 2 symbols", () => {
  // Hue code v2 failure mode 3: all five radiolarian captures ran at 2
  // symbols. The old rule (planSymbolSwitch) needs a lit scene AND a healthy
  // decode-margin average; a dark room fails the first, and on a dense fixture
  // the old tracker's hops dragged down the second.
  const noise = 0.06; // dim spots: per-channel sensor noise
  const oldTracker = run({ jitterRad: 0.006, colorNoise: noise }, ...BEFORE);
  const r = run({ jitterRad: 0.006, colorNoise: noise });
  const q = r.pipeline.decoder.quality;
  const est = q.estimate();
  const measured = new AlphabetPlanner().plan(2, est, PARAMS, q.decodeYield(), DURATION_MS);
  console.log(
    `dark dense: margin EMA ${r.pipeline.stats.marginEma?.toFixed(2)} (old tracker ${oldTracker.pipeline.stats.marginEma?.toFixed(2)}) · ${formatPrediction(est, PARAMS)} → ${measured}`,
  );
  assert.equal(planSymbolSwitch(2, DARK, r.pipeline.stats.marginEma), null, "control: the old rule stays on 2 in the dark");
  assert.equal(
    planSymbolSwitch(2, LIT, oldTracker.pipeline.stats.marginEma),
    null,
    "control: with the old tracker's hops it stays on 2 even when lit",
  );
  assert.equal(measured, 4, "the measured channel supports 4 symbols");

  // And a channel that really is too noisy stays on 2.
  const murky = run({ jitterRad: 0.006, colorNoise: 0.4 });
  const mq = murky.pipeline.decoder.quality;
  assert.equal(new AlphabetPlanner().plan(2, mq.estimate(), PARAMS, mq.decodeYield(), DURATION_MS), null);
});

/** The staggered codes on the radiolarian geometry: the palette pilot (wire
 * value; a pruned 12-bit book, 23-frame cycle at 2 symbols) and the sim-only
 * comparators (staggered white, the green/magenta draft — the v1 book, 18
 * frames), with a camera latency of 1.6 frames so the whole-frame phase lock k
 * is exercised. */
const STAGGER_PILOT = { sync: SYNC_STAGGER_PILOT, latencyMs: 225 };
const STAGGER_WHITE = { sync: SYNC_STAGGER_WHITE, latencyMs: 225 };
const STAGGER_GM = { sync: SYNC_STAGGER_GM, latencyMs: 225 };

test("staggered pilot, dense fixture: decodes as cleanly as v1, the phase locks", () => {
  const v1 = run({ jitterRad: 0.006 });
  const r = run({ jitterRad: 0.006, ...STAGGER_PILOT });
  const st = r.pipeline.stats;
  console.log(
    `hand-held: v1 ${fmt(v1)} | pilot ${fmt(r)} · k ${st.phaseK} pilots ${st.pilotCycles} ` +
      `misses ${st.delimiterMisses} φ-rejects ${st.phaseRejects} align ${st.alignShiftMs.toFixed(0)} ms`,
  );
  // 225 ms = 1 frame + 85 ms of 140 ms frames: k = 1 (or 2 with the shift
  // folded the other way), and the total latency estimate lands near 225.
  assert.ok(st.phaseK !== null, "k locked");
  assert.ok(Math.abs(st.alignShiftMs - 225) < 30, `latency ${st.alignShiftMs}`);
  assert.ok(r.grossFrac < 0.01, `gross ${r.grossFrac}`);
  assert.ok(r.wrongFrac < 0.05, `wrong ${r.wrongFrac}`);
  assert.ok(r.goodPerLedSec > 0.8 * v1.goodPerLedSec, `yield ${r.goodPerLedSec} vs v1 ${v1.goodPerLedSec}`);
});

test("sync bloom with staggered sync: identities and yield survive (hue code v2 phase 2)", () => {
  // Failure mode 1: v1 shows the white sync frame on every LED at once, so a
  // bloom of about a pitch costs every track its blob on the same frame. The
  // pilot shows no white at all; a staggered WHITE still blooms, per LED.
  const v1 = run({ jitterRad: 0.006, bloomPx: BLOOM_PX });
  const clean = run({ jitterRad: 0.006, ...STAGGER_PILOT });
  const pilot = run({ jitterRad: 0.006, bloomPx: BLOOM_PX, ...STAGGER_PILOT });
  const white = run({ jitterRad: 0.006, bloomPx: BLOOM_PX, ...STAGGER_WHITE });
  const gm = run({ jitterRad: 0.006, bloomPx: BLOOM_PX, ...STAGGER_GM });
  console.log(`sync bloom ${BLOOM_PX} px: v1 ${fmt(v1)}`);
  console.log(`sync bloom ${BLOOM_PX} px: staggered white ${fmt(white)}`);
  console.log(`sync bloom ${BLOOM_PX} px: staggered green/magenta ${fmt(gm)}`);
  console.log(`sync bloom ${BLOOM_PX} px: staggered pilot ${fmt(pilot)} (bloom-free pilot ${fmt(clean)})`);
  assert.ok(pilot.grossFrac < 0.01, `gross ${pilot.grossFrac}`);
  assert.ok(pilot.goodPerLedSec > 1.5, `yield ${pilot.goodPerLedSec}`);
  assert.ok(pilot.goodPerLedSec > 0.9 * clean.goodPerLedSec, "the bloom-free result");
  assert.ok(pilot.goodPerLedSec > 2 * v1.goodPerLedSec, "well above v1 under bloom");
  assert.ok(pilot.goodPerLedSec > white.goodPerLedSec, "and above a staggered white");
});

/**
 * Staggered hops: a track that moves from LED `a` to a neighbour `b` partway
 * through `a`'s cycle reads `a`'s pilot and first data windows, then `b`'s
 * colours at the same global frames — `b`'s own rotated cycle. Every stitch
 * whose windows all land on `b`'s DATA frames is a symbol sequence the
 * decoder could read; returns those that FEC-decode to a third id `c`, and
 * whether `c`'s phase φ(c) matches the pilot's (the ≈ 1/C chance the phase
 * check lets a hop through).
 */
function staggerStitches(): { a: number; b: number; split: number; c: number; phaseOk: boolean }[] {
  const p = withSyncPattern(PARAMS, SYNC_STAGGER_PILOT);
  const C = p.cycleFrames;
  const L = syncFrames(p);
  const n = dataFrames(p);
  const panel = panelLeds();
  const out: { a: number; b: number; split: number; c: number; phaseOk: boolean }[] = [];
  for (let i = 0; i < panel.length; i++) {
    for (let j = 0; j < panel.length; j++) {
      const gap = Math.hypot(panel[i]![0] - panel[j]![0], panel[i]![1] - panel[j]![1]);
      if (i === j || gap > 1.5 * PITCH_M) continue;
      const [a, b] = [FIRST_ID + i, FIRST_ID + j];
      const pa = staggerPhase(a, p);
      const pb = staggerPhase(b, p);
      for (let split = 1; split < n; split++) {
        const syms: number[] = [];
        let ok = true;
        for (let d = 0; d < n && ok; d++) {
          if (d < split) syms.push(symbolAt(a, d, p));
          else {
            const jb = (((pa + L + d - pb) % C) + C) % C;
            if (jb < L) ok = false;
            else syms.push(symbolAt(b, jb - L, p));
          }
        }
        if (!ok) continue;
        const { id } = decodeCycleSymbols(syms, p);
        if (id === null || id === a || id === b) continue;
        out.push({ a, b, split, c: id, phaseOk: staggerPhase(id, p) === pa });
      }
    }
  }
  return out;
}

test("staggered hops: the phase check rejects the stitches SEC-DED lets through", () => {
  const all = staggerStitches();
  const passed = all.filter((s) => s.phaseOk).length;
  const C = withSyncPattern(PARAMS, SYNC_STAGGER_PILOT).cycleFrames;
  console.log(`stagger stitches decoding to a third id: ${all.length}; passing φ: ${passed} (${pct(passed / Math.max(1, all.length))}, 1/C = ${pct(1 / C)})`);
  assert.ok(all.length > 20, "SEC-DED alone accepts stitched codewords");
  // Not exactly 1 in C: φ is linear in the id, so a stitch family that lands a
  // fixed id offset from `a` passes for every pair or for none, and a few such
  // families dominate a small neighbourhood. The rest of the safety net
  // (confirmation, best-in-cycle pilot) is in the end-to-end hop test below.
  assert.ok(passed / all.length < 0.2, "φ(id) rejects most of them");
});

/** The forced hop of runForcedHop, under the staggered pilot: one spot shows
 * `a`'s stream, then `b`'s from the stitch onward (both rotated cycles), with
 * `a` and `b` alternating long enough first for k to lock. */
function runStaggerHop(hop: { a: number; b: number; split: number; c: number }): { ids: number[]; phaseRejects: number } {
  const p = withSyncPattern(PARAMS, SYNC_STAGGER_PILOT);
  const C = p.cycleFrames;
  const bp = p.bitPeriodMs;
  const lockMs = 6 * C * bp;
  const pa = staggerPhase(hop.a, p);
  // The stitch: a's cycle starting at the first a-pilot after lockMs; b takes
  // over `split` data windows into it.
  const f0 = Math.ceil((lockMs + OFFSET - EPOCH) / bp);
  const fPilot = f0 + ((((pa - f0) % C) + C) % C);
  const tSwitch = EPOCH - OFFSET + (fPilot + syncFrames(p) + hop.split) * bp;
  const pipeline = new CvPipeline(p, EPOCH, (t) => t + OFFSET);
  const ids: number[] = [];
  pipeline.onDetections((rs) => ids.push(...rs.map((r) => r.ledId)));
  // Two still spots (a and b, far apart) until lockMs give k; then the spot
  // at a's position hops onto b.
  for (let t = 0; t < tSwitch + 5 * C * bp; t += 35) {
    const f = frameIndexAt(t + OFFSET, EPOCH, p);
    const blobs: Blob[] = [];
    const led = t < tSwitch ? hop.a : hop.b;
    const c = colorForFrame(led, f, p);
    blobs.push({ u: 360, v: 640, intensity: 0.9, area: 20, r: c[0], g: c[1], b: c[2] });
    if (t < lockMs) {
      for (const [k, other] of [FIRST_ID + 50, FIRST_ID + 80, FIRST_ID + 99].entries()) {
        const o = colorForFrame(other, f, p);
        blobs.push({ u: 100 + 200 * k, v: 200, intensity: 0.9, area: 20, r: o[0], g: o[1], b: o[2] });
      }
    }
    pipeline.step(blobs, { tCaptureMs: t, pose: null, K, imgW: IMG_W, imgH: IMG_H });
  }
  return { ids, phaseRejects: pipeline.stats.phaseRejects };
}

test("a staggered stitched hop doesn't put a third LED's id on the map", () => {
  const hop = staggerStitches().find((s) => !s.phaseOk);
  assert.ok(hop !== undefined);
  const r = runStaggerHop(hop);
  console.log(`stagger stitch ${hop.a}→${hop.b} (split ${hop.split}) decodes as ${hop.c}; records ${[...new Set(r.ids)].join(",")}; φ-rejects ${r.phaseRejects}`);
  assert.ok(!r.ids.includes(hop.c), "the stitched id never lands");
  assert.ok(r.ids.includes(hop.a) && r.ids.includes(hop.b), "both real ids still land");
});
