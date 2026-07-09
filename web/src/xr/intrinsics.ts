/**
 * Derive pinhole intrinsics from a WebXR projection matrix (design doc §5).
 *
 * WebGL projection matrices are column-major. For a (possibly asymmetric)
 * perspective frustum:
 *
 *   m[0] = 2n/(r-l)          m[8]  = (r+l)/(r-l)
 *   m[5] = 2n/(t-b)          m[9]  = (t+b)/(t-b)
 *
 * Mapping NDC to pixels with origin top-left, u right, v down — the §7.4
 * convention shared with the M3 camera model (u = cx + fx·x/d,
 * v = cy − fy·y/d):
 *
 *   fx = m[0]·W/2      cx = (1 − m[8])·W/2
 *   fy = m[5]·H/2      cy = (1 + m[9])·H/2
 *
 * For a symmetric frustum (m[8] = m[9] = 0) this gives the image center.
 * Device accuracy caveat: §13 — validate against a checkerboard calibration
 * on at least one target device before trusting absolute numbers.
 */

import type { Intrinsics } from "@ledmapper/protocol";

export function projectionMatrixToIntrinsics(
  projMatrix: ArrayLike<number>,
  imgW: number,
  imgH: number,
): Intrinsics {
  if (projMatrix.length !== 16) {
    throw new Error(`projection matrix must have 16 elements, got ${projMatrix.length}`);
  }
  if (!(imgW > 0) || !(imgH > 0)) {
    throw new Error(`image dimensions must be positive, got ${imgW}x${imgH}`);
  }
  const m0 = projMatrix[0]!;
  const m5 = projMatrix[5]!;
  const m8 = projMatrix[8]!;
  const m9 = projMatrix[9]!;
  if (!(m0 > 0) || !(m5 > 0)) {
    throw new Error("not a perspective projection matrix (m[0], m[5] must be > 0)");
  }
  const fx = (m0 * imgW) / 2;
  const fy = (m5 * imgH) / 2;
  const cx = ((1 - m8) * imgW) / 2;
  const cy = ((1 + m9) * imgH) / 2;
  return [fx, fy, cx, cy];
}

/**
 * Test/simulation helper — the exact inverse of
 * {@link projectionMatrixToIntrinsics}. Builds the column-major GL projection
 * matrix a WebXR view with these intrinsics would report.
 */
export function intrinsicsToProjectionMatrix(
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
  m[8] = 1 - (2 * cx) / imgW;
  m[9] = (2 * cy) / imgH - 1;
  m[10] = -(far + near) / (far - near);
  m[11] = -1;
  m[14] = (-2 * far * near) / (far - near);
  return m;
}
