/**
 * M8 — result preview: a dependency-free 3D scatter of the reconstructed map
 * on a 2D canvas (slow auto-orbit, depth-sorted painter's algorithm, colored
 * by confidence). A preview, not a CAD viewer — Sim Studio is the real
 * inspection tool.
 */

import type { OutputMap } from "@ledmapper/protocol";

export class MapView {
  private raf = 0;
  private angle = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly map: OutputMap,
  ) {}

  start(): void {
    this.stop();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.angle += 0.005;
      this.draw();
    };
    loop();
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private draw(): void {
    const ctx = this.canvas.getContext("2d")!;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, w, h);
    const leds = this.map.leds;
    if (leds.length === 0) {
      ctx.fillStyle = "#888";
      ctx.font = "14px system-ui";
      ctx.fillText("no LEDs solved", 16, 24);
      return;
    }

    // Center + scale to fit.
    let cx = 0, cy = 0, cz = 0;
    for (const l of leds) {
      cx += l.xyz[0];
      cy += l.xyz[1];
      cz += l.xyz[2];
    }
    cx /= leds.length;
    cy /= leds.length;
    cz /= leds.length;
    let maxR = 1e-6;
    for (const l of leds) {
      const r = Math.hypot(l.xyz[0] - cx, l.xyz[1] - cy, l.xyz[2] - cz);
      if (r > maxR) maxR = r;
    }
    const scale = (Math.min(w, h) * 0.42) / maxR;

    const sinA = Math.sin(this.angle);
    const cosA = Math.cos(this.angle);
    const pts = leds.map((l) => {
      const x = l.xyz[0] - cx;
      const y = l.xyz[1] - cy;
      const z = l.xyz[2] - cz;
      // Orbit about the +Y (up) axis, slight fixed tilt for depth.
      const rx = x * cosA + z * sinA;
      const rz = -x * sinA + z * cosA;
      const ty = y * 0.94 - rz * 0.34;
      const tz = y * 0.34 + rz * 0.94;
      return { sx: w / 2 + rx * scale, sy: h / 2 - ty * scale, depth: tz, led: l };
    });
    pts.sort((a, b) => a.depth - b.depth);

    for (const p of pts) {
      const c = p.led.confidence;
      const r = 2.5 + 2 * c;
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
      // Confidence: green (high) -> amber -> red (low).
      const hue = Math.round(c * 120);
      ctx.fillStyle = `hsl(${hue} 90% 50%)`;
      ctx.fill();
    }

    ctx.fillStyle = "#aaa";
    ctx.font = "12px system-ui";
    const s = this.map.stats;
    ctx.fillText(
      `${leds.length}/${this.map.ledCount} solved · rms ${s.rmsReprojPxGlobal.toFixed(2)} px · median parallax ${s.medianParallaxDeg.toFixed(1)}°`,
      12,
      h - 12,
    );
  }
}
