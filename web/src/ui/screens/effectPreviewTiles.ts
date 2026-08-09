/**
 * Lazy 64×64 preview-video tiles for the effects browser (FUG-80). Each effect
 * row registers its thumbnail element here; when it scrolls into view we fetch a
 * cached clip (or render one via the WASM VM) and swap the placeholder icon for
 * a looping <video>. Renders run through a small CONCURRENCY POOL so several
 * tiles fill in at once (overlapping the async encode/flush waits) without
 * spawning an unbounded number of WASM VMs / encoders at once.
 */

import { previewCache } from "../../store/previewCache";
import { renderEffectPreview } from "../../fx/previewVideo";

/** How many previews render concurrently. Small: each still does main-thread VM
 * work, so this mainly overlaps the async encode/flush waits between them. */
const RENDER_CONCURRENCY = 3;

export class EffectPreviewTiles {
  private readonly observer: IntersectionObserver | null;
  private readonly tiles = new Map<HTMLElement, { id: string; source: string }>();
  private readonly urls = new Set<string>();
  private queue: HTMLElement[] = [];
  private active = 0;

  constructor() {
    this.observer =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(
            (entries) => {
              for (const e of entries) if (e.isIntersecting) this.enqueue(e.target as HTMLElement);
            },
            { rootMargin: "150px" },
          )
        : null;
  }

  /** Register a thumb element for an effect; renders lazily once it's visible. */
  observe(el: HTMLElement, id: string, source: string): void {
    this.tiles.set(el, { id, source });
    if (this.observer) this.observer.observe(el);
    else this.enqueue(el); // no IntersectionObserver → just render it
  }

  private enqueue(el: HTMLElement): void {
    if (!this.tiles.has(el)) return;
    this.observer?.unobserve(el);
    if (!this.queue.includes(el)) this.queue.push(el);
    this.pump();
  }

  /** Start renders up to the concurrency limit; each frees its slot on finish. */
  private pump(): void {
    while (this.active < RENDER_CONCURRENCY && this.queue.length > 0) {
      const el = this.queue.shift()!;
      const t = this.tiles.get(el);
      if (!t || !el.isConnected) continue;
      this.active++;
      void this.renderTile(el, t.id, t.source).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private async renderTile(el: HTMLElement, id: string, source: string): Promise<void> {
    let blob = await previewCache.get(id, source);
    if (!blob) {
      try {
        blob = await renderEffectPreview(source);
      } catch {
        blob = null; // compile/encode failure → keep the placeholder icon
      }
      if (blob) void previewCache.put(id, source, blob);
    }
    if (!blob || !el.isConnected) return;
    const url = URL.createObjectURL(blob);
    this.urls.add(url);
    const video = document.createElement("video");
    video.className = "fx-thumb-video";
    video.muted = true;
    video.loop = true;
    video.autoplay = true;
    video.playsInline = true;
    video.src = url;
    video.addEventListener("loadeddata", () => void video.play().catch(() => {}));
    el.replaceChildren(video);
  }

  /** Forget all tiles and revoke object URLs — call before a list rebuild. */
  reset(): void {
    this.observer?.disconnect();
    this.tiles.clear();
    this.queue = [];
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls.clear();
  }

  dispose(): void {
    this.reset();
  }
}
