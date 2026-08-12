/**
 * FUG-112 — the registered 3D layer of the camera view.
 *
 * A second canvas over the video preview (sibling to the 2D-track LabelOverlay)
 * that draws the *solved* LED positions projected into the live viewport, so
 * the user sees the reconstructed map registered against what the camera sees —
 * both the 2D tracks and where the solve currently places each LED, together.
 *
 * There is no per-frame pose on the WebXR-free capture path, so each frame we
 * recover one via client-side PnP (geom/pnp) from the decoded-LED ↔ centroid
 * correspondences, warm-started from the previous lock. That same solve is the
 * "reacquired absolute pose" signal (classifyRegistration): if too few known
 * LEDs re-decode, or the fixture's gravity-relative transform has shifted since
 * the map was built, PnP never locks and the overlay reports it.
 *
 * The per-frame path is refine-only (cheap); the expensive from-scratch search
 * runs only when there is no lock and only every SEARCH_STRIDE frames.
 */

import type { Intrinsics, LedEntry, Pose, Vec3 } from "@ledmapper/protocol";
import type { BlobStatus } from "../cv/pipeline";
import { estimatePose, type Correspondence, type PnpResult } from "../geom/pnp";
import { project } from "../geom/pinhole";
import { imageToView } from "./markers";

export type RegistrationTone = "locked" | "weak" | "lost";

/** UI-facing summary of the current pose-reacquisition state. */
export interface Registration {
  tone: RegistrationTone;
  /** Short chip label, e.g. "Registered · 18 LEDs". */
  label: string;
  inliers: number;
  total: number;
  rmsPx: number;
}

/** Pair each decoded blob with its solved 3D position (skip the undecoded and
 * the not-yet-solved). Pure — unit-tested. */
export function buildCorrespondences(
  blobs: readonly BlobStatus[],
  solved: ReadonlyMap<number, Vec3>,
): Correspondence[] {
  const out: Correspondence[] = [];
  for (const b of blobs) {
    if (b.ledId === null) continue;
    const xyz = solved.get(b.ledId);
    if (xyz === undefined) continue;
    out.push({ xyz, u: b.u, v: b.v });
  }
  return out;
}

/** Map a PnP result + correspondence count to the reacquisition chip. Pure. */
export function classifyRegistration(
  res: PnpResult | null,
  corrCount: number,
  onGrace: boolean,
): Registration {
  if (res && res.ok) {
    return {
      tone: "locked",
      label: `Registered · ${res.inliers} LEDs · ${res.rmsPx.toFixed(1)} px`,
      inliers: res.inliers,
      total: res.total,
      rmsPx: res.rmsPx,
    };
  }
  if (onGrace) {
    return {
      tone: "weak",
      label: "Re-acquiring pose…",
      inliers: res?.inliers ?? 0,
      total: res?.total ?? corrCount,
      rmsPx: res?.rmsPx ?? Infinity,
    };
  }
  return {
    tone: "lost",
    label:
      corrCount < 4
        ? "Not registered — few known LEDs in view"
        : "Not registered — fixture may have moved",
    inliers: res?.inliers ?? 0,
    total: corrCount,
    rmsPx: res?.rmsPx ?? Infinity,
  };
}

/** Frames a lock can coast on its last pose before the overlay goes dark. */
const GRACE_FRAMES = 8;
/** Run the from-scratch multi-start at most this often while unregistered. */
const SEARCH_STRIDE = 5;

export class ProjectionOverlay {
  private readonly ctx: CanvasRenderingContext2D;
  private solvedById = new Map<number, { xyz: Vec3; confidence: number }>();
  private lastPose: Pose | null = null;
  private sinceLock = Infinity;
  private frame = 0;
  /** Draw the numeric confidence next to each dot (busier, but the point of a
   * supplemental scan is to see which LEDs are weak). */
  showScores = true;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  /** Replace the solved map the overlay registers against (live-map poll, or
   * the prior map seeded at the start of a supplemental scan). */
  setSolved(leds: readonly LedEntry[]): void {
    const m = new Map<number, { xyz: Vec3; confidence: number }>();
    for (const l of leds) m.set(l.id, { xyz: l.xyz, confidence: l.confidence });
    this.solvedById = m;
  }

  get solvedCount(): number {
    return this.solvedById.size;
  }

  /** Recover the pose, (optionally) draw the registered LEDs, and return the
   * chip state. `render=false` still computes registration — so the chip stays
   * live when the user has isolated the tracks layer — but draws nothing. */
  draw(
    blobs: readonly BlobStatus[],
    K: Intrinsics,
    imgW: number,
    imgH: number,
    render = true,
  ): Registration {
    this.frame++;
    const solvedXyz = new Map<number, Vec3>();
    for (const [id, v] of this.solvedById) solvedXyz.set(id, v.xyz);
    const corrs = buildCorrespondences(blobs, solvedXyz);

    // Per-frame refine from the last lock; occasional full search otherwise.
    let res: PnpResult | null = null;
    if (this.lastPose !== null) {
      res = estimatePose(corrs, K, { seed: this.lastPose, refineOnly: true });
    }
    if ((res === null || !res.ok) && this.frame % SEARCH_STRIDE === 0) {
      const searched = estimatePose(corrs, K, this.lastPose ? { seed: this.lastPose } : {});
      if (searched && (res === null || searched.inliers > res.inliers)) res = searched;
    }

    if (res && res.ok) {
      this.lastPose = res.pose;
      this.sinceLock = 0;
    } else {
      this.sinceLock++;
    }
    const onGrace = this.sinceLock > 0 && this.sinceLock <= GRACE_FRAMES && this.lastPose !== null;

    this.resize();
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const pose = res && res.ok ? res.pose : onGrace ? this.lastPose : null;
    if (render && pose !== null && imgW > 0 && imgH > 0) this.render(pose, K, imgW, imgH);

    return classifyRegistration(res, corrs.length, onGrace);
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Forget the current lock (e.g. when the solved map is swapped wholesale). */
  reset(): void {
    this.lastPose = null;
    this.sinceLock = Infinity;
  }

  private resize(): void {
    const dpr = devicePixelRatio;
    const w = this.canvas.clientWidth * dpr;
    const h = this.canvas.clientHeight * dpr;
    if (w > 0 && h > 0 && (this.canvas.width !== w || this.canvas.height !== h)) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private render(pose: Pose, K: Intrinsics, imgW: number, imgH: number): void {
    const ctx = this.ctx;
    const dpr = devicePixelRatio;
    const viewW = this.canvas.width;
    const viewH = this.canvas.height;
    ctx.font = `${11 * dpr}px system-ui`;
    ctx.textBaseline = "middle";
    for (const [id, led] of this.solvedById) {
      const pr = project(pose, K, led.xyz);
      if (pr.depth <= 0) continue;
      const { x, y } = imageToView(pr.u, pr.v, imgW, imgH, viewW, viewH);
      if (x < -20 || x > viewW + 20 || y < -20 || y > viewH + 20) continue;
      const c = Math.max(0, Math.min(1, led.confidence));
      const hue = Math.round(c * 120); // red (low) -> green (high)
      const r = (3 + 3 * c) * dpr;
      // Low-confidence LEDs get a hollow warning ring so the gaps to fill pop.
      if (c < 0.5) {
        ctx.strokeStyle = `hsl(${hue} 95% 60% / 0.95)`;
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath();
        ctx.arc(x, y, r + 3 * dpr, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${hue} 90% 55% / 0.85)`;
      ctx.fill();
      if (this.showScores) {
        ctx.fillStyle = "rgb(255 255 255 / 0.85)";
        ctx.fillText(`${id}·${Math.round(c * 100)}`, x + r + 2 * dpr, y);
      }
    }
  }
}
