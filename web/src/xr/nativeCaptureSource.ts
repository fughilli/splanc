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

import type { ImuSample, Intrinsics } from "@ledmapper/protocol";
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
  /** CoreMotion samples since the previous frame, already in the camera frame.
   * `ua`/`g` are the raw CoreMotion components the `accel` above was derived
   * from, carried so a sign convention can be re-tested from a session log. */
  imu: {
    t: number;
    gyro: [number, number, number];
    accel: [number, number, number];
    ua?: [number, number, number];
    g?: [number, number, number];
  }[];
}

interface CameraBridgePlugin {
  start(): Promise<{ width: number; height: number }>;
  stop(): Promise<void>;
  setDetectParams(opts: { threshold?: number; downscale?: number }): Promise<void>;
  log(opts: { message: string }): Promise<void>;
  saveSessionLog(opts: { name: string; json: string }): Promise<{ path: string; bytes: number }>;
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


/**
 * Maps a native capture timestamp into the performance.now() clock the rest of
 * the app works in.
 *
 * These are different epochs: CMTime presentation timestamps are seconds since
 * BOOT, while performance.now() is milliseconds since the PAGE's time origin —
 * and IMU samples (xr/imu.ts) are stamped with the latter. Left unmapped, the
 * solver's IMU trim (solver/src/pipeline.rs retains only samples inside the frame
 * span) discards every IMU sample and the solve dies with "too few IMU samples
 * for a VIO solve".
 *
 * The offset is the MINIMUM of (arrival − capture) over the first frames: every
 * observation is inflated by however long that frame took to reach JS, so the
 * smallest one is the closest estimate of the true epoch difference. Taking the
 * minimum rather than the first sample keeps one slow frame from biasing the
 * whole run.
 *
 * Monotonic-safe: the offset only ever shrinks, by at most the delivery jitter (a
 * few ms), while capture times advance ~33 ms per frame — so mapped timestamps
 * still increase. Deliberately epoch-agnostic: it corrects ANY constant offset
 * between the clocks, so it holds even if the native epoch is not boot-relative.
 */
export class ClockOffset {
  private offsetMs = Number.POSITIVE_INFINITY;
  private samples = 0;

  constructor(private readonly settleFrames = 30) {}

  /** Refine the estimate from a frame observation, and map that frame's time. */
  map(captureMs: number, arrivalMs: number): number {
    if (this.samples < this.settleFrames) {
      this.offsetMs = Math.min(this.offsetMs, arrivalMs - captureMs);
      this.samples++;
    }
    return this.apply(captureMs);
  }

  /** Map a timestamp WITHOUT letting it refine the estimate. For IMU samples:
   * they share the frames' clock, but they're captured before the frame that
   * carries them, so their apparent latency is not a latency — and letting them
   * vote would also burn the settle window ~3x faster than intended. */
  apply(captureMs: number): number {
    return captureMs + this.offsetMs;
  }
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
  private clock = new ClockOffset();
  // CoreMotion samples awaiting the capture screen's batch tick.
  private imuPending: ImuSample[] = [];
  /** Raw CoreMotion components, kept only for the session log (see FrameEvent). */
  private imuRawLog: { t: number; ua: number[]; g: number[] }[] = [];
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
    // Re-estimate per session: the offset is only valid for one run of the clock.
    this.clock = new ClockOffset();
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

  /**
   * Drain the IMU samples collected since the last call — same shape as
   * ImuRecorder.flush(), so the capture screen's batch tick works unchanged.
   *
   * These come from CoreMotion rather than WebKit's DeviceMotion, so no axis
   * guessing is involved: for the rear camera in portrait the CoreMotion device
   * frame and the wire's camera frame coincide (see the plugin's startImu), and
   * the samples are already in m/s^2 and rad/s.
   */
  flush(): ImuSample[] {
    const out = this.imuPending;
    this.imuPending = [];
    return out;
  }

  /** Raw CoreMotion components for the whole session, for offline convention
   * checks. Empty off-iOS. */
  rawImuLog(): { t: number; ua: number[]; g: number[] }[] {
    return this.imuRawLog;
  }

  /** Lit-pixel count of the last frame (diagnostics / HUD). */
  get lastLitPixels(): number {
    return this.lastLit;
  }

  private onNativeFrame(e: FrameEvent): void {
    if (!this.running || !this.frameCb) return;
    const arrivalMs = performance.now();

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

    // Map the frame FIRST so the IMU below applies an up-to-date offset. Both
    // clocks are boot-relative, so they take the SAME offset — mapping them
    // differently would shear camera and IMU apart, which is precisely what the
    // solver's IMU trim punishes.
    const tCaptureMs = this.clock.map(e.tCaptureMs, arrivalMs);
    for (const s of e.imu ?? []) {
      const t = this.clock.apply(s.t);
      this.imuPending.push({ t, gyro: s.gyro, accel: s.accel });
      if (s.ua && s.g && this.imuRawLog.length < 200000) {
        this.imuRawLog.push({ t, ua: s.ua, g: s.g });
      }
    }

    this.frameCb({
      texture: null,
      reduced,
      pose: null,
      K: this.intrinsics(e.imgW, e.imgH),
      imgW: e.imgW,
      imgH: e.imgH,
      tCaptureMs,
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

/**
 * Write a diagnostic line to the iOS device console.
 *
 * Release builds compile Capacitor's logging out, so `console.*` from here never
 * reaches `tools/iosctl log` — and enabling its production logging instead would
 * dump every bridge call, including a frame event 30x/s carrying kilobytes of
 * base64, which would distort the timings it exists to reveal. A no-op off-iOS,
 * so callers can log unconditionally alongside their normal console call.
 */
export function nativeLog(message: string): void {
  if (!isIosNative()) return;
  void cameraBridge().log({ message });
}

/**
 * Persist a capture's solver input into the app container for offline replay.
 *
 * Pull it with:
 *   xcrun devicectl device copy from --device <udid> \
 *     --domain-type appDataContainer --domain-identifier dev.splanc.app \
 *     --source Documents/<name> --destination .
 * then replay natively with `bazel run //solver:solver_cli < <name>`.
 *
 * A no-op off-iOS. Resolves to the on-device path, or null if it couldn't write.
 */
export async function saveSessionLog(name: string, json: string): Promise<string | null> {
  if (!isIosNative()) return null;
  try {
    const r = await cameraBridge().saveSessionLog({ name, json });
    return r.path;
  } catch {
    return null;
  }
}

/** The native source on iOS, or null everywhere else (caller keeps getUserMedia). */
export function nativeCaptureAvailable(): boolean {
  return isIosNative();
}
