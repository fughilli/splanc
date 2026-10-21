/** IMU-to-fixture extrinsic solve (docs/design/sensor-core.md §7): synthetic
 * random R_fi, noisy gravity poses, 1 / 2 / 3 / N poses, the near-parallel
 * degenerate case, and a bad pose surfacing as the worst residual. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  angleDeg,
  axisAngle,
  quatMul,
  rotate,
  separationFromAccepted,
  solveImuExtrinsic,
  type GravityPose,
  type QuatWxyz,
  type V3,
} from "../src/geom/imuExtrinsic";

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}

function randomQuat(r: () => number): QuatWxyz {
  const axis: V3 = [gauss(r), gauss(r), gauss(r)];
  return axisAngle(axis, r() * 2 * Math.PI);
}

const conj = (q: QuatWxyz): QuatWxyz => [q[0], -q[1], -q[2], -q[3]];
/** Angle of the rotation between two quaternions, degrees. */
function quatErrDeg(a: QuatWxyz, b: QuatWxyz): number {
  const d = quatMul(conj(a), b);
  return (2 * Math.atan2(Math.hypot(d[1], d[2], d[3]), Math.abs(d[0])) * 180) / Math.PI;
}

/** Perturb a direction by ~sigmaDeg. */
function noisy(v: V3, sigmaDeg: number, r: () => number): V3 {
  const s = (sigmaDeg * Math.PI) / 180;
  const axis: V3 = [gauss(r), gauss(r), gauss(r)];
  return rotate(axisAngle(axis, s * gauss(r)), v);
}

/** A still pose: the fixture is held so that world-up is `fixtureUp` in its
 * own frame; the IMU then reads up = R_fi⁻¹ · fixtureUp. */
function pose(rfi: QuatWxyz, fixtureUp: V3, sigmaDeg: number, r: () => number): GravityPose {
  const imuUp = rotate(conj(rfi), fixtureUp);
  return { imuUp: noisy(imuUp, sigmaDeg, r), fixtureUp: noisy(fixtureUp, sigmaDeg, r), sigmaDeg };
}

const UP: V3 = [0, 1, 0];

test("two orthogonal noise-free poses recover R_fi exactly", () => {
  const r = rng(1);
  for (let i = 0; i < 20; i++) {
    const rfi = randomQuat(r);
    const s = solveImuExtrinsic([pose(rfi, UP, 0, r), pose(rfi, [1, 0, 0], 0, r)]);
    assert.ok(quatErrDeg(s.q, rfi) < 1e-4, `trial ${i}: ${quatErrDeg(s.q, rfi)}`);
    assert.equal(s.yawResolved, true);
    assert.equal(s.quality, "good");
    assert.ok(Math.abs(s.separationDeg - 90) < 1e-6);
    assert.ok(s.residualDeg < 1e-4);
  }
});

test("noisy 2 / 3 / 8 poses: error tracks the predicted yaw error", () => {
  const r = rng(7);
  for (const n of [2, 3, 8]) {
    let worst = 0;
    for (let t = 0; t < 30; t++) {
      const rfi = randomQuat(r);
      const ups: V3[] = [UP, [1, 0, 0], [0, 0, 1], [0.7, 0.7, 0], [-1, 0, 0], [0, 0.6, -0.8], [0.3, -0.9, 0.3], [-0.5, 0.5, 0.7]];
      const poses = ups.slice(0, n).map((u) => pose(rfi, u, 1, r));
      const s = solveImuExtrinsic(poses);
      worst = Math.max(worst, quatErrDeg(s.q, rfi));
      assert.equal(s.yawResolved, true);
    }
    // 1° noise per direction: a few degrees worst-case over 30 random trials,
    // shrinking with more poses.
    assert.ok(worst < (n === 2 ? 6 : 4), `${n} poses: worst ${worst.toFixed(2)}°`);
  }
});

test("one pose: tilt is exact, yaw comes from the prior, flagged unresolved", () => {
  const r = rng(3);
  const rfi = randomQuat(r);
  const p = pose(rfi, UP, 0, r);
  const s = solveImuExtrinsic([p]);
  assert.equal(s.yawResolved, false);
  assert.equal(s.quality, "degenerate");
  assert.equal(s.predictedYawErrDeg, Infinity);
  // Gravity maps right whatever the yaw: up in the IMU frame -> +Y.
  assert.ok(angleDeg(rotate(s.q, p.imuUp), UP) < 1e-6);
  // With the true R_fi as prior, the gravity-only solve keeps its yaw.
  const withPrior = solveImuExtrinsic([p], rfi);
  assert.ok(quatErrDeg(withPrior.q, rfi) < 1e-4, `${quatErrDeg(withPrior.q, rfi)}`);
  // A prior off by a yaw about gravity keeps that yaw (nothing to correct it).
  const yawed = quatMul(axisAngle(UP, 0.4), rfi);
  assert.ok(Math.abs(quatErrDeg(solveImuExtrinsic([p], yawed).q, rfi) - 0.4 * (180 / Math.PI)) < 1e-3);
});

test("near-parallel poses are flagged degenerate, 20-45° marginal", () => {
  const r = rng(11);
  const rfi = randomQuat(r);
  const tilted = (deg: number): V3 => rotate(axisAngle([0, 0, 1], (deg * Math.PI) / 180), UP);
  const d = solveImuExtrinsic([pose(rfi, UP, 0, r), pose(rfi, tilted(10), 0, r)]);
  assert.equal(d.quality, "degenerate");
  assert.equal(d.yawResolved, false);
  const m = solveImuExtrinsic([
    { ...pose(rfi, UP, 0, r), sigmaDeg: 1 },
    { ...pose(rfi, tilted(30), 0, r), sigmaDeg: 1 },
  ]);
  assert.equal(m.quality, "marginal");
  assert.equal(m.yawResolved, true);
  assert.ok(m.predictedYawErrDeg > 1.9 && m.predictedYawErrDeg < 2.1, `${m.predictedYawErrDeg}`); // 1°/sin30
  const g = solveImuExtrinsic([pose(rfi, UP, 0, r), pose(rfi, tilted(60), 0, r)]);
  assert.equal(g.quality, "good");
});

test("a bad pose (fixture moved) stands out as the worst residual", () => {
  const r = rng(5);
  const rfi = randomQuat(r);
  // Four poses: with only three, one bad pose is indistinguishable from a bad
  // pair (each pair fits exactly, the odd one out is ambiguous).
  const poses = [
    pose(rfi, UP, 0.3, r),
    pose(rfi, [1, 0, 0], 0.3, r),
    pose(rfi, [0, 0, 1], 0.3, r),
    pose(rfi, [0.6, 0.0, -0.8], 0.3, r),
  ];
  // Pose 2's camera re-localisation was wrong by 15°.
  poses[2] = { ...poses[2]!, fixtureUp: rotate(axisAngle([1, 0, 0], (15 * Math.PI) / 180), poses[2]!.fixtureUp) };
  const s = solveImuExtrinsic(poses);
  assert.equal(s.worstPose, 2);
  assert.ok(s.residualDeg > 3);
  assert.equal(s.quality, "marginal");
  // Dropping it recovers a good fit.
  const ok = solveImuExtrinsic(poses.filter((_, i) => i !== 2));
  assert.ok(ok.residualDeg < 1, `${ok.residualDeg}`);
  assert.ok(quatErrDeg(ok.q, rfi) < 2);
});

test("weights favour the quieter pose", () => {
  const r = rng(9);
  const rfi = randomQuat(r);
  const a = pose(rfi, UP, 0, r);
  const b = pose(rfi, [1, 0, 0], 0, r);
  // A third pose with a large error but a large stated sigma barely moves it.
  const c: GravityPose = { ...pose(rfi, [0, 0, 1], 0, r), sigmaDeg: 30 };
  c.fixtureUp = rotate(axisAngle([1, 0, 0], 0.3), c.fixtureUp);
  const s = solveImuExtrinsic([a, b, c]);
  assert.ok(quatErrDeg(s.q, rfi) < 1, `${quatErrDeg(s.q, rfi)}`);
});

test("guidance separation readout", () => {
  const accepted: GravityPose[] = [{ imuUp: [0, 0, 1], fixtureUp: UP }];
  assert.equal(separationFromAccepted([0, 0, 1], []), 180);
  assert.ok(Math.abs(separationFromAccepted([1, 0, 0], accepted) - 90) < 1e-9);
  assert.ok(Math.abs(separationFromAccepted([0, 1, 1], accepted) - 45) < 1e-9);
});
