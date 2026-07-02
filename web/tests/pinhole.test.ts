/**
 * Cross-language consistency: src/geom/pinhole.ts vs the PRODUCTION M3 camera
 * model (reconstruction/camera.py), via a Python-generated golden. If this
 * fails, the synthetic pipeline test is validating against conventions the
 * solver doesn't share — fix the TS, never the golden.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Intrinsics, Quat, Vec3 } from "@ledmapper/protocol";
import { lookAtQuat, project, quatToRotMat } from "../src/geom/pinhole";
import golden from "./golden_pinhole.json";

test("lookAtQuat matches camera.look_at_quat", () => {
  for (const c of golden.cases) {
    const q = lookAtQuat(c.eye as Vec3, c.target as Vec3);
    // Quaternions are sign-ambiguous; compare up to sign.
    const sign = Math.sign(q[3] * c.q[3]!) || 1;
    for (let i = 0; i < 4; i++) {
      assert.ok(Math.abs(q[i]! - sign * c.q[i]!) < 1e-9, `case q[${i}]: ${q[i]} vs ${c.q[i]}`);
    }
  }
});

test("project matches camera.project (u, v, depth)", () => {
  for (const c of golden.cases) {
    const pose = { p: c.eye as Vec3, q: c.q as Quat };
    for (const pt of c.points) {
      const pr = project(pose, c.K as Intrinsics, pt.xyz as Vec3);
      assert.ok(Math.abs(pr.u - pt.u) < 1e-6, `u ${pr.u} vs ${pt.u}`);
      assert.ok(Math.abs(pr.v - pt.v) < 1e-6, `v ${pr.v} vs ${pt.v}`);
      assert.ok(Math.abs(pr.depth - pt.depth) < 1e-9, `depth`);
    }
  }
});

test("quatToRotMat is orthonormal with det +1", () => {
  for (const c of golden.cases) {
    const m = quatToRotMat(c.q as Quat);
    const det =
      m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) -
      m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) +
      m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!);
    assert.ok(Math.abs(det - 1) < 1e-9);
  }
});
