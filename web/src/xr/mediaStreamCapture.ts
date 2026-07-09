/**
 * MediaStreamCaptureSource — the WebXR-FREE capture path (M5 alternative;
 * docs/vio-exploration.md phase 4).
 *
 * getUserMedia rear camera + requestVideoFrameCallback, uploading each video
 * frame into a WebGL2 texture for the same GPU detect pass the XR path uses.
 * Works in ANY browser — no `#webxr-incubations` flag, no ARCore — which is
 * the point: ARCore's tracker is degenerate in our operating conditions, so
 * frames carry `pose: null` and the server's visual-inertial solver estimates
 * the trajectory jointly from the decoded observations + the DeviceMotion
 * stream (xr/imu.ts).
 *
 * Intrinsics: there is no projectionMatrix here. The K seed comes from (in
 * priority order) an explicit override, a cached calibration (e.g. the K a
 * previous WebXR session reported for this device), or a typical-FOV
 * heuristic (fx ≈ 0.72 · long side ≈ 70° horizontal). Focal error moves the
 * map's METRIC SCALE ~1:1 and barely affects shape — see the vio_test
 * observability probe — so an uncalibrated first run is usable, just not
 * scale-exact.
 *
 * NOTE video row order: texImage2D(video) puts the image TOP row at texture
 * v=0, the opposite of the XR camera texture — the detector must run with
 * flipV = false on this path.
 */

import type { Intrinsics } from "@ledmapper/protocol";
import type { CaptureFrame, CaptureSource } from "./capture";
import { XrUnsupportedError } from "./webxrCapture";

const IDENTITY4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Typical phone rear camera: ~70° horizontal FOV on the long side. */
export function heuristicK(w: number, h: number): Intrinsics {
  const f = 0.72 * Math.max(w, h);
  return [f, f, w / 2, h / 2];
}

export interface MediaStreamCaptureOptions {
  /** Intrinsics for the delivered video size; scaled if dimensions differ. */
  kSeed?: { k: Intrinsics; imgW: number; imgH: number } | undefined;
  /** Force fx (=fy) in pixels at the DELIVERED size; principal point stays
   * centered. Wins over kSeed. */
  fxOverride?: number | undefined;
  video?: MediaTrackConstraints | undefined;
}

export class MediaStreamCaptureSource implements CaptureSource {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  /** The live camera preview element — the caller composites UI over it. */
  readonly video: HTMLVideoElement;
  /** Interface parity with WebXRCaptureSource: no XR layer here. */
  readonly layerFramebuffer: WebGLFramebuffer | null = null;
  readonly layerSize = { width: 0, height: 0 };

  private stream: MediaStream | null = null;
  private texture: WebGLTexture | null = null;
  private frameCb: ((f: CaptureFrame) => void) | null = null;
  private endCb: (() => void) | null = null;
  private running = false;
  private rvfcHandle = 0;
  private rafHandle = 0;

  constructor(private readonly opts: MediaStreamCaptureOptions = {}) {
    this.canvas = document.createElement("canvas");
    const gl = this.canvas.getContext("webgl2", { antialias: false });
    if (!gl) throw new XrUnsupportedError("WebGL2 is unavailable", []);
    this.gl = gl;
    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.video.muted = true;
  }

  onFrame(cb: (f: CaptureFrame) => void): void {
    this.frameCb = cb;
  }

  onEnd(cb: () => void): void {
    this.endCb = cb;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new XrUnsupportedError("getUserMedia is unavailable (secure context needed).", []);
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: this.opts.video ?? {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
    } catch (e) {
      throw new XrUnsupportedError(
        `Camera access failed: ${e instanceof Error ? e.message : e}`,
        ["Grant the camera permission and reload."],
      );
    }
    this.video.srcObject = this.stream;
    await this.video.play();
    this.texture = this.gl.createTexture();
    this.running = true;
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.rvfcHandle && "cancelVideoFrameCallback" in this.video) {
      (this.video as HTMLVideoElement & { cancelVideoFrameCallback(h: number): void })
        .cancelVideoFrameCallback(this.rvfcHandle);
    }
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.video.pause();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.endCb?.();
  }

  private scheduleNext(): void {
    if (!this.running) return;
    if ("requestVideoFrameCallback" in this.video) {
      this.rvfcHandle = (
        this.video as HTMLVideoElement & {
          requestVideoFrameCallback(cb: () => void): number;
        }
      ).requestVideoFrameCallback(() => this.emitFrame());
    } else {
      this.rafHandle = requestAnimationFrame(() => this.emitFrame());
    }
  }

  private emitFrame(): void {
    if (!this.running || !this.texture) return;
    const gl = this.gl;
    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    if (w === 0 || h === 0) {
      this.scheduleNext();
      return;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);

    const seed = this.opts.kSeed;
    let k: Intrinsics;
    if (this.opts.fxOverride) {
      k = [this.opts.fxOverride, this.opts.fxOverride, w / 2, h / 2];
    } else if (seed && seed.imgW > 0 && seed.imgH > 0) {
      // Scale a calibration captured at another resolution of the same sensor.
      const sx = w / seed.imgW;
      const sy = h / seed.imgH;
      k = [seed.k[0] * sx, seed.k[1] * sy, seed.k[2] * sx, seed.k[3] * sy];
    } else {
      k = heuristicK(w, h);
    }

    this.frameCb?.({
      texture: this.texture,
      pose: null,
      K: k,
      imgW: w,
      imgH: h,
      tCaptureMs: performance.now(),
      viewMatrix: IDENTITY4,
      projMatrix: IDENTITY4,
      viewport: { x: 0, y: 0, width: w, height: h },
    });
    this.scheduleNext();
  }
}
