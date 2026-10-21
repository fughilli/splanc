/**
 * Group capture end to end (docs/design/multi-fixture-localization.md §4–5):
 * several mapped fixtures flash DISJOINT id ranges of one shared code book on a
 * shared epoch (with per-fixture clock-sync skew), a handheld phone films them
 * at 30 fps, the PRODUCTION track/decode pipeline (CvPipeline, dense records)
 * decodes the whole scene, groupCode splits ids back per fixture, and the
 * localizer recovers the relative poses. Plus the pure layout/profile helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodeParams } from "@ledmapper/protocol";
import { colorForFrame, dataBits } from "../src/code/gray";
import { secdedTotalBits } from "../src/code/fec";
import { cycleMs, frameIndexAt } from "../src/code/timing";
import { CvPipeline } from "../src/cv/pipeline";
import type { Blob } from "../src/cv/types";
import {
  deviceEpochMs,
  memberStartOptions,
  planCodeLayout,
  recordsToViews,
  resolveGroupCapture,
  seenProgress,
  splitId,
} from "../src/geom/groupCode";
import { applyRoomPose, localizeFixtures, poseError } from "../src/geom/multiFixture";
import { project } from "../src/geom/pinhole";
import { IMG_H, IMG_W, K, makeRoom, mulberry32, gaussian, simulateCapture, truthPoseOfModel } from "./multiFixtureSynth";

/** CodeParams the firmware derives for a code space (CodeSpec::derive, SEC-DED). */
function groupParams(codeSpace: number, symbols: 2 | 4, bitPeriodMs: number): CodeParams {
  const bits = secdedTotalBits(dataBits(codeSpace));
  return {
    ledCount: codeSpace,
    bits,
    encoding: "hue",
    symbols,
    bitPeriodMs,
    syncPattern: "on_off",
    cycleFrames: 2 + Math.ceil(bits / (symbols === 4 ? 2 : 1)),
    fec: "secded",
  };
}

test("code layout: contiguous disjoint slots, ids split back, cap enforced", () => {
  const L = planCodeLayout([
    { id: "a", ledCount: 120 },
    { id: "b", ledCount: 60 },
    { id: "c", ledCount: 150 },
  ]);
  assert.equal(L.codeSpace, 330);
  assert.deepEqual(L.slots.map((s) => s.offset), [0, 120, 180]);
  assert.deepEqual(splitId(L, 0), { member: 0, led: 0 });
  assert.deepEqual(splitId(L, 179), { member: 1, led: 59 });
  assert.deepEqual(splitId(L, 180), { member: 2, led: 0 });
  assert.equal(splitId(L, 330), null);
  assert.throws(() => planCodeLayout([{ id: "x", ledCount: 5000 }]));
});

test("group timing is the most conservative profile; diffuse members light one stride phase", () => {
  const r = resolveGroupCapture([
    { profile: { diffuse: false, symbols: 4, bitPeriodMs: 100, brightness: 0.6 }, fallback: { diffuse: false, strideSpacing: 4, anchorDensity: 3 } },
    { profile: { diffuse: true, strideSpacing: 3, symbols: 2, bitPeriodMs: 133 }, fallback: { diffuse: false, strideSpacing: 4, anchorDensity: 3 } },
    { profile: null, fallback: { diffuse: true, strideSpacing: 5, anchorDensity: 4 } },
  ]);
  assert.deepEqual(r.timing, { symbols: 2, bitPeriodMs: 133 });
  assert.equal(r.members[0]!.brightness, 0.6);
  assert.equal(r.members[1]!.strideSpacing, 3);
  assert.equal(r.members[2]!.strideSpacing, 5);
  const L = planCodeLayout([
    { id: "a", ledCount: 10 },
    { id: "b", ledCount: 20 },
    { id: "c", ledCount: 30 },
  ]);
  const o = memberStartOptions(L.slots[1]!, L, r.members[1]!, r.timing);
  assert.deepEqual(o, {
    ledCount: 20,
    symbols: 2,
    bitPeriodMs: 133,
    codeOffset: 10,
    codeSpace: 60,
    strideSpacing: 3,
    anchorDensity: 3,
    stridePhase: 0,
  });
  assert.equal(memberStartOptions(L.slots[0]!, L, r.members[0]!, r.timing)["strideSpacing"], undefined);
  assert.equal(deviceEpochMs(1000.4, 250.2), 1251);
});

test("decode → split → localize: three fixtures, shared epoch with sync skew, handheld 30 fps", () => {
  const room = makeRoom({ seed: 41, shapes: ["lamp", "panel", "ring"], mapNoiseM: 0.002, spreadM: 2.4 });
  const layout = planCodeLayout(room.map((f, k) => ({ id: `fx${k}`, ledCount: f.truth.length })));
  const P = groupParams(layout.codeSpace, 4, 100);
  const totalMs = 12 * cycleMs(P);
  const dt = 1000 / 30;
  const nFrames = Math.floor(totalMs / dt);
  const cams = simulateCapture(room, { seed: 7, frames: nFrames, walkM: 1.0, jitter: 0 }).cameras;
  // Phone-local epoch E; each fixture's frames are E + its clock-sync error.
  const E = 5000;
  const skewMs = [0, 6, -9]; // well inside the 15 % window guard of a 100 ms frame
  const rand = mulberry32(3);
  const g = gaussian(rand);
  const pipeline = new CvPipeline(P, E, (t) => t, { denseRecords: true, denseStride: 3 });
  const records: Parameters<typeof recordsToViews>[0][number][] = [];
  pipeline.onDetections((r) => records.push(...r));
  for (let f = 0; f < nFrames; f++) {
    const t = E + f * dt;
    const pose = cams[f]!;
    const blobs: Blob[] = [];
    room.forEach((fx, k) => {
      const frameIdx = frameIndexAt(t - skewMs[k]!, E, P);
      const off = layout.slots[k]!.offset;
      fx.truth.forEach((x, i) => {
        const pr = project(pose, K, applyRoomPose(fx.pose, x));
        if (pr.depth <= 0.1 || pr.u < 0 || pr.u >= IMG_W || pr.v < 0 || pr.v >= IMG_H) return;
        // Real blob detection merges LEDs closer than a few pixels; a merged
        // blob's track is garbage, so model it by dropping both.
        if (blobs.some((b) => Math.hypot(b.u - pr.u, b.v - pr.v) < 4)) return;
        const c = colorForFrame(off + i, frameIdx, P);
        blobs.push({ u: pr.u + 0.7 * g(), v: pr.v + 0.7 * g(), intensity: 0.9, area: 12, r: c[0], g: c[1], b: c[2] });
      });
    });
    pipeline.step(blobs, { tCaptureMs: t, pose: null, K, imgW: IMG_W, imgH: IMG_H });
  }
  // Every decoded id lies in some fixture's slot and projects where that LED is.
  const views = recordsToViews(records, layout);
  assert.ok(views.length > 40, `${views.length} views`);
  let wrong = 0, total = 0;
  for (const v of views) {
    const f = Math.round((v.t - E) / dt);
    for (const s of v.sightings) {
      total++;
      const fx = room[s.fixture]!;
      const pr = project(cams[f]!, K, applyRoomPose(fx.pose, fx.truth[s.led]!));
      if (Math.hypot(pr.u - s.u, pr.v - s.v) > 4) wrong++;
    }
  }
  // Track swaps where LEDs cross in the image (a helix front/back) mis-label a
  // few percent; the localizer gates them as outliers.
  assert.ok(wrong / total < 0.1, `${wrong}/${total} mis-decoded sightings`);
  const prog = seenProgress(views, 3);
  for (const p of prog) assert.ok(p.shared > 10, JSON.stringify(prog));

  const res = localizeFixtures(
    room.map((f) => f.model),
    views,
    { reference: 0 },
  );
  assert.ok(res.ok, JSON.stringify(res.fixtures.map((f) => [f.status, f.warnings])));
  const T0 = truthPoseOfModel(room[0]!);
  assert.deepEqual(T0.rotation.length, 4);
  for (const k of [1, 2]) {
    const est = res.fixtures[k]!.pose!;
    // Truth relative to fixture 0 (fixture 0's own pose is identity in the solve).
    const truthPts = [...room[k]!.model.leds.values()].map((x) => applyRoomPose(truthPoseOfModel(room[k]!), x));
    const inv = (p: [number, number, number]) => {
      const q = T0.rotation;
      // rotate by conjugate quaternion
      const [x, y, z, w] = [-q[0], -q[1], -q[2], q[3]];
      const d: [number, number, number] = [p[0] - T0.translation[0], p[1] - T0.translation[1], p[2] - T0.translation[2]];
      const tx = 2 * (y * d[2] - z * d[1]), ty = 2 * (z * d[0] - x * d[2]), tz = 2 * (x * d[1] - y * d[0]);
      return [d[0] + w * tx + (y * tz - z * ty), d[1] + w * ty + (z * tx - x * tz), d[2] + w * tz + (x * ty - y * tx)] as [number, number, number];
    };
    let s2 = 0;
    const pts = [...room[k]!.model.leds.values()];
    pts.forEach((x, i) => {
      const a = applyRoomPose(est, x);
      const b = inv(truthPts[i]!);
      s2 += (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    });
    const rms = Math.sqrt(s2 / pts.length);
    assert.ok(rms < 0.03, `fixture ${k}: LED rms ${(rms * 1000).toFixed(1)} mm`);
    void poseError;
  }
});
