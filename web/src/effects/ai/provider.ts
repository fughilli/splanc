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
  /** A web-llm prebuilt model id (see the models list in the AI settings). */
  model: string;
}

export interface AiConfig {
  provider: ProviderId;
  anthropic: AnthropicConfig;
  openai: OpenAiConfig;
  webllm: WebLlmConfig;
}

const CONFIG_STORAGE = "ledmapper.ai.config";
/** Legacy single-key storage migrated on first read (pre-FUG-87). */
const LEGACY_KEY = "ledmapper.anthropicKey";

/** The default Anthropic model — kept in sync with the historical default. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8";
/** A sensible Ollama default; the user picks a real one in AI settings. */
export const DEFAULT_OPENAI_BASE_URL = "http://localhost:11434/v1";

export function defaultConfig(): AiConfig {
  return {
    provider: "anthropic",
    anthropic: { key: "", model: DEFAULT_ANTHROPIC_MODEL },
    openai: { baseUrl: DEFAULT_OPENAI_BASE_URL, key: "", model: "", vision: false },
    webllm: { model: "" },
  };
}

/** Merge a parsed (possibly partial / older-shape) config over the defaults so
 * added fields always have a value and hand-edited storage can't crash us. */
export function normalizeConfig(raw: unknown): AiConfig {
  const d = defaultConfig();
  if (raw === null || typeof raw !== "object") return d;
  const r = raw as Partial<AiConfig>;
  const provider: ProviderId =
    r.provider === "openai" || r.provider === "webllm" ? r.provider : "anthropic";
  return {
    provider,
    anthropic: { ...d.anthropic, ...(r.anthropic ?? {}) },
    openai: { ...d.openai, ...(r.openai ?? {}) },
    webllm: { ...d.webllm, ...(r.webllm ?? {}) },
  };
}

let cache: AiConfig | null = null;

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
      if (legacy) cfg.anthropic.key = legacy;
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
    if (next.anthropic.key) localStorage.setItem(LEGACY_KEY, next.anthropic.key);
    else localStorage.removeItem(LEGACY_KEY);
  } catch {
    // storage unavailable — the in-memory cache still reflects the change
  }
  return next;
}

/** Is the ACTIVE provider ready to run (key/endpoint/model as required)? */
export function isAiConfigured(cfg: AiConfig = getAiConfig()): boolean {
  switch (cfg.provider) {
    case "anthropic":
      return cfg.anthropic.key.trim() !== "";
    case "openai":
      return cfg.openai.baseUrl.trim() !== "" && cfg.openai.model.trim() !== "";
    case "webllm":
      return cfg.webllm.model.trim() !== "";
  }
}

/** Human label for a provider id (menus, hints). */
export function providerLabel(id: ProviderId): string {
  switch (id) {
    case "anthropic":
      return "Anthropic (cloud)";
    case "openai":
      return "Local server (OpenAI-compatible)";
    case "webllm":
      return "In-browser (WebGPU)";
  }
}
