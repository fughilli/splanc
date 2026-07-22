/**
 * MediaStreamCaptureSource — THE capture path (M5; docs/vio-exploration.md
 * phase 4, sole path since the M6 WebXR removal).
 *
 * getUserMedia rear camera + requestVideoFrameCallback, uploading each video
 * frame into a WebGL2 texture for the GPU detect pass. Works in ANY browser
 * — no `#webxr-incubations` flag, no ARCore (whose tracker was degenerate in
 * our operating conditions anyway). Frames carry `pose: null`; the
 * visual-inertial solver estimates the trajectory jointly from the decoded
 * observations + the DeviceMotion stream (xr/imu.ts).
 *
 * Intrinsics: there is no projectionMatrix here. The K seed comes from (in
 * priority order) an explicit override, a cached calibration, or a
 * typical-FOV heuristic (fx ≈ 0.72 · long side ≈ 70° horizontal). Focal
 * error moves the map's METRIC SCALE ~1:1 and barely affects shape — see
 * the vio_test observability probe — so an uncalibrated first run is
 * usable, just not scale-exact.
 *
 * NOTE video row order: texImage2D(video) puts the image TOP row at texture
 * v=0 — the detector must run with flipV = false on this path.
 */

import type { Intrinsics } from "@ledmapper/protocol";
import type { CaptureFrame, CaptureSource } from "./capture";
import { CaptureUnsupportedError } from "./capture";
import { type ExposureCapabilities, planExposure } from "./exposureControl";

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
  /** Lock the camera exposure to this point in [0,1] (0 = minimum exposure —
   * darkest, least LED bloom; see exposureControl.ts). Unset = leave auto. */
  exposure?: number | undefined;
  /** Hard cap on the manual exposure duration, ms (Nyquist — bitPeriodMs/2, so
   * the exposure can't integrate across a pattern-frame hue transition). */
  maxExposureMs?: number | undefined;
}

export class MediaStreamCaptureSource implements CaptureSource {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  /** The live camera preview element — the caller composites UI over it. */
  readonly video: HTMLVideoElement;

  private stream: MediaStream | null = null;
  private texture: WebGLTexture | null = null;
  private frameCb: ((f: CaptureFrame) => void) | null = null;
  private endCb: (() => void) | null = null;
  private running = false;
  private rvfcHandle = 0;
  private rafHandle = 0;
  /** What planExposure() applied (or why it didn't), for the HUD/log. */
  exposureApplied: string | null = null;

  constructor(private readonly opts: MediaStreamCaptureOptions = {}) {
    this.canvas = document.createElement("canvas");
    const gl = this.canvas.getContext("webgl2", { antialias: false });
    if (!gl) throw new CaptureUnsupportedError("WebGL2 is unavailable", []);
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
      throw new CaptureUnsupportedError("getUserMedia is unavailable (secure context needed).", []);
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
      throw new CaptureUnsupportedError(
        `Camera access failed: ${e instanceof Error ? e.message : e}`,
        ["Grant the camera permission and reload."],
      );
    }
    this.video.srcObject = this.stream;
    await this.video.play();
    await this.applyExposure();
    this.texture = this.gl.createTexture();
    this.running = true;
    this.scheduleNext();
  }

  /** Lock the camera exposure per opts.exposure (no-op when unset). Best
   * effort: records what happened in exposureApplied and never throws. */
  private async applyExposure(): Promise<void> {
    if (this.opts.exposure === undefined) return;
    await this.setExposure(this.opts.exposure, this.opts.maxExposureMs);
  }

  /** Re-lock the camera exposure to `target01` (0 = shortest, 1 = longest).
   * `maxExposureMs` (Nyquist cap = bitPeriodMs/2) bounds the longest exposure.
   * Public so the exposure servo can retune it live. Best effort: records the
   * outcome in exposureApplied and never throws. */
  async setExposure(target01: number, maxExposureMs?: number): Promise<void> {
    const track = this.stream?.getVideoTracks()[0];
    const getCaps = track?.getCapabilities?.bind(track);
    if (!track || !getCaps) {
      this.exposureApplied = "unsupported (no track capabilities)";
      return;
    }
    try {
      const plan = planExposure(getCaps() as ExposureCapabilities, target01, maxExposureMs);
      if (!plan) {
        this.exposureApplied = "unsupported by this camera";
        return;
      }
      await track.applyConstraints(plan.constraints);
      this.exposureApplied = plan.description;
    } catch (e) {
      this.exposureApplied = `failed: ${e instanceof Error ? e.message : e}`;
      console.warn("[exposure] applyConstraints failed:", e);
    }
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
    });
    this.scheduleNext();
  }
}
