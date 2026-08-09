/**
 * Rasterize point LEDs into an RGBA frame as additive glowing dots (FUG-80) —
 * used to draw the virtual-tree preview, where LEDs sit at arbitrary 2D
 * positions rather than one-per-pixel. Each LED splats a small Gaussian kernel,
 * additively accumulated so overlapping strands read as brighter. Pure and
 * unit-tested.
 */

export interface SplatKernel {
  /** Offsets (dx,dy) and weights of the glow footprint, centered on the LED. */
  taps: { dx: number; dy: number; w: number }[];
}

/** A small Gaussian glow kernel of the given pixel radius (radius>=1). */
export function makeGlowKernel(radius = 1.4): SplatKernel {
  const r = Math.max(1, Math.ceil(radius));
  const sigma = radius * 0.62;
  const taps: SplatKernel["taps"] = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const w = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
      if (w > 0.02) taps.push({ dx, dy, w });
    }
  }
  return { taps };
}

/**
 * Splat `n` LEDs (2D coords in 0..1, y up) with flat-RGB colors into a
 * `size`×`size` RGBA frame. `accum` is a reused Float32 buffer (3*size*size);
 * `out` the reused RGBA output (4*size*size). Colors are added then clamped to
 * 255, so bright/overlapping LEDs saturate to white rather than wrap.
 */
export function rasterizeLeds(
  size: number,
  coords: Float32Array,
  rgb: Uint8Array,
  kernel: SplatKernel,
  accum: Float32Array,
  out: Uint8Array,
): void {
  accum.fill(0);
  const n = coords.length / 2;
  const pxSpan = size - 1;
  for (let i = 0; i < n; i++) {
    // y is flipped so the tree (grown +y) renders upright (row 0 = top).
    const cx = coords[i * 2]! * pxSpan;
    const cy = (1 - coords[i * 2 + 1]!) * pxSpan;
    const px = Math.round(cx);
    const py = Math.round(cy);
    const r = rgb[i * 3]!;
    const g = rgb[i * 3 + 1]!;
    const b = rgb[i * 3 + 2]!;
    if (r === 0 && g === 0 && b === 0) continue; // dark LED contributes nothing
    for (const t of kernel.taps) {
      const x = px + t.dx;
      const y = py + t.dy;
      if (x < 0 || x >= size || y < 0 || y >= size) continue;
      const j = (y * size + x) * 3;
      accum[j] = accum[j]! + r * t.w;
      accum[j + 1] = accum[j + 1]! + g * t.w;
      accum[j + 2] = accum[j + 2]! + b * t.w;
    }
  }
  const px2 = size * size;
  for (let p = 0; p < px2; p++) {
    out[p * 4] = Math.min(255, accum[p * 3]!);
    out[p * 4 + 1] = Math.min(255, accum[p * 3 + 1]!);
    out[p * 4 + 2] = Math.min(255, accum[p * 3 + 2]!);
    out[p * 4 + 3] = 255;
  }
}
