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
  bits: 6,
  encoding: "gray",
  bitPeriodMs: 100,
  syncPattern: "on_off",
  cycleFrames: 8,
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
    // The image shows the pattern as it was when the light hit the sensor;
    // the phone's timestamp lags that moment by `latency`.
    const tTrueLocal = f * FPS_DT;
    const tCaptureMs = tTrueLocal + latency;
    const tTrueServer = tTrueLocal + CLOCK_OFFSET;
    const frameIdx = frameIndexAt(tTrueServer, EPOCH_SERVER, PARAMS);

    const pose = arcPose(f / nFrames);
    const blobs: Blob[] = [];
    for (let id = 0; id < PARAMS.ledCount; id++) {
      if (!ledLitInFrame(id, frameIdx, PARAMS)) continue;
      const pr = project(pose, K, leds[id]!);
      if (pr.depth <= 0) continue;
      const u = pr.u + gauss();
      const v = pr.v + gauss();
      if (u < 0 || u >= IMG_W || v < 0 || v >= IMG_H) continue;
      blobs.push({ u, v, intensity: 0.9, area: 12 });
    }
    pipeline.step(blobs, { tCaptureMs, pose, K, imgW: IMG_W, imgH: IMG_H });
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
});

test("60 ms camera latency: self-clocking alignment recovers decode", () => {
  const { records, pipeline } = runSim({ cycles: 8, latencyMs: 60 });
  // Alignment needs a cycle or two of data; judge the later cycles by volume.
  const ids = new Set(records.map((r) => r.ledId));
  assert.ok(
    ids.size >= PARAMS.ledCount * 0.98,
    `decoded ${ids.size}/${PARAMS.ledCount} ids with latency`,
  );
  assert.equal(checkRecords(records, 1.0).wrong, 0);
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
