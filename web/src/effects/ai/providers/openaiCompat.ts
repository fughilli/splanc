/**
 * OpenAI-compatible provider (FUG-87).
 *
 * Talks to any server that implements the OpenAI `/chat/completions` API:
 * Ollama (`/v1`), LM Studio, llama.cpp's server, vLLM, etc. This is how you run
 * a model "on-device" without the browser doing the inference — you download a
 * GGUF from HuggingFace into one of those runtimes and point the app at it.
 *
 * The neutral, Anthropic-shaped message/tool blocks (provider.ts) are
 * translated to/from the OpenAI wire shape here. The translators are exported so
 * the WebGPU provider (which drives web-llm's OpenAI-shaped API) can reuse them,
 * and so the mapping is unit-testable without a live server.
 */

import type {
  AiProvider,
  ChatMessage,
  ContentBlock,
  OpenAiConfig,
  SendOptions,
  SendResult,
  ToolDef,
} from "../provider";

// -- OpenAI wire shapes (the subset we produce/consume) ----------------------

interface OaiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
type OaiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };
export interface OaiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | OaiContentPart[] | null;
  tool_calls?: OaiToolCall[];
  tool_call_id?: string;
}
export interface OaiTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

// -- translation: neutral → OpenAI -------------------------------------------

/** Neutral tool defs → OpenAI `tools`. */
export function toOpenAiTools(tools: readonly ToolDef[]): OaiTool[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

function imageUrl(b: Extract<ContentBlock, { type: "tool_result" }>["content"][number]): string | null {
  if (b.type !== "image") return null;
  return `data:${b.source.media_type};base64,${b.source.data}`;
}

/**
 * Neutral history (+ system prompt) → OpenAI `messages`.
 *
 * Ordering matters: an assistant message carrying `tool_calls` must be followed
 * immediately by one `tool` message per call, before anything else. So for a
 * user turn that bundles several tool_result blocks we emit every `tool` message
 * first, then fold any images those results carried into a single trailing
 * `user` message (the `tool` role can't reliably carry image parts).
 */
export function toOpenAiMessages(system: string, messages: ChatMessage[]): OaiMessage[] {
  const out: OaiMessage[] = [];
  if (system) out.push({ role: "system", content: system });

  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
      const toolCalls: OaiToolCall[] = m.content
        .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      // Always a string ("" when the turn is tool-calls only): some runtimes —
      // notably web-llm — reject `content: null` ("assistant's message should
      // have string content"), and OpenAI accepts "" alongside tool_calls.
      const msg: OaiMessage = { role: "assistant", content: text };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
      continue;
    }

    // User turn: a bundle of tool_result blocks (and, rarely, plain text).
    const images: OaiContentPart[] = [];
    const texts: string[] = [];
    for (const b of m.content) {
      if (b.type === "tool_result") {
        const textParts = b.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        out.push({
          role: "tool",
          tool_call_id: b.tool_use_id,
          content: textParts || (b.is_error ? "(error)" : "(ok)"),
        });
        for (const c of b.content) {
          const url = imageUrl(c);
          if (url) images.push({ type: "image_url", image_url: { url } });
        }
      } else if (b.type === "text") {
        texts.push(b.text);
      }
    }
    if (texts.length) out.push({ role: "user", content: texts.join("\n") });
    if (images.length) {
      out.push({
        role: "user",
        content: [{ type: "text", text: "Rendered preview:" }, ...images],
      });
    }
  }
  return out;
}

// -- translation: OpenAI → neutral -------------------------------------------

function safeParseArgs(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** An OpenAI `choices[0].message` → neutral content blocks. */
export function fromOpenAiMessage(msg: OaiMessage): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (typeof msg.content === "string" && msg.content) {
    blocks.push({ type: "text", text: msg.content });
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === "text" && part.text) blocks.push({ type: "text", text: part.text });
    }
  }
  for (const tc of msg.tool_calls ?? []) {
    blocks.push({
      type: "tool_use",
      id: tc.id,
      name: tc.function.name,
      input: safeParseArgs(tc.function.arguments),
    });
  }
  return blocks;
}

/** OpenAI `finish_reason` → neutral stop reason (so the loop keeps/ends). */
export function finishReasonToStop(reason: string | null | undefined): string {
  return reason === "tool_calls" ? "tool_use" : "end_turn";
}

// -- URL helpers -------------------------------------------------------------

/** Join a base URL and a path, tolerating a trailing slash on the base. */
export function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return b + p;
}

/** The server root (strips a trailing `/v1`) — Ollama's native `/api/*` lives
 * there, not under the OpenAI-compat `/v1` prefix. */
export function serverRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

// -- provider ----------------------------------------------------------------

function headers(cfg: OpenAiConfig): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (cfg.key.trim()) h["authorization"] = `Bearer ${cfg.key.trim()}`;
  return h;
}

/** Build an OpenAI-compatible provider from its config. */
export function makeOpenAiProvider(cfg: OpenAiConfig): AiProvider {
  return {
    id: "openai",
    capabilities: { tools: true, vision: cfg.vision },
    async send(messages: ChatMessage[], opts: SendOptions): Promise<SendResult> {
      if (!cfg.baseUrl.trim()) throw new Error("no local server URL set (add one in AI settings)");
      if (!cfg.model.trim()) throw new Error("no model selected (pick one in AI settings)");
      const body: Record<string, unknown> = {
        model: cfg.model,
        messages: toOpenAiMessages(opts.system, messages),
        max_tokens: opts.maxTokens ?? 4000,
        stream: false,
      };
      if (opts.tools.length) {
        body.tools = toOpenAiTools(opts.tools);
        body.tool_choice = "auto";
      }
      const resp = await fetch(joinUrl(cfg.baseUrl, "/chat/completions"), {
        method: "POST",
        headers: headers(cfg),
        signal: opts.signal ?? null,
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`local server ${resp.status}: ${text.slice(0, 300)}`);
      }
      const json = (await resp.json()) as {
        choices?: { message?: OaiMessage; finish_reason?: string }[];
      };
      const choice = json.choices?.[0];
      const message = choice?.message ?? { role: "assistant", content: "" };
      return {
        content: fromOpenAiMessage(message),
        stop_reason: finishReasonToStop(choice?.finish_reason),
      };
    },
  };
}

// -- model management (used by the AI settings screen) -----------------------

/** List the models the server currently has (OpenAI `/v1/models`). */
export async function listOpenAiModels(cfg: OpenAiConfig): Promise<string[]> {
  const resp = await fetch(joinUrl(cfg.baseUrl, "/models"), { headers: headers(cfg) });
  if (!resp.ok) throw new Error(`list models ${resp.status}`);
  const json = (await resp.json()) as { data?: { id?: string }[] };
  return (json.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string")
    .sort();
}

/** Progress of an Ollama model pull (download from the HuggingFace/Ollama hub). */
export interface PullProgress {
  status: string;
  completed?: number | undefined;
  total?: number | undefined;
}

/**
 * Pull (download) a model into an Ollama server — the "grab a model and run it
 * locally" flow. Streams NDJSON progress from Ollama's native `/api/pull` (which
 * lives at the server root, not under `/v1`). Only meaningful for Ollama; other
 * runtimes manage models out of band.
 */
export async function pullOllamaModel(
  cfg: OpenAiConfig,
  name: string,
  onProgress: (p: PullProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const resp = await fetch(`${serverRoot(cfg.baseUrl)}/api/pull`, {
    method: "POST",
    headers: headers(cfg),
    signal: signal ?? null,
    body: JSON.stringify({ name, stream: true }),
  });
  if (!resp.ok || resp.body === null) {
    const text = await resp.text().catch(() => "");
    throw new Error(`pull ${resp.status}: ${text.slice(0, 200)}`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ev = JSON.parse(trimmed) as PullProgress & { error?: string };
        if (ev.error) throw new Error(ev.error);
        onProgress({ status: ev.status ?? "", completed: ev.completed, total: ev.total });
      } catch (e) {
        if (e instanceof SyntaxError) continue; // partial line
        throw e;
      }
    }
  }
}
