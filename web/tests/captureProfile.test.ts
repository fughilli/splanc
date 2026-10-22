/** Capture-profile reuse + the post-mapping IMU pose (sensor-core.md §7). */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyProfile,
  buildProfile,
  captureSettingsNote,
  postMappingPose,
  profileForMap,
  type CaptureKnobs,
} from "../src/capture/captureProfile";
import { angleDeg, rotate, type QuatWxyz } from "../src/geom/imuExtrinsic";

const DEFAULTS: CaptureKnobs = { diffuse: false, strideSpacing: 4, anchorDensity: 6, threshold: 0.6, downscale: 2 };

test("round trip: what a capture records is what the next one applies", () => {
  const knobs: CaptureKnobs = { diffuse: true, strideSpacing: 6, anchorDensity: 8, threshold: 0.42, downscale: 1, lcGain: 2.5 };
  const p = buildProfile("m-lamp", knobs, { symbols: 4, bitPeriodMs: 66, brightness: 0.35 }, 1_792_000_000_000);
  const run = applyProfile(DEFAULTS, profileForMap(p, "m-lamp"));
  assert.deepEqual(run.knobs, knobs);
  assert.equal(run.symbols, 4);
  assert.equal(run.bitPeriodMs, 66);
  assert.equal(run.brightness, 0.35);
  assert.equal(run.skipProbe, true);
  assert.equal(run.applied, p);
});

test("fixtures mapped before profiles existed (or a different map) keep the defaults", () => {
  for (const stored of [null, undefined, buildProfile("other-map", DEFAULTS, { bitPeriodMs: 50 }, 0)]) {
    const run = applyProfile(DEFAULTS, profileForMap(stored, "m-lamp"));
    assert.deepEqual(run.knobs, DEFAULTS);
    assert.equal(run.skipProbe, false);
    assert.equal(run.applied, null);
    assert.equal(run.symbols, undefined);
  }
  // An empty device reply (proto3 defaults) is "none".
  const empty = { mapId: "", diffuse: false, strideSpacing: 0, anchorDensity: 0, symbols: 0, bitPeriodMs: 0, brightness: 0, detectThreshold: 0, downscale: 0, lcGain: 0, capturedAtMs: 0 };
  assert.equal(profileForMap(empty, ""), null);
});

test("a partial profile only pins what it has", () => {
  const p = buildProfile("m", { ...DEFAULTS, diffuse: true, strideSpacing: 3 }, { bitPeriodMs: 50 }, 0);
  const run = applyProfile(DEFAULTS, p);
  assert.equal(run.knobs.diffuse, true);
  assert.equal(run.knobs.strideSpacing, 3);
  assert.equal(run.skipProbe, false, "no symbols recorded -> still probe the timing");
  assert.equal(run.brightness, undefined);
});

test("post-mapping pose: the IMU's settled up becomes map +Y (tilt), yaw unresolved", () => {
  // IMU mounted with its +x up.
  const pose = postMappingPose(
    { status: "SENSOR_STATUS_RUNNING", restUpImu: [1, 0, 0], restUpSigmaDeg: 0.2, restSamples: 300, mountQuat: [1, 0, 0, 0] },
    1,
  )!;
  assert.ok(pose);
  assert.equal(pose.yawResolved, false);
  assert.ok(angleDeg(rotate(pose.q as QuatWxyz, [1, 0, 0]), [0, 1, 0]) < 1e-6);
  assert.equal(pose.poses.length, 1);
  assert.equal(pose.poses[0]!.sigmaDeg, 0.5, "floored");
  // Not settled / no sensor -> nothing to record.
  assert.equal(postMappingPose({ status: "SENSOR_STATUS_RUNNING", restUpImu: [], restUpSigmaDeg: 0, restSamples: 0, mountQuat: [] }, 1), null);
  assert.equal(postMappingPose({ status: "SENSOR_STATUS_ABSENT", restUpImu: [0, 0, 1], restUpSigmaDeg: 0, restSamples: 99, mountQuat: [] }, 1), null);
});

test("exposure round-trips and starts manual", () => {
  const p = buildProfile("m", DEFAULTS, { bitPeriodMs: 50, symbols: 2, exposure: 0.42 }, 0);
  assert.equal(p.exposure, 0.42);
  assert.equal(applyProfile(DEFAULTS, p).exposure, 0.42);
  // Not recorded (the servo chose) -> no manual start.
  const q = buildProfile("m", DEFAULTS, { bitPeriodMs: 50 }, 0);
  assert.equal(q.exposure, undefined);
  assert.equal(applyProfile(DEFAULTS, q).exposure, undefined);
});

test("no saved profile: the normal-capture defaults (device stride + global diffuse), said out loud", () => {
  const diffuseDefaults: CaptureKnobs = { ...DEFAULTS, diffuse: true, strideSpacing: 4 };
  const run = applyProfile(diffuseDefaults, profileForMap(null, "m"));
  // Never a silent dense / stride-1 fallback.
  assert.equal(run.knobs.diffuse, true);
  assert.equal(run.knobs.strideSpacing, 4);
  const note = captureSettingsNote(run, run.knobs);
  assert.match(note, /No saved capture settings for this map/);
  assert.match(note, /diffuse on, stride 4/);
  const saved = applyProfile(DEFAULTS, buildProfile("m", diffuseDefaults, { bitPeriodMs: 50 }, 0));
  assert.match(captureSettingsNote(saved, saved.knobs), /Using this map's saved capture settings: diffuse on, stride 4/);
  assert.match(captureSettingsNote(null, DEFAULTS), /diffuse off/);
});

test("what a successful calibration records is reused by the next run", () => {
  // The user fixed diffuse + stride on the calibrate screen and set exposure by hand.
  const worked: CaptureKnobs = { diffuse: true, strideSpacing: 6, anchorDensity: 6, threshold: 0.3, downscale: 2 };
  const p = buildProfile("m-dev", worked, { symbols: 4, bitPeriodMs: 66, brightness: 0.5, exposure: 0.35 }, 1);
  const next = applyProfile(DEFAULTS, profileForMap(p, "m-dev"));
  assert.deepEqual(next.knobs, worked);
  assert.equal(next.exposure, 0.35);
  assert.equal(next.brightness, 0.5);
  assert.equal(next.skipProbe, true);
});
