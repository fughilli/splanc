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
  /** Camera pose in the session reference space — null on the WebXR-free
   * path (MediaStreamCaptureSource), where the server's visual-inertial
   * solver estimates the trajectory jointly. */
  pose: Pose | null;
  /** fx, fy, cx, cy for this frame. */
  K: Intrinsics;
  imgW: number;
  imgH: number;
  /** Phone monotonic clock at capture, ms (performance.now domain). */
  tCaptureMs: number;
  /**
   * World→view matrix (column-major, inverse of the view pose). With
   * `projMatrix` this is what 3D-composites overlays exactly onto the
   * passthrough: anything rendered with projMatrix·viewMatrix lands on the
   * same pixels the real scene point occupies.
   */
  viewMatrix: Float32Array;
  /** View→clip projection matrix for this frame (column-major). */
  projMatrix: Float32Array;
  /** Region of the layer framebuffer this view renders into. */
  viewport: { x: number; y: number; width: number; height: number };
  /**
   * WebXR light-estimation ambient intensity (max RGB component of the
   * primary light, relative units), when the session granted the feature and
   * the runtime has an estimate this frame. Feeds exposure telemetry — the
   * closest thing the web platform has to reading the camera's 3A state.
   */
  ambientIntensity?: number | undefined;
}

export interface CaptureSource {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Called once per rAF/XR frame while started. */
  onFrame(cb: (f: CaptureFrame) => void): void;
}
