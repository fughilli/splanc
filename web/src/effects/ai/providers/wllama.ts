/**
 * In-browser CPU provider (wllama = llama.cpp compiled to WASM).
 *
 * This is the PHONE-friendly on-device path. Unlike the WebGPU provider
 * (providers/webllm.ts), inference runs purely on the CPU (WASM) in wllama's Web
 * Worker(s), so it can't starve/hang a mobile GPU driver the way a big WebGPU
 * compute burst does (the "black blocks + freeze" failure on phones). NOTE: this
 * is ENFORCED, not automatic — wllama 3.6.1 defaults to offloading all layers to
 * WebGPU, so loadWllamaModel MUST pass `n_gpu_layers: 0` (see there). The trade-off
 * is speed: a small model (1–3B GGUF) at a few tokens/sec, but the device stays
 * fully responsive.
 *
 * wllama is a real bundled dependency (`@wllama/wllama`, pnpm-locked): the engine
 * JS is dynamic-imported so Vite code-splits it into its own chunk (kept off the
 * base bundle, loaded only when this provider is used), and the .wasm is bundled
 * as an app-origin asset (`?url`). Nothing is fetched from a CDN at runtime — only
 * the (multi-GB) GGUF model weights are a runtime download (then browser-cached).
 *
 * Threads: wllama defaults to floor(hardwareConcurrency / 2), already leaving CPU
 * headroom for the UI (the same instinct as pocketpal-ai's 80%-of-cores cap). We
 * only force single-thread when the page isn't cross-origin-isolated (no
 * SharedArrayBuffer → multi-thread wasm is unavailable anyway).
 *
 * Tools: wllama has no native function-calling, so tool use is a TEXT PROTOCOL —
 * we describe the tools in the system prompt, ask the model to emit
 * `<tool_call>{json}</tool_call>`, and parse those back into neutral tool_use
 * blocks. Reliable only on models trained for that convention, so tools are
 * advertised (capabilities.tools) ONLY for an allow-list; other models degrade to
 * plain chat. The translation + parsing here is pure and unit-tested
 * (web/tests/wllamaProvider.test.ts); the wllama runtime call is browser/CPU-only
 * and validated on-device.
 */

import type {
  AiProvider,
  ChatMessage,
  ContentBlock,
  SendOptions,
  SendResult,
  WllamaConfig,
} from "../provider";
// The wllama WASM binary, bundled as an app-origin asset by Vite (`?url` → the
// emitted asset's URL). NOT fetched from a CDN at runtime — only the (multi-GB)
// GGUF model weights are a runtime download. 3.6.1 ships a single universal wasm
// that the engine's AssetsPathConfig points at via `default`.
import wllamaWasmUrl from "@wllama/wllama/esm/wasm/wllama.wasm?url";
import {
  isResumableDownloadSupported,
  downloadModelResumable,
  cachedModelFile,
  isModelCached,
  deleteCachedModel,
} from "../resumableDownload";

// -- minimal shapes of the parts of wllama we touch --------------------------

interface WllamaInstance {
  loadModelFromUrl(url: string, params?: Record<string, unknown>): Promise<void>;
  /** Load already-fetched GGUF bytes (our resumable-download path uses this so
   * wllama's own non-resumable downloader is bypassed). */
  loadModel(blobs: Blob[], params?: Record<string, unknown>): Promise<void>;
  createChatCompletion(opts: Record<string, unknown>): Promise<ChatCompletionResponse>;
  isModelLoaded(): boolean;
  exit(): Promise<void>;
}
interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
}
/** wllama's cached-model handle (ModelManager.getModels()). */
interface WllamaCachedModel {
  url: string;
  size: number;
  remove(): Promise<void>;
}
interface WllamaModelManager {
  getModels(opts?: { includeInvalid?: boolean }): Promise<WllamaCachedModel[]>;
  downloadModel(
    url: string,
    opts?: { progressCallback?: (p: { loaded: number; total: number }) => void },
  ): Promise<unknown>;
}
interface WllamaModule {
  Wllama: new (assets: unknown, config?: Record<string, unknown>) => WllamaInstance;
  ModelManager: new () => WllamaModelManager;
}

/** Progress of a first-run model download / load (0..1 + a label). */
export interface WllamaProgress {
  progress: number;
  text: string;
}

// The tool text-protocol + message translation is pure and lives in a separate,
// engine-free module so the unit tests can import it without pulling in the
// top-level WASM `?url` asset (which the node test runtime can't resolve). Kept
// re-exported here so existing importers (aiSettings.ts) are unaffected.
import {
  wllamaModelSupportsTools,
  formatToolInstructions,
  messagesToWllama,
  parseToolCalls,
  recoverSetScriptFromProse,
} from "./wllamaProtocol";
export { wllamaModelSupportsTools, formatToolInstructions, messagesToWllama, parseToolCalls };

// =============================================================================
// Engine lifecycle (module-level, reused across turns).
// =============================================================================

let modulePromise: Promise<WllamaModule> | null = null;
let engine: WllamaInstance | null = null;
let engineModel = "";
let engineCtx = 0;

async function loadModule(): Promise<WllamaModule> {
  if (!modulePromise) {
    // Dynamic import of the bundled package → Vite splits it into its own lazy
    // chunk (served from the app origin), so the ~MB engine stays off the base
    // bundle but is never fetched from a third-party CDN.
    modulePromise = import("@wllama/wllama/esm/index.js").then(
      (mod) => mod as unknown as WllamaModule,
    );
  }
  return modulePromise;
}

/** Cross-origin-isolated pages get SharedArrayBuffer → wllama can multi-thread;
 * otherwise force single-thread (multi-thread wasm can't load anyway). */
function threadCount(configured: number): number | undefined {
  const isolated = typeof globalThis !== "undefined" && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  if (!isolated) return 1; // no SAB → single-thread
  if (configured > 0) return configured;
  return undefined; // let wllama pick floor(hardwareConcurrency / 2)
}

/** A held screen wake-lock (subset of WakeLockSentinel). */
interface WakeSentinel {
  release(): Promise<void>;
}

/** Request a screen wake-lock for the duration of a (possibly multi-minute)
 * on-device inference so the phone doesn't auto-lock — which suspends the WASM
 * worker mid-turn (the model appears to "hang", and any progress telemetry
 * stops). Best-effort: returns null where the API is absent (non-secure context,
 * unsupported browser) or the request is refused. The lock auto-releases if the
 * page is hidden, so it prevents the idle screen-timeout, not deliberate
 * backgrounding. */
async function acquireWakeLock(): Promise<WakeSentinel | null> {
  try {
    const wl = (navigator as { wakeLock?: { request(type: string): Promise<WakeSentinel> } })
      .wakeLock;
    if (!wl) return null;
    return await wl.request("screen");
  } catch {
    return null;
  }
}

/** True when the browser can run wllama at all (WebAssembly present). */
export function isWllamaSupported(): boolean {
  return typeof WebAssembly !== "undefined";
}

/** LoadModelParams shared by both load paths. `n_gpu_layers: 0` forces CPU-only
 * (see the loadWllamaModel note); never remove it. */
function loadParams(nCtx: number, nThreads: number): Record<string, unknown> {
  const threads = threadCount(nThreads);
  return {
    // CRITICAL: force CPU-only. wllama 3.6.1 DEFAULTS to n_gpu_layers 99999 (offload
    // every layer to WebGPU) — which is exactly the mobile GPU path that starves the
    // display compositor and freezes the phone ("black blocks"). 0 → the engine sets
    // noWebGPU and runs purely on the CPU/WASM, so the device stays responsive. This
    // is the whole reason this provider exists; never remove it.
    n_gpu_layers: 0,
    n_ctx: nCtx,
    ...(threads !== undefined ? { n_threads: threads } : {}),
  };
}

/** Load `model` (a GGUF URL) into the engine if not already the active one.
 * When OPFS is available the weights are fetched via the resumable/checkpointed
 * downloader (survives backgrounding) and handed to wllama as a Blob; otherwise
 * we fall back to wllama's own (non-resumable) URL downloader. */
export async function loadWllamaModel(
  model: string,
  nCtx: number,
  nThreads: number,
  onProgress?: (p: WllamaProgress) => void,
): Promise<void> {
  if (engine && engineModel === model && engineCtx === nCtx && engine.isModelLoaded()) return;
  await unloadWllamaModel();
  const { Wllama } = await loadModule();
  // Point the engine at the bundled, app-origin wasm asset (3.6.1 uses one
  // universal wasm via `default`) — no CDN, no wasm-from-cdn helper.
  const inst = new Wllama({ default: wllamaWasmUrl });
  const params = loadParams(nCtx, nThreads);

  if (isResumableDownloadSupported() && !isSplitModel(model)) {
    // Resumable path: fetch (or reuse) the checkpointed file, then load the bytes.
    const file =
      (await cachedModelFile(model)) ??
      (await downloadModelResumable(model, {
        onProgress: (p) =>
          onProgress?.({ progress: p.total ? p.loaded / p.total : 0, text: "Downloading…" }),
      }));
    onProgress?.({ progress: 1, text: "Loading…" });
    await inst.loadModel([file], params);
  } else {
    // Fallback: wllama's own downloader (no resume) — used when OPFS is
    // unavailable or for split (multi-part) GGUFs the resumable path can't join.
    await inst.loadModelFromUrl(model, {
      ...params,
      ...(onProgress
        ? {
            progressCallback: ({ loaded, total }: { loaded: number; total: number }) =>
              onProgress({ progress: total ? loaded / total : 0, text: "Loading…" }),
          }
        : {}),
    });
  }
  engine = inst;
  engineModel = model;
  engineCtx = nCtx;
}

/** wllama split (multi-part) GGUFs — "…-00001-of-00003.gguf". The resumable
 * downloader handles single files; split models fall back to wllama's joiner. */
function isSplitModel(url: string): boolean {
  return /-\d{5}-of-\d{5}\.gguf(\?.*)?$/i.test(url);
}

/** Free the loaded model + worker(s). */
export async function unloadWllamaModel(): Promise<void> {
  if (engine) {
    try {
      await engine.exit();
    } catch {
      // best-effort
    }
  }
  engine = null;
  engineModel = "";
  engineCtx = 0;
}

// -- model cache management (mirrors the web-llm provider so the settings UI can
//    share one model-manager component) -------------------------------------

let modelManager: WllamaModelManager | null = null;
async function getModelManager(): Promise<WllamaModelManager> {
  const mod = await loadModule();
  if (!modelManager) modelManager = new mod.ModelManager();
  return modelManager;
}

/** Whether to use our resumable/checkpointed store for this model (single-file
 * GGUF + OPFS available) vs. wllama's own downloader (split models / no OPFS). */
function useResumableStore(url: string): boolean {
  return isResumableDownloadSupported() && !isSplitModel(url);
}

/** Is this model's weights already downloaded (cached) in the browser? */
export async function isWllamaModelDownloaded(url: string): Promise<boolean> {
  if (useResumableStore(url)) return isModelCached(url);
  try {
    const models = await (await getModelManager()).getModels();
    return models.some((m) => m.url === url);
  } catch {
    return false;
  }
}

/** Is this model the one currently loaded into the active engine (this tab)? */
export function isWllamaModelLoaded(url: string): boolean {
  return engine !== null && engineModel === url;
}

/** Download + cache a model's weights WITHOUT loading it onto the CPU. Resumable
 * (checkpointed) so backgrounding the app doesn't force a full re-download. */
export async function downloadWllamaModel(
  url: string,
  onProgress?: (p: WllamaProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (useResumableStore(url)) {
    await downloadModelResumable(url, {
      onProgress: (p) =>
        onProgress?.({ progress: p.total ? p.loaded / p.total : 0, text: "Downloading…" }),
      signal,
    });
    return;
  }
  const mm = await getModelManager();
  await mm.downloadModel(url, {
    progressCallback: ({ loaded, total }) =>
      onProgress?.({ progress: total ? loaded / total : 0, text: "Downloading…" }),
  });
}

/** Delete a model's cached weights (unloads it first if it's the active one). */
export async function deleteWllamaModel(url: string): Promise<void> {
  if (engineModel === url) await unloadWllamaModel();
  if (useResumableStore(url)) {
    await deleteCachedModel(url);
    return;
  }
  const models = await (await getModelManager()).getModels();
  const m = models.find((x) => x.url === url);
  if (m) await m.remove();
}

/** Build an in-browser CPU (wllama) provider from its config. */
export function makeWllamaProvider(cfg: WllamaConfig): AiProvider {
  return {
    id: "wllama",
    // Tools only for models that reliably emit the text convention; no vision.
    capabilities: { tools: wllamaModelSupportsTools(cfg.model), vision: false },
    async send(messages: ChatMessage[], opts: SendOptions): Promise<SendResult> {
      if (!cfg.model.trim()) {
        throw new Error("no in-browser CPU model selected (pick one in AI settings)");
      }
      if (!isWllamaSupported()) throw new Error("WebAssembly is not available in this browser");
      const useTools = opts.tools.length > 0 && wllamaModelSupportsTools(cfg.model);
      const system = useTools ? opts.system + formatToolInstructions(opts.tools) : opts.system;
      await loadWllamaModel(cfg.model, cfg.contextWindowSize, cfg.nThreads);
      if (!engine) throw new Error("in-browser CPU model failed to load");

      // Progress tracking for the status line: on-device CPU inference is slow, so
      // we surface prefill/generation progress. A rough chars→tokens estimate feeds
      // the "prefilling ~N tok" label; t0/tokCount/firstAt drive the heartbeat below.
      const wllamaMessages = messagesToWllama(system, messages);
      const promptChars = wllamaMessages.reduce((n, m) => n + m.content.length, 0);
      const tokEst = Math.round(promptChars / 3.6); // rough chars→tokens
      const t0 = Date.now();
      let tokCount = 0;
      let firstAt = 0;
      opts.stream?.onStatus?.(`prefilling ~${tokEst} tok (ctx ${cfg.contextWindowSize})…`);
      // Hold the screen awake for the whole turn so an idle auto-lock can't
      // suspend the worker mid-prefill (best-effort; released in every exit path).
      const wake = await acquireWakeLock();
      // A heartbeat that updates the status EVEN if no token ever streams (a long
      // prefill): the model runs in a worker, so the main thread is free. tok=0 for
      // a long time ⇒ still prefilling; tok climbing ⇒ generating (just slow).
      const beat = window.setInterval(() => {
        const secs = Math.round((Date.now() - t0) / 1000);
        opts.stream?.onStatus?.(
          firstAt ? `generating (${tokCount} tok, ${secs}s)` : `prefilling… (${secs}s, ~${tokEst}/${cfg.contextWindowSize} ctx)`,
        );
      }, 2000);

      let full = "";
      const onData = (chunk: unknown): void => {
        // First chunk marks the prefill→generate transition (flips the status line).
        if (firstAt === 0) firstAt = Date.now();
        // wllama's ChatCompletionChunk is OpenAI-shaped; be tolerant of the exact
        // field so a version nudge doesn't silently drop the stream.
        const c = chunk as {
          choices?: { delta?: { content?: string; reasoning_content?: string } }[];
          currentText?: string;
        };
        const delta = c.choices?.[0]?.delta?.content;
        // Reasoning models (e.g. Qwen3) stream chain-of-thought in a SEPARATE
        // `reasoning_content` field. We disable thinking below, but if a model
        // still emits it, surface it to the live transcript + progress counter so
        // the turn doesn't look frozen — WITHOUT appending it to `full` (it must
        // not leak into the parsed script / tool call).
        const reason = c.choices?.[0]?.delta?.reasoning_content;
        if (typeof delta === "string" && delta) {
          full += delta;
          tokCount++;
          opts.stream?.onText?.(delta);
        } else if (typeof reason === "string" && reason) {
          tokCount++;
          opts.stream?.onText?.(reason);
        } else if (typeof c.currentText === "string" && c.currentText.length > full.length) {
          const d = c.currentText.slice(full.length);
          full = c.currentText;
          tokCount++;
          opts.stream?.onText?.(d);
        }
      };

      let resp: ChatCompletionResponse | undefined;
      try {
        resp = await engine.createChatCompletion({
          messages: wllamaMessages,
          // Bound generation: a real effect program (+ the JSON tool-call envelope)
          // is well under 1024 tokens, and on a phone CPU every extra token costs
          // ~0.3–0.5s. A former 2048 default meant a model that rambled instead of
          // finishing burned minutes PER repair round (a failing turn once ran ~50
          // min on-device). 1024 keeps ample headroom while capping the worst case.
          n_predict: opts.maxTokens ?? 1024,
          stream: true,
          onData,
          // Disable chain-of-thought on reasoning models (Qwen3 et al.): for
          // structured tool-call authoring the <think> block is pure latency
          // (minutes of CPU decode before any answer) and doesn't reach `content`.
          // A jinja template that doesn't know this kwarg simply ignores it.
          chat_template_kwargs: { enable_thinking: false },
          // Reuse the KV of the previous completion's common prefix (llama.cpp
          // prompt cache). The system block is a constant prefix across turns, and
          // warmUp() pre-decodes it at boot, so the first user turn — and every
          // follow-up — skips re-prefilling the (large) shared prefix.
          cache_prompt: true,
          ...(opts.signal ? { abortSignal: opts.signal } : {}),
        });
      } catch (e) {
        clearInterval(beat);
        void wake?.release().catch(() => undefined);
        throw e;
      }
      clearInterval(beat);
      void wake?.release().catch(() => undefined);
      // stream:true + onData resolves to void; if a build returned the response
      // object instead, fall back to its content so we never lose the reply.
      if (!full && resp?.choices?.[0]?.message?.content) full = resp.choices[0].message.content;

      if (!useTools) {
        return { content: [{ type: "text", text: full }], stop_reason: "end_turn" };
      }
      const { calls, text } = parseToolCalls(full);
      // Prose-recovery fallback: small models routinely NARRATE a program (in a
      // ``` block or bare) instead of emitting the set_script tool call, so the
      // edit would otherwise be dropped and the user just sees code in the chat.
      // When there's no set_script call but the reply contains a real program,
      // synthesize the call so the effect still applies. (Measured essential in
      // tools/model_eval — eff% >> native tool% for every sub-3B model.)
      if (!calls.some((c) => c.name === "set_script")) {
        const recovered = recoverSetScriptFromProse(full);
        if (recovered) calls.push(recovered);
      }
      const content: ContentBlock[] = [];
      if (text) content.push({ type: "text", text });
      for (const [i, call] of calls.entries()) {
        content.push({ type: "tool_use", id: `wllama_${i}`, name: call.name, input: call.input });
      }
      return { content, stop_reason: calls.length > 0 ? "tool_use" : "end_turn" };
    },
    async warmUp(system: string): Promise<void> {
      try {
        if (!cfg.model.trim() || !isWllamaSupported()) return;
        await loadWllamaModel(cfg.model, cfg.contextWindowSize, cfg.nThreads);
        if (!engine) return;
        // Prime the prefill with the system prompt so its KV is resident before
        // the first real turn. Use the SAME leading `system` message the turn will
        // send (messagesToWllama puts it first) + cache_prompt, so the turn reuses
        // this decoded prefix instead of re-prefilling it. CPU-only, so this is
        // safe to run at boot even on a phone — it never touches the GPU.
        await engine.createChatCompletion({
          messages: [
            { role: "system", content: system },
            { role: "user", content: "Ready?" },
          ],
          n_predict: 1,
          stream: false,
          cache_prompt: true,
          chat_template_kwargs: { enable_thinking: false },
        });
      } catch {
        // warm-up is a pure optimization — never throw.
      }
    },
  };
}
