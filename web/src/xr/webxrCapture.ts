/**
 * M5 — `WebXRCaptureSource`: the Android Chrome capture path (design doc §5).
 *
 * Owns the `immersive-ar` session + render loop and exposes each frame as a
 * {@link CaptureFrame}. Requires the `camera-access` feature (raw camera
 * texture, synced pose, intrinsics from the projection matrix). Fails loudly
 * with actionable guidance when unsupported (§13: unsupported devices are
 * rejected, not silently degraded).
 *
 * The GL context is created here and shared with the CV detector (the camera
 * texture only exists in this context). `dom-overlay` hosts the M8 UI during
 * the session.
 */

import type { Pose } from "@ledmapper/protocol";
import type { CaptureFrame, CaptureSource } from "./capture";
import { projectionMatrixToIntrinsics } from "./intrinsics";

export class XrUnsupportedError extends Error {
  constructor(message: string, readonly hints: string[]) {
    super(message);
    this.name = "XrUnsupportedError";
  }
}

const SECURE_HINTS = [
  "WebXR needs a secure context: use https:// (self-signed is fine — 'Advanced → Proceed'), " +
    "or add the origin to chrome://flags/#unsafely-treat-insecure-origin-as-secure.",
];
const CAMERA_HINTS = [
  "Raw camera access requires Chrome for Android with 'WebXR Incubations' enabled: " +
    "chrome://flags/#webxr-incubations.",
  "Google Play Services for AR (ARCore) must be installed and up to date.",
];

export class WebXRCaptureSource implements CaptureSource {
  private session: XRSession | null = null;
  private refSpace: XRReferenceSpace | null = null;
  private binding: XRWebGLBinding | null = null;
  private glLayer: XRWebGLLayer | null = null;
  private frameCb: ((f: CaptureFrame) => void) | null = null;
  private endCb: (() => void) | null = null;

  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;

  /**
   * @param overlayRoot element shown via dom-overlay during the AR session
   *   (the M8 in-session UI). Optional feature — degrades gracefully.
   */
  constructor(private readonly overlayRoot?: HTMLElement) {
    this.canvas = document.createElement("canvas");
    const gl = this.canvas.getContext("webgl2", {
      xrCompatible: true,
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new XrUnsupportedError("WebGL2 is unavailable", []);
    this.gl = gl;
  }

  onFrame(cb: (f: CaptureFrame) => void): void {
    this.frameCb = cb;
  }

  /** Fires when the XR session ends for any reason (user gesture, error). */
  onEnd(cb: () => void): void {
    this.endCb = cb;
  }

  /** The XR layer framebuffer for this frame (for feedback overlays). */
  get layerFramebuffer(): WebGLFramebuffer | null {
    return this.glLayer ? this.glLayer.framebuffer : null;
  }

  get layerSize(): { width: number; height: number } {
    return this.glLayer
      ? { width: this.glLayer.framebufferWidth, height: this.glLayer.framebufferHeight }
      : { width: 0, height: 0 };
  }

  async start(): Promise<void> {
    if (this.session) return;
    if (!window.isSecureContext) {
      throw new XrUnsupportedError("Not a secure context — WebXR is disabled here.", SECURE_HINTS);
    }
    if (!navigator.xr) {
      throw new XrUnsupportedError("navigator.xr is missing (not a WebXR browser?).", CAMERA_HINTS);
    }
    if (!(await navigator.xr.isSessionSupported("immersive-ar"))) {
      throw new XrUnsupportedError("immersive-ar sessions are not supported on this device.", CAMERA_HINTS);
    }

    let session: XRSession;
    try {
      const init: XRSessionInit = {
        requiredFeatures: ["camera-access"],
        optionalFeatures: ["local-floor", "dom-overlay"],
        ...(this.overlayRoot ? { domOverlay: { root: this.overlayRoot } } : {}),
      };
      session = await navigator.xr.requestSession("immersive-ar", init);
    } catch (e) {
      throw new XrUnsupportedError(
        `Could not start an AR session with camera-access: ${e instanceof Error ? e.message : e}`,
        CAMERA_HINTS,
      );
    }
    this.session = session;
    session.addEventListener("end", () => {
      this.session = null;
      this.refSpace = null;
      this.binding = null;
      this.glLayer = null;
      this.endCb?.();
    });

    await this.gl.makeXRCompatible();
    this.glLayer = new XRWebGLLayer(session, this.gl);
    await session.updateRenderState({ baseLayer: this.glLayer });

    // §3: 'local-floor' preferred, 'local' fallback.
    try {
      this.refSpace = await session.requestReferenceSpace("local-floor");
    } catch {
      this.refSpace = await session.requestReferenceSpace("local");
    }

    this.binding = new XRWebGLBinding(session, this.gl);
    session.requestAnimationFrame(this.xrFrame);
  }

  async stop(): Promise<void> {
    const s = this.session;
    this.session = null;
    if (s) {
      try {
        await s.end();
      } catch {
        // already ended
      }
    }
  }

  private xrFrame = (_t: DOMHighResTimeStamp, frame: XRFrame): void => {
    const session = this.session;
    if (!session || !this.refSpace || !this.binding) return;
    session.requestAnimationFrame(this.xrFrame);

    const viewerPose = frame.getViewerPose(this.refSpace);
    if (!viewerPose) return;

    for (const view of viewerPose.views) {
      const camera = view.camera;
      if (!camera) continue;
      const texture = this.binding.getCameraImage(camera);
      if (!texture) continue;

      const { position: p, orientation: q } = view.transform;
      const pose: Pose = {
        p: [p.x, p.y, p.z],
        q: [q.x, q.y, q.z, q.w],
      };
      const K = projectionMatrixToIntrinsics(view.projectionMatrix, camera.width, camera.height);
      // Capture timestamp: the rAF callback time is the closest monotonic
      // stamp we can get to the camera frame; constant camera→display latency
      // is absorbed by the decoder's sync-delimiter alignment (§8.1).
      const f: CaptureFrame = {
        texture,
        pose,
        K,
        imgW: camera.width,
        imgH: camera.height,
        tCaptureMs: performance.now(),
      };
      this.frameCb?.(f);
      break; // one view on handheld AR
    }
  };
}
