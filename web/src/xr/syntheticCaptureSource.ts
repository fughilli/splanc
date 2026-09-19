/**
 * Synthetic capture source for the phone-in-the-loop HITL harness (and tests).
 *
 * A hardware-free `CaptureSource`: it renders a KNOWN fixture's LEDs — projected
 * through a pinhole camera walking an arc for parallax, coloured with the SAME
 * hue-code the firmware drives (`code/gray.ts`) at the SAME frame timing
 * (`code/timing.ts`) — into a pre-reduced RGBA frame the real detector CCLs and
 * the real decoder recovers indices from. This reuses the virtual-image → decoder
 * infrastructure the synthetic pipeline test is built on (pipeline_synthetic.test.ts:
 * project + colorForFrame + CvPipeline), so the whole mapping journey (detect →
 * track → decode → solve → upload) runs with no camera and no real scene.
 *
 * Loaded only behind the `?driver=` guard (see ui/screens/capture.ts), so it never
 * enters the production bundle.
 */

import type { CodeParams, ImuSample, Intrinsics, Pose, Vec3 } from "@ledmapper/protocol";
import { colorForFrame } from "../code/gray";
import { frameIndexAt } from "../code/timing";
import { type Mat3, lookAtQuat, project, quatToRotMat } from "../geom/pinhole";
import type { CaptureFrame, CaptureSource } from "./capture";

// --- minimal SO(3) / matrix helpers for synthesizing IMU from the pose track ---
// (mirrors solver/src/{so3,linalg}.rs, only the ops synth_imu needs). Mat3 is the
// row-major camera-to-world rotation `quatToRotMat` returns.
const GRAVITY = 9.81; // m/s²; G_WORLD = [0, -GRAVITY, 0] (solver/src/vio.rs).

function transpose3(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}
function matMul3(a: Mat3, b: Mat3): Mat3 {
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = a;
  const [b0, b1, b2, b3, b4, b5, b6, b7, b8] = b;
  return [
    a0 * b0 + a1 * b3 + a2 * b6, a0 * b1 + a1 * b4 + a2 * b7, a0 * b2 + a1 * b5 + a2 * b8,
    a3 * b0 + a4 * b3 + a5 * b6, a3 * b1 + a4 * b4 + a5 * b7, a3 * b2 + a4 * b5 + a5 * b8,
    a6 * b0 + a7 * b3 + a8 * b6, a6 * b1 + a7 * b4 + a8 * b7, a6 * b2 + a7 * b5 + a8 * b8,
  ];
}
/** R^T · v (world → body when R is camera-to-world). */
function matTvec(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
}
/** SO(3) log map → rotation vector (axis·angle). Ported from solver/src/so3.rs;
 * the near-π branch is omitted — the finite-difference steps here are ~1e-4 rad. */
function so3Log(r: Mat3): Vec3 {
  const tr = r[0] + r[4] + r[8];
  const theta = Math.acos(Math.min(1, Math.max(-1, (tr - 1) / 2)));
  const w: Vec3 = [r[7] - r[5], r[2] - r[6], r[3] - r[1]];
  const s = theta < 1e-9 ? 0.5 : theta / (2 * Math.sin(theta));
  return [w[0] * s, w[1] * s, w[2] * s];
}

export interface SyntheticSceneOpts {
  /** Fixture LED world positions (metres). Defaults to a planar grid of `ledCount`. */
  leds?: Vec3[];
  ledCount?: number;
  imgW?: number;
  imgH?: number;
  /** [fx, fy, cx, cy]. Defaults to a plausible phone intrinsic for imgW×imgH. */
  K?: Intrinsics;
  /** Reduced-buffer downscale vs the full image (detector reads r.w to recover it). */
  downscale?: number;
  fps?: number;
  /** LED blob radius in reduced-buffer pixels. */
  discRadius?: number;
  /** Seconds for the camera to sweep the arc's nominal span (parallax baseline). */
  durationSec?: number;
  /** Orbit radius (m) about the fixture centroid — the VIO parallax lever. */
  radius?: number;
}

/** A planar grid fixture centred on the origin in the z=0 plane (0.1 m pitch). */
function gridLeds(n: number): Vec3[] {
  const cols = Math.ceil(Math.sqrt(n));
  const out: Vec3[] = [];
  for (let id = 0; id < n; id++) {
    const r = Math.floor(id / cols);
    const c = id % cols;
    out.push([(c - (cols - 1) / 2) * 0.1, ((cols - 1) / 2 - r) * 0.1, 0]);
  }
  return out;
}

export class SyntheticCaptureSource implements CaptureSource {
  private readonly leds: Vec3[];
  private readonly imgW: number;
  private readonly imgH: number;
  private readonly K: Intrinsics;
  private readonly ds: number;
  private readonly dw: number;
  private readonly dh: number;
  private readonly fps: number;
  private readonly discR: number;
  private readonly durationSec: number;
  private readonly radius: number;
  private readonly centroid: Vec3;

  private cb: ((f: CaptureFrame) => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  // Synthetic IMU (visual-inertial): a 60 Hz stream consistent with the same pose
  // trajectory the frames are projected from, so the VIO solver can recover scale.
  private imuBuf: ImuSample[] = [];
  private imuTimer: ReturnType<typeof setInterval> | null = null;
  private t0Ms = 0;
  private code: { params: CodeParams; epoch: number; toServer: (t: number) => number } | null =
    null;

  constructor(opts: SyntheticSceneOpts = {}) {
    this.leds = opts.leds ?? gridLeds(opts.ledCount ?? 30);
    this.imgW = opts.imgW ?? 1280;
    this.imgH = opts.imgH ?? 720;
    this.K = opts.K ?? [900, 900, this.imgW / 2, this.imgH / 2];
    this.ds = opts.downscale ?? 4;
    this.dw = Math.floor(this.imgW / this.ds);
    this.dh = Math.floor(this.imgH / this.ds);
    this.fps = opts.fps ?? 30;
    this.discR = opts.discRadius ?? 2;
    this.durationSec = opts.durationSec ?? 8;
    this.radius = opts.radius ?? 1.8;
    const n = this.leds.length || 1;
    const sum: Vec3 = [0, 0, 0];
    for (const l of this.leds) {
      sum[0] += l[0];
      sum[1] += l[1];
      sum[2] += l[2];
    }
    this.centroid = [sum[0] / n, sum[1] / n, sum[2] / n];
  }

  /** Supply the negotiated code-book so the render matches what the decoder expects.
   * Called after `startMapping` resolves (before then, frames render dark). */
  setCode(params: CodeParams, epoch: number, toServer: (t: number) => number): void {
    this.code = { params, epoch, toServer };
  }

  /** No-op: the synthetic source has no real exposure to steer. */
  setExposure(_t: number, _capMs?: number): void {}

  /** The synthetic scene never ends on its own (no camera track to drop); it stops
   * only when the harness ends the capture. Kept for parity with the real sources. */
  onEnd(_cb: () => void): void {}

  onFrame(cb: (f: CaptureFrame) => void): void {
    this.cb = cb;
  }

  async start(): Promise<void> {
    this.t0Ms = performance.now();
    this.timer = setInterval(() => {
      const f = this.render(performance.now() - this.t0Ms);
      if (this.cb) this.cb(f);
    }, 1000 / this.fps);
    // Emit IMU at ~60 Hz from the SAME pose track (stamped in the frames' clock,
    // performance.now, so the solver aligns inertial + visual by timestamp).
    this.imuTimer = setInterval(() => {
      const nowMs = performance.now();
      this.imuBuf.push(this.imuSampleAt((nowMs - this.t0Ms) / 1000, nowMs));
    }, 1000 / 60);
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.imuTimer !== null) {
      clearInterval(this.imuTimer);
      this.imuTimer = null;
    }
  }

  /** Drain buffered IMU (the `imuFlusher` interface the capture screen batches). */
  flush(): ImuSample[] {
    const out = this.imuBuf;
    this.imuBuf = [];
    return out;
  }

  /** Camera pose at `tSec`: a handheld-style orbit about the fixture centroid,
   * always looking at it — a wide translating arc (radius `radius`) plus small
   * vertical bob, so both parallax and rotation make VIO scale observable. Mirrors
   * solver/src/synth.rs cam_pos/cam_rot (the solver's own solvable benchmark). */
  private poseAtTime(tSec: number): Pose {
    const theta = -0.5 + tSec / this.durationSec + 0.12 * Math.sin(1.7 * tSec);
    const eye: Vec3 = [
      this.centroid[0] + this.radius * Math.sin(theta),
      this.centroid[1] + 0.12 + 0.15 * Math.sin(2.1 * tSec),
      this.centroid[2] + this.radius * Math.cos(theta),
    ];
    return { p: eye, q: lookAtQuat(eye, this.centroid) };
  }

  /** One IMU sample at `tSec` (stamped `tMs`): body-frame angular velocity from a
   * finite-difference of the pose rotation, and specific force R^T·(a_world − g)
   * from the second difference of position. Ported from synth.rs synth_imu. */
  private imuSampleAt(tSec: number, tMs: number): ImuSample {
    const h = 1e-4;
    const rot = quatToRotMat(this.poseAtTime(tSec).q);
    const rel = matMul3(transpose3(rot), quatToRotMat(this.poseAtTime(tSec + h).q));
    const omega = so3Log(rel);
    const pPlus = this.poseAtTime(tSec + h).p;
    const pMinus = this.poseAtTime(tSec - h).p;
    const pNow = this.poseAtTime(tSec).p;
    const aWorld: Vec3 = [
      (pPlus[0] + pMinus[0] - 2 * pNow[0]) / (h * h),
      (pPlus[1] + pMinus[1] - 2 * pNow[1]) / (h * h),
      (pPlus[2] + pMinus[2] - 2 * pNow[2]) / (h * h),
    ];
    // a_world − G_WORLD, with G_WORLD = [0, −GRAVITY, 0].
    const fBody = matTvec(rot, [aWorld[0], aWorld[1] + GRAVITY, aWorld[2]]);
    return { t: tMs, gyro: [omega[0] / h, omega[1] / h, omega[2] / h], accel: fBody };
  }

  private render(tLocalMs: number): CaptureFrame {
    const detect = new Uint8Array(this.dw * this.dh * 4);
    const measure = new Uint8Array(this.dw * this.dh * 4);
    const pose = this.poseAtTime(tLocalMs / 1000);
    if (this.code) {
      const { params, epoch, toServer } = this.code;
      const frameIdx = frameIndexAt(toServer(tLocalMs), epoch, params);
      for (let id = 0; id < this.leds.length; id++) {
        const pr = project(pose, this.K, this.leds[id]!);
        if (pr.depth <= 0) continue;
        const dx = pr.u / this.ds;
        const dy = pr.v / this.ds;
        if (dx < 0 || dx >= this.dw || dy < 0 || dy >= this.dh) continue;
        const c = colorForFrame(id, frameIdx, params);
        this.stamp(detect, dx, dy, c, 255);
        this.stamp(measure, dx, dy, c, 255);
      }
    }
    return {
      texture: null,
      reduced: {
        detect,
        w: this.dw,
        h: this.dh,
        truncated: false,
        measure,
        measureW: this.dw,
        measureH: this.dh,
      },
      pose,
      K: this.K,
      imgW: this.imgW,
      imgH: this.imgH,
      tCaptureMs: this.t0Ms + tLocalMs,
    };
  }

  /** Stamp a filled disc: alpha = lit mask / luminance, RGB = the LED colour. */
  private stamp(
    buf: Uint8Array,
    cx: number,
    cy: number,
    color: readonly [number, number, number],
    alpha: number,
  ): void {
    const r = this.discR;
    const rr = (color[0] * 255) | 0;
    const gg = (color[1] * 255) | 0;
    const bb = (color[2] * 255) | 0;
    for (let yy = Math.max(0, Math.floor(cy - r)); yy <= Math.min(this.dh - 1, cy + r); yy++) {
      for (let xx = Math.max(0, Math.floor(cx - r)); xx <= Math.min(this.dw - 1, cx + r); xx++) {
        if ((xx - cx) ** 2 + (yy - cy) ** 2 > r * r) continue;
        const o = (yy * this.dw + xx) * 4;
        buf[o] = rr;
        buf[o + 1] = gg;
        buf[o + 2] = bb;
        buf[o + 3] = alpha;
      }
    }
  }
}
