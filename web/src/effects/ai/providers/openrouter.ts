/**
 * OpenRouter provider (docs/design/ai-tiers.md) — the free tier's backend, and
 * the "OpenRouter" cloud vendor for anyone who brings an OpenRouter key.
 *
 * OpenRouter speaks the OpenAI chat-completions API, so the neutral⇄OpenAI
 * translators come from openaiCompat.ts. What this adds over the generic
 * OpenAI-compatible client:
 *   - STREAMING (SSE) with tool-call deltas reassembled by `index`, live text and
 *     the streamed set_script `summary` as the status line (same hooks as the
 *     Anthropic provider);
 *   - `reasoning: {enabled: false}` for the free models: their default reasoning
 *     can spend the whole output budget before any tool call (measured: 4000
 *     reasoning tokens, no set_script, on Nemotron 3.5 Super VL);
 *   - free-model fallbacks via OpenRouter's `models` array (only `:free` ids, so
 *     a fallback can never bill the user);
 *   - typed errors (OpenRouterError) for the free tier's real failure modes: the
 *     daily free allowance (50/day, or 1000/day after buying 10 credits), the
 *     20/minute limit, an upstream provider being busy, a revoked key, a model
 *     that is gone. The app shows `message` as is, so each one is written for a
 *     person and says what to do next.
 *
 * Browser note: OpenRouter answers CORS with `*` but does NOT expose
 * `Retry-After` / `X-RateLimit-*` to scripts, so reset times are read from the
 * error body (`error.metadata.headers`), which it does include.
 */

import type { AiProvider, ChatMessage, ContentBlock, SendOptions, SendResult, StreamHooks } from "../provider";
import { toOpenAiMessages, toOpenAiTools, finishReasonToStop, type OaiMessage } from "./openaiCompat";
import { partialField, toolLabel } from "./anthropic";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
/** Shown on the user's OpenRouter activity page (app attribution headers). */
const APP_URL = "https://splanc.io";
const APP_TITLE = "Splanc";

// -- curated free models ------------------------------------------------------

export interface FreeModel {
  id: string;
  label: string;
  /** One line for the picker: what to expect (from the eval). */
  note: string;
  /** Native tool calling (all curated entries need it: set_script is a tool). */
  tools: boolean;
  /** Accepts image input (capture_preview). The free tier doesn't advertise
   * vision: every capture is one more request against a 50/day allowance. */
  vision: boolean;
  /** OpenRouter routes it with `provider.data_collection: "deny"` (only
   * providers that don't store/train on prompts). Most free endpoints refuse
   * that ("No endpoints found matching your data policy (Free model
   * training)"), i.e. they may train on prompts. For a private model the
   * request enforces "deny", and it only falls back to other private models. */
  private: boolean;
}

/**
 * The free models offered in the picker, best first. Chosen by the eval in
 * tools/fx_agent_eval/openrouter_eval.py (docs/design/ai-tiers.md, run
 * 2026-11-18 against the live API, 15 fixed prompts, the app's own chat prompt
 * and set_script tool): valid set_script calls, compiling within 2 repairs,
 * latency, and whether data_collection "deny" routes. The free catalog changes
 * often, so the picker also accepts any other `:free` id, and the provider
 * falls back along this list when a model is busy or gone.
 */
export const FREE_MODELS: readonly FreeModel[] = [
  {
    id: "nvidia/nemotron-3.5-lightning:free",
    label: "Nemotron 3.5 Lightning (NVIDIA)",
    note: "Recommended: fast, most effects compile",
    tools: true,
    vision: false,
    private: false,
  },
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b:free",
    label: "Nemotron 3 Ultra (NVIDIA)",
    note: "Largest; as good, but slower",
    tools: true,
    vision: false,
    private: false,
  },
  {
    id: "nvidia/nemotron-3.5-super-vl:free",
    label: "Nemotron 3.5 Super (NVIDIA)",
    note: "Fast; more compile errors",
    tools: true,
    vision: true,
    private: false,
  },
  {
    id: "cohere/north-mini-code:free",
    label: "North Mini Code (Cohere)",
    note: "Not used for training; weaker results",
    tools: true,
    vision: false,
    private: true,
  },
];
export const DEFAULT_FREE_MODEL = FREE_MODELS[0]!.id;

export function isFreeModelId(id: string): boolean {
  return id.trim().endsWith(":free");
}

/** Is this a curated model whose request must not let providers keep data? */
export function isPrivateFreeModel(id: string): boolean {
  return FREE_MODELS.some((m) => m.id === id && m.private);
}

/** Fallback chain for a free-tier request: the chosen model, then other
 * curated free models (OpenRouter allows up to 3 entries in `models`). Never a
 * paid id; for a private model, only other private models. */
export function freeFallbacks(primary: string, max = 3): string[] {
  const priv = isPrivateFreeModel(primary);
  const out = [primary];
  for (const m of FREE_MODELS) {
    if (out.length >= max) break;
    if (m.id !== primary && (!priv || m.private)) out.push(m.id);
  }
  return out.filter(isFreeModelId);
}

/** Curated free models that accept image input, best first. */
export const FREE_VISION_MODELS: readonly string[] = FREE_MODELS.filter((m) => m.vision && !m.private).map((m) => m.id);

export function isVisionFreeModel(id: string): boolean {
  return FREE_MODELS.some((m) => m.id === id && m.vision);
}

function hasImages(messages: OaiMessage[]): boolean {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"));
}

// -- free-tier vision (owner decision 2026-11-18) ------------------------------------
// capture_preview costs one request per image. On the 50/day allowance that is
// too dear, so vision is ON only for accounts with the 1000/day allowance
// (OpenRouter's GET /key reports `free_model_daily_requests.limit`). The last
// seen limit is cached here; it is refreshed whenever key info is fetched, and
// a 429 that names the daily limit updates it too.

const FREE_LIMIT_KEY = "splanc.openrouter.freeDailyLimit";
/** Free-model requests per day that turn vision on. */
export const VISION_MIN_DAILY_LIMIT = 1000;

function lsSafe(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function recordFreeDailyLimit(limit: number, now = Date.now()): void {
  if (!Number.isFinite(limit) || limit <= 0) return;
  lsSafe()?.setItem(FREE_LIMIT_KEY, JSON.stringify({ limit, at: now }));
}

/** The last known daily free-request limit for the stored key, with when it
 * was seen; null if never fetched. */
export function cachedFreeDailyLimit(): { limit: number; at: number } | null {
  try {
    const v = JSON.parse(lsSafe()?.getItem(FREE_LIMIT_KEY) ?? "null") as { limit?: unknown; at?: unknown } | null;
    return v && typeof v.limit === "number" && typeof v.at === "number" ? { limit: v.limit, at: v.at } : null;
  } catch {
    return null;
  }
}

export function clearFreeDailyLimit(): void {
  lsSafe()?.removeItem(FREE_LIMIT_KEY);
}

/** Should the free tier advertise vision (capture_preview) for this model? */
export function freeTierVision(model: string): boolean {
  if (!isFreeModelId(model) || isPrivateFreeModel(model) || FREE_VISION_MODELS.length === 0) return false;
  return (cachedFreeDailyLimit()?.limit ?? 0) >= VISION_MIN_DAILY_LIMIT;
}

// -- errors -------------------------------------------------------------------

export type OpenRouterErrorKind =
  /** The account's daily free-model allowance is used up. */
  | "daily_limit"
  /** Too many requests this minute (free models: 20/min). */
  | "rate_limited"
  /** The model's upstream provider is overloaded / rate-limited. */
  | "upstream_busy"
  /** Key revoked, expired or wrong. */
  | "auth"
  /** No credit for this request (paid model, negative balance, key limit). */
  | "payment"
  /** The model id is unknown, retired, or has no endpoint for this request. */
  | "model_unavailable"
  /** OpenRouter or the provider is down / timed out. */
  | "unavailable"
  | "other";

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly kind: OpenRouterErrorKind,
    readonly status: number,
    /** When the limit resets (epoch ms), if OpenRouter said. */
    readonly resetAt?: number,
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

/** True for failures where switching tier (or waiting) is the answer. */
export function isFreeTierLimit(e: unknown): e is OpenRouterError {
  return e instanceof OpenRouterError && (e.kind === "daily_limit" || e.kind === "rate_limited");
}

interface OrErrorBody {
  error?: {
    code?: number | string;
    message?: string;
    metadata?: {
      headers?: Record<string, string>;
      provider_name?: string;
      raw?: unknown;
      limit_source?: string;
    } & Record<string, unknown>;
  };
}

function header(h: Record<string, string> | undefined, name: string): string | undefined {
  if (!h) return undefined;
  const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
  return k === undefined ? undefined : String(h[k]);
}

/** Parse a reset time: epoch ms (OpenRouter's X-RateLimit-Reset) or seconds. */
function parseReset(v: string | undefined, now: number): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (n > 1e12) return n; // epoch ms
  if (n > 1e9) return n * 1000; // epoch s
  return now + n * 1000; // a delta in seconds (Retry-After style)
}

/** "in 3 min", "at 17:00" — short and local. */
export function describeReset(resetAt: number | undefined, now = Date.now()): string {
  if (resetAt === undefined) return "";
  const s = Math.max(0, Math.round((resetAt - now) / 1000));
  if (s < 90) return ` Try again in ${Math.max(1, s)} s.`;
  if (s < 3600) return ` Try again in ${Math.round(s / 60)} min.`;
  const d = new Date(resetAt);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return ` It resets at ${hh}:${mm}.`;
}

const OTHER_TIERS = "For more, add credits to your OpenRouter account, or pick another tier in Settings ▸ AI ▸ Model setup.";

/**
 * Map an OpenRouter error response to a typed, human error. `status` is the
 * HTTP status (or the in-stream error code), `body` the parsed JSON (or null).
 */
export function openRouterError(status: number, body: unknown, now = Date.now()): OpenRouterError {
  const err = (body as OrErrorBody | null)?.error ?? {};
  const msg = String(err.message ?? "");
  const meta = err.metadata ?? {};
  const h = meta.headers;
  const resetAt = parseReset(header(h, "X-RateLimit-Reset") ?? header(h, "Retry-After"), now);
  const lower = msg.toLowerCase();

  if (status === 429) {
    const limit = Number(header(h, "X-RateLimit-Limit"));
    const daily = lower.includes("per-day") || lower.includes("per day") || limit === 50 || limit === 1000;
    if (daily) {
      const n = limit === 1000 ? "1000" : "50";
      recordFreeDailyLimit(limit === 1000 ? 1000 : 50, now);
      return new OpenRouterError(
        `You've used today's free OpenRouter requests (${n} per day).${describeReset(resetAt, now)} ${OTHER_TIERS}`,
        "daily_limit",
        status,
        resetAt,
      );
    }
    if (meta.provider_name || lower.includes("upstream") || lower.includes("provider returned error")) {
      return new OpenRouterError(
        `The free model is busy at its provider${meta.provider_name ? ` (${meta.provider_name})` : ""}. Try again in a minute, or pick another free model in Settings ▸ AI.`,
        "upstream_busy",
        status,
        resetAt,
      );
    }
    return new OpenRouterError(
      `Too many requests — free models allow 20 a minute.${describeReset(resetAt, now) || " Try again in a minute."}`,
      "rate_limited",
      status,
      resetAt,
    );
  }
  if (status === 401 || status === 403) {
    return new OpenRouterError(
      "OpenRouter didn't accept the key (revoked or expired). Reconnect OpenRouter in Settings ▸ AI.",
      "auth",
      status,
    );
  }
  if (status === 402) {
    const src = String(meta.limit_source ?? "");
    const why =
      src === "openrouter_key_limit"
        ? "This key's credit limit is used up."
        : src === "openrouter_in_flight_budget"
          ? "Too many requests are running at once."
          : "Your OpenRouter balance can't cover this request (free models need a balance that isn't negative).";
    return new OpenRouterError(`${why} Check your OpenRouter account, or pick a free model.`, "payment", status, resetAt);
  }
  if (
    status === 404 ||
    lower.includes("no endpoints found") ||
    lower.includes("not a valid model") ||
    lower.includes("model not found")
  ) {
    const policy = lower.includes("data policy")
      ? " Your OpenRouter privacy settings block it: free models need “Free model training” allowed (openrouter.ai/settings/privacy)."
      : "";
    return new OpenRouterError(
      `That model isn't available on OpenRouter right now.${policy} Pick another one in Settings ▸ AI.`,
      "model_unavailable",
      status,
    );
  }
  if (status === 0 || status === 408 || status === 502 || status === 503 || status === 504) {
    return new OpenRouterError(
      "Couldn't reach the model on OpenRouter (network or provider down). Try again shortly.",
      "unavailable",
      status,
    );
  }
  return new OpenRouterError(`OpenRouter ${status}: ${msg.slice(0, 200) || "request failed"}`, "other", status);
}

// -- request ------------------------------------------------------------------

export interface OpenRouterProviderConfig {
  key: string;
  model: string;
  /** Advertise image input (capture_preview). */
  vision?: boolean | undefined;
  /** Fall back along the curated free list when the model is busy/gone.
   * Only applies to `:free` models (default true for them). */
  fallbacks?: boolean | undefined;
  /** Override for tests / a self-hosted gateway. */
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

/** The chat-completions request body (exported for tests). */
export function openRouterRequestBody(
  cfg: OpenRouterProviderConfig,
  messages: ChatMessage[],
  opts: Pick<SendOptions, "system" | "tools" | "maxTokens">,
): Record<string, unknown> {
  const free = isFreeModelId(cfg.model);
  const oaiMessages = toOpenAiMessages(opts.system, messages);
  // A free text-only model can't take the capture_preview image: send that
  // request to the curated free vision models instead (only reachable when
  // vision is on, i.e. a 1000/day account; never for a private pick).
  const toVision = free && hasImages(oaiMessages) && !isVisionFreeModel(cfg.model) && !isPrivateFreeModel(cfg.model);
  const primary = toVision ? (FREE_VISION_MODELS[0] ?? cfg.model) : cfg.model;
  const body: Record<string, unknown> = {
    model: primary,
    messages: oaiMessages,
    // Room for a whole set_script; a cut-off tool call wedges the loop.
    max_tokens: opts.maxTokens ?? 8000,
    stream: true,
  };
  if (free && cfg.fallbacks !== false) {
    const chain = toVision ? FREE_VISION_MODELS.slice(0, 3) : freeFallbacks(cfg.model);
    if (chain.length > 1) body.models = chain;
  }
  // Free models: no hidden reasoning (it can eat the whole budget before the
  // tool call). Paid models: leave the model's default.
  if (free) body.reasoning = { enabled: false };
  // A model picked for privacy: only providers that don't store/train on data.
  if (isPrivateFreeModel(cfg.model)) body.provider = { data_collection: "deny" };
  if (opts.tools.length) {
    body.tools = toOpenAiTools(opts.tools);
    body.tool_choice = "auto";
  }
  return body;
}

function requestHeaders(key: string): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${key.trim()}`,
    "HTTP-Referer": APP_URL,
    "X-Title": APP_TITLE,
  };
}

// -- stream -------------------------------------------------------------------

interface ToolAcc {
  id: string;
  name: string;
  args: string;
}

interface OrChunk {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    message?: OaiMessage;
    finish_reason?: string | null;
  }[];
  error?: { code?: number | string; message?: string; metadata?: unknown };
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Read an OpenAI-style SSE chat stream into neutral blocks: text first, then
 * one tool_use per tool call (in `index` order), the same shape the
 * non-streaming translator returns. Fires live hooks as it goes. An in-stream
 * `error` chunk (OpenRouter sends one when a provider fails mid-response)
 * throws an OpenRouterError.
 */
export async function consumeOpenAiStream(
  body: ReadableStream<Uint8Array>,
  hooks?: StreamHooks,
): Promise<SendResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let finish: string | null = null;
  const tools = new Map<number, ToolAcc>();
  let lastSummary = "";
  let thinkingShown = false;

  const handle = (payload: string): void => {
    let ev: OrChunk;
    try {
      ev = JSON.parse(payload) as OrChunk;
    } catch {
      return;
    }
    if (ev.error) {
      const code = Number(ev.error.code);
      throw openRouterError(Number.isFinite(code) ? code : 502, { error: ev.error });
    }
    const ch = ev.choices?.[0];
    if (!ch) return;
    const d = ch.delta ?? {};
    if (d.reasoning && !thinkingShown) {
      thinkingShown = true;
      hooks?.onStatus?.("Thinking…");
    }
    if (typeof d.content === "string" && d.content) {
      text += d.content;
      hooks?.onText?.(d.content);
    }
    for (const tc of d.tool_calls ?? []) {
      const i = typeof tc.index === "number" ? tc.index : tools.size;
      let acc = tools.get(i);
      if (!acc) {
        acc = { id: "", name: "", args: "" };
        tools.set(i, acc);
      }
      if (tc.id) acc.id = tc.id;
      if (tc.function?.name) {
        const fresh = acc.name === "";
        acc.name += tc.function.name;
        if (fresh) {
          lastSummary = "";
          hooks?.onStatus?.(toolLabel(acc.name));
        }
      }
      if (tc.function?.arguments) {
        acc.args += tc.function.arguments;
        if (acc.name) hooks?.onToolInput?.(acc.name, acc.id || `call_${i}`, acc.args);
        if (acc.name === "set_script") {
          const s = partialField(acc.args, "summary");
          if (s && s !== lastSummary) {
            lastSummary = s;
            hooks?.onStatus?.(s);
          }
        }
      }
    }
    if (ch.finish_reason) finish = ch.finish_reason;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      // ": OPENROUTER PROCESSING" keep-alive comments and blank separators.
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      handle(payload);
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith("data:")) {
    const payload = tail.slice(5).trim();
    if (payload && payload !== "[DONE]") handle(payload);
  }

  const content: ContentBlock[] = [];
  if (text) content.push({ type: "text", text });
  const order = [...tools.keys()].sort((a, b) => a - b);
  for (const i of order) {
    const t = tools.get(i)!;
    if (!t.name) continue;
    content.push({ type: "tool_use", id: t.id || `call_${i}`, name: t.name, input: safeParse(t.args) });
  }
  // Some providers end a tool-calling turn with "stop"; the calls still need
  // running, so a turn that carries tool_use is a tool_use stop.
  const stop = content.some((b) => b.type === "tool_use") ? "tool_use" : finishReasonToStop(finish);
  return { content, stop_reason: finish === "length" && stop !== "tool_use" ? "max_tokens" : stop };
}

// -- provider -----------------------------------------------------------------

export function makeOpenRouterProvider(cfg: OpenRouterProviderConfig): AiProvider {
  const known = FREE_MODELS.find((m) => m.id === cfg.model);
  return {
    id: "openai",
    capabilities: { tools: known?.tools ?? true, vision: cfg.vision ?? false },
    async send(messages: ChatMessage[], opts: SendOptions): Promise<SendResult> {
      if (!cfg.key.trim()) {
        throw new OpenRouterError("OpenRouter isn't connected yet. Open Settings ▸ AI ▸ Model setup.", "auth", 401);
      }
      if (!cfg.model.trim()) {
        throw new OpenRouterError("No OpenRouter model selected (pick one in Settings ▸ AI).", "model_unavailable", 400);
      }
      const doFetch = cfg.fetchImpl ?? fetch;
      let resp: Response;
      try {
        resp = await doFetch(`${(cfg.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers: requestHeaders(cfg.key),
          signal: opts.signal ?? null,
          body: JSON.stringify(openRouterRequestBody(cfg, messages, opts)),
        });
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        throw openRouterError(0, null);
      }
      if (!resp.ok || resp.body === null) {
        const raw = await resp.text().catch(() => "");
        let json: unknown = null;
        try {
          json = JSON.parse(raw);
        } catch {
          json = { error: { message: raw.slice(0, 300) } };
        }
        throw openRouterError(resp.status, json);
      }
      return consumeOpenAiStream(resp.body, opts.stream);
    },
  };
}

// -- account (free allowance) ---------------------------------------------------

export interface OpenRouterKeyInfo {
  /** Daily free-model requests (null when OpenRouter didn't report them). */
  freeDaily: { used: number; limit: number; remaining: number } | null;
  /** Has this account ever bought credits (false = 50/day free tier). */
  isFreeTier: boolean | null;
  label: string | null;
}

/** GET /api/v1/key — the key's free-model allowance for today. */
export async function fetchOpenRouterKeyInfo(
  key: string,
  fetchImpl: typeof fetch = fetch,
  baseUrl = OPENROUTER_BASE_URL,
): Promise<OpenRouterKeyInfo> {
  const resp = await fetchImpl(`${baseUrl}/key`, { headers: { authorization: `Bearer ${key.trim()}` } });
  if (!resp.ok) throw openRouterError(resp.status, await resp.json().catch(() => null));
  const j = (await resp.json()) as {
    data?: {
      label?: string;
      is_free_tier?: boolean;
      free_model_daily_requests?: { used?: number; limit?: number; remaining?: number };
    };
  };
  const f = j.data?.free_model_daily_requests;
  if (f && typeof f.limit === "number") recordFreeDailyLimit(f.limit);
  return {
    freeDaily:
      f && typeof f.limit === "number"
        ? { used: f.used ?? 0, limit: f.limit, remaining: f.remaining ?? Math.max(0, f.limit - (f.used ?? 0)) }
        : null,
    isFreeTier: typeof j.data?.is_free_tier === "boolean" ? j.data.is_free_tier : null,
    label: typeof j.data?.label === "string" ? j.data.label : null,
  };
}

/** The public model list, filtered to free models that can call tools. */
export async function listFreeToolModels(
  fetchImpl: typeof fetch = fetch,
  baseUrl = OPENROUTER_BASE_URL,
): Promise<{ id: string; name: string; vision: boolean }[]> {
  const resp = await fetchImpl(`${baseUrl}/models`);
  if (!resp.ok) throw openRouterError(resp.status, null);
  const j = (await resp.json()) as {
    data?: {
      id?: string;
      name?: string;
      supported_parameters?: string[];
      architecture?: { input_modalities?: string[] };
    }[];
  };
  return (j.data ?? [])
    .filter((m) => typeof m.id === "string" && isFreeModelId(m.id) && (m.supported_parameters ?? []).includes("tools"))
    .map((m) => ({
      id: m.id!,
      name: m.name ?? m.id!,
      vision: (m.architecture?.input_modalities ?? []).includes("image"),
    }));
}
