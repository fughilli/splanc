/**
 * Pure geometry/pixel helpers for the 64×64 effect previews (FUG-80). Kept in
 * their own DOM-free module so they stay unit-testable (the live canvas driver
 * in livePreview.ts is browser-only).
 */

/** Preview raster is 64×64 — one LED per pixel for spatial effects. */
export const PREVIEW_SIZE = 64;
/** Nominal simulation rate; the device runs the VM at 60 fps. */
export const PREVIEW_FPS = 60;

/**
 * Flat xyz positions (3*size*size) for a `size`×`size` grid in the XY plane,
 * row-major (index = row*size + col, matching RGBA image rows), each axis spread
 * evenly across 0..1 with z=0. shade_all() derives led.uv from these, so a
 * regular unit grid makes uv the pixel coordinate.
 */
export function buildGridPositions(size: number): Float32Array {
  const out = new Float32Array(size * size * 3);
  const denom = size > 1 ? size - 1 : 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3;
      out[i] = x / denom;
      out[i + 1] = y / denom;
      out[i + 2] = 0;
    }
  }
  return out;
}

/** Expand flat RGB (3*N) to tightly-packed RGBA (4*N) with opaque alpha. */
export function rgbToRgba(rgb: Uint8Array, out: Uint8Array | Uint8ClampedArray): void {
  const n = rgb.length / 3;
  for (let i = 0; i < n; i++) {
    out[i * 4] = rgb[i * 3]!;
    out[i * 4 + 1] = rgb[i * 3 + 1]!;
    out[i * 4 + 2] = rgb[i * 3 + 2]!;
    out[i * 4 + 3] = 255;
  }
}
