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
  /** Raw camera image for this frame (texture in the source's GL context).
   * Null when the source pre-reduced the frame itself (see `reduced`). */
  texture: WebGLTexture | null;
  /** Set by a source that ran the detector's threshold/downsample pass itself —
   * the native iOS path, where frames never enter a WebGL context at all
   * (design doc §4.7). The detector reads this instead of running its GPU pass;
   * use `DetectorGL.detectFrame`/`measureFrame` so either form works. */
  reduced?: import("../cv/detect").ReducedFrame | undefined;
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
