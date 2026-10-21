/**
 * Room-localization plumbing: the capture session (records → views → solve,
 * warm-started), anchoring solved poses on a reference's existing room pose,
 * pose wire round trips, and the debug bundle (same envelope as the #318
 * capture bundles; replays to the same poses).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { DetectionRecord, OutputMap } from "@ledmapper/protocol";
import {
  anchorPoses,
  flatToRoomPose,
  GroupCaptureSession,
  planCodeLayout,
  roomPoseToFlat,
} from "../src/geom/groupCode";
import { applyRoomPose, composeRoomPose, invertRoomPose, poseError, type RoomPose } from "../src/geom/multiFixture";
import { bundleFileName } from "../src/solver/captureBundle";
import {
  buildLocalizeBundle,
  bundleFixture,
  isLocalizeBundle,
  localizeOutcome,
  replayLocalizeBundle,
} from "../src/solver/localizeBundle";
import { K, IMG_H, IMG_W, makeRoom, simulateCapture } from "./multiFixtureSynth";

function mapOf(leds: Map<number, [number, number, number]>, id: string): OutputMap {
  return {
    mapId: id,
    createdAt: "2026-10-21T00:00:00Z",
    units: "meters",
    frame: "gravity_leveled",
    ledCount: leds.size,
    leds: [...leds.entries()].map(([i, xyz]) => ({ id: i, xyz, confidence: 1, nViews: 5, rmsReprojPx: 1, parallaxDeg: 10 })),
    unmapped: [],
    stats: { rmsReprojPxGlobal: 1, medianParallaxDeg: 10, scaleRelStdErr: 0.03 },
  } as unknown as OutputMap;
}

test("pose composition: inverse, compose, wire round trip", () => {
  const a: RoomPose = { translation: [1, 2, 3], rotation: [0, Math.sin(0.4), 0, Math.cos(0.4)], scale: 1.1 };
  const b: RoomPose = { translation: [-0.5, 0, 0.2], rotation: [Math.sin(0.2), 0, 0, Math.cos(0.2)], scale: 0.9 };
  const x: [number, number, number] = [0.3, -0.2, 0.7];
  const ab = applyRoomPose(composeRoomPose(a, b), x);
  const direct = applyRoomPose(a, applyRoomPose(b, x));
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(ab[k]! - direct[k]!) < 1e-9);
  const back = applyRoomPose(invertRoomPose(a), applyRoomPose(a, x));
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(back[k]! - x[k]!) < 1e-9);
  const flat = roomPoseToFlat("living", a);
  assert.equal(flat.room, "living");
  const again = flatToRoomPose(flat)!;
  assert.ok(poseError(a, again, [x]).ledRmsM < 1e-5);
  assert.equal(flatToRoomPose({ translation: [1, 2] }), null);
});

test("anchoring keeps an existing room frame: the reference stays where it was", () => {
  const solved: (RoomPose | null)[] = [
    { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: 1 },
    { translation: [1, 0, 0], rotation: [0, 0, 0, 1], scale: 1 },
    null,
  ];
  const stored: RoomPose = { translation: [5, 0, 2], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2], scale: 1 };
  const out = anchorPoses(solved, 0, stored);
  assert.ok(poseError(stored, out[0]!, [[0, 0, 0], [1, 1, 1]]).ledRmsM < 1e-9);
  // Fixture 1 was 1 m along the reference's +x: after a 90° yaw that's -z in the room.
  const p = applyRoomPose(out[1]!, [0, 0, 0]);
  assert.ok(Math.abs(p[0] - 5) < 1e-9 && Math.abs(p[2] - 1) < 1e-9, `${p}`);
  assert.equal(out[2], null);
  // No stored reference pose: unchanged.
  assert.deepEqual(anchorPoses(solved, 0, null), solved);
});

test("session: dense records → views → solve; the bundle replays to the same poses", () => {
  const room = makeRoom({ seed: 61, shapes: ["lamp", "panel", "tree"] });
  const members = room.map((f, k) => ({
    id: `fx${k}`,
    name: f.model.name!,
    ledCount: f.model.leds.size,
    map: mapOf(f.model.leds as Map<number, [number, number, number]>, `map${k}`),
  }));
  const s = new GroupCaptureSession(members, 0);
  assert.deepEqual(s.layout, planCodeLayout(members));
  // Synthetic decoded records (what CvPipeline's dense mode emits), batch by batch.
  const sim = simulateCapture(room, { seed: 9, frames: 120 });
  const recs: DetectionRecord[] = sim.views.flatMap((v) =>
    v.sightings.map((x) => ({
      ledId: s.layout.slots[x.fixture]!.offset + x.led,
      tCaptureMs: v.t,
      u: x.u,
      v: x.v,
      imgW: IMG_W,
      imgH: IMG_H,
      K,
      pose: null,
      confidence: 1,
    })),
  );
  for (let i = 0; i < recs.length; i += 500) s.addRecords(recs.slice(i, i + 500));
  assert.equal(s.views().length, sim.views.filter((v) => v.sightings.length).length);
  const prog = s.progress();
  assert.ok(prog.every((p) => p.shared > 5), JSON.stringify(prog));
  const r1 = s.solve({ maxViews: 60 });
  const r2 = s.solve(); // warm-started from r1
  assert.ok(r2.ok, JSON.stringify(r2.warnings));
  assert.ok(poseError(r1.fixtures[1]!.pose!, r2.fixtures[1]!.pose!, [[0, 0, 0]]).transM < 0.05);

  const bundle = buildLocalizeBundle({
    app: { version: null, gitCommit: "test", gitDirty: false },
    capture: {
      ledCount: s.layout.codeSpace,
      transport: "direct",
      layout: s.layout,
      codeParams: null,
      timing: { symbols: 4, bitPeriodMs: 100 },
      members: members.map((m) => ({ id: m.id, name: m.name, features: ["group_capture"], capture: null, profile: null })),
      arm: members.map((m) => ({ id: m.id, ok: true, skewBoundMs: 3 })),
      epochLocalMs: 0,
      durationMs: 12_000,
      reference: 0,
    },
    fixtures: s.models.map((m, i) => bundleFixture(m, `map${i}`, null)),
    views: s.views(),
    options: { reference: 0 },
    result: r2,
    error: null,
  });
  assert.ok(isLocalizeBundle(bundle));
  assert.equal(bundle.outcome, localizeOutcome(r2, null));
  assert.match(bundleFileName(bundle), /^splanc-localize-.*\.splanc-capture\.json$/);
  // Through JSON (what Export writes) and back: the replay reproduces the poses.
  const replayed = replayLocalizeBundle(JSON.parse(JSON.stringify(bundle)));
  for (const k of [1, 2]) {
    const e = poseError(r2.fixtures[k]!.pose!, replayed.fixtures[k]!.pose!, s.models[k]!.leds.values());
    assert.ok(e.ledRmsM < 0.002, `fixture ${k} replay drift ${e.ledRmsM}`);
  }
  assert.equal(localizeOutcome(null, "boom"), "failed");
});
