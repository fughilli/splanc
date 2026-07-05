/**
 * M6 detect stage, CPU half: connected components + sub-pixel centroids over
 * the thresholded luminance buffer read back from the GPU pass (detect.ts).
 *
 * The buffer is sparse (LEDs are the brightest things in frame, §5), so a
 * simple stack-based 4-connectivity flood fill over nonzero pixels is cheap.
 * Centroids are intensity-weighted with pixel centers at (x+0.5, y+0.5).
 * Pure and orientation-agnostic — coordinate scaling/flipping to full-res
 * camera pixels is the caller's job.
 */

export interface CclBlob {
  /** Intensity-weighted centroid in buffer coordinates. */
  x: number;
  y: number;
  /** Pixel count. */
  area: number;
  /** Mean intensity of member pixels, [0, 1]. */
  intensity: number;
  /** Bounding-box size in buffer px (shape gate: screen-refresh/PWM bands
   * from filming a display are strongly elongated; LEDs are compact). */
  w: number;
  h: number;
  /** Mean color of member pixels, [0, 1] (only when `colorBase` is given). */
  r?: number;
  g?: number;
  b?: number;
}

export interface CclOptions {
  /** Discard components smaller than this many pixels. */
  minArea?: number;
  /** Discard components larger than this many pixels (glare, windows). */
  maxArea?: number;
  /** Hard cap on returned blobs (brightest-area-first) — runaway safety. */
  maxBlobs?: number;
  /**
   * Accumulate per-blob mean color from channels at `offsetOfPixel +
   * colorBase .. +2` (e.g. 0 for RGB when the weight channel is alpha).
   */
  colorBase?: number;
}

/**
 * @param data intensity buffer, 0 = background; sampled at `offset + (y*width+x)*stride`
 *   (stride/offset let RGBA readbacks be scanned without a compaction copy).
 */
export function connectedComponents(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  stride = 1,
  offset = 0,
  opts: CclOptions = {},
): CclBlob[] {
  const minArea = opts.minArea ?? 1;
  const maxArea = opts.maxArea ?? 10_000;
  const maxBlobs = opts.maxBlobs ?? 4096;
  const colorBase = opts.colorBase;

  const visited = new Uint8Array(width * height);
  const blobs: CclBlob[] = [];
  const stack: number[] = [];

  const at = (x: number, y: number) => data[offset + (y * width + x) * stride]!;
  const colorAt = (x: number, y: number, ch: number) =>
    data[(y * width + x) * stride + colorBase! + ch]!;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (visited[idx] || at(x, y) === 0) continue;

      // Flood fill one component.
      let area = 0;
      let sumW = 0;
      let sumWX = 0;
      let sumWY = 0;
      let minX = width;
      let maxX = -1;
      let minY = height;
      let maxY = -1;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      stack.length = 0;
      stack.push(idx);
      visited[idx] = 1;
      while (stack.length > 0) {
        const i = stack.pop()!;
        const ix = i % width;
        const iy = (i / width) | 0;
        const w = at(ix, iy);
        area++;
        sumW += w;
        sumWX += w * (ix + 0.5);
        sumWY += w * (iy + 0.5);
        if (ix < minX) minX = ix;
        if (ix > maxX) maxX = ix;
        if (iy < minY) minY = iy;
        if (iy > maxY) maxY = iy;
        if (colorBase !== undefined) {
          sumR += colorAt(ix, iy, 0);
          sumG += colorAt(ix, iy, 1);
          sumB += colorAt(ix, iy, 2);
        }
        // 4-connectivity.
        if (ix > 0) tryPush(i - 1, ix - 1, iy);
        if (ix < width - 1) tryPush(i + 1, ix + 1, iy);
        if (iy > 0) tryPush(i - width, ix, iy - 1);
        if (iy < height - 1) tryPush(i + width, ix, iy + 1);
      }
      if (area >= minArea && area <= maxArea && sumW > 0) {
        const blob: CclBlob = {
          x: sumWX / sumW,
          y: sumWY / sumW,
          area,
          intensity: sumW / area / 255,
          w: maxX - minX + 1,
          h: maxY - minY + 1,
        };
        if (colorBase !== undefined) {
          blob.r = sumR / area / 255;
          blob.g = sumG / area / 255;
          blob.b = sumB / area / 255;
        }
        blobs.push(blob);
      }
    }
  }

  function tryPush(i: number, x: number, y: number): void {
    if (!visited[i] && at(x, y) !== 0) {
      visited[i] = 1;
      stack.push(i);
    }
  }

  if (blobs.length > maxBlobs) {
    blobs.sort((a, b) => b.area * b.intensity - a.area * a.intensity);
    blobs.length = maxBlobs;
  }
  return blobs;
}
