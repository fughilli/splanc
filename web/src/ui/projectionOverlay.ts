/**
 * FUG-112 — the registered 3D layer of the camera view.
 *
 * A second canvas over the video preview (sibling to the 2D-track LabelOverlay)
 * that draws the *solved* LED positions projected into the live viewport, so
 * the user sees the reconstructed map registered against what the camera sees —
 * both the 2D tracks and where the solve currently places each LED, together.
 * It runs concurrently with every scan: the drawn set is the base map (in a
 * supplemental scan) ∪ the live solve so far (geom/liveUnion), each mark coded
 * for provenance (hue + shape) and 1-σ position uncertainty (fill + projected
 * ring) — see ui/overlayStyle.
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

import type { Intrinsics, Pose, Vec3 } from "@ledmapper/protocol";
import type { BlobStatus } from "../cv/pipeline";
import type { OverlayLed } from "../geom/liveUnion";
import { estimatePose, type Correspondence, type PnpResult } from "../geom/pnp";
import { project } from "../geom/pinhole";
import { imageToView } from "./markers";
import { drawMarker, markerStyle, sigmaRadiusPx } from "./overlayStyle";

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

/** Map a PnP result + correspondence count to the reacquisition chip. Pure.
 * `supplement` distinguishes a supplemental scan (where a persistent failure to
 * lock means the fixture's gravity-relative transform likely changed) from a
 * first-time capture (where it just means the solve is still converging). */
export function classifyRegistration(
  res: PnpResult | null,
  corrCount: number,
  onGrace: boolean,
  supplement: boolean,
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
      label: supplement ? "Re-acquiring pose…" : "Aligning…",
      inliers: res?.inliers ?? 0,
      total: res?.total ?? corrCount,
      rmsPx: res?.rmsPx ?? Infinity,
    };
  }
  const label =
    corrCount < 4
      ? "Not registered — few known LEDs in view"
      : supplement
        ? "Not registered — fixture may have moved"
        : "Aligning to the solve…";
  return {
    tone: corrCount < 4 || supplement ? "lost" : "weak",
    label,
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
  private solvedById = new Map<number, OverlayLed>();
  private spacingM: number | null = null;
  private lastPose: Pose | null = null;
  private sinceLock = Infinity;
  private frame = 0;
  /** Label each mark with its id and 1-σ (busier, but the point of watching
   * the solve live is to see which LEDs are still loose). */
  showScores = true;
  /** Draw each LED's projected 1-σ ring. Off by default: the interim live
   * solves are loose, so nearly every LED gets a large ring and the view
   * clutters — the marker fill already encodes the variance tier. */
  showRings = false;
  /** Registering against a prior map (supplement) vs the live solve (fresh) —
   * only changes the chip wording. */
  supplement = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  /** Replace the LED set the overlay registers against and draws — the union
   * of the base map and the live solve (geom/liveUnion), each LED with its
   * provenance and σ. `spacingM` is the LED pitch the variance tiers use. */
  setSolved(leds: readonly OverlayLed[], spacingM: number | null = null): void {
    const m = new Map<number, OverlayLed>();
    for (const l of leds) m.set(l.id, l);
    this.solvedById = m;
    this.spacingM = spacingM;
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

    return classifyRegistration(res, corrs.length, onGrace, this.supplement);
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** The camera pose (camera->map, pinhole.ts convention) when the LAST frame
   * locked; null while unregistered or coasting on a stale lock. The IMU
   * calibration flow reads it to bring the phone's gravity into the map frame. */
  get lockedPose(): Pose | null {
    return this.sinceLock === 0 ? this.lastPose : null;
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
    // object-fit: cover — image px → view px.
    const viewScale = Math.max(viewW / imgW, viewH / imgH);
    // Loose LEDs first so the confident marks paint on top of them.
    const order = [...this.solvedById.values()].sort((a, b) => b.sigmaM - a.sigmaM);
    for (const led of order) {
      const pr = project(pose, K, led.xyz);
      if (pr.depth <= 0) continue;
      const { x, y } = imageToView(pr.u, pr.v, imgW, imgH, viewW, viewH);
      if (x < -20 || x > viewW + 20 || y < -20 || y > viewH + 20) continue;
      const st = markerStyle(led.provenance, led.sigmaM, this.spacingM);
      // 1-σ ring at its projected on-screen size, when bigger than the mark;
      // capped so a hopeless LED doesn't paint over the whole view.
      const ringPx = sigmaRadiusPx(led.sigmaM, pr.depth, K[0]) * viewScale;
      if (this.showRings && ringPx > st.sizePx * dpr * 1.6) {
        ctx.beginPath();
        ctx.arc(x, y, Math.min(ringPx, 80 * dpr), 0, Math.PI * 2);
        ctx.lineWidth = dpr;
        ctx.strokeStyle = st.color;
        ctx.globalAlpha = 0.55;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      drawMarker(ctx, st, x, y, dpr);
      if (this.showScores) {
        ctx.fillStyle = "rgb(255 255 255 / 0.85)";
        ctx.fillText(`${led.id} ±${formatSigma(led.sigmaM)}`, x + (st.sizePx + 4) * dpr, y);
      }
    }
  }
}

/** Compact σ label: millimetres below 10 cm, else centimetres. */
export function formatSigma(sigmaM: number): string {
  if (!Number.isFinite(sigmaM)) return "∞";
  const mm = sigmaM * 1000;
  if (mm < 100) return `${mm < 10 ? mm.toFixed(1) : Math.round(mm)}mm`;
  return `${Math.round(mm / 10)}cm`;
}
