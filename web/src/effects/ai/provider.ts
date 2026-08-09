/**
 * AI provider abstraction (FUG-87).
 *
 * The effect editor's AI features — NL→effect generation and MIDI remapping —
 * were originally wired straight to Anthropic's Messages API. This module
 * generalizes that into a small provider interface so the SAME tool-use loop
 * (see generate.ts `chatTurn`) can run against:
 *   - Anthropic (cloud, BYO key) — the default, unchanged behavior;
 *   - a local OpenAI-compatible server (Ollama / LM Studio / llama.cpp / vLLM)
 *     — "download a GGUF from HuggingFace and run it on your own machine";
 *   - an in-browser WebGPU model (web-llm / MLC) — weights fetched from
 *     HuggingFace and cached in the browser, à la pocketpal-ai.
 *
 * The neutral message/tool representation is Anthropic-shaped (content blocks
 * with tool_use / tool_result / image), which is expressive enough to drive the
 * loop; each provider translates that to/from its own wire format at its edge.
 *
 * Everything here is client-side: no server proxy, config in localStorage.
 */

// =============================================================================
// Neutral wire types (shared by generate.ts and every provider).
// =============================================================================

/** A content block in a conversation message (the subset the loop produces). */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: (
        | { type: "text"; text: string }
        | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
      )[];
      is_error?: boolean;
    };

/** A full conversation message (chat history is an array of these). */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

/** A tool the model may call. `input_schema` is a JSON Schema object. */
export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** What a provider can do — drives graceful degradation in the loop. */
export interface ProviderCapabilities {
  /** Function/tool calling. If false, the loop runs plain-chat only. */
  tools: boolean;
  /** Image inputs (the `capture_preview` vision tool). If false, that tool is
   * withheld so no image blocks are ever produced. */
  vision: boolean;
}

/** Options for one request round. */
export interface SendOptions {
  system: string;
  tools: readonly ToolDef[];
  signal?: AbortSignal | undefined;
  maxTokens?: number | undefined;
}

/** The result of one request round (one assistant turn). */
export interface SendResult {
  content: ContentBlock[];
  /** "tool_use" when the model wants tools run; anything else ends the loop. */
  stop_reason: string | null;
}

/** A pluggable chat backend. */
export interface AiProvider {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;
  /** Run one assistant turn given the running history + advertised tools. */
  send(messages: ChatMessage[], opts: SendOptions): Promise<SendResult>;
}

// =============================================================================
// Config (localStorage): which provider is active + each provider's settings.
// =============================================================================

export type ProviderId = "anthropic" | "openai" | "webllm";

export interface AnthropicConfig {
  key: string;
  model: string;
}
export interface OpenAiConfig {
  /** Base URL of an OpenAI-compatible server, e.g. http://localhost:11434/v1
   * (Ollama), http://localhost:1234/v1 (LM Studio), http://localhost:8080/v1
   * (llama.cpp server). No trailing slash required. */
  baseUrl: string;
  /** Optional bearer key (local servers usually need none). */
  key: string;
  model: string;
  /** Whether the selected model accepts image inputs (vision). */
  vision: boolean;
}
export interface WebLlmConfig {
  /** The active (loaded) web-llm prebuilt model id, or "". */
  model: string;
  /** Extra model ids the user has pinned via "Add" (custom / off-filter). */
  pinned: string[];
  /** web-llm context window in tokens. web-llm's per-model default (often 4096)
   * is too small for our grounded prompts, so this is user-configurable; must
   * not exceed what the model was trained for. */
  contextWindowSize: number;
}

/**
 * The top-level provider category the user picks (3 buttons). "cloud" fans out
 * to a specific vendor (see {@link CloudVendor}); "local" is a self-hosted
 * OpenAI-compatible server; "webllm" is in-browser WebGPU.
 */
export type ProviderKind = "cloud" | "local" | "webllm";

/** Cloud vendors offered under the "Cloud" category. */
export type CloudVendor = "anthropic" | "openai" | "gemini" | "grok" | "openrouter" | "custom";

/** Per-vendor cloud settings (each vendor keeps its own key + model). */
export interface CloudVendorConfig {
  key: string;
  model: string;
  /** Endpoint. Fixed for known vendors; user-set for "custom". Empty for the
   * native Anthropic API (which isn't OpenAI-compatible). */
  baseUrl: string;
}

/** Static metadata per cloud vendor: label, endpoint, and UI hints. */
export const CLOUD_VENDORS: Record<
  CloudVendor,
  { label: string; baseUrl: string; native: boolean; modelPlaceholder: string; keyHint: string }
> = {
  anthropic: {
    label: "Anthropic",
    baseUrl: "",
    native: true, // uses the native Messages API, not /chat/completions
    modelPlaceholder: "claude-opus-4-8",
    keyHint: "sk-ant-…",
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    native: false,
    modelPlaceholder: "gpt-4o",
    keyHint: "sk-…",
  },
  gemini: {
    label: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    native: false,
    modelPlaceholder: "gemini-2.0-flash",
    keyHint: "AIza…",
  },
  grok: {
    label: "Grok (xAI)",
    baseUrl: "https://api.x.ai/v1",
    native: false,
    modelPlaceholder: "grok-2-latest",
    keyHint: "xai-…",
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    native: false,
    modelPlaceholder: "anthropic/claude-3.5-sonnet",
    keyHint: "sk-or-…",
  },
  custom: {
    label: "Custom",
    baseUrl: "",
    native: false,
    modelPlaceholder: "model id",
    keyHint: "API key",
  },
};

export interface AiConfig {
  kind: ProviderKind;
  cloud: { vendor: CloudVendor; vendors: Record<CloudVendor, CloudVendorConfig> };
  local: OpenAiConfig;
  webllm: WebLlmConfig;
}

const CONFIG_STORAGE = "ledmapper.ai.config";
/** Legacy single-key storage migrated on first read (pre-FUG-87). */
const LEGACY_KEY = "ledmapper.anthropicKey";

/** The default Anthropic model — kept in sync with the historical default. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8";
/** A sensible Ollama default; the user picks a real one in AI settings. */
export const DEFAULT_OPENAI_BASE_URL = "http://localhost:11434/v1";
/** Default in-browser context window (tokens): fits our grounded prompts, and is
 * within the 8K trained context of the Llama-3-8B-based tool models. */
export const DEFAULT_WEBLLM_CONTEXT = 8192;

function isCloudVendor(v: unknown): v is CloudVendor {
  return typeof v === "string" && v in CLOUD_VENDORS;
}

function emptyVendors(): Record<CloudVendor, CloudVendorConfig> {
  const out = {} as Record<CloudVendor, CloudVendorConfig>;
  for (const v of Object.keys(CLOUD_VENDORS) as CloudVendor[]) {
    out[v] = {
      key: "",
      model: v === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : "",
      baseUrl: CLOUD_VENDORS[v].baseUrl,
    };
  }
  return out;
}

export function defaultConfig(): AiConfig {
  return {
    kind: "cloud",
    cloud: { vendor: "anthropic", vendors: emptyVendors() },
    local: { baseUrl: DEFAULT_OPENAI_BASE_URL, key: "", model: "", vision: false },
    webllm: { model: "", pinned: [], contextWindowSize: DEFAULT_WEBLLM_CONTEXT },
  };
}

/** Merge a parsed (possibly partial / older-shape) config over the defaults so
 * added fields always have a value and hand-edited storage can't crash us. Also
 * migrates the pre-"3-button" shape ({provider, anthropic, openai, webllm}). */
export function normalizeConfig(raw: unknown): AiConfig {
  const d = defaultConfig();
  if (raw === null || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;

  // -- migrate the earlier {provider, anthropic, openai, webllm} shape --------
  if (typeof r["provider"] === "string" && r["kind"] === undefined) {
    const provider = r["provider"];
    const anth = (r["anthropic"] ?? {}) as Partial<AnthropicConfig>;
    d.cloud.vendors.anthropic = {
      key: typeof anth.key === "string" ? anth.key : "",
      model: typeof anth.model === "string" && anth.model ? anth.model : DEFAULT_ANTHROPIC_MODEL,
      baseUrl: "",
    };
    const oai = (r["openai"] ?? {}) as Partial<OpenAiConfig>;
    d.local = { ...d.local, ...oai };
    const wl = (r["webllm"] ?? {}) as { model?: unknown };
    if (typeof wl.model === "string") d.webllm.model = wl.model;
    d.kind = provider === "openai" ? "local" : provider === "webllm" ? "webllm" : "cloud";
    d.cloud.vendor = "anthropic";
    return d;
  }

  // -- current shape ----------------------------------------------------------
  const kind: ProviderKind =
    r["kind"] === "local" || r["kind"] === "webllm" ? r["kind"] : "cloud";
  const cloud = (r["cloud"] ?? {}) as { vendor?: unknown; vendors?: unknown };
  const vendors = emptyVendors();
  if (cloud.vendors && typeof cloud.vendors === "object") {
    const stored = cloud.vendors as Record<string, Partial<CloudVendorConfig>>;
    for (const v of Object.keys(vendors) as CloudVendor[]) {
      const cv = stored[v];
      if (cv && typeof cv === "object") {
        vendors[v] = {
          key: typeof cv.key === "string" ? cv.key : "",
          model: typeof cv.model === "string" ? cv.model : vendors[v].model,
          baseUrl: typeof cv.baseUrl === "string" ? cv.baseUrl : vendors[v].baseUrl,
        };
      }
    }
  }
  const vendor: CloudVendor = isCloudVendor(cloud.vendor) ? cloud.vendor : "anthropic";
  const local = (r["local"] ?? {}) as Partial<OpenAiConfig>;
  const webllm = (r["webllm"] ?? {}) as {
    model?: unknown;
    pinned?: unknown;
    contextWindowSize?: unknown;
  };
  return {
    kind,
    cloud: { vendor, vendors },
    local: { ...d.local, ...local },
    webllm: {
      model: typeof webllm.model === "string" ? webllm.model : "",
      pinned: Array.isArray(webllm.pinned)
        ? webllm.pinned.filter((x): x is string => typeof x === "string")
        : [],
      contextWindowSize:
        typeof webllm.contextWindowSize === "number" && webllm.contextWindowSize > 0
          ? Math.floor(webllm.contextWindowSize)
          : DEFAULT_WEBLLM_CONTEXT,
    },
  };
}

let cache: AiConfig | null = null;

/** The Anthropic key (cloud vendor "anthropic"), for the legacy-key mirror. */
function anthropicKey(cfg: AiConfig): string {
  return cfg.cloud.vendors.anthropic.key;
}

/** Read the AI config, migrating the legacy single-key storage on first use. */
export function getAiConfig(): AiConfig {
  if (cache) return cache;
  let cfg = defaultConfig();
  try {
    const stored = localStorage.getItem(CONFIG_STORAGE);
    if (stored) {
      cfg = normalizeConfig(JSON.parse(stored));
    } else {
      // Migrate a legacy Anthropic key so existing users keep working.
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) cfg.cloud.vendors.anthropic.key = legacy;
    }
  } catch {
    // storage unavailable / corrupt — fall back to defaults
  }
  cache = cfg;
  return cfg;
}

/** Persist a patch over the current config and return the merged result. */
export function updateAiConfig(patch: Partial<AiConfig>): AiConfig {
  const next = normalizeConfig({ ...getAiConfig(), ...patch });
  cache = next;
  try {
    localStorage.setItem(CONFIG_STORAGE, JSON.stringify(next));
    // Keep the legacy key mirror in sync so a downgrade still finds the key.
    const key = anthropicKey(next);
    if (key) localStorage.setItem(LEGACY_KEY, key);
    else localStorage.removeItem(LEGACY_KEY);
  } catch {
    // storage unavailable — the in-memory cache still reflects the change
  }
  return next;
}

/** Is the ACTIVE provider ready to run (key/endpoint/model as required)? */
export function isAiConfigured(cfg: AiConfig = getAiConfig()): boolean {
  switch (cfg.kind) {
    case "cloud": {
      const v = cfg.cloud.vendors[cfg.cloud.vendor];
      const meta = CLOUD_VENDORS[cfg.cloud.vendor];
      const hasEndpoint = meta.native || v.baseUrl.trim() !== "";
      return v.key.trim() !== "" && v.model.trim() !== "" && hasEndpoint;
    }
    case "local":
      return cfg.local.baseUrl.trim() !== "" && cfg.local.model.trim() !== "";
    case "webllm":
      return cfg.webllm.model.trim() !== "";
  }
}

/** Human label for a provider category (the 3 buttons + status line). */
export function kindLabel(kind: ProviderKind): string {
  switch (kind) {
    case "cloud":
      return "Cloud";
    case "local":
      return "Local server (OpenAI-compatible)";
    case "webllm":
      return "In-browser (WebGPU)";
  }
}
