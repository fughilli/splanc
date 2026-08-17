/**
 * CaptureSource backed by the native iOS AVCaptureSession (design doc §4.7).
 *
 * iOS cannot control camera exposure through getUserMedia — WebKit implements none
 * of the Image-Capture exposure extensions, and its camera lives in the WebKit GPU
 * process where our AVCaptureDevice writes never reach it (§4.6). So on iOS the
 * mapping path takes the camera itself, via `@splanc/camera-bridge`.
 *
 * Whole frames never cross the bridge. The plugin runs the detector's own
 * threshold/downsample pass natively and ships only the NON-ZERO pixels of the
 * result — a thresholded image of a dark room with LEDs in it is almost entirely
 * zero, so this is a few KB per frame rather than the ~921 KB a dense 640×360 RGBA
 * readback would cost. This module rebuilds the dense buffer JS-side and hands it
 * to the existing detector via {@link ReducedFrame}, so `connectedComponents` and
 * everything downstream run completely unchanged.
 *
 * The preview the user aims with is a native AVCaptureVideoPreviewLayer behind the
 * WebView, NOT a <video> element — so there's no `video` property here, and the
 * capture screen must keep the page transparent while this source is running.
 */

import type { Intrinsics } from "@ledmapper/protocol";
import type { CaptureFrame, CaptureSource } from "./capture";
import type { ReducedFrame } from "../cv/detect";
import { isIosNative, registerNativePlugin } from "../net/native";
import { heuristicK } from "./mediaStreamCapture";

interface FrameEvent {
  w: number;
  h: number;
  imgW: number;
  imgH: number;
  /** base64 little-endian Uint32 indices of lit pixels. */
  idx: string;
  /** base64 RGBA bytes for those pixels, same order. */
  px: string;
  lit: number;
  truncated: boolean;
  measureW: number;
  measureH: number;
  measure: string;
  tCaptureMs: number;
}

interface CameraBridgePlugin {
  start(): Promise<{ width: number; height: number }>;
  stop(): Promise<void>;
  setDetectParams(opts: { threshold?: number; downscale?: number }): Promise<void>;
  setExposure(opts: { target: number; maxExposureMs?: number }): Promise<{
    applied: boolean;
    description: string;
  }>;
  addListener(
    event: "cameraFrame",
    cb: (e: FrameEvent) => void,
  ): Promise<{ remove(): Promise<void> }>;
}

let bridge: CameraBridgePlugin | null = null;
function cameraBridge(): CameraBridgePlugin {
  if (!bridge) bridge = registerNativePlugin<CameraBridgePlugin>("CameraBridge");
  return bridge;
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class NativeCaptureSource implements CaptureSource {
  private frameCb: ((f: CaptureFrame) => void) | null = null;
  private listener: { remove(): Promise<void> } | null = null;
  private running = false;
  // Reused across frames: reallocating a 640×360 RGBA buffer 30×/s would churn
  // the GC through the whole capture run.
  private dense = new Uint8Array(0);
  private lastLit = 0;
  private endCb: (() => void) | null = null;
  // Latest scene-stats buffer; see onNativeFrame for why it persists across frames.
  private measure: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private measureW = 0;
  private measureH = 0;
  /** What the last setExposure did, for the HUD (mirrors MediaStreamCaptureSource). */
  exposureApplied: string | null = null;

  constructor(
    private readonly opts: {
      kSeed?: { k: Intrinsics; imgW: number; imgH: number } | null | undefined;
      fxOverride?: number | undefined;
    } = {},
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    const b = cameraBridge();
    this.listener = await b.addListener("cameraFrame", (e) => this.onNativeFrame(e));
    await b.start();
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.listener?.remove();
    this.listener = null;
    // Hand the camera back — nothing else (getUserMedia included) can open it
    // while this session holds it.
    await cameraBridge().stop();
    this.endCb?.();
  }

  onFrame(cb: (f: CaptureFrame) => void): void {
    this.frameCb = cb;
  }

  onEnd(cb: () => void): void {
    this.endCb = cb;
  }

  /** Lock exposure to `target01` (0 = shortest) with an optional ceiling, on the
   * session this app owns — the whole reason this path exists. Best effort: the
   * outcome lands in exposureApplied and it never throws. */
  async setExposure(target01: number, maxExposureMs?: number): Promise<void> {
    try {
      const r = await cameraBridge().setExposure(
        maxExposureMs === undefined ? { target: target01 } : { target: target01, maxExposureMs },
      );
      this.exposureApplied = r.applied ? `native: ${r.description}` : `unapplied: ${r.description}`;
    } catch (e) {
      this.exposureApplied = `failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** Push the detector's live threshold down to the native reduction. The threshold
   * servo retunes it as blob counts move, and the native pass must use the same
   * value or the servo is reacting to counts it isn't actually controlling. */
  setDetectParams(p: { threshold?: number; downscale?: number }): void {
    if (!this.running) return;
    void cameraBridge().setDetectParams(p);
  }

  /** Lit-pixel count of the last frame (diagnostics / HUD). */
  get lastLitPixels(): number {
    return this.lastLit;
  }

  private onNativeFrame(e: FrameEvent): void {
    if (!this.running || !this.frameCb) return;

    // Rebuild the dense RGBA buffer the detector's CCL expects by scattering the
    // lit pixels back into a zeroed frame.
    const need = e.w * e.h * 4;
    if (this.dense.length !== need) this.dense = new Uint8Array(need);
    else this.dense.fill(0);
    const idxBytes = b64ToBytes(e.idx);
    const px = b64ToBytes(e.px);
    const idx = new Uint32Array(idxBytes.buffer, idxBytes.byteOffset, idxBytes.length >> 2);
    for (let i = 0; i < idx.length; i++) {
      const o = idx[i]! * 4;
      const s = i * 4;
      this.dense[o] = px[s]!;
      this.dense[o + 1] = px[s + 1]!;
      this.dense[o + 2] = px[s + 2]!;
      this.dense[o + 3] = px[s + 3]!;
    }
    this.lastLit = e.lit;

    // The native side computes scene stats only every 6th frame (they move at AE
    // speed, and it's a second full scan of the source). Carry the last one
    // forward so every frame still presents a complete ReducedFrame.
    if (e.measureW > 0 && e.measure.length > 0) {
      this.measure = b64ToBytes(e.measure);
      this.measureW = e.measureW;
      this.measureH = e.measureH;
    }

    const reduced: ReducedFrame = {
      detect: this.dense,
      w: e.w,
      h: e.h,
      truncated: e.truncated,
      measure: this.measure,
      measureW: this.measureW,
      measureH: this.measureH,
    };

    this.frameCb({
      texture: null,
      reduced,
      pose: null,
      K: this.intrinsics(e.imgW, e.imgH),
      imgW: e.imgW,
      imgH: e.imgH,
      tCaptureMs: e.tCaptureMs,
    });
  }

  private intrinsics(w: number, h: number): Intrinsics {
    if (this.opts.fxOverride) {
      return [this.opts.fxOverride, this.opts.fxOverride, w / 2, h / 2];
    }
    const seed = this.opts.kSeed;
    if (seed && seed.imgW > 0 && seed.imgH > 0) {
      const sx = w / seed.imgW;
      const sy = h / seed.imgH;
      return [seed.k[0] * sx, seed.k[1] * sy, seed.k[2] * sx, seed.k[3] * sy];
    }
    return heuristicK(w, h);
  }
}

/** The native source on iOS, or null everywhere else (caller keeps getUserMedia). */
export function nativeCaptureAvailable(): boolean {
  return isIosNative();
}
