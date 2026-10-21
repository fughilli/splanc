/** The guided Calibrate-IMU flow's logic (sensor-core.md §7.3): gating on
 * stillness / separation / PnP lock / a steady phone, the camera->map rotation
 * of the phone's gravity, and the solve recovering R_fi end to end. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ImuCalSession, MIN_REST_SAMPLES, rotateXyzw } from "../src/capture/imuCalSession";
import { angleDeg, axisAngle, quatMul, rotate, type QuatWxyz, type V3 } from "../src/geom/imuExtrinsic";

const conj = (q: QuatWxyz): QuatWxyz => [q[0], -q[1], -q[2], -q[3]];
const toXyzw = (q: QuatWxyz): number[] => [q[1], q[2], q[3], q[0]];
function errDeg(a: QuatWxyz, b: QuatWxyz): number {
  const d = quatMul(conj(a), b);
  return (2 * Math.atan2(Math.hypot(d[1], d[2], d[3]), Math.abs(d[0])) * 180) / Math.PI;
}

/** World (room) up = map up once the fixture stands as mapped; when it is tipped
 * by T (fixture->room), room up in the fixture frame is T^-1 * Y. */
function scene(rfi: QuatWxyz, tip: QuatWxyz, camToRoom: QuatWxyz) {
  const upFixture = rotate(conj(tip), [0, 1, 0]);
  const imuUp = rotate(conj(rfi), upFixture);
  // camera -> map(fixture) = tip^-1 * camToRoom; the phone sees room up in camera frame.
  const camToMap = quatMul(conj(tip), camToRoom);
  const phoneUpCam = rotate(conj(camToRoom), [0, 1, 0]);
  return { imuUp, camToMap, phoneUpCam };
}

let clock = 0;
/** One second of a steady phone (timestamps keep advancing, like the real feed). */
function still(session: ImuCalSession, upCam: V3) {
  const s = [];
  for (let i = 0; i < 60; i++) s.push({ t: (clock += 25), accel: upCam.map((c) => c * 9.81) as V3 });
  session.pushPhone(s);
}

test("rotateXyzw matches the wxyz rotation", () => {
  const q = axisAngle([1, 2, 3], 0.9);
  const v: V3 = [0.3, -0.4, 0.8];
  assert.ok(angleDeg(rotateXyzw(toXyzw(q), v), rotate(q, v)) < 1e-9);
});

test("gating: still fixture, separation, lock, steady phone", () => {
  const rfi = axisAngle([0.2, 1, 0.1], 1.1);
  const cam = axisAngle([1, 0, 0], -0.3);
  const s1 = scene(rfi, [1, 0, 0, 0], cam);
  const sess = new ImuCalSession([{ imuUp: s1.imuUp, fixtureUp: [0, 1, 0], sigmaDeg: 0.5 }]);
  // Not tipped yet: too close to pose 1.
  still(sess, s1.phoneUpCam);
  let r = sess.readiness({ atRest: true, restUpImu: s1.imuUp, restUpSigmaDeg: 0.2, restSamples: 200 }, toXyzw(s1.camToMap));
  assert.equal(r.canCapture, false);
  assert.match(r.blockers.join(";"), /Tip it further/);
  // Tipped 80° about x, but moving / no lock.
  const s2 = scene(rfi, axisAngle([1, 0, 0], (80 * Math.PI) / 180), cam);
  r = sess.readiness({ atRest: false, restUpImu: s2.imuUp, restUpSigmaDeg: 0.2, restSamples: 3 }, null);
  assert.deepEqual(r.blockers.slice(0, 1), ["Hold the fixture still"]);
  assert.ok(r.blockers.includes("Point the camera at the lit fixture"));
  r = sess.readiness({ atRest: true, restUpImu: s2.imuUp, restUpSigmaDeg: 0.2, restSamples: MIN_REST_SAMPLES }, toXyzw(s2.camToMap));
  assert.equal(r.canCapture, true, r.blockers.join(";"));
  assert.ok(Math.abs(r.separationDeg - 80) < 0.5, `${r.separationDeg}`);
});

test("a shaky phone blocks the capture", () => {
  const sess = new ImuCalSession();
  const s = [];
  for (let i = 0; i < 40; i++) s.push({ t: i * 25, accel: [Math.sin(i) * 3, 9.81, Math.cos(i) * 3] as V3 });
  sess.pushPhone(s);
  const r = sess.readiness({ atRest: true, restUpImu: [0, 0, 1], restUpSigmaDeg: 0.2, restSamples: 200 }, [0, 0, 0, 1]);
  assert.ok(r.blockers.includes("Hold the phone steady"));
});

test("end to end: pose 1 from mapping + two tipped poses recover R_fi", () => {
  const rfi = axisAngle([0.3, -1, 0.5], 2.0);
  const camA = axisAngle([0, 1, 0], 0.4);
  const camB = quatMul(axisAngle([1, 0, 0], -0.2), axisAngle([0, 1, 0], -0.7));
  const s1 = scene(rfi, [1, 0, 0, 0], camA);
  const sess = new ImuCalSession([{ imuUp: s1.imuUp, fixtureUp: [0, 1, 0], sigmaDeg: 0.5 }]);
  for (const [tip, cam] of [
    [axisAngle([1, 0, 0], Math.PI / 2), camA],
    [axisAngle([0, 0, 1], -Math.PI / 2), camB],
  ] as [QuatWxyz, QuatWxyz][]) {
    const s = scene(rfi, tip, cam);
    still(sess, s.phoneUpCam);
    const r = sess.readiness({ atRest: true, restUpImu: s.imuUp, restUpSigmaDeg: 0.2, restSamples: 300 }, toXyzw(s.camToMap));
    assert.equal(r.canCapture, true, r.blockers.join(";"));
    sess.capture(r);
  }
  assert.equal(sess.poses.length, 3);
  const sol = sess.solve()!;
  assert.equal(sol.yawResolved, true);
  assert.equal(sol.quality, "good");
  assert.ok(errDeg(sol.q, rfi) < 0.01, `${errDeg(sol.q, rfi)}°`);
  sess.drop(2);
  assert.equal(sess.poses.length, 2);
});
