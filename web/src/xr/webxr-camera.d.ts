/**
 * WebXR Raw Camera Access (the `camera-access` feature) — Chrome's incubation
 * API, not yet in @types/webxr. https://immersive-web.github.io/raw-camera-access/
 */

interface XRCamera {
  readonly width: number;
  readonly height: number;
}

interface XRView {
  /** Present when the session has camera-access and this view has a camera image. */
  readonly camera?: XRCamera;
}

interface XRWebGLBinding {
  /** Opaque camera-image texture for this frame; valid until the next frame. */
  getCameraImage(camera: XRCamera): WebGLTexture;
}

/**
 * WebXR Lighting Estimation (the `light-estimation` feature) — also absent
 * from @types/webxr 0.5.x. Only the pieces we consume: the scalar ambient
 * intensity that feeds exposure telemetry (cv/exposure.ts).
 * https://immersive-web.github.io/lighting-estimation/
 */

interface XRLightProbe extends EventTarget {}

interface XRLightEstimate {
  /** RGB intensity of the estimated primary light source (relative units). */
  readonly primaryLightIntensity: DOMPointReadOnly;
  readonly primaryLightDirection: DOMPointReadOnly;
}

interface XRSession {
  /** Present when the session was granted 'light-estimation'. */
  requestLightProbe?(options?: { reflectionFormat?: string }): Promise<XRLightProbe>;
}

interface XRFrame {
  /** Null until the runtime has produced an estimate for this frame. */
  getLightEstimate?(probe: XRLightProbe): XRLightEstimate | null;
}
