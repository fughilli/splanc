/**
 * Fakes for the on-device AI runtimes (FUG-87, docs/design/on-device-models.md)
 * so node:test can drive the REAL providers end to end without a GPU, WASM or
 * network:
 *
 *   - {@link wllamaFake}: a scriptable `@wllama/wllama` module (the in-browser
 *     CPU engine) — records every load (URL vs. downloaded blob + its params) and
 *     chat completion, and streams a configured reply through `onData`;
 *   - {@link webllmFake}: a scriptable `@mlc-ai/web-llm` module (the WebGPU
 *     engine) — prebuilt catalog, worker/main-thread engine creation, the weight
 *     cache, and recorded `chat.completions.create` requests;
 *   - {@link FakeDir} / {@link installOpfs}: an in-memory Origin Private File
 *     System (the resumable model downloader's checkpoint store);
 *   - {@link setNavigator}: a `navigator` override (user agent, WebGPU, OPFS).
 *
 * The engine stubs are registered on import (via moduleStubs), so import this
 * module before any provider loads its engine.
 */

import { stubModule } from "./moduleStubs";

// -- @wllama/wllama -------------------------------------------------------------

export interface WllamaLoad {
  method: "loadModelFromUrl" | "loadModel";
  url: string | null;
  blobs: Blob[];
  params: Record<string, unknown>;
}

class FakeWllamaEngine {
  private loaded = false;
  readonly loads: WllamaLoad[] = [];
  readonly completions: Record<string, unknown>[] = [];
  exited = false;
  constructor(readonly assets: unknown) {
    wllamaFake.engines.push(this);
  }
  async loadModelFromUrl(url: string, params: Record<string, unknown> = {}): Promise<void> {
    this.loads.push({ method: "loadModelFromUrl", url, blobs: [], params });
    const cb = params["progressCallback"] as ((p: { loaded: number; total: number }) => void) | undefined;
    cb?.({ loaded: 1, total: 4 });
    cb?.({ loaded: 4, total: 4 });
    this.loaded = true;
  }
  async loadModel(blobs: Blob[], params: Record<string, unknown> = {}): Promise<void> {
    this.loads.push({ method: "loadModel", url: null, blobs, params });
    this.loaded = true;
  }
  isModelLoaded(): boolean {
    return this.loaded;
  }
  async exit(): Promise<void> {
    this.exited = true;
    this.loaded = false;
  }
  async createChatCompletion(opts: Record<string, unknown>): Promise<unknown> {
    this.completions.push(opts);
    const onData = opts["onData"] as ((chunk: unknown) => void) | undefined;
    const text = wllamaFake.replies.shift() ?? wllamaFake.reply;
    if (opts["stream"] && onData) {
      for (const piece of text.match(/[\s\S]{1,8}/g) ?? []) onData({ choices: [{ delta: { content: piece } }] });
      return undefined;
    }
    return { choices: [{ message: { content: text } }] };
  }
}

/** wllama's own (non-resumable) downloader/cache, used for split GGUFs / no OPFS. */
class FakeWllamaModelManager {
  async getModels(): Promise<{ url: string; size: number; remove(): Promise<void> }[]> {
    return [...wllamaFake.managerCache].map((url) => ({
      url,
      size: 1,
      remove: async () => void wllamaFake.managerCache.delete(url),
    }));
  }
  async downloadModel(
    url: string,
    opts: { progressCallback?: (p: { loaded: number; total: number }) => void } = {},
  ): Promise<void> {
    opts.progressCallback?.({ loaded: 2, total: 4 });
    wllamaFake.managerCache.add(url);
  }
}

export const wllamaFake = {
  /** Every engine instance the provider constructed (newest last). */
  engines: [] as FakeWllamaEngine[],
  /** Queued answers, one per completion; then {@link reply} for the rest. */
  replies: [] as string[],
  /** What the CPU model answers once the queue is empty. */
  reply: "ok",
  /** URLs held by wllama's own model cache (the non-OPFS fallback). */
  managerCache: new Set<string>(),
  get last(): FakeWllamaEngine {
    const e = this.engines[this.engines.length - 1];
    if (!e) throw new Error("no wllama engine was created");
    return e;
  },
  reset(): void {
    this.engines.length = 0;
    this.replies.length = 0;
    this.reply = "ok";
    this.managerCache.clear();
  },
};

stubModule("@wllama/wllama/esm/index.js", { Wllama: FakeWllamaEngine, ModelManager: FakeWllamaModelManager });

// -- @mlc-ai/web-llm ------------------------------------------------------------

export interface WebLlmEngineRecord {
  model: string;
  /** The Worker it runs in, or null for the main-thread engine. */
  worker: unknown;
  chatOpts: unknown;
  requests: Record<string, unknown>[];
  unloaded: boolean;
}

function makeMlcEngine(rec: WebLlmEngineRecord): unknown {
  return {
    chat: {
      completions: {
        create: async (req: Record<string, unknown>) => {
          rec.requests.push(req);
          const next = webllmFake.replies.shift();
          return next
            ? { choices: [{ message: next.message, finish_reason: next.finishReason }] }
            : { choices: [{ message: webllmFake.reply, finish_reason: webllmFake.finishReason }] };
        },
      },
    },
    unload: async () => {
      rec.unloaded = true;
    },
  };
}

export const webllmFake = {
  engines: [] as WebLlmEngineRecord[],
  /** Model ids whose weights are already in the browser cache. */
  cached: new Set<string>(),
  /** Whether this web-llm build offers the Web Worker engine. */
  workerEngine: true,
  /** Queued answers, one per request; then {@link reply}/{@link finishReason}. */
  replies: [] as { message: Record<string, unknown>; finishReason: string }[],
  reply: { role: "assistant", content: "ok" } as Record<string, unknown>,
  finishReason: "stop",
  reset(): void {
    this.engines.length = 0;
    this.replies.length = 0;
    this.cached.clear();
    this.workerEngine = true;
    this.reply = { role: "assistant", content: "ok" };
    this.finishReason = "stop";
  },
};

type InitProgress = (r: { progress?: number; text?: string }) => void;
function createEngine(worker: unknown, model: string, opts?: { initProgressCallback?: InitProgress }, chatOpts?: unknown): unknown {
  const rec: WebLlmEngineRecord = { model, worker, chatOpts, requests: [], unloaded: false };
  webllmFake.engines.push(rec);
  opts?.initProgressCallback?.({ progress: 0.5, text: "Fetching param cache" });
  opts?.initProgressCallback?.({ progress: 1, text: "Finish loading" });
  webllmFake.cached.add(model);
  return makeMlcEngine(rec);
}

stubModule("@mlc-ai/web-llm", {
  prebuiltAppConfig: {
    model_list: [
      { model_id: "Hermes-3-Llama-3.1-8B-q4f16_1-MLC", vram_required_MB: 4876, low_resource_required: false },
      { model_id: "Qwen2.5-3B-Instruct-q4f16_1-MLC", vram_required_MB: 2504, low_resource_required: true },
    ],
  },
  get CreateWebWorkerMLCEngine() {
    return webllmFake.workerEngine
      ? async (worker: unknown, model: string, opts?: { initProgressCallback?: InitProgress }, chatOpts?: unknown) =>
          createEngine(worker, model, opts, chatOpts)
      : undefined;
  },
  CreateMLCEngine: async (model: string, opts?: { initProgressCallback?: InitProgress }, chatOpts?: unknown) =>
    createEngine(null, model, opts, chatOpts),
  hasModelInCache: async (id: string) => webllmFake.cached.has(id),
  deleteModelAllInfoInCache: async (id: string) => void webllmFake.cached.delete(id),
});

// -- Origin Private File System -------------------------------------------------

class FakeWritable {
  private buf: Uint8Array<ArrayBuffer>;
  private pos = 0;
  constructor(
    private readonly file: FakeFileHandle,
    keepExistingData: boolean,
  ) {
    this.buf = keepExistingData ? file.data.slice() : new Uint8Array(0);
  }
  async seek(p: number): Promise<void> {
    this.pos = p;
  }
  async write(chunk: Uint8Array | string): Promise<void> {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    const end = this.pos + bytes.length;
    if (end > this.buf.length) {
      const grown = new Uint8Array(end);
      grown.set(this.buf);
      this.buf = grown;
    }
    this.buf.set(bytes, this.pos);
    this.pos = end;
  }
  /** Like OPFS, writes land in the file only when the stream is closed. */
  async close(): Promise<void> {
    this.file.data = this.buf;
  }
}

export class FakeFileHandle {
  data: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  constructor(readonly name: string) {}
  async getFile(): Promise<File> {
    return new File([this.data], this.name);
  }
  async createWritable(opts: { keepExistingData?: boolean } = {}): Promise<FakeWritable> {
    return new FakeWritable(this, opts.keepExistingData === true);
  }
}

export class FakeDir {
  readonly files = new Map<string, FakeFileHandle>();
  readonly dirs = new Map<string, FakeDir>();
  async getDirectoryHandle(name: string, opts: { create?: boolean } = {}): Promise<FakeDir> {
    let d = this.dirs.get(name);
    if (!d) {
      if (!opts.create) throw new DOMException(`${name} not found`, "NotFoundError");
      d = new FakeDir();
      this.dirs.set(name, d);
    }
    return d;
  }
  async getFileHandle(name: string, opts: { create?: boolean } = {}): Promise<FakeFileHandle> {
    let f = this.files.get(name);
    if (!f) {
      if (!opts.create) throw new DOMException(`${name} not found`, "NotFoundError");
      f = new FakeFileHandle(name);
      this.files.set(name, f);
    }
    return f;
  }
  async removeEntry(name: string): Promise<void> {
    if (!this.files.delete(name)) throw new DOMException(`${name} not found`, "NotFoundError");
  }
}

// -- navigator ------------------------------------------------------------------

const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

/** Replace `navigator` with a plain object: `userAgent` (desktop Chrome by
 * default) plus the given overrides (`gpu`, `storage`, …). */
export function setNavigator(overrides: Record<string, unknown> = {}): void {
  Object.defineProperty(globalThis, "navigator", {
    value: {
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      hardwareConcurrency: 8,
      ...overrides,
    },
    configurable: true,
    writable: true,
  });
}

/** Put an in-memory OPFS behind `navigator.storage` (keeping other overrides). */
export function installOpfs(navOverrides: Record<string, unknown> = {}): FakeDir {
  const root = new FakeDir();
  setNavigator({ ...navOverrides, storage: { getDirectory: async () => root } });
  (globalThis as Record<string, unknown>)["FileSystemWritableFileStream"] = FakeWritable;
  return root;
}

/** Undo {@link setNavigator} / {@link installOpfs}. */
export function restoreNavigator(): void {
  if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
  delete (globalThis as Record<string, unknown>)["FileSystemWritableFileStream"];
}

/** Let promise chains + the providers' async engine loads settle (no timers). */
export async function flushAsync(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}
