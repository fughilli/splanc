/**
 * mat4: the 3D-compositing path (MVP projection of solved LEDs into the XR
 * view) must agree pixel-for-pixel with the pinhole camera model the
 * reconstruction uses — otherwise composited markers would not overlap the
 * physical LEDs even for a perfect solve.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Intrinsics, Pose, Vec3 } from "@ledmapper/protocol";
import {
  mul4,
  projectPoint,
  projectionFromIntrinsics,
  viewMatrixFromPose,
} from "../src/geom/mat4";
import { lookAtQuat, project } from "../src/geom/pinhole";

const K: Intrinsics = [500, 490, 315, 245];
const IMG_W = 640;
const IMG_H = 480;

const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

test("mul4: identity and associativity", () => {
  const p = projectionFromIntrinsics(K, IMG_W, IMG_H);
  assert.deepEqual([...mul4(I4, p)], [...p]);
  assert.deepEqual([...mul4(p, I4)], [...p]);
});

test("projectPoint returns null behind the camera", () => {
  const pose: Pose = { p: [0, 0, 0], q: [0, 0, 0, 1] }; // looks down -Z
  const mvp = mul4(projectionFromIntrinsics(K, IMG_W, IMG_H), viewMatrixFromPose(pose));
  assert.equal(projectPoint(mvp, 0, 0, 2), null); // +Z is behind
  assert.notEqual(projectPoint(mvp, 0, 0, -2), null);
});

test("MVP projection matches the pinhole model (arc of poses × grid of points)", () => {
  const points: Vec3[] = [];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) points.push([(i - 1.5) * 0.3, (j - 1) * 0.25, -0.1 * i]);
  }
  for (let s = 0; s < 8; s++) {
    const a = (s / 8) * Math.PI - Math.PI / 2;
    const eye: Vec3 = [2.2 * Math.sin(a), 0.3 * (s % 3), 2.2 * Math.cos(a)];
    const pose: Pose = { p: eye, q: lookAtQuat(eye, [0, 0, 0]) };
    const mvp = mul4(projectionFromIntrinsics(K, IMG_W, IMG_H), viewMatrixFromPose(pose));
    for (const xw of points) {
      const pin = project(pose, K, xw);
      const ndc = projectPoint(mvp, xw[0], xw[1], xw[2]);
      assert.ok(pin.depth > 0.05, "test geometry keeps points in front");
      assert.ok(ndc !== null, "in-front point must project");
      const u = (ndc.x * 0.5 + 0.5) * IMG_W;
      const v = (0.5 - ndc.y * 0.5) * IMG_H; // NDC y-up → pixel v-down
      assert.ok(Math.abs(u - pin.u) < 1e-3, `u: ${u} vs ${pin.u}`);
      assert.ok(Math.abs(v - pin.v) < 1e-3, `v: ${v} vs ${pin.v}`);
      assert.ok(ndc.z > -1 && ndc.z < 1, "depth inside the clip volume");
    }
  }
});
