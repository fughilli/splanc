/**
 * M5 — the capture seam (design doc §6 M5).
 *
 * `CaptureSource` is the interface everything downstream consumes; the
 * implementation is {@link MediaStreamCaptureSource} (mediaStreamCapture.ts):
 * getUserMedia + DeviceMotion, poses solved jointly by the visual-inertial
 * solver. (The former WebXR path was removed — M6: ARCore's tracker is
 * degenerate in our operating conditions and the incubations flag made it
 * effectively demo-only. Nothing downstream knows which source produced a
 * frame, so a future calibrated/native source slots back in here.)
 */

import type { Intrinsics, Pose } from "@ledmapper/protocol";

/** Capture setup failed in a way the user can act on (permissions, secure
 * context, missing APIs). `hints` are remediation lines for the error UI. */
export class CaptureUnsupportedError extends Error {
  constructor(
    message: string,
    readonly hints: string[],
  ) {
    super(message);
    this.name = "CaptureUnsupportedError";
  }
}

export interface CaptureFrame {
  /** Raw camera image for this frame (texture in the source's GL context). */
  texture: WebGLTexture;
  /** Camera pose in the session reference space — null when the source has
   * no tracker (MediaStreamCaptureSource), in which case the visual-inertial
   * solver estimates the trajectory jointly. */
  pose: Pose | null;
  /** fx, fy, cx, cy for this frame. */
  K: Intrinsics;
  imgW: number;
  imgH: number;
  /** Phone monotonic clock at capture, ms (performance.now domain). */
  tCaptureMs: number;
  /**
   * Ambient light estimate (relative units) when the source has one; feeds
   * exposure telemetry. Unset on the getUserMedia path.
   */
  ambientIntensity?: number | undefined;
}

export interface CaptureSource {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Called once per delivered camera frame while started. */
  onFrame(cb: (f: CaptureFrame) => void): void;
}
