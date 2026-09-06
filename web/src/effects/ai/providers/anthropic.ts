/**
 * Anthropic provider (FUG-87) — the cloud default, BYO key, direct browser→API
 * CORS with no server proxy (docs/design/effects-compiler.md §"AI generation").
 *
 * The neutral message/tool representation (provider.ts) is already
 * Anthropic-shaped — content blocks with tool_use / tool_result / image, tools
 * with `input_schema` — so this provider is essentially a passthrough that adds
 * the auth headers and the cacheable system prefix. Extracted from the original
 * inline `messagesRequest` in generate.ts.
 *
 * It STREAMS the Messages API (SSE) so a long turn narrates itself live in the
 * editor chat (assistant text, "Thinking…", tool verbs, and the model's own
 * streamed set_script `summary`) via the optional `opts.stream` hooks, and it
 * reconstructs the final `content` blocks exactly as the non-streaming response
 * would return them so the tool-use loop is unchanged.
 */

import type {
  AiProvider,
  AnthropicConfig,
  ChatMessage,
  ContentBlock,
  SendOptions,
  SendResult,
  StreamHooks,
} from "../provider";

const API_URL = "https://api.anthropic.com/v1/messages";

/** A message's content with a prompt-cache breakpoint on its LAST block (a bare
 * string becomes one text block). NON-MUTATING — the stored history that the
 * loop re-sends each round must never carry a moved/stale breakpoint. */
export function withCacheControl(content: string | ContentBlock[]): unknown {
  const cc = { type: "ephemeral" as const };
  if (typeof content === "string") {
    return [{ type: "text", text: content, cache_control: cc }];
  }
  if (content.length === 0) return content;
  const copy = content.map((b) => ({ ...b })) as Record<string, unknown>[];
  copy[copy.length - 1] = { ...copy[copy.length - 1], cache_control: cc };
  return copy;
}

/** Fixed status verb for a tool call, shown the moment the model starts it. */
function toolLabel(name: string): string {
  switch (name) {
    case "set_script":
      return "Writing the effect code…";
    case "capture_preview":
      return "Taking a screenshot of the preview…";
    case "estimate_performance":
      return "Running a performance pass…";
    case "list_midi_controls":
      return "Reading MIDI controls…";
    case "set_midi_mapping":
      return "Mapping MIDI controls…";
    default:
      return "Working…";
  }
}

/** Best-effort extraction of a string field's in-progress value from partial JSON
 * (a streamed tool-input object), e.g. the set_script `summary`. Null until the
 * field's opening quote has arrived. */
function partialField(json: string, field: string): string | null {
  const m = new RegExp(`"${field}"\\s*:\\s*"`).exec(json);
  if (m === null) return null;
  const start = m.index + m[0].length;
  let out = "";
  for (let i = start; i < json.length; i++) {
    const ch = json[i]!;
    if (ch === "\\") {
      const next = json[i + 1];
      if (next === undefined) break; // escape spans the stream boundary
      out += unescapeChar(next);
      i++;
    } else if (ch === '"') {
      break; // closing quote — field complete
    } else {
      out += ch;
    }
  }
  return out;
}

function unescapeChar(c: string): string {
  switch (c) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case '"':
      return '"';
    case "\\":
      return "\\";
    case "/":
      return "/";
    default:
      return c;
  }
}

/**
 * Read the Anthropic SSE stream, reconstructing the assistant `content` blocks
 * (text, thinking + signature, tool_use with parsed input) exactly as the
 * non-streaming response would return them — so the tool-use loop and the
 * history it re-sends are unchanged — while firing live progress:
 *   - text_delta      → onText (the reply, as written)
 *   - thinking_delta  → onStatus("Thinking…")
 *   - tool_use start  → onStatus(fixed verb)
 *   - set_script's `summary` field (streamed first) → onStatus(<model summary>)
 */
export async function consumeChatStream(
  body: ReadableStream<Uint8Array>,
  hooks?: StreamHooks,
): Promise<SendResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let stopReason: string | null = null;
  // Blocks reconstructed by their `index`; `toolJson` accumulates each tool_use's
  // streamed input JSON until its content_block_stop, when we parse it.
  const blocks: Record<number, Record<string, unknown>> = {};
  let maxIndex = -1;
  const toolJson: Record<number, string> = {};
  let lastSummary = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "" || payload === "[DONE]") continue;
        let ev: {
          type?: string;
          index?: number;
          content_block?: Record<string, unknown>;
          delta?: Record<string, unknown>;
          error?: unknown;
        };
        try {
          ev = JSON.parse(payload);
        } catch {
          continue;
        }
        if (ev.type === "error") {
          throw new Error(`Anthropic stream error: ${JSON.stringify(ev.error)}`);
        }
        if (ev.type === "content_block_start" && typeof ev.index === "number") {
          const cb = { ...(ev.content_block ?? {}) };
          blocks[ev.index] = cb;
          maxIndex = Math.max(maxIndex, ev.index);
          if (cb.type === "tool_use") {
            toolJson[ev.index] = "";
            cb.input = {};
            lastSummary = "";
            hooks?.onStatus?.(toolLabel(String(cb.name)));
          }
        } else if (ev.type === "content_block_delta" && typeof ev.index === "number") {
          const b = blocks[ev.index];
          const d = ev.delta ?? {};
          if (b === undefined) continue;
          if (d.type === "text_delta") {
            b.text = String(b.text ?? "") + String(d.text ?? "");
            hooks?.onText?.(String(d.text ?? ""));
          } else if (d.type === "thinking_delta") {
            b.thinking = String(b.thinking ?? "") + String(d.thinking ?? "");
            hooks?.onStatus?.("Thinking…");
          } else if (d.type === "signature_delta") {
            b.signature = String(b.signature ?? "") + String(d.signature ?? "");
          } else if (d.type === "input_json_delta") {
            const acc = (toolJson[ev.index] ?? "") + String(d.partial_json ?? "");
            toolJson[ev.index] = acc;
            if (b.name === "set_script") {
              const s = partialField(acc, "summary");
              if (s !== null && s !== lastSummary) {
                lastSummary = s;
                hooks?.onStatus?.(s);
              }
            }
          }
        } else if (ev.type === "content_block_stop" && typeof ev.index === "number") {
          const b = blocks[ev.index];
          if (b?.type === "tool_use") {
            try {
              b.input = JSON.parse(toolJson[ev.index] || "{}");
            } catch {
              b.input = {};
            }
          }
        } else if (ev.type === "message_delta") {
          const sr = (ev.delta ?? {}).stop_reason;
          if (typeof sr === "string") stopReason = sr;
        }
      }
    }
  }

  const content: ContentBlock[] = [];
  for (let i = 0; i <= maxIndex; i++) if (blocks[i]) content.push(blocks[i] as unknown as ContentBlock);
  return { content, stop_reason: stopReason };
}

/** Build an Anthropic provider from its config. */
export function makeAnthropicProvider(cfg: AnthropicConfig): AiProvider {
  return {
    id: "anthropic",
    capabilities: { tools: true, vision: true },
    async send(messages: ChatMessage[], opts: SendOptions): Promise<SendResult> {
      if (!cfg.key.trim()) throw new Error("no Anthropic API key set (add one in AI settings)");
      // Cache the growing conversation prefix: a breakpoint on the LAST message's
      // last block so every tool-loop round (and the next turn's shared prefix)
      // re-reads the history — editor context, prior tool_results, any preview
      // images — at the cache rate instead of re-billing it each round.
      const reqMessages: { role: string; content: unknown }[] = messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));
      if (reqMessages.length > 0) {
        reqMessages[reqMessages.length - 1]!.content = withCacheControl(
          messages[messages.length - 1]!.content,
        );
      }
      const resp = await fetch(API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": cfg.key,
          "anthropic-version": "2023-06-01",
          // Enables the direct browser→Anthropic CORS path (BYO key, static site).
          "anthropic-dangerous-direct-browser-access": "true",
        },
        signal: opts.signal ?? null,
        body: JSON.stringify({
          model: cfg.model,
          // A set_script carrying a whole shader PLUS adaptive-thinking tokens
          // easily exceeds a small ceiling, and a mid-tool-call cutoff wedges the
          // chat (see chatTurn's truncation guard). max_tokens is a ceiling, not a
          // cost, so give it real headroom.
          max_tokens: opts.maxTokens ?? 16000,
          // opus-4-8 supports ADAPTIVE thinking only. The lever to shorten the
          // up-front "Thinking…" is output_config.effort: "medium" trades a little
          // depth for a quicker, more interactive pace.
          thinking: { type: "adaptive" },
          output_config: { effort: "medium" },
          stream: true,
          // Frozen, cacheable system prefix so caching engages across turns.
          system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
          ...(opts.tools.length ? { tools: opts.tools } : {}),
          messages: reqMessages,
        }),
      });
      if (!resp.ok || resp.body === null) {
        const body = await resp.text().catch(() => "");
        throw new Error(`Anthropic API ${resp.status}: ${body.slice(0, 300)}`);
      }
      return consumeChatStream(resp.body, opts.stream);
    },
  };
}
