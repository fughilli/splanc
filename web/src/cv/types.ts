/** M6 — shared CV types. */

import type { Intrinsics, Pose } from "@ledmapper/protocol";

/** A bright-blob detection in one camera frame. Full-res px, origin top-left. */
export interface Blob {
  u: number;
  v: number;
  /** Mean thresholded luminance over the blob, [0, 1]. */
  intensity: number;
  /** Blob pixel count (at detection resolution, scaled to full-res px²). */
  area: number;
  /** Bounding box in full-res px (when the detector provides it). */
  w?: number;
  h?: number;
  /** Mean blob color, [0, 1] (when the detector provides it) — the hue-coded
   * fixture probe reads bit values from chroma, not brightness. */
  r?: number;
  g?: number;
  b?: number;
}

/** Per-frame capture metadata a detection record needs (§7.4). */
export interface FrameMeta {
  tCaptureMs: number;
  pose: Pose;
  K: Intrinsics;
  imgW: number;
  imgH: number;
}
