/**
 * DeviceMotion → camera-frame IMU samples (WebXR-free capture path,
 * docs/vio-exploration.md phase 4).
 *
 * The client owns the DEVICE-SPECIFIC axis mapping, because only it knows the
 * device: DeviceMotion axis conventions vary across browsers/handsets (the
 * 2026-07-08 device delivers rotationRate with alpha/beta/gamma being the
 * camera-frame x/y/z rates directly, NOT the W3C reading of alpha=z, beta=x,
 * gamma=y — measured by `vio_replay --diagnose` against WebXR attitudes).
 * Samples are normalized here and sent over the wire in the CAMERA frame
 * (+X right, +Y up, -Z look), rad/s and m/s² — the server never sees device
 * quirks.
 *
 * The mapping is expressed as six signed source tokens (gyro from
 * {a,b,g} = rotationRate alpha/beta/gamma; accel from {x,y,z}) and is
 * overridable via `?imumap=` until a per-device calibration flow exists.
 */

import type { ImuSample } from "@ledmapper/protocol";

export interface ImuMapping {
  /** Camera x/y/z rate sources: signed indices into [alpha, beta, gamma]. */
  gyro: [number, number, number];
  gyroSign: [number, number, number];
  /** Camera x/y/z force sources: signed indices into [ax, ay, az]. */
  accel: [number, number, number];
  accelSign: [number, number, number];
}

/** Fitted on the 2026-07-08 device (Chrome/Android): gyro = (alpha, beta,
 * gamma) as camera x/y/z; accel = identity. */
export const DEFAULT_IMU_MAPPING: ImuMapping = {
  gyro: [0, 1, 2],
  gyroSign: [1, 1, 1],
  accel: [0, 1, 2],
  accelSign: [1, 1, 1],
};

/**
 * Parse an `?imumap=` override: `"<gyro>;<accel>"`, each a comma list of
 * signed tokens, e.g. `"+a,+b,+g;+x,+y,+z"` (the default) or the W3C-spec
 * reading `"+b,+g,+a;+x,+y,+z"`. Returns null on any malformed input.
 */
export function parseImuMapping(spec: string): ImuMapping | null {
  const [gy, ac] = spec.split(";");
  if (!gy || !ac) return null;
  const parse = (
    part: string,
    letters: Record<string, number>,
  ): { idx: [number, number, number]; sign: [number, number, number] } | null => {
    const toks = part.split(",");
    if (toks.length !== 3) return null;
    const idx: number[] = [];
    const sign: number[] = [];
    for (const tok of toks) {
      const m = /^([+-]?)([a-z])$/.exec(tok.trim());
      if (!m || !(m[2]! in letters)) return null;
      idx.push(letters[m[2]!]!);
      sign.push(m[1] === "-" ? -1 : 1);
    }
    return { idx: idx as [number, number, number], sign: sign as [number, number, number] };
  };
  const g = parse(gy, { a: 0, b: 1, g: 2 });
  const a = parse(ac, { x: 0, y: 1, z: 2 });
  if (!g || !a) return null;
  return { gyro: g.idx, gyroSign: g.sign, accel: a.idx, accelSign: a.sign };
}

const DEG = Math.PI / 180;

/** Normalize one DeviceMotion reading into a wire ImuSample (pure, tested). */
export function motionToSample(
  tMs: number,
  rotationRate: { alpha: number | null; beta: number | null; gamma: number | null },
  accelIncludingGravity: { x: number | null; y: number | null; z: number | null },
  mapping: ImuMapping = DEFAULT_IMU_MAPPING,
): ImuSample | null {
  const rr = [rotationRate.alpha, rotationRate.beta, rotationRate.gamma];
  const ac = [accelIncludingGravity.x, accelIncludingGravity.y, accelIncludingGravity.z];
  if (rr.some((v) => v === null) || ac.some((v) => v === null)) return null;
  const gyro = mapping.gyro.map((src, i) => mapping.gyroSign[i]! * (rr[src] as number) * DEG);
  const accel = mapping.accel.map((src, i) => mapping.accelSign[i]! * (ac[src] as number));
  return {
    t: tMs,
    gyro: gyro as [number, number, number],
    accel: accel as [number, number, number],
  };
}

/**
 * DeviceMotion recorder: attaches on start(), batches normalized samples, and
 * hands them to `flush()`'s consumer (~the caller's send cadence). iOS gates
 * motion access behind a permission that must be requested from a user
 * gesture — start() tries; denial simply yields no samples (the server then
 * rejects a pose-less solve with a clear error).
 */
export class ImuRecorder {
  private samples: ImuSample[] = [];
  private handler: ((e: DeviceMotionEvent) => void) | null = null;

  constructor(
    private readonly mapping: ImuMapping = DEFAULT_IMU_MAPPING,
    private readonly now: () => number = () => performance.now(),
  ) {}

  start(): void {
    if (this.handler) return;
    const h = (e: DeviceMotionEvent): void => {
      if (!e.rotationRate || !e.accelerationIncludingGravity) return;
      const s = motionToSample(
        this.now(),
        e.rotationRate,
        e.accelerationIncludingGravity,
        this.mapping,
      );
      if (s) this.samples.push(s);
    };
    this.handler = h;
    const dme = DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> };
    if (typeof dme.requestPermission === "function") {
      dme
        .requestPermission()
        .then((st) => {
          if (st === "granted" && this.handler === h) window.addEventListener("devicemotion", h);
        })
        .catch(() => undefined);
    } else {
      window.addEventListener("devicemotion", h);
    }
  }

  stop(): void {
    if (this.handler) window.removeEventListener("devicemotion", this.handler);
    this.handler = null;
    this.samples = [];
  }

  /** Drain the current batch (empty array when nothing new). */
  flush(): ImuSample[] {
    const out = this.samples;
    this.samples = [];
    return out;
  }
}
