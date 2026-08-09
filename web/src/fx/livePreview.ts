/**
 * Live 64×64 canvas driver for an effect preview (FUG-80). This is the RELIABLE
 * fallback for the effect tiles: it runs the exact firmware VM and paints each
 * frame straight to a <canvas> with putImageData — no WebCodecs, no muxing, no
 * cached asset — so a tile always shows its animation even where the offline
 * webm encode is unavailable or fails. Reuses the same grid/tree frame producer
 * as the webm path (previewVideo.ts), so what you see matches the encoded clip.
 *
 * Only VISIBLE tiles animate: the caller drives play()/pause() from an
 * IntersectionObserver, and dispose() frees the VM.
 */

import { compileScript, FxPreview } from "./preview";
import { makeFrameProducer } from "./previewVideo";
import { PREVIEW_SIZE, PREVIEW_FPS } from "./previewGrid";

/** Cap live redraws (multiple tiles animate at once; the VM tick is the cost). */
const DRAW_FPS = 30;

export class LiveEffectPreview {
  private raf = 0;
  private running = false;
  private disposed = false;
  private frame = 0;
  private lastDrawMs = 0;

  private constructor(
    private readonly preview: FxPreview,
    private readonly image: ImageData,
    private readonly ctx: CanvasRenderingContext2D,
    private readonly produce: (i: number) => Uint8Array,
  ) {}

  /**
   * Compile `source`, spin up the VM, and bind it to `canvas` (sized to 64×64).
   * Returns null when the source doesn't compile or 2D canvas is unavailable.
   */
  static async create(canvas: HTMLCanvasElement, source: string): Promise<LiveEffectPreview | null> {
    const compiled = await compileScript(source);
    if (!compiled.ok) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    const preview = await FxPreview.create(compiled.bytecode);
    for (const u of compiled.uniforms) preview.setUniform(u.slot, u.default);
    const producer = makeFrameProducer(preview, source);
    const image = ctx.createImageData(PREVIEW_SIZE, PREVIEW_SIZE);
    return new LiveEffectPreview(preview, image, ctx, producer.frame);
  }

  /**
   * Start (or resume) the animation. No-op if already running or disposed.
   * Paces by REAL elapsed time (not per-rAF) so playback speed is independent of
   * the display refresh — a 120 Hz screen wouldn't run the effect at 2×.
   */
  play(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastDrawMs = 0;
    const loop = (now: number): void => {
      if (!this.running) return;
      if (this.lastDrawMs === 0) {
        this.lastDrawMs = now;
        this.step(1);
      } else if (now - this.lastDrawMs >= 1000 / DRAW_FPS) {
        // Advance the VM by however many 60 fps steps really elapsed (capped so a
        // background stall doesn't cause a huge catch-up burst), draw the last.
        const steps = Math.min(4, Math.max(1, Math.round(((now - this.lastDrawMs) / 1000) * PREVIEW_FPS)));
        this.lastDrawMs = now;
        this.step(steps);
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Tick the VM `n` frames and paint the last. */
  private step(n: number): void {
    let rgba: Uint8Array | null = null;
    for (let k = 0; k < n; k++) rgba = this.produce(this.frame++);
    if (rgba) {
      this.image.data.set(rgba);
      this.ctx.putImageData(this.image, 0, 0);
    }
  }

  /** Stop animating but keep the VM (so play() resumes where it left off). */
  pause(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  dispose(): void {
    this.disposed = true;
    this.pause();
    this.preview.dispose();
  }
}
