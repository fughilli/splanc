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
}

export interface CclOptions {
  /** Discard components smaller than this many pixels. */
  minArea?: number;
  /** Discard components larger than this many pixels (glare, windows). */
  maxArea?: number;
  /** Hard cap on returned blobs (brightest-area-first) — runaway safety. */
  maxBlobs?: number;
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

  const visited = new Uint8Array(width * height);
  const blobs: CclBlob[] = [];
  const stack: number[] = [];

  const at = (x: number, y: number) => data[offset + (y * width + x) * stride]!;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (visited[idx] || at(x, y) === 0) continue;

      // Flood fill one component.
      let area = 0;
      let sumW = 0;
      let sumWX = 0;
      let sumWY = 0;
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
        // 4-connectivity.
        if (ix > 0) tryPush(i - 1, ix - 1, iy);
        if (ix < width - 1) tryPush(i + 1, ix + 1, iy);
        if (iy > 0) tryPush(i - width, ix, iy - 1);
        if (iy < height - 1) tryPush(i + width, ix, iy + 1);
      }
      if (area >= minArea && area <= maxArea && sumW > 0) {
        blobs.push({
          x: sumWX / sumW,
          y: sumWY / sumW,
          area,
          intensity: sumW / area / 255,
        });
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
