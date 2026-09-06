/**
 * wllama tool text-protocol + message translation (PURE — no engine/wasm import,
 * so it's node-testable; see web/tests/wllamaProvider.test.ts). Kept separate from
 * wllama.ts, which pulls in the bundled WASM engine (a top-level `?url` asset
 * import that can't load under the node unit-test runtime).
 *
 * wllama has no native function-calling, so tool use is a text convention: the
 * tool specs go in the system prompt, the model emits `<tool_call>{json}</tool_call>`
 * (Hermes / Qwen-2.5 style), and we parse those back into neutral tool_use blocks.
 */

import type { ChatMessage, ContentBlock, ToolDef } from "../provider";

/** Models whose chat template + training reliably emit the `<tool_call>` JSON
 * convention. Matched loosely on the GGUF filename/URL (models are arbitrary HF
 * URLs here, unlike web-llm's fixed catalog). Everything else → plain chat. */
export function wllamaModelSupportsTools(modelUrlOrId: string): boolean {
  const s = modelUrlOrId.toLowerCase();
  const isInstruct = s.includes("instruct") || s.includes("hermes");
  return isInstruct && (s.includes("qwen2.5") || s.includes("qwen3") || s.includes("hermes"));
}

/** The system-prompt addendum describing the advertised tools + the wire
 * convention the model must follow to call them. */
export function formatToolInstructions(tools: readonly ToolDef[]): string {
  const specs = tools
    .map((t) => `- ${t.name}: ${t.description}\n  arguments schema: ${JSON.stringify(t.input_schema)}`)
    .join("\n");
  return (
    `\n\n# Tools\n` +
    `You can call tools. To call one, emit a line of exactly this form (and nothing else on that line):\n` +
    `<tool_call>{"name": "<tool>", "arguments": { ... }}</tool_call>\n` +
    `You may call multiple tools by emitting multiple such lines. After a tool runs you'll get a ` +
    `<tool_response> with its result; continue until the task is done, then reply normally.\n\n` +
    `Available tools:\n${specs}`
  );
}

/** Serialize one neutral message's content to the flat string wllama's chat
 * template consumes. Assistant tool_use → `<tool_call>` lines; user tool_result
 * → `<tool_response>` blocks; images are dropped (this path has no vision). */
export function contentToText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const b of content) {
    if (b.type === "text") {
      parts.push(b.text);
    } else if (b.type === "tool_use") {
      parts.push(`<tool_call>${JSON.stringify({ name: b.name, arguments: b.input })}</tool_call>`);
    } else if (b.type === "tool_result") {
      const text = b.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      parts.push(`<tool_response>${text || "(no text output)"}</tool_response>`);
    }
  }
  return parts.join("\n");
}

/** Build the wllama `messages` array from the neutral history + system prompt. */
export function messagesToWllama(
  system: string,
  messages: ChatMessage[],
): { role: string; content: string }[] {
  const out: { role: string; content: string }[] = [{ role: "system", content: system }];
  for (const m of messages) out.push({ role: m.role, content: contentToText(m.content) });
  return out;
}

/** Extract `<tool_call>{...}</tool_call>` blocks from generated text, returning
 * the parsed calls plus the prose with those blocks removed. Tolerant of
 * whitespace and of malformed JSON (a call that won't parse is skipped). */
export function parseToolCalls(text: string): {
  calls: { name: string; input: Record<string, unknown> }[];
  text: string;
} {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1]!) as { name?: unknown; arguments?: unknown };
      if (typeof obj.name === "string") {
        const input =
          obj.arguments && typeof obj.arguments === "object"
            ? (obj.arguments as Record<string, unknown>)
            : {};
        calls.push({ name: obj.name, input });
      }
    } catch {
      // malformed tool call — skip it (the prose still shows through)
    }
  }
  const prose = text.replace(re, "").trim();
  return { calls, text: prose };
}
