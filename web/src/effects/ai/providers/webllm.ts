/**
 * In-browser WebGPU provider (FUG-87) — the truest "on-device model" path, à la
 * pocketpal-ai: model weights are fetched from HuggingFace and cached in the
 * browser, and inference runs locally on the GPU via web-llm (MLC). Nothing
 * leaves the device.
 *
 * web-llm is loaded LAZILY from a CDN ESM URL rather than bundled, so it adds no
 * npm/lockfile dependency and no weight to the base bundle — it's fetched only
 * when the user actually selects the in-browser provider. web-llm exposes an
 * OpenAI-shaped `chat.completions.create`, so we reuse the OpenAI translators.
 *
 * This path is best-effort: it requires WebGPU and a first-run model download.
 */

import type {
  AiProvider,
  ChatMessage,
  SendOptions,
  SendResult,
  WebLlmConfig,
} from "../provider";
import {
  finishReasonToStop,
  fromOpenAiMessage,
  toOpenAiMessages,
  toOpenAiTools,
  type OaiMessage,
} from "./openaiCompat";

/** The web-llm ESM bundle. A `string`-typed specifier keeps tsc from trying to
 * resolve the URL as a module (which it would flag as missing). */
const CDN_URL: string = "https://esm.run/@mlc-ai/web-llm";

// -- minimal shape of the parts of web-llm we touch --------------------------

interface MlcEngine {
  chat: {
    completions: {
      create: (
        req: Record<string, unknown>,
      ) => Promise<{ choices?: { message?: OaiMessage; finish_reason?: string }[] }>;
    };
  };
}
interface WebLlmModule {
  prebuiltAppConfig?: { model_list?: { model_id?: string }[] };
  CreateMLCEngine: (
    model: string,
    opts?: { initProgressCallback?: (r: { progress?: number; text?: string }) => void },
  ) => Promise<MlcEngine>;
}

let modulePromise: Promise<WebLlmModule> | null = null;
let engine: MlcEngine | null = null;
let engineModel = "";

/** True when the browser exposes WebGPU (required for in-browser inference). */
export function isWebLlmSupported(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

async function loadModule(): Promise<WebLlmModule> {
  if (!modulePromise) {
    modulePromise = import(/* @vite-ignore */ CDN_URL) as Promise<WebLlmModule>;
  }
  return modulePromise;
}

/** The prebuilt models web-llm can run (ids include a quantization suffix). */
export async function listWebLlmModels(): Promise<string[]> {
  const m = await loadModule();
  return (m.prebuiltAppConfig?.model_list ?? [])
    .map((x) => x.model_id)
    .filter((id): id is string => typeof id === "string")
    .sort();
}

/** Progress of a first-run model download / GPU initialization. */
export interface InitProgress {
  /** 0..1 (best-effort; web-llm reports it during weight fetch + compile). */
  progress: number;
  text: string;
}

/**
 * Ensure the given model is loaded (downloading + caching its weights on first
 * use). Safe to call repeatedly; only reloads when the model changes.
 */
export async function loadWebLlmModel(
  model: string,
  onProgress?: (p: InitProgress) => void,
): Promise<void> {
  if (engine && engineModel === model) return;
  const m = await loadModule();
  engine = await m.CreateMLCEngine(model, {
    initProgressCallback: (r) => onProgress?.({ progress: r.progress ?? 0, text: r.text ?? "" }),
  });
  engineModel = model;
}

/** Build an in-browser WebGPU provider from its config. */
export function makeWebLlmProvider(cfg: WebLlmConfig): AiProvider {
  return {
    id: "webllm",
    // Prebuilt web-llm models generally do function calling but not vision, so
    // the vision tool is withheld (it would produce image blocks it can't use).
    capabilities: { tools: true, vision: false },
    async send(messages: ChatMessage[], opts: SendOptions): Promise<SendResult> {
      if (!cfg.model.trim()) {
        throw new Error("no in-browser model selected (pick one in AI settings)");
      }
      if (!isWebLlmSupported()) {
        throw new Error("WebGPU is not available in this browser");
      }
      await loadWebLlmModel(cfg.model);
      if (!engine) throw new Error("in-browser model failed to load");
      const req: Record<string, unknown> = {
        messages: toOpenAiMessages(opts.system, messages),
        max_tokens: opts.maxTokens ?? 4000,
        stream: false,
      };
      if (opts.tools.length) {
        req.tools = toOpenAiTools(opts.tools);
        req.tool_choice = "auto";
      }
      const reply = await engine.chat.completions.create(req);
      const choice = reply.choices?.[0];
      const message = choice?.message ?? { role: "assistant", content: "" };
      return {
        content: fromOpenAiMessage(message),
        stop_reason: finishReasonToStop(choice?.finish_reason),
      };
    },
  };
}
