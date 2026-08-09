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
  /** Free the model from GPU memory (weights stay in the browser cache). */
  unload?: () => Promise<void>;
}
interface ModelRecord {
  model_id?: string;
  /** The HuggingFace URL the weights are fetched from. */
  model?: string;
  vram_required_MB?: number;
  low_resource_required?: boolean;
}
type AppConfig = { model_list?: ModelRecord[] };
interface WebLlmModule {
  prebuiltAppConfig?: AppConfig;
  CreateMLCEngine: (
    model: string,
    opts?: { initProgressCallback?: (r: { progress?: number; text?: string }) => void },
  ) => Promise<MlcEngine>;
  /** Whether the model's weights are already cached in the browser. */
  hasModelInCache?: (modelId: string, appConfig?: AppConfig) => Promise<boolean>;
  /** Evict a model's cached weights + metadata from the browser. */
  deleteModelAllInfoInCache?: (modelId: string, appConfig?: AppConfig) => Promise<void>;
  deleteModelInCache?: (modelId: string, appConfig?: AppConfig) => Promise<void>;
}

let modulePromise: Promise<WebLlmModule> | null = null;
let engine: MlcEngine | null = null;
let engineModel = "";

/**
 * web-llm only implements function calling for a FIXED, enumerated set of models
 * (the engine throws for any other model when `tools` is present — e.g. even
 * Hermes-3-Llama-3.2-3B is unsupported; only the 3.1-8B Hermes-3 variants are).
 * A name heuristic is therefore wrong: this must be the exact allow-list web-llm
 * publishes. Our AI features are tool-driven, so we never send tools to a model
 * outside this set (no crash) and the UI steers the user to a supported one.
 */
export const WEBLLM_TOOL_MODELS = new Set<string>([
  "Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC",
  "Hermes-2-Pro-Llama-3-8B-q4f32_1-MLC",
  "Hermes-2-Pro-Mistral-7B-q4f16_1-MLC",
  "Hermes-3-Llama-3.1-8B-q4f32_1-MLC",
  "Hermes-3-Llama-3.1-8B-q4f16_1-MLC",
]);

/** Whether web-llm can do tool/function calling for this exact model id. */
export function modelSupportsTools(id: string): boolean {
  return WEBLLM_TOOL_MODELS.has(id);
}

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

/** A browsable web-llm model entry (all MLC models are HuggingFace-hosted). */
export interface WebLlmModelCard {
  id: string;
  /** Approx GPU memory the model needs, if web-llm declares it. */
  vramMB: number | null;
  /** web-llm's "runs on low-resource devices" flag. */
  lowResource: boolean;
  /** Whether it can drive our tool-based features. */
  tools: boolean;
  /** Link to the model's HuggingFace page. */
  hfUrl: string | null;
}

function hfUrlFor(r: ModelRecord, id: string): string {
  if (typeof r.model === "string" && /^https?:\/\//.test(r.model)) return r.model;
  return `https://huggingface.co/mlc-ai/${id}`;
}

/** The prebuilt models web-llm can run, as browsable cards. */
export async function listWebLlmModelCards(): Promise<WebLlmModelCard[]> {
  const m = await loadModule();
  return (m.prebuiltAppConfig?.model_list ?? [])
    .map((r): WebLlmModelCard | null => {
      const id = typeof r.model_id === "string" ? r.model_id : "";
      if (!id) return null;
      return {
        id,
        vramMB: typeof r.vram_required_MB === "number" ? r.vram_required_MB : null,
        lowResource: r.low_resource_required === true,
        tools: modelSupportsTools(id),
        hfUrl: hfUrlFor(r, id),
      };
    })
    .filter((c): c is WebLlmModelCard => c !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
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

/** Is this model the one currently loaded into the active engine (this tab)? */
export function isModelLoaded(model: string): boolean {
  return engine !== null && engineModel === model;
}

/** Free the loaded model from GPU memory (weights stay cached in the browser). */
export async function unloadWebLlmModel(): Promise<void> {
  if (engine) {
    try {
      await engine.unload?.();
    } catch {
      // best-effort — drop the reference regardless
    }
  }
  engine = null;
  engineModel = "";
}

/** Whether the model's weights are already downloaded (cached) in the browser. */
export async function isModelDownloaded(model: string): Promise<boolean> {
  const m = await loadModule();
  if (typeof m.hasModelInCache !== "function") return false;
  try {
    return await m.hasModelInCache(model, m.prebuiltAppConfig);
  } catch {
    return false;
  }
}

/**
 * Download + cache a model's weights WITHOUT keeping it loaded on the GPU. web-llm
 * has no pure-download API, so we spin up a throwaway engine to fetch/compile
 * (populating the browser cache) and immediately unload it — leaving the weights
 * cached for a fast later load. If this model happens to be the active one, the
 * active engine is left intact.
 */
export async function downloadWebLlmModel(
  model: string,
  onProgress?: (p: InitProgress) => void,
): Promise<void> {
  if (isModelLoaded(model)) return; // already loaded ⇒ already downloaded
  const m = await loadModule();
  const tmp = await m.CreateMLCEngine(model, {
    initProgressCallback: (r) => onProgress?.({ progress: r.progress ?? 0, text: r.text ?? "" }),
  });
  try {
    await tmp.unload?.();
  } catch {
    // best-effort
  }
}

/** Delete a model's cached weights from the browser (unloads it first if active). */
export async function deleteWebLlmModel(model: string): Promise<void> {
  if (engineModel === model) await unloadWebLlmModel();
  const m = await loadModule();
  const del = m.deleteModelAllInfoInCache ?? m.deleteModelInCache;
  if (typeof del !== "function") {
    throw new Error("this web-llm build can't delete cached models");
  }
  await del(model, m.prebuiltAppConfig);
}

/** Build an in-browser WebGPU provider from its config. */
export function makeWebLlmProvider(cfg: WebLlmConfig): AiProvider {
  return {
    id: "webllm",
    // Tool-calling is per-model in web-llm (only a fixed set supports it), and no
    // prebuilt model does vision — so vision is always withheld and tools are
    // advertised only when the selected model actually supports them.
    capabilities: { tools: modelSupportsTools(cfg.model), vision: false },
    async send(messages: ChatMessage[], opts: SendOptions): Promise<SendResult> {
      if (!cfg.model.trim()) {
        throw new Error("no in-browser model selected (pick one in AI settings)");
      }
      if (!isWebLlmSupported()) {
        throw new Error("WebGPU is not available in this browser");
      }
      await loadWebLlmModel(cfg.model);
      if (!engine) throw new Error("in-browser model failed to load");
      const useTools = opts.tools.length > 0 && modelSupportsTools(cfg.model);
      // web-llm's Hermes function-calling path injects its OWN system prompt and
      // rejects a custom `system` message ("cannot specify customized system
      // prompt"). So when sending tools, don't emit a system role — fold our
      // system prompt into the first user turn instead. Without tools, a normal
      // system message is fine.
      const oaiMessages = toOpenAiMessages(useTools ? "" : opts.system, messages);
      if (useTools && opts.system) foldSystemIntoFirstUser(oaiMessages, opts.system);
      const req: Record<string, unknown> = {
        messages: oaiMessages,
        max_tokens: opts.maxTokens ?? 4000,
        stream: false,
      };
      if (useTools) {
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

/** Prepend `system` to the first string-content user message (or insert one). */
function foldSystemIntoFirstUser(messages: OaiMessage[], system: string): void {
  const first = messages.find((m) => m.role === "user" && typeof m.content === "string");
  if (first && typeof first.content === "string") {
    first.content = `${system}\n\n${first.content}`;
  } else {
    messages.unshift({ role: "user", content: system });
  }
}
