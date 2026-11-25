/**
 * Kokoro-82M, the on-device voice (D-541 PR 8; owner decision D-549: the
 * default engine). Ported from the stage demo (agent/src/stage/page.ts), with
 * three changes for the app:
 *
 * - **The download is explicit.** Nothing is fetched until the user presses
 *   Download (Settings ▸ AI ▸ Voice, or the sheet the chat's speaker toggle
 *   opens). Until then the system voice reads. About 115 MB, once: the
 *   quantised model (92 MB, Hugging Face), the speech runtime (22 MB) and the
 *   kokoro-js library (2 MB, jsDelivr), plus 0.5 MB per voice used.
 * - **It runs in a worker**, so synthesis never stalls the editor or its live
 *   preview. The worker is an inline module (a Blob URL) that imports the
 *   pinned kokoro-js build from the CDN, as the stage page does.
 * - **CPU (WASM, q8) everywhere.** WebGPU would need the 326 MB fp32 model and
 *   hangs phone GPUs (the wllama finding); q8 on WASM is the size the owner
 *   chose (~90 MB of weights).
 *
 * The weights stay in the browser's Cache API (transformers.js's
 * "transformers-cache"; voices in "kokoro-voices"), so later sessions load
 * from disk. `remove()` deletes them. No key, no server of ours.
 */

import type { KokoroLike, SpeakOptions } from "./tts";

export const KOKORO_LIB_URL = "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js";
export const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
/** The weights file transformers.js caches under its remote URL (q8 = "_quantized"). */
export const KOKORO_WEIGHTS_URL = `https://huggingface.co/${KOKORO_MODEL}/resolve/main/onnx/model_quantized.onnx`;
const WEIGHTS_BYTES = 92_361_116;
/** What the user is told the first download costs (model + runtime + library). */
export const KOKORO_DOWNLOAD_MB = 115;
const MODEL_CACHE = "transformers-cache";
const VOICE_CACHE = "kokoro-voices";

export type KokoroState = "unknown" | "absent" | "downloading" | "cached" | "loading" | "ready" | "failed";

/** The worker as this module uses it (a real Worker, or a test fake). */
export interface WorkerLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
}

/** Plays synthesised audio. */
export interface AudioOut {
  play(samples: Float32Array, sampleRate: number, signal: AbortSignal): Promise<void>;
  stop(): void;
  /** From a user gesture: create/resume the audio context. */
  unlock(): void;
}

export interface CacheStoreLike {
  open(name: string): Promise<{ match(url: string): Promise<unknown>; keys(): Promise<readonly { url: string }[]>; delete(req: { url: string } | string): Promise<boolean> }>;
  delete(name: string): Promise<boolean>;
}

export interface KokoroDeps {
  spawn: () => WorkerLike;
  audio: AudioOut;
  /** The Cache API. Without it nothing persists: every session downloads. */
  caches?: CacheStoreLike | null;
  /** Synthesis stall guard (ms); tests shorten it. */
  stallMs?: (text: string) => number;
}

export interface KokoroProgress {
  loaded: number;
  total: number;
}

/** The worker: load the model (reporting download progress), then turn text
 * into samples, one request at a time. Plain JS: it runs from a Blob URL. */
export const KOKORO_WORKER_SOURCE = `
let tts = null;
let chain = Promise.resolve();
self.onmessage = (e) => {
  const m = e.data;
  chain = chain.then(() => handle(m)).catch((err) => {
    self.postMessage({ t: "error", id: m.id, message: String((err && err.message) || err) });
  });
};
async function handle(m) {
  if (m.t === "load") {
    const lib = await import(m.lib);
    tts = await lib.KokoroTTS.from_pretrained(m.model, {
      dtype: m.dtype,
      device: m.device,
      progress_callback: (p) => {
        if (p && p.status === "progress") self.postMessage({ t: "progress", file: p.file, loaded: p.loaded || 0, total: p.total || 0 });
      },
    });
    self.postMessage({ t: "ready" });
  } else if (m.t === "gen") {
    if (!tts) throw new Error("the voice is not loaded");
    const a = await tts.generate(m.text, { voice: m.voice, speed: m.speed });
    const audio = a.audio;
    self.postMessage({ t: "audio", id: m.id, audio: audio, rate: a.sampling_rate }, [audio.buffer]);
  }
}
`;

interface Pending {
  resolve: (v: { audio: Float32Array; rate: number }) => void;
  reject: (e: Error) => void;
}

export class KokoroVoice implements KokoroLike {
  readonly id = "kokoro" as const;
  private _state: KokoroState = "unknown";
  private _error = "";
  private _progress: KokoroProgress = { loaded: 0, total: WEIGHTS_BYTES };
  private files = new Map<string, KokoroProgress>();
  private worker: WorkerLike | null = null;
  private loadWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  private pending = new Map<number, Pending>();
  private nextId = 1;
  /** Synthesised-ahead clips, by voice|rate|text (bounded). */
  private clips = new Map<string, Promise<{ audio: Float32Array; rate: number }>>();
  private readonly listeners = new Set<() => void>();
  private probing: Promise<KokoroState> | null = null;
  /** The weights are in the browser cache (loading needs no download). */
  private onDisk = false;

  constructor(private readonly d: KokoroDeps) {}

  get state(): KokoroState {
    return this._state;
  }
  get error(): string {
    return this._error;
  }
  get progress(): KokoroProgress {
    return this._progress;
  }

  /** Called on every state / progress change. Returns the unsubscribe. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(state: KokoroState, error = ""): void {
    this._state = state;
    this._error = error;
    for (const fn of [...this.listeners]) fn();
  }

  ready(): boolean {
    return this._state === "ready";
  }

  /** Is the model on this device (in the Cache API)? */
  probe(): Promise<KokoroState> {
    if (this._state !== "unknown") return Promise.resolve(this._state);
    this.probing ??= (async () => {
      let have = false;
      const c = this.d.caches;
      if (c) {
        try {
          have = !!(await (await c.open(MODEL_CACHE)).match(KOKORO_WEIGHTS_URL));
        } catch {
          have = false;
        }
      }
      this.onDisk = have;
      if (this._state === "unknown") this.set(have ? "cached" : "absent");
      return this._state;
    })();
    return this.probing;
  }

  /** The explicit first-use download (also loads it). Resolves when ready. */
  download(): Promise<void> {
    if (this._state === "ready") return Promise.resolve();
    return this.start("downloading");
  }

  /** Load the downloaded model into memory: a no-op unless it is on disk. */
  load(): void {
    if (this._state !== "cached") return;
    void this.start("loading").catch(() => undefined);
  }

  whenReady(): Promise<void> {
    if (this._state === "cached") return this.start("loading");
    if (this._state === "loading" || this._state === "downloading")
      return new Promise<void>((resolve, reject) => this.loadWaiters.push({ resolve, reject }));
    return Promise.resolve();
  }

  private start(state: "downloading" | "loading"): Promise<void> {
    const p = new Promise<void>((resolve, reject) => this.loadWaiters.push({ resolve, reject }));
    if (this._state === "downloading" || this._state === "loading") return p;
    this.files.clear();
    this._progress = { loaded: 0, total: WEIGHTS_BYTES };
    this.set(state);
    let w: WorkerLike;
    try {
      w = this.d.spawn();
    } catch (e) {
      this.fail(e);
      return p;
    }
    this.worker = w;
    w.onmessage = (ev) => this.onMessage(w, ev.data as Record<string, unknown>);
    w.onerror = (ev) => {
      if (this.worker === w) this.fail(ev.message || "the voice worker stopped");
    };
    w.postMessage({ t: "load", lib: KOKORO_LIB_URL, model: KOKORO_MODEL, dtype: "q8", device: "wasm" });
    return p;
  }

  private onMessage(w: WorkerLike, m: Record<string, unknown>): void {
    if (this.worker !== w) return;
    switch (m["t"]) {
      case "progress": {
        this.files.set(String(m["file"]), { loaded: Number(m["loaded"]) || 0, total: Number(m["total"]) || 0 });
        let loaded = 0;
        let total = 0;
        for (const f of this.files.values()) {
          loaded += f.loaded;
          total += f.total;
        }
        this._progress = { loaded, total: Math.max(total, WEIGHTS_BYTES) };
        for (const fn of [...this.listeners]) fn();
        break;
      }
      case "ready": {
        this.onDisk = !!this.d.caches;
        this.set("ready");
        for (const l of this.loadWaiters.splice(0)) l.resolve();
        break;
      }
      case "audio": {
        const id = Number(m["id"]);
        const p = this.pending.get(id);
        this.pending.delete(id);
        p?.resolve({ audio: m["audio"] as Float32Array, rate: Number(m["rate"]) || 24000 });
        break;
      }
      case "error": {
        const id = m["id"];
        const message = String(m["message"] ?? "error");
        if (typeof id === "number" && this.pending.has(id)) {
          const p = this.pending.get(id)!;
          this.pending.delete(id);
          p.reject(new Error(message));
        } else if (this._state === "downloading" || this._state === "loading") this.fail(message);
        break;
      }
    }
  }

  private fail(e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    this.dropWorker();
    this.set("failed", message);
    for (const l of this.loadWaiters.splice(0)) l.reject(new Error(message));
  }

  private dropWorker(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error("the voice was unloaded"));
    this.pending.clear();
    this.clips.clear();
  }

  /** Free the memory (the model stays on disk; the next speech reloads it). */
  unload(): void {
    if (!this.worker) return;
    this.dropWorker();
    for (const l of this.loadWaiters.splice(0)) l.reject(new Error("cancelled"));
    this.set(this.onDisk ? "cached" : "absent");
  }

  /** Delete the downloaded voice from this device. */
  async remove(): Promise<void> {
    this.unload();
    const c = this.d.caches;
    if (c) {
      try {
        const cache = await c.open(MODEL_CACHE);
        for (const req of await cache.keys()) if (req.url.includes(KOKORO_MODEL)) await cache.delete(req);
        await c.delete(VOICE_CACHE);
      } catch {
        /* nothing cached */
      }
    }
    this.onDisk = false;
    this.set("absent");
  }

  private synth(text: string, o: SpeakOptions): Promise<{ audio: Float32Array; rate: number }> {
    const key = `${o.voice}|${o.rate}|${text}`;
    const have = this.clips.get(key);
    if (have) return have;
    const w = this.worker;
    if (!w || this._state !== "ready") return Promise.reject(new Error("the voice is not loaded"));
    const id = this.nextId++;
    const p = new Promise<{ audio: Float32Array; rate: number }>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({ t: "gen", id, text, voice: o.voice, speed: o.rate });
    });
    this.clips.set(key, p);
    p.catch(() => this.clips.delete(key));
    while (this.clips.size > 12) this.clips.delete(this.clips.keys().next().value!);
    return p;
  }

  prepare(text: string, o: SpeakOptions): void {
    if (this.ready()) void this.synth(text, o).catch(() => undefined);
  }

  async speak(text: string, o: SpeakOptions, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const key = `${o.voice}|${o.rate}|${text}`;
    const stall = this.d.stallMs?.(text) ?? 30_000 + text.length * 200;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clip = await Promise.race([
      this.synth(text, o),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("the voice took too long")), stall);
      }),
    ]).finally(() => clearTimeout(timer));
    this.clips.delete(key);
    if (signal.aborted) return;
    await this.d.audio.play(clip.audio, clip.rate, signal);
  }

  stop(): void {
    this.d.audio.stop();
  }

  unlock(): void {
    this.d.audio.unlock();
  }
}

// -- browser wiring ---------------------------------------------------------------

/** Web Audio output; the context is created on the first gesture. */
export function webAudioOut(): AudioOut {
  type Ctx = AudioContext;
  let ctx: Ctx | null = null;
  let src: AudioBufferSourceNode | null = null;
  const make = (): Ctx | null => {
    if (ctx) return ctx;
    const C = (globalThis as unknown as { AudioContext?: new () => Ctx; webkitAudioContext?: new () => Ctx }).AudioContext ??
      (globalThis as unknown as { webkitAudioContext?: new () => Ctx }).webkitAudioContext;
    ctx = C ? new C() : null;
    return ctx;
  };
  return {
    play(samples, rate, signal) {
      return new Promise<void>((resolve) => {
        const c = make();
        if (!c || signal.aborted) return resolve();
        if (c.state === "suspended") void c.resume().catch(() => undefined);
        const b = c.createBuffer(1, samples.length, rate);
        b.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
        const s = c.createBufferSource();
        s.buffer = b;
        s.connect(c.destination);
        src = s;
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          if (src === s) src = null;
          resolve();
        };
        const onAbort = (): void => {
          try {
            s.stop();
          } catch {
            /* not started */
          }
          finish();
        };
        s.onended = finish;
        signal.addEventListener("abort", onAbort);
        // A suspended context never ends a clip.
        const timer = setTimeout(finish, b.duration * 1000 + 3000);
        s.start();
      });
    },
    stop() {
      try {
        src?.stop();
      } catch {
        /* not started */
      }
      src = null;
    },
    unlock() {
      const c = make();
      if (c && c.state === "suspended") void c.resume().catch(() => undefined);
    },
  };
}

/** Could Kokoro run here at all (workers, WebAssembly, Web Audio)? */
export function kokoroSupported(): boolean {
  const g = globalThis as unknown as Record<string, unknown>;
  return typeof Worker !== "undefined" && typeof WebAssembly !== "undefined" && !!(g["AudioContext"] || g["webkitAudioContext"]);
}

/** A phone that reports little memory (Chrome's navigator.deviceMemory, GB). */
export function lowMemoryDevice(): boolean {
  const mem = typeof navigator !== "undefined" ? (navigator as unknown as { deviceMemory?: number }).deviceMemory : undefined;
  return typeof mem === "number" && mem > 0 && mem <= 2;
}

let app: KokoroVoice | null | undefined;

/** The app's Kokoro voice (null where it cannot run). */
export function appKokoro(): KokoroVoice | null {
  if (app !== undefined) return app;
  if (!kokoroSupported()) return (app = null);
  app = new KokoroVoice({
    spawn: () => {
      const url = URL.createObjectURL(new Blob([KOKORO_WORKER_SOURCE], { type: "text/javascript" }));
      const w = new Worker(url, { type: "module", name: "kokoro" });
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return w as unknown as WorkerLike;
    },
    audio: webAudioOut(),
    caches: typeof caches !== "undefined" ? (caches as unknown as CacheStoreLike) : null,
  });
  void app.probe();
  return app;
}
