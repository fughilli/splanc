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
 * URLs here, unlike web-llm's fixed catalog). Everything else → plain chat.
 *
 * Hermes, Qwen3 and Granite are instruction/tool-tuned by default — their GGUFs
 * often omit an "-instruct" suffix (e.g. "Qwen3-0.6B-…", "granite-4.0-350m-…"), so
 * requiring "instruct" would wrongly exclude them. IBM Granite emits the SAME
 * `<tool_call>{name,arguments}</tool_call>` convention, so no parser change is
 * needed. Qwen2.5 ships base AND instruct variants, so it must say "instruct" to
 * be treated as a tool-capable chat model. */
export function wllamaModelSupportsTools(modelUrlOrId: string): boolean {
  const s = modelUrlOrId.toLowerCase();
  if (s.includes("hermes")) return true;
  if (s.includes("qwen3")) return true;
  if (s.includes("granite")) return true;
  if (s.includes("qwen2.5") && s.includes("instruct")) return true;
  return false;
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

/** Strip a wrapping markdown code fence from a model-supplied script. Small
 * (esp. on-device) models sometimes wrap the `set_script` source in ```` ``` ````
 * despite the schema asking for raw source, which then fails to compile. Removes
 * a leading fence (with an optional language tag ONLY when it's alone on the first
 * line — so real code that happens to start right after the backticks is kept)
 * and a trailing fence. Valid DSL never legitimately starts with ```` ``` ````, so
 * this is safe for every provider. */
export function stripCodeFence(s: string): string {
  let t = s.trim();
  if (t.startsWith("```")) {
    t = t.slice(3);
    const nl = t.indexOf("\n");
    const firstLine = (nl === -1 ? t : t.slice(0, nl)).trim();
    // Drop a bare language tag line (e.g. ```glsl\n…); keep code that ran on the
    // same line as the opening backticks (```uniform float…).
    if (nl !== -1 && firstLine.length <= 12 && /^[a-zA-Z0-9_-]*$/.test(firstLine)) {
      t = t.slice(nl + 1);
    }
  }
  if (t.endsWith("```")) t = t.slice(0, -3);
  return t.trim();
}

/** Does a blob of text look like an effect PROGRAM (not prose)? Used by the
 * prose-recovery fallback: a small model often IGNORES the tool convention and
 * just prints the program (in a ``` block or bare) into the chat. We detect the
 * two mandatory entry points so we don't misfire on ordinary prose. */
export function looksLikeEffectSource(s: string): boolean {
  return /\bshade\s*\(/.test(s) && /\b(void\s+update|update\s*\()/.test(s);
}

/** Fallback for models that narrate a program instead of calling set_script:
 * pull the most likely effect source out of `text` (a fenced code block if
 * present, else the whole text) and, when it looks like a real program, return a
 * synthetic set_script call so the turn still applies. Returns null when nothing
 * program-like is found (genuine prose / a refusal). This is what makes the tiny
 * on-device models usable — measured against the native path in the eval. */
export function recoverSetScriptFromProse(
  text: string,
): { name: "set_script"; input: { source: string; summary: string } } | null {
  const wrap = (source: string): { name: "set_script"; input: { source: string; summary: string } } =>
    ({ name: "set_script", input: { source, summary: "recovered from prose" } });

  // Case 1: a TRUNCATED / unparseable tool call — the model started
  // `<tool_call>{"name":"set_script","arguments":{...,"source":"..."` but never
  // closed it (a common small-model failure: it rambles past the token cap).
  // parseToolCalls (which needs a complete, valid block) found nothing, so pull
  // the `source` string straight out of the partial JSON. Do this FIRST so we
  // never mistake the `<tool_call>{…` markup itself for effect source.
  const srcKey = /"source"\s*:\s*"/.exec(text);
  if (srcKey) {
    let out = "";
    for (let i = srcKey.index + srcKey[0].length; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === "\\") {
        const next = text[i + 1];
        if (next === undefined) break;
        out += next === "n" ? "\n" : next === "t" ? "\t" : next;
        i++;
      } else if (ch === '"') {
        break; // closing quote — source complete
      } else {
        out += ch;
      }
    }
    const src = stripCodeFence(out);
    if (looksLikeEffectSource(src)) return wrap(src);
  }

  // Case 2: the model printed the program as PROSE — a fenced ```code``` block,
  // or the whole message when it's plainly a program. Never treat leftover
  // tool-call markup as source.
  if (/<tool_call>/i.test(text) || /"name"\s*:\s*"set_script"/.test(text)) return null;
  const fence = /```[a-zA-Z0-9_-]*\n([\s\S]*?)```/.exec(text);
  const candidate = stripCodeFence(fence ? fence[1]! : text);
  if (!looksLikeEffectSource(candidate)) return null;
  return wrap(candidate);
}

/** Scan a balanced JSON object starting at `text[start] === "{"`, respecting
 * string literals + escapes so braces inside strings don't miscount. Returns the
 * index just past the closing brace, or -1 if it never balances (truncated). */
function scanJsonObject(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (ch === "\\") i++; // skip the escaped char
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Extract `<tool_call>` calls from generated text, returning the parsed calls
 * plus the prose with those blocks removed. Tolerant of whitespace and of
 * malformed JSON (a call that won't parse is skipped). Crucially, ALSO tolerant
 * of a MISSING closing `</tool_call>` tag: small models routinely emit valid
 * `<tool_call>{…}` JSON but forget the closing tag, and a strict tag-pair regex
 * would drop the call entirely. We locate each `<tool_call>`, brace-match the
 * JSON object after it, and consume an optional trailing `</tool_call>`. */
export function parseToolCalls(text: string): {
  calls: { name: string; input: Record<string, unknown> }[];
  text: string;
} {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const OPEN = "<tool_call>";
  const CLOSE = "</tool_call>";
  let prose = "";
  let cursor = 0;
  for (;;) {
    const open = text.indexOf(OPEN, cursor);
    if (open === -1) break;
    const braceStart = text.indexOf("{", open + OPEN.length);
    // No JSON object after the tag → treat the tag as noise, keep scanning.
    if (braceStart === -1) {
      prose += text.slice(cursor, open + OPEN.length);
      cursor = open + OPEN.length;
      continue;
    }
    const braceEnd = scanJsonObject(text, braceStart);
    prose += text.slice(cursor, open); // text before this call stays in the prose
    const jsonEnd = braceEnd === -1 ? text.length : braceEnd;
    try {
      const obj = JSON.parse(text.slice(braceStart, jsonEnd)) as {
        name?: unknown;
        arguments?: unknown;
      };
      if (typeof obj.name === "string") {
        const input =
          obj.arguments && typeof obj.arguments === "object"
            ? (obj.arguments as Record<string, unknown>)
            : {};
        calls.push({ name: obj.name, input });
      }
    } catch {
      // malformed / truncated JSON — skip the call (recovery may salvage it).
    }
    // Advance past the JSON and an optional immediately-following close tag.
    let after = jsonEnd;
    const rest = text.slice(jsonEnd);
    const ws = rest.length - rest.trimStart().length;
    if (text.startsWith(CLOSE, jsonEnd + ws)) after = jsonEnd + ws + CLOSE.length;
    cursor = after;
  }
  prose += text.slice(cursor);
  return { calls, text: prose.trim() };
}
