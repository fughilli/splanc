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
interface ModelRecord {
  model_id?: string;
  /** The HuggingFace URL the weights are fetched from. */
  model?: string;
  vram_required_MB?: number;
  low_resource_required?: boolean;
}
interface WebLlmModule {
  prebuiltAppConfig?: { model_list?: ModelRecord[] };
  CreateMLCEngine: (
    model: string,
    opts?: { initProgressCallback?: (r: { progress?: number; text?: string }) => void },
  ) => Promise<MlcEngine>;
}

let modulePromise: Promise<WebLlmModule> | null = null;
let engine: MlcEngine | null = null;
let engineModel = "";

/**
 * web-llm only implements function calling for a fixed set of models (the engine
 * throws for any other model when `tools` is present). Our AI features
 * (set_script effect generation + MIDI mapping) are entirely tool-driven, so we
 * gate on this: non-tool models are never sent tools (no crash), and the UI
 * steers the user to a tool-capable one. Kept as an explicit allow-list (from
 * web-llm's own supported set) plus a Hermes name heuristic for forward-compat.
 */
export const WEBLLM_TOOL_MODELS = new Set<string>([
  "Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC",
  "Hermes-2-Pro-Llama-3-8B-q4f32_1-MLC",
  "Hermes-2-Pro-Mistral-7B-q4f16_1-MLC",
  "Hermes-3-Llama-3.1-8B-q4f32_1-MLC",
  "Hermes-3-Llama-3.1-8B-q4f16_1-MLC",
]);

/** Whether web-llm can do tool/function calling for this model id. */
export function modelSupportsTools(id: string): boolean {
  return WEBLLM_TOOL_MODELS.has(id) || /hermes/i.test(id);
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
      const req: Record<string, unknown> = {
        messages: toOpenAiMessages(opts.system, messages),
        max_tokens: opts.maxTokens ?? 4000,
        stream: false,
      };
      // Defensive: only ever send tools to a model web-llm can tool-call for
      // (the loop already gates on capabilities, but this model may differ).
      if (opts.tools.length && modelSupportsTools(cfg.model)) {
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
