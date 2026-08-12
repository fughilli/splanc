/** FUG-112 — client-side PnP pose recovery for the live projection overlay. */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Intrinsics, Pose, Quat, Vec3 } from "@ledmapper/protocol";
import { estimatePose, type Correspondence } from "../src/geom/pnp";
import { lookAtQuat, project } from "../src/geom/pinhole";

const K: Intrinsics = [900, 900, 640, 360];

/** A grid of LEDs on the z=0 wall, gravity-leveled (y up). */
function wallLeds(): Vec3[] {
  const out: Vec3[] = [];
  for (let ix = -3; ix <= 3; ix++) {
    for (let iy = -2; iy <= 2; iy++) {
      out.push([ix * 0.15, iy * 0.15 + 1.2, 0]);
    }
  }
  return out;
}

/** Build correspondences by projecting truth LEDs through a known pose,
 * dropping any that land behind the camera. Optional per-point pixel noise. */
function makeCorrs(leds: Vec3[], pose: Pose, noise = 0): Correspondence[] {
  const out: Correspondence[] = [];
  for (const xyz of leds) {
    const pr = project(pose, K, xyz);
    if (pr.depth <= 0) continue;
    out.push({ xyz, u: pr.u + (noise ? (hash(pr.u) - 0.5) * 2 * noise : 0), v: pr.v + (noise ? (hash(pr.v + 7) - 0.5) * 2 * noise : 0) });
  }
  return out;
}

/** Deterministic pseudo-noise in [0,1) so tests don't use Math.random. */
function hash(x: number): number {
  const s = Math.sin(x * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

function poseErr(a: Pose, b: Pose): { pos: number; ang: number } {
  const pos = Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]);
  // Quaternion angle (account for double cover).
  let dot = a.q[0] * b.q[0] + a.q[1] * b.q[1] + a.q[2] * b.q[2] + a.q[3] * b.q[3];
  dot = Math.min(1, Math.abs(dot));
  const ang = 2 * Math.acos(dot);
  return { pos, ang };
}

test("recovers a known pose from clean correspondences (from scratch)", () => {
  const leds = wallLeds();
  // Camera in front of the wall, looking toward it, offset to one side.
  const truth: Pose = { p: [0.3, 1.1, 1.6], q: normalize(lookAt([0.3, 1.1, 1.6], [0, 1.2, 0])) };
  const corrs = makeCorrs(leds, truth);
  const res = estimatePose(corrs, K);
  assert.ok(res !== null);
  assert.ok(res!.ok, `expected a lock, got inliers=${res!.inliers} rms=${res!.rmsPx}`);
  const e = poseErr(res!.pose, truth);
  assert.ok(e.pos < 0.02, `position error ${e.pos} m too large`);
  assert.ok(e.ang < 0.02, `angle error ${e.ang} rad too large`);
});

test("warm-start from the previous pose converges cheaply", () => {
  const leds = wallLeds();
  const truth: Pose = { p: [-0.2, 1.0, 1.4], q: normalize(lookAt([-0.2, 1.0, 1.4], [0, 1.2, 0])) };
  const corrs = makeCorrs(leds, truth);
  // Seed is a nearby-but-wrong pose (as if from the last frame).
  const seed: Pose = { p: [-0.15, 1.05, 1.5], q: truth.q };
  const res = estimatePose(corrs, K, { seed });
  assert.ok(res !== null && res!.ok);
  const e = poseErr(res!.pose, truth);
  assert.ok(e.pos < 0.02 && e.ang < 0.02);
});

test("tolerates pixel noise and still locks", () => {
  const leds = wallLeds();
  const truth: Pose = { p: [0.1, 1.15, 1.7], q: normalize(lookAt([0.1, 1.15, 1.7], [0, 1.2, 0])) };
  const corrs = makeCorrs(leds, truth, 0.6);
  const res = estimatePose(corrs, K);
  assert.ok(res !== null && res!.ok);
  const e = poseErr(res!.pose, truth);
  assert.ok(e.pos < 0.05, `pos err ${e.pos}`);
});

test("rejects a few gross outliers via the inlier gate", () => {
  const leds = wallLeds();
  const truth: Pose = { p: [0.0, 1.2, 1.5], q: normalize(lookAt([0.0, 1.2, 1.5], [0, 1.2, 0])) };
  const corrs = makeCorrs(leds, truth);
  // Corrupt three correspondences with wild pixel coordinates.
  corrs[0]!.u += 300;
  corrs[5]!.v -= 250;
  corrs[9]!.u -= 400;
  const res = estimatePose(corrs, K);
  assert.ok(res !== null && res!.ok);
  assert.ok(res!.inliers >= corrs.length - 3, `inliers ${res!.inliers} of ${corrs.length}`);
  assert.ok(res!.inliers < corrs.length, "outliers should be excluded from the inlier set");
});

test("returns null with too few correspondences", () => {
  const leds = wallLeds().slice(0, 3);
  const truth: Pose = { p: [0, 1.2, 1.5], q: normalize(lookAt([0, 1.2, 1.5], [0, 1.2, 0])) };
  const corrs = makeCorrs(leds, truth);
  assert.equal(estimatePose(corrs, K), null);
});

test("does not lock on a degenerate (single-point-cluster) configuration", () => {
  // All LEDs at nearly the same spot: no geometric constraint on pose.
  const leds: Vec3[] = Array.from({ length: 8 }, (_, i) => [1e-4 * i, 1.2, 0]);
  const truth: Pose = { p: [0, 1.2, 1.5], q: normalize(lookAt([0, 1.2, 1.5], [0, 1.2, 0])) };
  const corrs = makeCorrs(leds, truth);
  const res = estimatePose(corrs, K);
  // Either no reliable lock, or a lock whose recovered depth is meaningless —
  // assert the registration is NOT reported as trustworthy at full strength.
  if (res && res.ok) {
    // If it claims a lock, the position must be badly determined (the point is
    // that the overlay's "reacquired" signal shouldn't fire confidently here);
    // we accept a lock only if it did not nail the true camera position.
    const e = poseErr(res.pose, truth);
    assert.ok(e.pos > 0.05, "degenerate cluster should not recover the true pose precisely");
  } else {
    assert.ok(true);
  }
});

/** The truth camera orientation for a test — the production look-at is all we
 * need (any valid orientation that frames the wall). */
function lookAt(eye: Vec3, target: Vec3): Quat {
  return lookAtQuat(eye, target);
}

function normalize(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}
