/**
 * M8 — the 2D annotation layer of the camera view (a canvas over the video
 * preview), drawn once per frame:
 *
 *  - **Blob outlines** — the 2D detection stage's per-frame output, colored
 *    by track association: green = matched a track with a decoded id (the
 *    gate the blob passed is the track's reprojected solve prediction once
 *    the LED is solved), amber = matched a track still awaiting decode,
 *    red = matched nothing this frame (spawned a fresh track). Mapped with
 *    the camera image's aspect-fill crop — these annotate the *image*.
 *
 * (The 3D-composited per-LED id labels left with the M6 WebXR removal —
 * there is no per-frame pose to project through. Client-side PnP against
 * the solved map is the phase-4.5 follow-up that brings registered
 * overlays back — docs/vio-exploration.md.)
 */

import type { BlobStatus } from "../cv/pipeline";
import { imageToView } from "./markers";

const OUTLINE = {
  identified: "hsl(140 90% 60% / 0.9)",
  tracked: "hsl(45 95% 60% / 0.9)",
  unmatched: "hsl(5 95% 62% / 0.9)",
};

export class LabelOverlay {
  private readonly ctx: CanvasRenderingContext2D;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  /** Redraw the frame's annotations. */
  draw(blobs: readonly BlobStatus[] = [], imgW = 0, imgH = 0): void {
    const dpr = devicePixelRatio;
    const viewW = this.canvas.clientWidth * dpr;
    const viewH = this.canvas.clientHeight * dpr;
    if (viewW === 0 || viewH === 0) return;
    if (this.canvas.width !== viewW || this.canvas.height !== viewH) {
      this.canvas.width = viewW;
      this.canvas.height = viewH;
    }
    const ctx = this.ctx;
    ctx.clearRect(0, 0, viewW, viewH);

    if (imgW > 0 && imgH > 0) {
      const scale = Math.max(viewW / imgW, viewH / imgH);
      ctx.lineWidth = 1.5 * dpr;
      for (const b of blobs) {
        const { x, y } = imageToView(b.u, b.v, imgW, imgH, viewW, viewH);
        if (x < 0 || x > viewW || y < 0 || y > viewH) continue;
        const r = Math.max(Math.sqrt(b.area / Math.PI) * scale, 5 * dpr);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.strokeStyle = !b.matched
          ? OUTLINE.unmatched
          : b.ledId !== null
            ? OUTLINE.identified
            : OUTLINE.tracked;
        ctx.stroke();
      }
    }
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}
