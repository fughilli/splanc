/**
 * M5 — the capture seam (design doc §6 M5).
 *
 * `CaptureSource` is the interface everything downstream consumes; the Android
 * implementation is {@link WebXRCaptureSource} (webxrCapture.ts). A future iOS
 * `MediaStreamCaptureSource` satisfies the same interface — nothing downstream
 * of M5 knows which source produced a frame, because the frame already carries
 * pose + K.
 */

import type { Intrinsics, Pose } from "@ledmapper/protocol";

export interface CaptureFrame {
  /** Raw camera image for this frame (texture in the source's GL context). */
  texture: WebGLTexture;
  /** Camera pose in the session reference space. */
  pose: Pose;
  /** fx, fy, cx, cy for this frame. */
  K: Intrinsics;
  imgW: number;
  imgH: number;
  /** Phone monotonic clock at capture, ms (performance.now domain). */
  tCaptureMs: number;
}

export interface CaptureSource {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Called once per rAF/XR frame while started. */
  onFrame(cb: (f: CaptureFrame) => void): void;
}
