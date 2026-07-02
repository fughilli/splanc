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
