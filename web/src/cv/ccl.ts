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
  /**
   * Blooming diagnostics. A too-bright LED saturates the sensor to a white
   * core surrounded by a colored halo, which blooms the blob and can wash
   * its mean color toward gray. `peak`/`satFrac` say "how blown out" (always
   * computed — cheap, and the brightness servo reads satFrac every frame);
   * `cr/cg/cb` say "what hue the halo is" (only with `stats`/`split`).
   */
  /** Peak weight-channel luminance in the blob, [0, 1] (1 = fully clipped). */
  peak?: number;
  /** Fraction of member pixels at/above the saturation cut (~0.98). */
  satFrac?: number;
  /** CHROMA-WEIGHTED mean color, [0, 1]: each pixel weighted by its own
   * chroma (max−min channel), so the near-gray saturated core contributes
   * ~nothing and the colored halo dominates — the hue as it survives
   * blooming. `null`-ish (0,0,0) when the blob has no chroma anywhere. */
  cr?: number;
  cg?: number;
  cb?: number;
  /** Blob came out of an oversized component via the `splitOversized`
   * cut ladders (its r/g/b are the sampled halo hue, not a member mean). */
  split?: boolean;
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
  /** Also compute the CHROMA-WEIGHTED color (cr/cg/cb) — the extra per-pixel
   * chroma math, so opt-in (the trace path). peak/satFrac are always
   * computed regardless (cheap; the brightness servo needs satFrac). */
  stats?: boolean;
  /**
   * Split components larger than `maxArea` instead of dropping them (needs
   * `colorBase`). A washed-out strip merges every LED's halo into one huge
   * component (observed 2026-07-12: a single 98k-px component spanning the
   * whole frame at threshold 0.6, so maxArea silently discarded ALL LEDs).
   * Oversized components are recursively re-thresholded within their own
   * pixels — first on the weight channel (separates dim LEDs from the glow),
   * then, for pieces still merged at saturation, on min(r,g,b): a bloomed
   * core is WHITE where its halo is colored, so whiteness separates cores a
   * clipped weight channel cannot. Split blobs report the chroma-weighted
   * halo hue around their core as r/g/b (the core itself is gray and would
   * defeat the hue decode).
   */
  splitOversized?: boolean;
}

/** Weight-channel value at/above which a pixel counts as saturated (~0.98). */
const SAT_CUT = 250;

/** Halo-hue sampling window radius bound (buffer px) — keeps the per-core
 * cost bounded no matter how large the parent glow is. */
const MAX_HALO_RADIUS = 32;

/** Weight-ladder rung height (see splitByWeight). ~0.06 in luminance: fine
 * enough that a dim LED separating from a glow is seen at some rung before
 * the cut passes its peak, coarse enough that a full climb from the base
 * threshold to SAT_CUT is a handful of passes over the component. */
const WEIGHT_STEP = 16;

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
  const stats = opts.stats === true && colorBase !== undefined;
  const splitOversized = opts.splitOversized === true && colorBase !== undefined;

  const visited = new Uint8Array(width * height);
  const blobs: CclBlob[] = [];
  const stack: number[] = [];
  const members: number[] = [];

  const weightAt = (i: number) => data[offset + i * stride]!;
  const chAt = (i: number, ch: number) => data[i * stride + colorBase! + ch]!;
  // Whiteness: a bloomed core clips ALL channels; its halo keeps min≈0.
  const minChAt = (i: number) => Math.min(chAt(i, 0), Math.min(chAt(i, 1), chAt(i, 2)));

  // Split-ladder scratch, allocated only if an oversized component shows up.
  // `parentStamp` marks the current oversized component's pixels (the ladder
  // floods and the halo sampler must not escape it); `ladderSeen` is the
  // per-ladder-level visited set, generation-stamped to avoid re-clearing.
  let parentStamp: Int32Array | null = null;
  let ladderSeen: Int32Array | null = null;
  let parentId = 0;
  let ladderGen = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (visited[idx] || weightAt(idx) === 0) continue;

      // Flood fill one component, collecting member indices.
      members.length = 0;
      stack.length = 0;
      stack.push(idx);
      visited[idx] = 1;
      let minW = 255;
      while (stack.length > 0) {
        const i = stack.pop()!;
        members.push(i);
        const wi = weightAt(i);
        if (wi < minW) minW = wi;
        const ix = i % width;
        const iy = (i / width) | 0;
        if (ix > 0) tryPush(i - 1);
        if (ix < width - 1) tryPush(i + 1);
        if (iy > 0) tryPush(i - width);
        if (iy < height - 1) tryPush(i + width);
      }
      if (members.length <= maxArea) {
        const blob = blobFromMembers(members);
        if (blob !== null) blobs.push(blob);
      } else if (splitOversized) {
        // Oversized: every LED halo in view merged into one glow. Stamp the
        // parent and re-threshold within it (see CclOptions.splitOversized).
        // The ladder starts from the component's dimmest member — every cut
        // at or below it returns the piece whole.
        parentStamp ??= new Int32Array(width * height);
        ladderSeen ??= new Int32Array(width * height);
        parentId++;
        for (const i of members) parentStamp[i] = parentId;
        splitByWeight([...members], minW);
      }
      // else: oversized and splitting off — dropped, as before (glare).
    }
  }

  function tryPush(i: number): void {
    if (!visited[i] && weightAt(i) !== 0) {
      visited[i] = 1;
      stack.push(i);
    }
  }

  /** Measure one pixel set into a blob (null if it fails the area/weight
   * gates). Split pieces get their color overridden by the halo hue. */
  function blobFromMembers(pixels: readonly number[], split = false): CclBlob | null {
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
    let peak = 0;
    let satCount = 0;
    let sumCW = 0;
    let sumCWR = 0;
    let sumCWG = 0;
    let sumCWB = 0;
    for (const i of pixels) {
      const ix = i % width;
      const iy = (i / width) | 0;
      const w = weightAt(i);
      area++;
      sumW += w;
      sumWX += w * (ix + 0.5);
      sumWY += w * (iy + 0.5);
      if (ix < minX) minX = ix;
      if (ix > maxX) maxX = ix;
      if (iy < minY) minY = iy;
      if (iy > maxY) maxY = iy;
      // peak/satFrac are weight-channel only and CHEAP, and the brightness
      // servo reads satFrac every frame (exposure.ts), so compute them
      // always — not just on the trace path.
      if (w > peak) peak = w;
      if (w >= SAT_CUT) satCount++;
      if (colorBase !== undefined) {
        const cr = chAt(i, 0);
        const cg = chAt(i, 1);
        const cb = chAt(i, 2);
        sumR += cr;
        sumG += cg;
        sumB += cb;
        if (stats || split) {
          // Chroma = max−min channel: 0 for gray/white (the saturated
          // core), high for a colored halo pixel. Weighting the color sum
          // by it recovers the hue the bloom didn't destroy.
          const chroma = Math.max(cr, Math.max(cg, cb)) - Math.min(cr, Math.min(cg, cb));
          sumCW += chroma;
          sumCWR += chroma * cr;
          sumCWG += chroma * cg;
          sumCWB += chroma * cb;
        }
      }
    }
    if (area < minArea || area > maxArea || sumW === 0) return null;
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
    // Always present (cheap): how blown out the blob is.
    blob.peak = peak / 255;
    blob.satFrac = satCount / area;
    if (stats || split) {
      const cwNorm = sumCW > 0 ? sumCW * 255 : 1;
      blob.cr = sumCWR / cwNorm;
      blob.cg = sumCWG / cwNorm;
      blob.cb = sumCWB / cwNorm;
    }
    if (split) {
      blob.split = true;
      // A split-out piece is mostly saturated core — its member-mean color
      // is gray and would defeat the hue decode. Report the surrounding
      // halo's hue instead; fall back to the member chroma-weighted mean
      // (already halo-dominated) when the neighborhood has no chroma.
      const halo = haloHue(blob);
      if (halo !== null) {
        [blob.r, blob.g, blob.b] = halo;
        [blob.cr, blob.cg, blob.cb] = halo;
      } else if (sumCW > 0) {
        blob.r = blob.cr!;
        blob.g = blob.cg!;
        blob.b = blob.cb!;
      }
    }
    return blob;
  }

  /**
   * Chroma-weighted mean color of the current parent component's pixels
   * around a split-out core, with a spatial falloff so a neighboring LED's
   * halo (which may carry a DIFFERENT symbol hue) doesn't take over.
   */
  function haloHue(core: CclBlob): [number, number, number] | null {
    const rad = Math.min(MAX_HALO_RADIUS, Math.max(4, 1.5 * Math.max(core.w, core.h)));
    const x0 = Math.max(0, Math.round(core.x - rad));
    const x1 = Math.min(width - 1, Math.round(core.x + rad));
    const y0 = Math.max(0, Math.round(core.y - rad));
    const y1 = Math.min(height - 1, Math.round(core.y + rad));
    const falloff2 = rad * rad * 0.25;
    let sum = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const i = yy * width + xx;
        if (parentStamp![i] !== parentId) continue;
        const cr = chAt(i, 0);
        const cg = chAt(i, 1);
        const cb = chAt(i, 2);
        const chroma = Math.max(cr, Math.max(cg, cb)) - Math.min(cr, Math.min(cg, cb));
        if (chroma === 0) continue;
        const dx = xx + 0.5 - core.x;
        const dy = yy + 0.5 - core.y;
        const w = chroma / (1 + (dx * dx + dy * dy) / falloff2);
        sum += w;
        sumR += w * cr;
        sumG += w * cg;
        sumB += w * cb;
      }
    }
    if (sum === 0) return null;
    return [sumR / sum / 255, sumG / sum / 255, sumB / sum / 255];
  }

  /** Flood one piece of the current parent at `cut` over `valueAt`. */
  function floodPiece(seed: number, cut: number, valueAt: (i: number) => number): number[] {
    const piece: number[] = [];
    const seen = ladderSeen!;
    const parent = parentStamp!;
    stack.length = 0;
    stack.push(seed);
    seen[seed] = ladderGen;
    while (stack.length > 0) {
      const i = stack.pop()!;
      piece.push(i);
      const ix = i % width;
      const iy = (i / width) | 0;
      let j = i - 1;
      if (ix > 0 && seen[j] !== ladderGen && parent[j] === parentId && valueAt(j) >= cut) {
        seen[j] = ladderGen;
        stack.push(j);
      }
      j = i + 1;
      if (ix < width - 1 && seen[j] !== ladderGen && parent[j] === parentId && valueAt(j) >= cut) {
        seen[j] = ladderGen;
        stack.push(j);
      }
      j = i - width;
      if (iy > 0 && seen[j] !== ladderGen && parent[j] === parentId && valueAt(j) >= cut) {
        seen[j] = ladderGen;
        stack.push(j);
      }
      j = i + width;
      if (iy < height - 1 && seen[j] !== ladderGen && parent[j] === parentId && valueAt(j) >= cut) {
        seen[j] = ladderGen;
        stack.push(j);
      }
    }
    return piece;
  }

  /**
   * Weight-channel cut ladder (fixed WEIGHT_STEP increments toward SAT_CUT).
   * A piece emits only once it has no saturated pixels — a dim LED that
   * separated from the glow at this cut. Pieces that still contain
   * saturation keep climbing (an intermediate-cut slab can span several LEDs
   * even under maxArea); at SAT_CUT the weight channel is clipped flat and
   * can't separate further, so still-merged pieces fall through to the
   * whiteness ladder. The step is fixed, not bisected: a dim piece VANISHES
   * at the first cut above its peak, so the step bounds how much of a
   * just-separated LED's dynamic range a single rung can skip.
   */
  function splitByWeight(piece: readonly number[], cut: number): void {
    if (cut >= SAT_CUT) {
      splitByWhiteness(piece, 0);
      return;
    }
    const nextCut = Math.min(SAT_CUT, cut + WEIGHT_STEP);
    ladderGen++;
    const pieces: number[][] = [];
    for (const i of piece) {
      if (ladderSeen![i] === ladderGen || weightAt(i) < nextCut) continue;
      pieces.push(floodPiece(i, nextCut, weightAt));
    }
    for (const sub of pieces) {
      let peak = 0;
      for (const j of sub) if (weightAt(j) > peak) peak = weightAt(j);
      if (sub.length > maxArea || (peak >= SAT_CUT && nextCut < SAT_CUT)) {
        splitByWeight(sub, nextCut);
      } else {
        const blob = blobFromMembers(sub, true);
        if (blob !== null) blobs.push(blob);
      }
    }
  }

  /**
   * Whiteness (min-channel) cut ladder for pieces the weight channel can't
   * split: across a fully clipped band the max channel is 255 everywhere,
   * but only the bloomed CORES are white — the halo between them keeps
   * min(r,g,b) low. Pieces still oversized at a near-saturated whiteness cut
   * are a genuine wall of white light (window, lamp): dropped, as maxArea
   * always intended.
   */
  function splitByWhiteness(piece: readonly number[], cut: number): void {
    if (cut >= SAT_CUT) return; // glare
    const nextCut = Math.min(SAT_CUT, Math.ceil((cut + 256) / 2));
    ladderGen++;
    const pieces: number[][] = [];
    for (const i of piece) {
      if (ladderSeen![i] === ladderGen || minChAt(i) < nextCut) continue;
      pieces.push(floodPiece(i, nextCut, minChAt));
    }
    for (const sub of pieces) {
      if (sub.length > maxArea) {
        splitByWhiteness(sub, nextCut);
      } else {
        const blob = blobFromMembers(sub, true);
        if (blob !== null) blobs.push(blob);
      }
    }
  }

  if (blobs.length > maxBlobs) {
    blobs.sort((a, b) => b.area * b.intensity - a.area * a.intensity);
    blobs.length = maxBlobs;
  }
  return blobs;
}
