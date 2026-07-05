/**
 * M8 — the 2D annotation layer of the camera view (a canvas in the XR
 * dom-overlay), drawn once per XR frame:
 *
 *  - **Blob outlines** — the 2D detection stage's per-frame output, colored
 *    by track association: green = matched a track with a decoded id (the
 *    gate the blob passed is the track's reprojected solve prediction once
 *    the LED is solved), amber = matched a track still awaiting decode,
 *    red = matched nothing this frame (spawned a fresh track). Mapped with
 *    the camera image's aspect-fill crop — these annotate the *image*.
 *  - **Id labels** — one per SOLVED LED, projected through the frame's real
 *    view/projection (the same MVP as the GL rings, see points3d.ts), so the
 *    text tracks the physical LED and survives dark code-word frames.
 */

import type { LedEntry } from "@ledmapper/protocol";
import type { BlobStatus } from "../cv/pipeline";
import { projectPoint, type Mat4 } from "../geom/mat4";
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
  draw(
    leds: readonly LedEntry[],
    mvp: Mat4,
    blobs: readonly BlobStatus[] = [],
    imgW = 0,
    imgH = 0,
  ): void {
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

    // -- 2D stage: blob outlines (aspect-fill image mapping) ---------------
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

    // -- solved LEDs: id labels (3D-composited mapping) --------------------
    ctx.font = `${Math.round(13 * dpr)}px system-ui, sans-serif`;
    ctx.textBaseline = "middle";

    for (const l of leds) {
      const ndc = projectPoint(mvp, l.xyz[0], l.xyz[1], l.xyz[2]);
      if (ndc === null || ndc.x < -1 || ndc.x > 1 || ndc.y < -1 || ndc.y > 1) continue;
      const x = (ndc.x * 0.5 + 0.5) * viewW;
      const y = (0.5 - ndc.y * 0.5) * viewH; // NDC y up → canvas y down

      // Confidence: green (high) -> amber -> red (low), like the map preview.
      const hue = Math.round(l.confidence * 120);
      const label = `#${l.id}`;
      const tx = x + 12 * dpr; // clear of the GL ring
      ctx.lineWidth = 3 * dpr;
      ctx.strokeStyle = "rgb(0 0 0 / 0.75)";
      ctx.strokeText(label, tx, y);
      ctx.fillStyle = `hsl(${hue} 85% 70%)`;
      ctx.fillText(label, tx, y);
    }
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}
