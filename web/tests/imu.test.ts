/** DeviceMotion → camera-frame normalization (xr/imu.ts, no-XR capture). */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_IMU_MAPPING, motionToSample, parseImuMapping } from "../src/xr/imu";

const RR = { alpha: 10, beta: 20, gamma: 30 }; // deg/s
const AG = { x: 0.1, y: 9.7, z: -0.3 }; // m/s²
const DEG = Math.PI / 180;

test("default mapping: gyro = (alpha, beta, gamma) as camera x/y/z, accel identity", () => {
  // The 2026-07-08 device fit (vio_replay --diagnose): NOT the W3C reading.
  const s = motionToSample(1000, RR, AG)!;
  assert.equal(s.t, 1000);
  assert.deepEqual(s.gyro, [10 * DEG, 20 * DEG, 30 * DEG]);
  assert.deepEqual(s.accel, [0.1, 9.7, -0.3]);
});

test("parseImuMapping round-trips the default and the W3C-spec reading", () => {
  const dflt = parseImuMapping("+a,+b,+g;+x,+y,+z")!;
  assert.deepEqual(dflt, DEFAULT_IMU_MAPPING);

  // W3C spec: alpha about z, beta about x, gamma about y → camera x/y/z
  // rates come from (beta, gamma, alpha).
  const w3c = parseImuMapping("+b,+g,+a;+x,+y,+z")!;
  const s = motionToSample(0, RR, AG, w3c)!;
  assert.deepEqual(s.gyro, [20 * DEG, 30 * DEG, 10 * DEG]);
});

test("signs and axis swaps apply; malformed specs are rejected", () => {
  const m = parseImuMapping("-a,+g,-b;-y,+x,+z")!;
  const s = motionToSample(0, RR, AG, m)!;
  assert.deepEqual(s.gyro, [-10 * DEG, 30 * DEG, -20 * DEG]);
  assert.deepEqual(s.accel, [-9.7, 0.1, -0.3]);

  assert.equal(parseImuMapping(""), null);
  assert.equal(parseImuMapping("+a,+b;+x,+y,+z"), null);
  assert.equal(parseImuMapping("+a,+b,+q;+x,+y,+z"), null);
  assert.equal(parseImuMapping("+a,+b,+g"), null);
});

test("null components (sensor warm-up) yield no sample", () => {
  assert.equal(motionToSample(0, { alpha: null, beta: 1, gamma: 2 }, AG), null);
  assert.equal(motionToSample(0, RR, { x: 1, y: 2, z: null }), null);
});
