/**
 * Lazy 64×64 preview tiles for the effects browser (FUG-80). Each effect row
 * registers its thumbnail; when it scrolls into view we show its animation.
 *
 * Two-tier so a tile ALWAYS ends up showing its effect:
 *   1. Preferred — a cached/encoded looping .webm played in a <video>. Cheap to
 *      replay, persists across reloads (previewCache).
 *   2. Fallback — if the effect has no webm yet AND the offline encode yields
 *      nothing (unsupported/failed WebCodecs), drive a live <canvas> straight
 *      from the VM (livePreview). No encode, no cache — but it always paints.
 *
 * Renders run through a small CONCURRENCY POOL so several tiles fill at once
 * without spawning an unbounded number of VMs/encoders. Live tiles animate only
 * while visible (play/pause from the IntersectionObserver).
 */

import { previewCache } from "../../store/previewCache";
import { renderEffectPreview } from "../../fx/previewVideo";
import { LiveEffectPreview } from "../../fx/livePreview";
import { PREVIEW_SIZE } from "../../fx/previewGrid";

/** How many previews render concurrently (each still does main-thread VM work). */
const RENDER_CONCURRENCY = 3;

interface TileState {
  id: string;
  source: string;
  started: boolean;
  visible: boolean;
  live: LiveEffectPreview | null;
  video: HTMLVideoElement | null;
}

export class EffectPreviewTiles {
  private readonly observer: IntersectionObserver | null;
  private readonly tiles = new Map<HTMLElement, TileState>();
  private readonly urls = new Set<string>();
  private queue: HTMLElement[] = [];
  private active = 0;

  constructor() {
    this.observer =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver((entries) => this.onIntersect(entries), { rootMargin: "150px" })
        : null;
  }

  /** Register a thumb element for an effect; renders lazily once it's visible. */
  observe(el: HTMLElement, id: string, source: string): void {
    this.tiles.set(el, { id, source, started: false, visible: false, live: null, video: null });
    if (this.observer) this.observer.observe(el);
    else this.kick(el); // no IntersectionObserver → render eagerly
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      const st = this.tiles.get(e.target as HTMLElement);
      if (!st) continue;
      st.visible = e.isIntersecting;
      if (e.isIntersecting) this.kick(e.target as HTMLElement);
      else {
        st.live?.pause();
        st.video?.pause();
      }
    }
  }

  /** First view kicks off a render; later views (re)start the animation. */
  private kick(el: HTMLElement): void {
    const st = this.tiles.get(el);
    if (!st) return;
    st.live?.play();
    if (st.video) void st.video.play().catch(() => {});
    if (st.started) return;
    st.started = true;
    if (!this.queue.includes(el)) this.queue.push(el);
    this.pump();
  }

  /** Start renders up to the concurrency limit; each frees its slot on finish. */
  private pump(): void {
    while (this.active < RENDER_CONCURRENCY && this.queue.length > 0) {
      const el = this.queue.shift()!;
      const st = this.tiles.get(el);
      if (!st || !el.isConnected) continue;
      this.active++;
      void this.renderTile(el, st).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private async renderTile(el: HTMLElement, st: TileState): Promise<void> {
    // Tier 1: a cached clip is already known-good; a fresh one must prove it
    // actually decodes to a visible frame (some browsers "play" a broken/empty
    // webm as black) before we trust and cache it.
    let blob = await previewCache.get(st.id, st.source);
    if (!blob) {
      let fresh: Blob | null = null;
      try {
        fresh = await renderEffectPreview(st.source);
      } catch {
        fresh = null;
      }
      if (fresh && (await webmShowsContent(fresh))) {
        blob = fresh;
        void previewCache.put(st.id, st.source, blob);
      }
    }
    if (!this.tiles.has(el) || !el.isConnected) return; // list rebuilt meanwhile

    if (blob) {
      this.showVideo(el, st, blob);
      return;
    }
    // Tier 2: live canvas — no encode, always paints (validated VM → putImageData).
    await this.showLive(el, st);
  }

  private showVideo(el: HTMLElement, st: TileState, blob: Blob): void {
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
    st.video = video;
    el.replaceChildren(video);
  }

  private async showLive(el: HTMLElement, st: TileState): Promise<void> {
    const canvas = document.createElement("canvas");
    canvas.width = PREVIEW_SIZE;
    canvas.height = PREVIEW_SIZE;
    canvas.className = "fx-thumb-video"; // shares the tile's fill/pixelated styling
    let live: LiveEffectPreview | null = null;
    try {
      live = await LiveEffectPreview.create(canvas, st.source);
    } catch {
      live = null;
    }
    if (!live) return; // compile failed → keep the sparkle placeholder
    if (!this.tiles.has(el) || !el.isConnected) {
      live.dispose();
      return;
    }
    st.live = live;
    el.replaceChildren(canvas);
    if (st.visible) live.play();
  }

  /** Forget all tiles, stop animations, revoke URLs — call before a list rebuild. */
  reset(): void {
    this.observer?.disconnect();
    for (const st of this.tiles.values()) st.live?.dispose();
    this.tiles.clear();
    this.queue = [];
    this.active = 0;
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls.clear();
  }

  dispose(): void {
    this.reset();
  }
}

/**
 * Decode-check a freshly-encoded preview: does it actually show a non-black frame?
 * Guards against a webm that "loads" but plays black (a broken/empty encode) — if
 * it can't be decoded and sampled within a short budget, we return false and the
 * caller uses the live-canvas path instead. Fail-safe: any error → false.
 */
function webmShowsContent(blob: Blob): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") return resolve(true);
    const url = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 4000);
    video.onerror = () => finish(false);
    // Sample partway in, where most effects have visible content.
    video.onloadeddata = () => {
      video.currentTime = Math.min(1.5, (video.duration || 3) * 0.5);
    };
    video.onseeked = () => {
      try {
        if (!video.videoWidth) return finish(false);
        const c = document.createElement("canvas");
        c.width = PREVIEW_SIZE;
        c.height = PREVIEW_SIZE;
        const cx = c.getContext("2d");
        if (!cx) return finish(false);
        cx.drawImage(video, 0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
        const d = cx.getImageData(0, 0, PREVIEW_SIZE, PREVIEW_SIZE).data;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] || d[i + 1] || d[i + 2]) return finish(true);
        }
        finish(false); // fully black frame → treat as a failed encode
      } catch {
        finish(false);
      }
    };
    video.src = url;
    video.load();
  });
}
