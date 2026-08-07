/**
 * Anthropic provider (FUG-87) — the cloud default, BYO key, direct browser→API
 * CORS with no server proxy (docs/design/effects-compiler.md §"AI generation").
 *
 * The neutral message/tool representation (provider.ts) is already
 * Anthropic-shaped — content blocks with tool_use / tool_result / image, tools
 * with `input_schema` — so this provider is essentially a passthrough that adds
 * the auth headers and the cacheable system prefix. Extracted from the original
 * inline `messagesRequest` in generate.ts.
 */

import type {
  AiProvider,
  AnthropicConfig,
  ChatMessage,
  ContentBlock,
  SendOptions,
  SendResult,
} from "../provider";

const API_URL = "https://api.anthropic.com/v1/messages";

/** Build an Anthropic provider from its config. */
export function makeAnthropicProvider(cfg: AnthropicConfig): AiProvider {
  return {
    id: "anthropic",
    capabilities: { tools: true, vision: true },
    async send(messages: ChatMessage[], opts: SendOptions): Promise<SendResult> {
      if (!cfg.key.trim()) throw new Error("no Anthropic API key set (add one in AI settings)");
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
          max_tokens: opts.maxTokens ?? 4000,
          thinking: { type: "adaptive" },
          // Frozen, cacheable system prefix so caching engages across turns.
          system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
          ...(opts.tools.length ? { tools: opts.tools } : {}),
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`Anthropic API ${resp.status}: ${body.slice(0, 300)}`);
      }
      const json = (await resp.json()) as {
        content?: ContentBlock[];
        stop_reason?: string | null;
      };
      return { content: json.content ?? [], stop_reason: json.stop_reason ?? null };
    },
  };
}
