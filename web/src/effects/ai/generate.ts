/**
 * AI effect generation — BYO-key, direct browser→Anthropic CORS
 * (docs/design/effects-compiler.md §"AI generation", DECISION: no server proxy
 * anywhere; client-side CORS to api.anthropic.com; BYO key from localStorage).
 *
 * Streams the Messages API so the script arrives live in the editor; the caller
 * defers compilation until the stream settles (debounced) so the user doesn't
 * see errors thrashing mid-generation. The system prompt is a frozen, cacheable
 * prefix (system-prompt.ts) so the repair loop pays the cached rate.
 *
 * There is NO worker and NO proxy here — this is a plain fetch from the page.
 */

import type { FxDiagnostic } from "../../fx/preview";
import { OUTPUT_SCHEMA, SYSTEM_PROMPT } from "./system-prompt";

const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-8";
const KEY_STORAGE = "ledmapper.anthropicKey";

/** Read/write the BYO Anthropic key (localStorage; single-user self-host). */
export function getApiKey(): string | null {
  try {
    return localStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}
export function setApiKey(key: string): void {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    // storage unavailable — generation just won't have a key
  }
}

/** One conversation turn kept in the workspace so follow-ups refine. */
export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateResult {
  script: string;
  notes: string;
}

interface GenerateOptions {
  /** Called with the partial script text as it streams in (live editor feed). */
  onScript?: (partial: string) => void;
  signal?: AbortSignal;
}

/** Build the user turn for a fresh ask or a refinement (with current script).
 * `perfContext` (optional) is the assembled AI perf-context prompt block
 * (effects/perfContext.perfContextToPrompt) — measured or predicted metrics +
 * the hot-opcode histogram — so an "optimize this" ask is grounded in the
 * effect's actual budget. */
export function askTurn(ask: string, currentScript?: string, perfContext?: string): Turn {
  const base = currentScript
    ? `Current script:\n\n${currentScript}\n\nRequested change: ${ask}`
    : ask;
  const content = perfContext ? `${base}\n\n${perfContext}` : base;
  return { role: "user", content };
}

/** Build the user turn for an auto-repair round from compiler diagnostics. */
export function repairTurn(script: string, diagnostics: FxDiagnostic[]): Turn {
  const list = diagnostics
    .map((d) => `- line ${d.line + 1}, col ${d.col + 1}: ${d.msg}`)
    .join("\n");
  return {
    role: "user",
    content: `The previous script does not compile. Fix every error; change as little else as possible.\n\nScript:\n\n${script}\n\nCompiler diagnostics:\n${list}`,
  };
}

/**
 * One Messages API call. Streams text; parses the final `{script, notes}` JSON
 * (structured output guarantees the shape). Throws on transport/HTTP errors.
 */
export async function generate(
  turns: Turn[],
  opts: GenerateOptions = {},
): Promise<GenerateResult> {
  const key = getApiKey();
  if (!key) throw new Error("no Anthropic API key set (add one in AI settings)");

  const resp = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      // Enables the direct browser→Anthropic CORS path (BYO key, static site).
      "anthropic-dangerous-direct-browser-access": "true",
    },
    signal: opts.signal ?? null,
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      stream: true,
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
      messages: turns.map((t) => ({ role: t.role, content: t.content })),
    }),
  });

  if (!resp.ok || resp.body === null) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Anthropic API ${resp.status}: ${body.slice(0, 300)}`);
  }

  const raw = await consumeStream(resp.body, opts.onScript);
  return parseResult(raw);
}

/**
 * Read the SSE stream, concatenating text deltas into the raw JSON string.
 * The structured output arrives as ordinary text_delta events forming the JSON
 * object; we surface the in-progress `script` field to `onScript` as it grows.
 */
async function consumeStream(
  body: ReadableStream<Uint8Array>,
  onScript?: (partial: string) => void,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let json = "";
  let lastScript = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by blank lines; each carries a `data:` line.
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "" || payload === "[DONE]") continue;
        let ev: unknown;
        try {
          ev = JSON.parse(payload);
        } catch {
          continue;
        }
        const delta = extractTextDelta(ev);
        if (delta === null) continue;
        json += delta;
        if (onScript) {
          const partial = partialScript(json);
          if (partial !== null && partial !== lastScript) {
            lastScript = partial;
            onScript(partial);
          }
        }
      }
    }
  }
  return json;
}

function extractTextDelta(ev: unknown): string | null {
  if (ev === null || typeof ev !== "object") return null;
  const e = ev as { type?: string; delta?: { type?: string; text?: string } };
  if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
    return e.delta.text ?? "";
  }
  return null;
}

/** Best-effort extraction of the in-progress `script` field from partial JSON. */
function partialScript(json: string): string | null {
  const m = /"script"\s*:\s*"/.exec(json);
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
      break; // closing quote — script field is complete
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

function parseResult(json: string): GenerateResult {
  const obj = JSON.parse(json) as { script?: unknown; notes?: unknown };
  if (typeof obj.script !== "string") throw new Error("AI response missing `script`");
  return {
    script: obj.script,
    notes: typeof obj.notes === "string" ? obj.notes : "",
  };
}

// =============================================================================
// Interactive chat with a tool-use loop (replaces the one-shot generate above
// in the editor). The conversation is multi-turn; the assistant can call two
// client-fulfilled tools:
//   - set_script({source})   → replace the editor content + trigger a compile
//   - capture_preview()      → render the live FxPreview canvas to a PNG and
//                              return it as an IMAGE tool_result block (vision),
//                              so the model can SEE the effect and iterate.
// The loop: send messages(+tools) → if the response has tool_use, execute each
// tool locally, append tool_result blocks, and call again; stop at a final text
// turn. The system prompt is a stable cached prefix so prompt caching engages
// across turns (docs: model claude-opus-4-8, anthropic-version 2023-06-01,
// direct-browser CORS, BYO key).
// =============================================================================

/** A content block in an Anthropic message (the subset we produce/consume). */
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

/** The tool the model calls to replace the editor script. */
export interface SetScriptCall {
  source: string;
}

/** Client-side fulfillment of the two tools + streaming hooks. The editor
 * supplies these so the AI can act on the live editor + preview. */
export interface ChatHooks {
  /** The model proposed a new script. Apply it, compile, and return the compile
   * outcome text (ok/diagnostics/uniforms + disassembly) to feed back. */
  onSetScript: (source: string) => Promise<string>;
  /** The model asked to see the preview. Return a PNG data URL
   * ("data:image/png;base64,...") of the current live preview canvas. */
  onCapturePreview: () => Promise<string>;
  /** Streamed assistant text (deltas) for the "thinking…"/live panel. */
  onText?: (delta: string) => void;
  /** A tool is about to run (for a status line in the panel). */
  onToolUse?: (name: string) => void;
  signal?: AbortSignal;
}

const TOOLS = [
  {
    name: "set_script",
    description:
      "Replace the entire editor script with a new effect program and compile it. " +
      "Use this to author or revise the effect. The compile result (success, " +
      "diagnostics, uniforms, and disassembly) is returned so you can iterate.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        source: { type: "string", description: "The complete new effect source." },
      },
      required: ["source"],
    },
  },
  {
    name: "capture_preview",
    description:
      "Render the current live preview to a PNG image so you can see how the " +
      "effect looks on the LED map right now, and comment or iterate on it.",
    input_schema: { type: "object", additionalProperties: false, properties: {} },
  },
] as const;

const CHAT_SYSTEM = `${SYSTEM_PROMPT}

You are now in an interactive chat with the user inside the effect editor. You can:
- Answer questions about the current effect program.
- Call set_script to author or revise the effect; you'll get the compile result back (fix any errors and iterate).
- Call capture_preview to SEE the live preview rendered to an image, then comment on or refine the look.
Keep prose brief. When you change the script, prefer minimal, targeted edits. After a change, it's often useful to capture_preview to confirm the result.`;

function dataUrlToImageBlock(dataUrl: string): {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
} {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  const media_type = m?.[1] ?? "image/png";
  const data = m?.[2] ?? "";
  return { type: "image", source: { type: "base64", media_type, data } };
}

async function messagesRequest(messages: ChatMessage[], signal?: AbortSignal): Promise<{
  content: ContentBlock[];
  stop_reason: string | null;
}> {
  const key = getApiKey();
  if (!key) throw new Error("no Anthropic API key set (add one in AI settings)");
  const resp = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    signal: signal ?? null,
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      // Frozen, cacheable system prefix so caching engages across turns.
      system: [
        { type: "text", text: CHAT_SYSTEM, cache_control: { type: "ephemeral" } },
      ],
      tools: TOOLS,
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
}

/** Assemble the always-included editor context block for a user turn: the
 * current source + latest compile result (+ disassembly when present). */
export function editorContext(opts: {
  source: string;
  compileSummary: string;
  disassembly?: string;
}): string {
  let ctx = `Current editor script:\n\n\`\`\`\n${opts.source}\n\`\`\`\n\nLatest compile result: ${opts.compileSummary}`;
  if (opts.disassembly) {
    ctx += `\n\nDisassembly:\n\`\`\`\n${opts.disassembly}\n\`\`\``;
  }
  return ctx;
}

/**
 * Run the tool-use loop for one user turn. `history` is the running conversation
 * (mutated in place: the user turn should already be appended by the caller, or
 * pass it and we append). Returns the updated history plus the final assistant
 * text. Executes set_script / capture_preview locally; a few rounds of
 * auto-iteration are natural since the model gets compile results back.
 */
export async function chatTurn(history: ChatMessage[], hooks: ChatHooks): Promise<string> {
  let finalText = "";
  const MAX_ROUNDS = 8; // hard cap so a misbehaving loop can't run forever
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { content, stop_reason } = await messagesRequest(history, hooks.signal);
    history.push({ role: "assistant", content });

    // Surface any assistant text.
    for (const block of content) {
      if (block.type === "text" && block.text) {
        finalText = block.text;
        hooks.onText?.(block.text);
      }
    }

    const toolUses = content.filter(
      (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
    );
    if (stop_reason !== "tool_use" || toolUses.length === 0) break;

    // Fulfill every tool call locally, then feed the results back in one user turn.
    const results: ContentBlock[] = [];
    for (const tu of toolUses) {
      hooks.onToolUse?.(tu.name);
      try {
        if (tu.name === "set_script") {
          const source = String((tu.input as { source?: unknown }).source ?? "");
          const summary = await hooks.onSetScript(source);
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: [{ type: "text", text: summary }],
          });
        } else if (tu.name === "capture_preview") {
          const dataUrl = await hooks.onCapturePreview();
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: [
              { type: "text", text: "Live preview rendered:" },
              dataUrlToImageBlock(dataUrl),
            ],
          });
        } else {
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: [{ type: "text", text: `unknown tool ${tu.name}` }],
            is_error: true,
          });
        }
      } catch (e) {
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: [{ type: "text", text: `tool error: ${e instanceof Error ? e.message : String(e)}` }],
          is_error: true,
        });
      }
    }
    history.push({ role: "user", content: results });
  }
  return finalText;
}
