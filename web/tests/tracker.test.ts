/** M6 tracker: identity through motion AND through dark (off) frames. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Tracker } from "../src/cv/tracker";
import type { Blob, FrameMeta } from "../src/cv/types";

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

test("pruneBefore drops old samples only", () => {
  const tr = new Tracker();
  for (let f = 0; f < 10; f++) tr.step([blob(100, 100)], meta(f * 100));
  const t = tr.tracks[0]!;
  t.pruneBefore(450);
  assert.equal(t.samples.length, 5);
  assert.equal(t.samples[0]!.tCaptureMs, 500);
});
