/**
 * Synthetic end-to-end test of the M6 track/decode pipeline — the browser-free
 * analogue of the design doc's Phase 3 acceptance, and a faithful simulation
 * of the virtual-LED-wall test setup: a planar grid fixture blinking the M1
 * frame plan, viewed by a pinhole camera walking an arc at 30 fps.
 *
 * The blob stream is generated with the same projection conventions as the M3
 * solver (src/geom/pinhole.ts mirrors reconstruction/camera.py), so the
 * records this pipeline emits are exactly what the Pi would receive.
 *
 * Covers: clean decode coverage + correctness, constant camera latency
 * (absorbed by the self-clocking alignment), dropped frames, and pixel noise.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodeParams, DetectionRecord, Pose, Vec3 } from "@ledmapper/protocol";
import { ledLitInFrame } from "../src/code/gray";
import { cycleMs, frameIndexAt } from "../src/code/timing";
import { CvPipeline } from "../src/cv/pipeline";
import type { Blob } from "../src/cv/types";
import { lookAtQuat, project } from "../src/geom/pinhole";

const PARAMS: CodeParams = {
  ledCount: 64,
  // 7 data bits (ceil(log2(64+1)) — codewords carry id+1) + 4 Hamming parity
  // + 1 overall parity: the production SEC-DED code-book (fec.ts).
  bits: 12,
  encoding: "gray",
  bitPeriodMs: 100,
  syncPattern: "on_off",
  cycleFrames: 14,
  fec: "secded",
};

const IMG_W = 1280;
const IMG_H = 720;
const K: [number, number, number, number] = [800, 800, 640, 360];
const EPOCH_SERVER = 10_000;
const CLOCK_OFFSET = 500; // tServer = tLocal + offset
const FPS_DT = 1000 / 30;

/** 8x8 planar grid, 0.1 m pitch, centered at the origin in the z=0 plane. */
function wallLeds(): Vec3[] {
  const leds: Vec3[] = [];
  for (let id = 0; id < PARAMS.ledCount; id++) {
    const row = Math.floor(id / 8);
    const col = id % 8;
    leds.push([(col - 3.5) * 0.1, (3.5 - row) * 0.1, 0]);
  }
  return leds;
}

/** Camera pose on a radius-2 m arc about the wall center, looking at it. */
function arcPose(frac: number): Pose {
  const theta = (-30 + 60 * frac) * (Math.PI / 180);
  const eye: Vec3 = [2 * Math.sin(theta), 0.1, 2 * Math.cos(theta)];
  return { p: eye, q: lookAtQuat(eye, [0, 0, 0]) };
}

interface SimOptions {
  cycles?: number;
  /** Camera pipeline latency: tCaptureMs is stamped this much AFTER the light. */
  latencyMs?: number;
  /** Probability a frame is dropped entirely. */
  dropP?: number;
  /** Gaussian-ish pixel noise sigma. */
  noisePx?: number;
  seed?: number;
  /** Adversarial code corruption: this LED's light is INVERTED during the
   * given bit-frame indices (0-based within the data bits) of EVERY cycle —
   * the decisive-window error model (reflection/chroma misread) FEC targets. */
  corruptLed?: number;
  corruptBits?: number[];
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

function runSim(opts: SimOptions = {}): { records: DetectionRecord[]; pipeline: CvPipeline } {
  const cycles = opts.cycles ?? 6;
  const latency = opts.latencyMs ?? 0;
  const dropP = opts.dropP ?? 0;
  const noise = opts.noisePx ?? 0;
  const rand = mulberry32(opts.seed ?? 42);
  const gauss = () => (rand() + rand() + rand() + rand() - 2) * Math.SQRT2 * (noise || 0);

  const leds = wallLeds();
  const pipeline = new CvPipeline(PARAMS, EPOCH_SERVER, (t) => t + CLOCK_OFFSET);
  const records: DetectionRecord[] = [];
  pipeline.onDetections((r) => records.push(...r));

  const totalMs = cycles * cycleMs(PARAMS);
  const nFrames = Math.floor(totalMs / FPS_DT);
  for (let f = 0; f < nFrames; f++) {
    if (rand() < dropP) continue;
    // The image shows the pattern (and the WORLD) as they were when the
    // light hit the sensor; the timestamp AND the pose WebXR reports with
    // the frame are from `latency` ms later — as on a real device. Records
    // must pair pixels with the EXPOSURE-time pose (decoder latency
    // correction), or every record carries motion x latency bias.
    const tTrueLocal = f * FPS_DT;
    const tCaptureMs = tTrueLocal + latency;
    const tTrueServer = tTrueLocal + CLOCK_OFFSET;
    const frameIdx = frameIndexAt(tTrueServer, EPOCH_SERVER, PARAMS);

    const exposurePose = arcPose(tTrueLocal / totalMs);
    const framePose = arcPose(Math.min(1, tCaptureMs / totalMs));
    const blobs: Blob[] = [];
    for (let id = 0; id < PARAMS.ledCount; id++) {
      let lit = ledLitInFrame(id, frameIdx, PARAMS);
      if (id === opts.corruptLed && (opts.corruptBits ?? []).includes(frameIdx - 2)) {
        lit = !lit;
      }
      if (!lit) continue;
      const pr = project(exposurePose, K, leds[id]!);
      if (pr.depth <= 0) continue;
      const u = pr.u + gauss();
      const v = pr.v + gauss();
      if (u < 0 || u >= IMG_W || v < 0 || v >= IMG_H) continue;
      blobs.push({ u, v, intensity: 0.9, area: 12 });
    }
    pipeline.step(blobs, { tCaptureMs, pose: framePose, K, imgW: IMG_W, imgH: IMG_H });
  }
  return { records, pipeline };
}

/**
 * A record is correct if its pixel is where its claimed LED actually projects
 * for its pose (within `tolPx`) — id/position consistency, no oracle leakage.
 */
function checkRecords(records: DetectionRecord[], tolPx: number): { wrong: number } {
  const leds = wallLeds();
  let wrong = 0;
  for (const r of records) {
    const pr = project(r.pose, r.K, leds[r.ledId]!);
    const err = Math.hypot(pr.u - r.u, pr.v - r.v);
    if (err > tolPx) wrong++;
  }
  return { wrong };
}

test("clean walk: full coverage, zero wrong ids", () => {
  const { records, pipeline } = runSim({ cycles: 6 });
  const ids = new Set(records.map((r) => r.ledId));
  assert.equal(ids.size, PARAMS.ledCount, `decoded ${ids.size}/${PARAMS.ledCount} ids`);
  assert.equal(checkRecords(records, 1.0).wrong, 0);
  // ~one record per LED per completed cycle (first cycle is warm-up).
  assert.ok(records.length >= PARAMS.ledCount * 3, `${records.length} records`);
  assert.ok(pipeline.stats.rejectedSync <= pipeline.stats.cyclesCompleted, "sane stats");

  // Every surviving track was labeled with its decoded id (the camera-view
  // overlay renders these), and the labels are the full id set.
  const labeled = pipeline.tracker.tracks.filter((t) => t.ledId !== null);
  assert.equal(labeled.length, PARAMS.ledCount, `${labeled.length} labeled tracks`);
  const trackIds = new Set(labeled.map((t) => t.ledId));
  assert.equal(trackIds.size, PARAMS.ledCount, "labels are distinct");
  for (const t of labeled) assert.ok(t.ledConfidence > 0 && t.ledConfidence <= 1);
});

test("60 ms camera latency: self-clocking alignment recovers decode", () => {
  const { records, pipeline } = runSim({ cycles: 8, latencyMs: 60 });
  // Alignment needs a cycle or two of data; judge the later cycles by volume.
  const ids = new Set(records.map((r) => r.ledId));
  assert.ok(
    ids.size >= PARAMS.ledCount * 0.98,
    `decoded ${ids.size}/${PARAMS.ledCount} ids with latency`,
  );
  // Tolerance: the exposure-time pose comes from the nearest 30 fps sample
  // (<= half a frame off), and the first cycle decodes before the alignment
  // estimator warms up — a few px of pose-pairing error remains.
  assert.equal(checkRecords(records, 8.0).wrong, 0);
  // The estimator should have converged near the injected latency (sign:
  // samples are stamped late, so alignShift ≈ +latency). The score landscape
  // is a plateau at the sparse 30 fps sampling, so allow half a bit period.
  assert.ok(
    Math.abs(pipeline.stats.alignShiftMs - 60) < PARAMS.bitPeriodMs / 2,
    `alignShiftMs=${pipeline.stats.alignShiftMs}`,
  );
});

test("nominal degradation (0.5 px noise, 10% dropped frames): ≥98% ids, no wrong ids", () => {
  const { records } = runSim({ cycles: 8, noisePx: 0.5, dropP: 0.1, seed: 7 });
  const ids = new Set(records.map((r) => r.ledId));
  assert.ok(ids.size >= Math.floor(PARAMS.ledCount * 0.98), `decoded ${ids.size}/64`);
  // Tolerance widened for the injected pixel noise.
  assert.equal(checkRecords(records, 3.0).wrong, 0);
});

test("a persistently corrupted bit window: FEC corrects, id never wrong", () => {
  // Pre-FEC this was the misidentification hole: one decisively-wrong window
  // (margin 1.0 — voting can't see it) decoded to a VALID wrong id. Under
  // SEC-DED the cycle corrects to the true id instead.
  const { records, pipeline } = runSim({ cycles: 6, corruptLed: 21, corruptBits: [4] });
  const ids = new Set(records.map((r) => r.ledId));
  assert.equal(ids.size, PARAMS.ledCount, `decoded ${ids.size}/${PARAMS.ledCount} ids`);
  assert.equal(checkRecords(records, 1.0).wrong, 0);
  assert.ok(pipeline.decoder.stats.correctedCycles > 0, "corrections were exercised");
  assert.ok(records.some((r) => r.ledId === 21), "the corrupted LED still maps");
});

test("two corrupted bit windows: detected and rejected, never misidentified", () => {
  const { records, pipeline } = runSim({ cycles: 6, corruptLed: 21, corruptBits: [1, 8] });
  // The victim LED cannot decode (every cycle is a double error)…
  assert.ok(!records.some((r) => r.ledId === 21), "double error must not decode");
  assert.ok(pipeline.decoder.stats.rejectedFec > 0, "double errors were FEC-rejected");
  // …but crucially nothing ELSE inherited its observations: zero wrong ids.
  assert.equal(checkRecords(records, 1.0).wrong, 0);
  const ids = new Set(records.map((r) => r.ledId));
  assert.equal(ids.size, PARAMS.ledCount - 1);
});

test("records carry the frame's pose/K/dims (§7.4 contract)", () => {
  const { records } = runSim({ cycles: 3 });
  assert.ok(records.length > 0);
  for (const r of records.slice(0, 20)) {
    assert.equal(r.imgW, IMG_W);
    assert.equal(r.imgH, IMG_H);
    assert.deepEqual(r.K, K);
    assert.ok(r.confidence > 0 && r.confidence <= 1);
    assert.ok(Math.hypot(...r.pose.p) > 1.5, "pose is on the arc");
  }
});

// ---------------------------------------------------------------------------
// gray-hue mode: constant-brightness color coding, decoded RELATIVE to each
// track's white sync frame — must survive a strong white-balance cast and
// reject static-hue clutter.
// ---------------------------------------------------------------------------

const PARAMS_HUE: CodeParams = { ...PARAMS, encoding: "gray-hue" };
// A warm color cast: channel gains the camera might apply. Relative decoding
// must cancel this exactly.
const CAST: [number, number, number] = [1.0, 0.8, 0.55];

function hueFrameColor(id: number, frameIdx: number): [number, number, number] {
  if (frameIdx === 0) return [1, 1, 1]; // ALL_ON white
  if (frameIdx === 1) return [0, 1, 0]; // ALL_OFF green
  return ledLitInFrame(id, frameIdx, PARAMS_HUE) ? [1, 0, 0] : [0, 0, 1];
}

interface HueSimOptions {
  /** Camera/pose latency, as in runSim: frame pose lags the exposure. */
  latencyMs?: number;
  /** Translating close-range pan (frame edges CROP the wall) instead of the
   * look-at arc — the partial-visibility sweep scenario. */
  sweep?: boolean;
}

function runHueSim(
  cycles = 6,
  opts: HueSimOptions = {},
): { records: DetectionRecord[]; pipeline: CvPipeline } {
  const latency = opts.latencyMs ?? 0;
  const leds = wallLeds();
  const pipeline = new CvPipeline(PARAMS_HUE, EPOCH_SERVER, (t) => t + CLOCK_OFFSET);
  const records: DetectionRecord[] = [];
  pipeline.onDetections((r) => records.push(...r));

  const totalMs = cycles * cycleMs(PARAMS_HUE);
  const nFrames = Math.floor(totalMs / FPS_DT);
  // Sweep: close to the wall, looking straight ahead, panning left->right —
  // only a strip of the wall is in frame at any time.
  const sweepPose = (frac: number): Pose => ({
    // Serpentine: pan across with enough vertical weave that every row
    // eventually enters the (cropping) frame.
    p: [-0.55 + 1.1 * frac, 0.24 * Math.sin(frac * 9), 0.42],
    q: [0, 0, 0, 1],
  });
  const poseAt = (frac: number): Pose =>
    opts.sweep ? sweepPose(frac) : arcPose(frac);
  for (let f = 0; f < nFrames; f++) {
    const tTrueLocal = f * FPS_DT;
    const tCaptureMs = tTrueLocal + latency;
    const frameIdx = frameIndexAt(tTrueLocal + CLOCK_OFFSET, EPOCH_SERVER, PARAMS_HUE);
    const exposurePose = poseAt(tTrueLocal / totalMs);
    const framePose = poseAt(Math.min(1, tCaptureMs / totalMs));
    const blobs: Blob[] = [];
    for (let id = 0; id < PARAMS_HUE.ledCount; id++) {
      // Every LED is LIT every frame; only its color changes.
      const pr = project(exposurePose, K, leds[id]!);
      if (pr.depth <= 0) continue;
      if (pr.u < 0 || pr.u >= IMG_W || pr.v < 0 || pr.v >= IMG_H) continue;
      const c = hueFrameColor(id, frameIdx);
      blobs.push({
        u: pr.u,
        v: pr.v,
        intensity: 0.9,
        area: 12,
        r: c[0] * CAST[0],
        g: c[1] * CAST[1],
        b: c[2] * CAST[2],
      });
    }
    // Static-hue clutter: a red lamp and a bright white light, always on.
    blobs.push({ u: 100, v: 100, intensity: 0.95, area: 20, r: CAST[0], g: 0, b: 0 });
    blobs.push({ u: 1180, v: 620, intensity: 1.0, area: 30, r: CAST[0], g: CAST[1], b: CAST[2] });
    pipeline.step(blobs, { tCaptureMs, pose: framePose, K, imgW: IMG_W, imgH: IMG_H });
  }
  return { records, pipeline };
}

test("gray-hue: full coverage under a strong color cast, zero wrong ids", () => {
  const { records, pipeline } = runHueSim(6);
  const ids = new Set(records.map((r) => r.ledId));
  assert.equal(ids.size, PARAMS_HUE.ledCount, `decoded ${ids.size}/${PARAMS_HUE.ledCount}`);
  assert.equal(checkRecords(records, 1.0).wrong, 0);
  assert.ok(records.length >= PARAMS_HUE.ledCount * 3, `${records.length} records`);
  // Confidence should be high: the cast cancels, margins are near-full.
  const confs = records.map((r) => r.confidence).sort((a, b) => a - b);
  assert.ok(confs[Math.floor(confs.length * 0.1)]! > 0.4, `p10 conf ${confs[0]}`);
  assert.ok(pipeline.decoder.stats.rejectedRange === 0, "no out-of-range decodes");
});

test("gray-hue: static-hue clutter is rejected by the relative sync check", () => {
  const { records, pipeline } = runHueSim(6);
  // No record may sit at the clutter positions (they never decode).
  for (const r of records) {
    assert.ok(Math.hypot(r.u - 100, r.v - 100) > 30, "red lamp produced a record");
    assert.ok(Math.hypot(r.u - 1180, r.v - 620) > 30, "white light produced a record");
  }
  // Their tracks exist but fail the green sync (normalize to neutral).
  assert.ok(pipeline.decoder.stats.rejectedSync > 0, "clutter cycles were sync-rejected");
});

test("gray-hue partial-visibility sweep + 100 ms latency: records stay pose-consistent", () => {
  // The user scenario: pan a close-in phone across the wall so frame edges
  // crop it; every LED is visible only during part of the pass, and the
  // camera moves the whole time (motion x latency bias would poison the
  // solve without the decoder's exposure-time pose pairing).
  const { records } = runHueSim(20, { sweep: true, latencyMs: 100 });
  const ids = new Set(records.map((r) => r.ledId));
  // Corner LEDs whose in-frame dwell bursts are shorter than one full code
  // cycle cannot decode on this single pass (a real sweep revisits them).
  assert.ok(
    ids.size >= Math.floor(PARAMS_HUE.ledCount * 0.85),
    `decoded ${ids.size}/${PARAMS_HUE.ledCount} ids under cropping`,
  );
  // Pose-pairing correctness is what the solver consumes: records must
  // match their claimed pose to within nearest-sample interpolation error
  // (frame-entry tracks with no sample near the exposure time are rejected
  // outright; only pre-alignment first-cycle records may remain biased).
  const wrong = checkRecords(records, 8.0).wrong;
  assert.ok(wrong <= records.length * 0.02, `${wrong}/${records.length} pose-biased records`);
  // Multi-view coverage survives cropping (enough for triangulation).
  const views = new Map<number, number>();
  for (const r of records) views.set(r.ledId, (views.get(r.ledId) ?? 0) + 1);
  const enough = [...views.values()].filter((n) => n >= 2).length;
  assert.ok(enough >= Math.floor(PARAMS_HUE.ledCount * 0.8), `${enough} LEDs with >=2 views`);
});
