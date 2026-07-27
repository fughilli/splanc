/**
 * Video → device-texture streaming panel for the effect editor. Streams frames
 * from a local video/image file OR the device camera into a loaded effect's 2D
 * `texture` on the ESP32 player, over the existing wss control plane.
 *
 * Frames are sized to the TARGET texture's width×height (discovered from the
 * compiled .fxb via parseFxbTextures — never hardcoded; the firmware drops a
 * mismatched frame), drawn object-fit:cover into an offscreen canvas, read back
 * as RGBA, and encoded by a single per-session TextureStreamer (so XOR-delta +
 * RLE work across frames). `client.setTexture` is fire-and-forget.
 *
 * It's opt-in and off the hot path: no camera/rAF runs unless streaming. The
 * editor keeps the panel's `node` stable (re-parented by FxLayout, never
 * recreated), feeds it the latest compiled bytecode + connection state, and
 * disposes it on unmount.
 */

import { parseFxbTextures, type FxbTexture } from "../../net/fxbTextures";
import { TextureStreamer, type TextureFormat } from "../../net/textureCodec";
import type { SetTextureMessage } from "../../net/proto";
import { Button } from "../../ui/kit";

/** The subset of LedMapperClient the panel consumes (fire-and-forget send). */
export interface TextureSink {
  readonly isConnected: boolean;
  setTexture(msg: SetTextureMessage): boolean;
}

const FORMATS: { value: TextureFormat; label: string }[] = [
  { value: "rgb565", label: "RGB565 (default)" },
  { value: "rgb888", label: "RGB888" },
  { value: "rgb332", label: "RGB332" },
  { value: "gray8", label: "Gray 8" },
];
const FPS_CHOICES = [10, 15, 20, 30];
const DEFAULT_FPS = 15;

let stylesInstalled = false;
function installStyles(): void {
  if (stylesInstalled || typeof document === "undefined") return;
  stylesInstalled = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

export class VideoTexturePanel {
  /** Stable content node handed to FxLayout (re-parented, never recreated). */
  readonly node: HTMLElement;

  private sink: TextureSink | null = null;
  private textures: FxbTexture[] = [];
  private format: TextureFormat = "rgb565";
  private fps = DEFAULT_FPS;
  private texIndex = 0;

  // Source state.
  private video = document.createElement("video");
  private imageBitmap: ImageBitmap | HTMLImageElement | null = null;
  private objectUrl: string | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceKind: "none" | "file-video" | "file-image" | "camera" = "none";

  // Streaming state.
  private streamer: TextureStreamer | null = null;
  private canvas = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D | null = null;
  private raf = 0;
  private lastSend = 0;
  private running = false;
  private disposed = false;

  // Stats.
  private sentTimes: number[] = [];
  private lastBytes = 0;

  // DOM handles.
  private hint = document.createElement("p");
  private controls = document.createElement("div");
  private preview = document.createElement("div");
  private texSelect = document.createElement("select");
  private texRow = document.createElement("label");
  private fmtSelect = document.createElement("select");
  private fpsSelect = document.createElement("select");
  private fileInput = document.createElement("input");
  private startBtn: HTMLButtonElement;
  private cameraBtn: HTMLButtonElement;
  private stats = document.createElement("p");

  constructor() {
    installStyles();
    this.node = document.createElement("div");
    this.node.className = "fxvid";

    this.hint.className = "fxedit-muted";

    // -- source pickers -----------------------------------------------------
    this.fileInput.type = "file";
    this.fileInput.accept = "video/*,image/*";
    this.fileInput.className = "fxvid-file";
    this.fileInput.addEventListener("change", () => void this.onFilePicked());

    this.cameraBtn = Button({
      label: "Use camera",
      icon: "camera",
      variant: "quiet",
      onClick: () => void this.useCamera(),
    });

    const pickRow = document.createElement("div");
    pickRow.className = "fxedit-btnrow fxvid-pick";
    pickRow.append(this.fileInput, this.cameraBtn);

    // -- live preview -------------------------------------------------------
    this.preview.className = "fxvid-preview";
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.loop = true;
    this.video.className = "fxvid-video";
    this.preview.appendChild(this.video);

    // -- target / format / fps selectors ------------------------------------
    this.texRow.className = "fxedit-fieldrow";
    const texCap = document.createElement("span");
    texCap.textContent = "Target texture";
    this.texSelect.className = "fxedit-mappick";
    this.texSelect.addEventListener("change", () => {
      this.texIndex = Number(this.texSelect.value);
      this.streamer?.reset();
      this.resetStats();
    });
    this.texRow.append(texCap, this.texSelect);

    const fmtRow = document.createElement("label");
    fmtRow.className = "fxedit-fieldrow";
    const fmtCap = document.createElement("span");
    fmtCap.textContent = "Format";
    this.fmtSelect.className = "fxedit-mappick";
    for (const f of FORMATS) {
      const o = document.createElement("option");
      o.value = f.value;
      o.textContent = f.label;
      this.fmtSelect.appendChild(o);
    }
    this.fmtSelect.value = this.format;
    this.fmtSelect.addEventListener("change", () => {
      this.format = this.fmtSelect.value as TextureFormat;
      this.rebuildStreamer(); // a format change needs a fresh keyframe
      this.resetStats();
    });
    fmtRow.append(fmtCap, this.fmtSelect);

    const fpsRow = document.createElement("label");
    fpsRow.className = "fxedit-fieldrow";
    const fpsCap = document.createElement("span");
    fpsCap.textContent = "Frame rate";
    this.fpsSelect.className = "fxedit-mappick";
    for (const f of FPS_CHOICES) {
      const o = document.createElement("option");
      o.value = String(f);
      o.textContent = `${f} fps`;
      this.fpsSelect.appendChild(o);
    }
    this.fpsSelect.value = String(this.fps);
    this.fpsSelect.addEventListener("change", () => {
      this.fps = Number(this.fpsSelect.value);
    });
    fpsRow.append(fpsCap, this.fpsSelect);

    // -- start / stop -------------------------------------------------------
    this.startBtn = Button({
      label: "Start streaming",
      icon: "effect-to-device",
      onClick: () => this.toggle(),
    });
    this.startBtn.disabled = true;

    this.stats.className = "fxvid-stats";
    this.stats.textContent = "";

    this.controls.className = "fxvid-controls";
    this.controls.append(
      pickRow,
      this.preview,
      this.texRow,
      fmtRow,
      fpsRow,
      this.startBtn,
      this.stats,
    );

    this.node.append(this.hint, this.controls);
    this.refresh();
  }

  /** Feed the latest compiled bytecode (or null while errored) so the panel can
   * (re)discover the effect's textures. Preserves the current selection when the
   * same texture index still exists. */
  setBytecode(fxb: Uint8Array | null): void {
    let texs: FxbTexture[] = [];
    if (fxb) {
      try {
        texs = parseFxbTextures(fxb);
      } catch {
        texs = [];
      }
    }
    const changed =
      texs.length !== this.textures.length ||
      texs.some((t, i) => {
        const p = this.textures[i];
        return !p || p.index !== t.index || p.width !== t.width || p.height !== t.height;
      });
    this.textures = texs;
    if (changed) {
      this.populateTextures();
      // Dims may have changed → the current stream is invalid.
      this.streamer?.reset();
      this.rebuildStreamer();
    }
    this.refresh();
  }

  /** Feed the live client (or null when disconnected). */
  setSink(sink: TextureSink | null): void {
    this.sink = sink;
    if ((!sink || !sink.isConnected) && this.running) this.stop();
    this.refresh();
  }

  private populateTextures(): void {
    const prev = this.texIndex;
    this.texSelect.replaceChildren();
    for (const t of this.textures) {
      const o = document.createElement("option");
      o.value = String(t.index);
      o.textContent = `#${t.index} · ${t.width}×${t.height}`;
      this.texSelect.appendChild(o);
    }
    const keep = this.textures.some((t) => t.index === prev);
    this.texIndex = keep ? prev : this.textures[0]?.index ?? 0;
    this.texSelect.value = String(this.texIndex);
    // Only one texture → hide the selector row (no choice to make).
    this.texRow.style.display = this.textures.length > 1 ? "" : "none";
  }

  private target(): FxbTexture | null {
    return this.textures.find((t) => t.index === this.texIndex) ?? this.textures[0] ?? null;
  }

  private ready(): boolean {
    return (this.sink?.isConnected ?? false) && this.textures.length > 0;
  }

  /** Reflect connection/effect gating: show the hint OR the controls, and enable
   * Start only when a device is connected, a texture exists, and a source is set. */
  private refresh(): void {
    const connected = this.sink?.isConnected ?? false;
    const hasTex = this.textures.length > 0;
    if (!connected || !hasTex) {
      this.controls.style.display = "none";
      this.hint.style.display = "";
      this.hint.textContent = !hasTex
        ? "Load an effect that declares a `texture`, then connect a device to stream video into it."
        : "Connect a device (tap the status pill) to stream video into this effect's texture.";
      return;
    }
    this.hint.style.display = "none";
    this.controls.style.display = "";
    this.startBtn.disabled = this.sourceKind === "none";
    this.cameraBtn.disabled = false;
  }

  // -- sources --------------------------------------------------------------
  private async onFilePicked(): Promise<void> {
    const file = this.fileInput.files?.[0];
    if (!file) return;
    this.clearSource();
    this.objectUrl = URL.createObjectURL(file);
    if (file.type.startsWith("image/")) {
      const img = new Image();
      img.src = this.objectUrl;
      try {
        await img.decode();
      } catch {
        this.hintError("Could not decode that image.");
        return;
      }
      this.imageBitmap = img;
      this.sourceKind = "file-image";
      this.video.style.display = "none";
    } else {
      this.video.src = this.objectUrl;
      this.video.style.display = "";
      try {
        await this.video.play();
      } catch {
        /* autoplay may be blocked until Start; not fatal */
      }
      this.sourceKind = "file-video";
    }
    this.rebuildStreamer();
    this.refresh();
  }

  private async useCamera(): Promise<void> {
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) {
      this.hintError("Camera not supported in this browser.");
      return;
    }
    try {
      const stream = await md.getUserMedia({ video: { facingMode: "environment" } });
      this.clearSource();
      this.mediaStream = stream;
      this.video.srcObject = stream;
      this.video.style.display = "";
      await this.video.play().catch(() => undefined);
      this.sourceKind = "camera";
      this.rebuildStreamer();
      this.refresh();
    } catch {
      this.hintError("Camera access denied or unavailable.");
    }
  }

  private hintError(text: string): void {
    this.hint.style.display = "";
    this.hint.textContent = text;
    this.stats.textContent = "";
  }

  /** Release the current source (used before switching, and on dispose). */
  private clearSource(): void {
    if (this.mediaStream) {
      for (const t of this.mediaStream.getTracks()) t.stop();
      this.mediaStream = null;
    }
    this.video.srcObject = null;
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.video.removeAttribute("src");
    this.imageBitmap = null;
    this.sourceKind = "none";
  }

  // -- streaming ------------------------------------------------------------
  private rebuildStreamer(): void {
    const tex = this.target();
    this.streamer = tex ? new TextureStreamer(this.texIndex, this.format, true) : null;
  }

  private toggle(): void {
    if (this.running) this.stop();
    else this.start();
  }

  private start(): void {
    if (!this.ready() || this.sourceKind === "none") return;
    if (!this.streamer) this.rebuildStreamer();
    this.streamer?.reset();
    this.resetStats();
    this.running = true;
    this.startBtn.replaceChildren(document.createTextNode("Stop"));
    this.lastSend = 0;
    if (this.sourceKind === "file-video" || this.sourceKind === "camera") {
      void this.video.play().catch(() => undefined);
    }
    this.raf = requestAnimationFrame((t) => this.loop(t));
  }

  private stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.sourceKind === "file-video" || this.sourceKind === "camera") this.video.pause();
    this.startBtn.replaceChildren(document.createTextNode("Start streaming"));
  }

  private loop(t: number): void {
    if (!this.running || this.disposed) return;
    this.raf = requestAnimationFrame((n) => this.loop(n));
    const interval = 1000 / this.fps;
    if (this.lastSend !== 0 && t - this.lastSend < interval) return;
    this.lastSend = t;
    this.sendFrame();
  }

  private sendFrame(): void {
    const tex = this.target();
    const sink = this.sink;
    if (!tex || !sink?.isConnected || !this.streamer) return;

    const src = this.currentSource();
    if (!src) return;

    if (this.canvas.width !== tex.width || this.canvas.height !== tex.height) {
      this.canvas.width = tex.width;
      this.canvas.height = tex.height;
      this.ctx = null;
    }
    if (!this.ctx) {
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
      if (!this.ctx) return;
    }
    const ctx = this.ctx;

    // object-fit: cover crop into the target texture box.
    const sw = src.width;
    const sh = src.height;
    if (sw === 0 || sh === 0) return;
    const scale = Math.max(tex.width / sw, tex.height / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    const dx = (tex.width - dw) / 2;
    const dy = (tex.height - dh) / 2;
    try {
      ctx.drawImage(src.el, dx, dy, dw, dh);
    } catch {
      return; // source not yet decodable (e.g. video with no data)
    }
    const img = ctx.getImageData(0, 0, tex.width, tex.height);
    const msg = this.streamer.frame(tex.width, tex.height, img.data);
    sink.setTexture(msg);

    this.lastBytes = msg.data.length;
    this.recordSent();
  }

  private currentSource(): { el: CanvasImageSource; width: number; height: number } | null {
    if (this.sourceKind === "file-image" && this.imageBitmap) {
      const w =
        "naturalWidth" in this.imageBitmap ? this.imageBitmap.naturalWidth : this.imageBitmap.width;
      const h =
        "naturalHeight" in this.imageBitmap
          ? this.imageBitmap.naturalHeight
          : this.imageBitmap.height;
      return { el: this.imageBitmap, width: w, height: h };
    }
    if (this.sourceKind === "file-video" || this.sourceKind === "camera") {
      if (this.video.videoWidth === 0) return null;
      return { el: this.video, width: this.video.videoWidth, height: this.video.videoHeight };
    }
    return null;
  }

  // -- stats ----------------------------------------------------------------
  private resetStats(): void {
    this.sentTimes = [];
    this.lastBytes = 0;
    if (!this.running) this.stats.textContent = "";
  }

  private recordSent(): void {
    const now = performance.now();
    this.sentTimes.push(now);
    while (this.sentTimes.length > 0 && now - this.sentTimes[0]! > 1000) this.sentTimes.shift();
    const fps = this.sentTimes.length;
    this.stats.textContent = `${fps} fps sent · ${this.lastBytes} B/frame`;
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.clearSource();
    this.streamer = null;
  }
}

const CSS = `
.fxvid { display:flex; flex-direction:column; gap:var(--sp-2); padding:var(--sp-2); min-width:14rem; }
.fxvid-controls { display:flex; flex-direction:column; gap:var(--sp-2); }
.fxvid-pick { align-items:center; }
.fxvid-file { font-size:var(--f-caption); color:var(--text-dim); max-width:100%; }
.fxvid-preview {
  position:relative; width:100%; aspect-ratio:16/9; background:#000;
  border:1px solid var(--border); border-radius:var(--r-ctrl); overflow:hidden;
}
.fxvid-video { width:100%; height:100%; object-fit:contain; display:block; background:#000; }
.fxvid-stats {
  font:12px/1.4 ui-monospace, monospace; color:var(--text-dim);
  font-variant-numeric:tabular-nums; min-height:1.2em; margin:0;
}
`;
