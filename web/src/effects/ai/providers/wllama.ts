/**
 * In-browser CPU provider (wllama = llama.cpp compiled to WASM).
 *
 * This is the PHONE-friendly on-device path. Unlike the WebGPU provider
 * (providers/webllm.ts), inference runs on the CPU in wllama's Web Worker(s) and
 * NEVER touches the display GPU — so it can't starve/hang a mobile GPU driver the
 * way a big WebGPU compute burst does (the "black blocks + freeze" failure on
 * phones). The trade-off is speed: it's a small model (1–3B GGUF) at a few
 * tokens/sec, but the device stays fully responsive.
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

// -- minimal shapes of the parts of wllama we touch --------------------------

interface WllamaInstance {
  loadModelFromUrl(url: string, params?: Record<string, unknown>): Promise<void>;
  createChatCompletion(opts: Record<string, unknown>): Promise<ChatCompletionResponse>;
  isModelLoaded(): boolean;
  exit(): Promise<void>;
}
interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
}
interface WllamaModule {
  Wllama: new (assets: unknown, config?: Record<string, unknown>) => WllamaInstance;
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

/** True when the browser can run wllama at all (WebAssembly present). */
export function isWllamaSupported(): boolean {
  return typeof WebAssembly !== "undefined";
}

/** Load `model` (a GGUF URL) into the engine if not already the active one. */
export async function loadWllamaModel(
  model: string,
  nCtx: number,
  nThreads: number,
): Promise<void> {
  if (engine && engineModel === model && engineCtx === nCtx && engine.isModelLoaded()) return;
  await unloadWllamaModel();
  const { Wllama } = await loadModule();
  // Point the engine at the bundled, app-origin wasm asset (3.6.1 uses one
  // universal wasm via `default`) — no CDN, no wasm-from-cdn helper.
  const inst = new Wllama({ default: wllamaWasmUrl });
  const threads = threadCount(nThreads);
  await inst.loadModelFromUrl(model, {
    n_ctx: nCtx,
    ...(threads !== undefined ? { n_threads: threads } : {}),
  });
  engine = inst;
  engineModel = model;
  engineCtx = nCtx;
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

      let full = "";
      const onData = (chunk: unknown): void => {
        // wllama's ChatCompletionChunk is OpenAI-shaped; be tolerant of the exact
        // field so a version nudge doesn't silently drop the stream.
        const c = chunk as {
          choices?: { delta?: { content?: string } }[];
          currentText?: string;
        };
        const delta = c.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) {
          full += delta;
          opts.stream?.onText?.(delta);
        } else if (typeof c.currentText === "string" && c.currentText.length > full.length) {
          const d = c.currentText.slice(full.length);
          full = c.currentText;
          opts.stream?.onText?.(d);
        }
      };

      const resp = await engine.createChatCompletion({
        messages: messagesToWllama(system, messages),
        n_predict: opts.maxTokens ?? 2048,
        stream: true,
        onData,
        ...(opts.signal ? { abortSignal: opts.signal } : {}),
      });
      // stream:true + onData resolves to void; if a build returned the response
      // object instead, fall back to its content so we never lose the reply.
      if (!full && resp?.choices?.[0]?.message?.content) full = resp.choices[0].message.content;

      if (!useTools) {
        return { content: [{ type: "text", text: full }], stop_reason: "end_turn" };
      }
      const { calls, text } = parseToolCalls(full);
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
        // Prime the prefill with the system prompt (1 token). CPU-only, so this is
        // safe to run at boot even on a phone — it never touches the GPU.
        await engine.createChatCompletion({
          messages: [{ role: "user", content: system }],
          n_predict: 1,
          stream: false,
        });
      } catch {
        // warm-up is a pure optimization — never throw.
      }
    },
  };
}
