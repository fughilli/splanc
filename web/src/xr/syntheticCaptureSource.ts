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

import type { CodeParams, Intrinsics, Pose, Vec3 } from "@ledmapper/protocol";
import { colorForFrame } from "../code/gray";
import { frameIndexAt } from "../code/timing";
import { lookAtQuat, project } from "../geom/pinhole";
import type { CaptureFrame, CaptureSource } from "./capture";

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
  private readonly centroid: Vec3;

  private cb: ((f: CaptureFrame) => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
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
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Camera pose at fraction `frac` of the sweep: an arc in front of the fixture,
   * always looking at the centroid, translating for parallax the solver needs. */
  private poseAt(frac: number): Pose {
    const eye: Vec3 = [
      this.centroid[0] + 0.5 * Math.sin(frac * Math.PI * 2),
      this.centroid[1] + 0.15 * Math.sin(frac * Math.PI * 4),
      this.centroid[2] + 0.9,
    ];
    return { p: eye, q: lookAtQuat(eye, this.centroid) };
  }

  private render(tLocalMs: number): CaptureFrame {
    const detect = new Uint8Array(this.dw * this.dh * 4);
    const measure = new Uint8Array(this.dw * this.dh * 4);
    const pose = this.poseAt(Math.min(1, (tLocalMs % 6000) / 6000));
    // Loop the ~6 s sweep so a slow start still yields enough coverage.
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
