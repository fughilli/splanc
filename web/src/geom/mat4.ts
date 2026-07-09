/**
 * Minimal column-major 4×4 helpers for compositing overlays with the WebXR
 * view — the same convention `XRView.projectionMatrix` and
 * `XRRigidTransform.matrix` use (and WebGL uniforms expect).
 *
 * `viewMatrixFromPose`/`projectionFromIntrinsics` mirror the pinhole model in
 * geom/pinhole.ts (and therefore M3's production camera model); the mat4 test
 * pins `projectPoint(P·V, x)` to `pinhole.project` so the 3D-composited
 * markers and the reconstruction agree pixel-for-pixel.
 */

import type { Intrinsics, Pose } from "@ledmapper/protocol";
import { quatToRotMat } from "./pinhole";

export type Mat4 = Float32Array | number[];

/** c = a·b (column-major). */
export function mul4(a: Mat4, b: Mat4): Float32Array {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = s;
    }
  }
  return out;
}

/**
 * Project a world point through an MVP matrix. Returns NDC (x right, y UP,
 * both in [-1, 1] when visible) or null when the point is at/behind the
 * camera plane.
 */
export function projectPoint(
  m: Mat4,
  x: number,
  y: number,
  z: number,
): { x: number; y: number; z: number } | null {
  const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  if (cw <= 1e-9) return null;
  return {
    x: (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / cw,
    y: (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / cw,
    z: (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) / cw,
  };
}

/**
 * World→camera view matrix from a §7.4 pose (camera-to-world p, q). The
 * WebXR equivalent is `view.transform.inverse.matrix`.
 */
export function viewMatrixFromPose(pose: Pose): Float32Array {
  const r = quatToRotMat(pose.q); // camera-to-world, row-major
  const [px, py, pz] = pose.p;
  const m = new Float32Array(16);
  for (let row = 0; row < 3; row++) {
    // World→camera rotation is Rᵀ: element (row, col) = r[col*3 + row]... in
    // row-major r that is r[3*col + row]; column-major m stores it at
    // m[col*4 + row].
    for (let col = 0; col < 3; col++) m[col * 4 + row] = r[3 * col + row]!;
    m[12 + row] = -(r[row]! * px + r[3 + row]! * py + r[6 + row]! * pz);
  }
  m[15] = 1;
  return m;
}

/**
 * GL projection matrix from pinhole intrinsics (§7.4 conventions: u right,
 * v down, camera looks down −Z). Inverse of what M5 does when it derives K
 * from `XRView.projectionMatrix`.
 */
export function projectionFromIntrinsics(
  k: Intrinsics,
  imgW: number,
  imgH: number,
  near = 0.01,
  far = 100,
): Float32Array {
  const [fx, fy, cx, cy] = k;
  const m = new Float32Array(16);
  m[0] = (2 * fx) / imgW;
  m[5] = (2 * fy) / imgH;
  // ndc_x = 2u/W − 1 with u = cx + fx·x/(−z)  →  z-column terms:
  m[8] = 1 - (2 * cx) / imgW;
  m[9] = (2 * cy) / imgH - 1; // v-down → NDC-y-up flip built in
  m[10] = -(far + near) / (far - near);
  m[11] = -1;
  m[14] = (-2 * far * near) / (far - near);
  return m;
}
