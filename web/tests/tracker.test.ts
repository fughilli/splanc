/** M6 tracker: identity through motion AND through dark (off) frames. */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Intrinsics, Pose, Vec3 } from "@ledmapper/protocol";
import { Tracker } from "../src/cv/tracker";
import type { Blob, FrameMeta } from "../src/cv/types";
import { project } from "../src/geom/pinhole";

function meta(tCaptureMs: number): FrameMeta {
  return {
    tCaptureMs,
    pose: { p: [0, 0, 0], q: [0, 0, 0, 1] },
    K: [500, 500, 320, 240],
    imgW: 640,
    imgH: 480,
  };
}

function blob(u: number, v: number): Blob {
  return { u, v, intensity: 0.9, area: 9 };
}

test("a moving blob keeps one track id", () => {
  const tr = new Tracker({ gatePx: 60 });
  for (let f = 0; f < 10; f++) {
    tr.step([blob(100 + f * 10, 200)], meta(f * 33));
  }
  assert.equal(tr.tracks.length, 1);
  const t = tr.tracks[0]!;
  assert.equal(t.samples.length, 10);
  assert.ok(t.samples.every((s) => s.on));
});

test("track coasts through off frames and re-acquires (the code-word case)", () => {
  const tr = new Tracker({ gatePx: 60, maxCoastMs: 1000 });
  tr.step([blob(100, 200)], meta(0));
  // LED off for 5 frames while camera drifts right...
  for (let f = 1; f <= 5; f++) tr.step([], meta(f * 33));
  assert.equal(tr.tracks.length, 1);
  // ...LED back on, displaced but within the gate.
  tr.step([blob(130, 200)], meta(6 * 33));
  assert.equal(tr.tracks.length, 1, "must re-acquire, not fork a new track");
  const t = tr.tracks[0]!;
  assert.deepEqual(
    t.samples.map((s) => s.on),
    [true, false, false, false, false, false, true],
  );
});

test("velocity prediction bridges motion during dark frames", () => {
  const tr = new Tracker({ gatePx: 25, maxCoastMs: 1000 });
  // Establish velocity: 3 px/frame for 5 frames.
  for (let f = 0; f < 5; f++) tr.step([blob(100 + f * 3, 200)], meta(f * 33));
  // Dark for 5 frames; the blob keeps moving underneath.
  for (let f = 5; f < 10; f++) tr.step([], meta(f * 33));
  // Reappears 30 px further — outside the gate from the LAST SEEN position
  // (gate 25) but well inside it from the coasted prediction.
  tr.step([blob(100 + 10 * 3, 200)], meta(10 * 33));
  assert.equal(tr.tracks.length, 1);
  assert.equal(tr.tracks[0]!.samples.filter((s) => s.on).length, 6);
});

test("stale tracks die after maxCoastMs", () => {
  const tr = new Tracker({ maxCoastMs: 200 });
  tr.step([blob(50, 50)], meta(0));
  tr.step([], meta(100));
  assert.equal(tr.tracks.length, 1);
  tr.step([], meta(300));
  assert.equal(tr.tracks.length, 0);
});

test("two nearby blobs stay distinct", () => {
  const tr = new Tracker({ gatePx: 40 });
  for (let f = 0; f < 8; f++) {
    tr.step([blob(100, 100 + f * 2), blob(160, 100 + f * 2)], meta(f * 33));
  }
  assert.equal(tr.tracks.length, 2);
  for (const t of tr.tracks) assert.equal(t.samples.length, 8);
});

test("unmatched blobs found new tracks", () => {
  const tr = new Tracker({ gatePx: 30 });
  tr.step([blob(100, 100)], meta(0));
  tr.step([blob(100, 100), blob(400, 400)], meta(33));
  assert.equal(tr.tracks.length, 2);
});

test("lastAssignment reports per-blob association (UI feedback contract)", () => {
  const tr = new Tracker({ gatePx: 30 });
  tr.step([blob(100, 100)], meta(0));
  const known = tr.tracks[0]!;
  known.ledId = 3;

  // Blob 0 continues the known track; blob 1 matches nothing.
  tr.step([blob(102, 100), blob(400, 400)], meta(33));
  assert.equal(tr.lastAssignment.length, 2);
  assert.equal(tr.lastAssignment[0], known, "matched its pre-existing track");
  assert.equal(tr.lastAssignment[0]!.ledId, 3, "identity readable off the assignment");
  assert.equal(tr.lastAssignment[1], null, "fresh blob is unmatched this frame");

  // Next frame the fresh track exists, so the same blob now matches.
  tr.step([blob(400, 400)], meta(66));
  assert.notEqual(tr.lastAssignment[0], null);
  assert.equal(tr.lastAssignment[0]!.ledId, null, "tracked but not yet decoded");
});

test("identified+solved track coasts by reprojection under camera motion", () => {
  // A static LED watched from a camera strafing sideways 5 cm/frame at 2 m:
  // parallax races the LED's *apparent* position across the image while it is
  // dark, so constant-velocity coasting (velocity ≈ 0 here — one on-frame)
  // loses it — reprojection of its solved 3D position through each frame's
  // pose must not.
  const xyz: Vec3 = [0.3, 0.1, 0];
  const K: Intrinsics = [500, 500, 320, 240];
  const poseAt = (i: number): Pose => ({ p: [i * 0.05, 0, 2], q: [0, 0, 0, 1] });
  const metaAt = (i: number): FrameMeta => ({
    tCaptureMs: i * 33,
    pose: poseAt(i),
    K,
    imgW: 640,
    imgH: 480,
  });
  const blobAt = (i: number): Blob => {
    const pr = project(poseAt(i), K, xyz);
    return blob(pr.u, pr.v);
  };

  // Sanity: the dark-stretch apparent motion really does exceed the gate.
  const p0 = project(poseAt(0), K, xyz);
  const p11 = project(poseAt(11), K, xyz);
  assert.ok(Math.hypot(p11.u - p0.u, p11.v - p0.v) > 60, "scenario must out-run the gate");

  const run = (solved: boolean): Tracker => {
    const tr = new Tracker({ gatePx: 20, maxCoastMs: 1000 });
    tr.step([blobAt(0)], metaAt(0));
    tr.tracks[0]!.ledId = 7; // as the decoder would stamp it
    if (solved) tr.setSolvedPositions([{ id: 7, xyz }]);
    for (let i = 1; i <= 10; i++) tr.step([], metaAt(i)); // dark, camera swinging
    tr.step([blobAt(11)], metaAt(11)); // LED reappears
    return tr;
  };

  const withSolve = run(true);
  assert.equal(withSolve.tracks.length, 1, "re-acquired, no forked track");
  assert.equal(withSolve.tracks[0]!.ledId, 7, "same identity");
  assert.ok(withSolve.tracks[0]!.samples.at(-1)!.on);

  // Control: without the solved position the same scenario forks a new track.
  const without = run(false);
  assert.equal(without.tracks.length, 2, "const-velocity coasting loses this LED");
});

test("pruneBefore drops old samples only", () => {
  const tr = new Tracker();
  for (let f = 0; f < 10; f++) tr.step([blob(100, 100)], meta(f * 100));
  const t = tr.tracks[0]!;
  t.pruneBefore(450);
  assert.equal(t.samples.length, 5);
  assert.equal(t.samples[0]!.tCaptureMs, 500);
});
