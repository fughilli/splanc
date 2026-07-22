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

/** Build the user turn for a fresh ask or a refinement (with current script). */
export function askTurn(ask: string, currentScript?: string): Turn {
  const content = currentScript
    ? `Current script:\n\n${currentScript}\n\nRequested change: ${ask}`
    : ask;
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
