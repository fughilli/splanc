/**
 * wllama (in-browser CPU) provider — the pure, testable pieces: the tool-model
 * allow-list, the neutral↔wllama message translation, the `<tool_call>` text
 * protocol, and the tool-call parser. The wllama runtime itself (WASM/CPU) is
 * browser-only and validated on-device; here we lock down the translation +
 * parsing that decide correctness.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  wllamaModelSupportsTools,
  formatToolInstructions,
  contentToText,
  messagesToWllama,
  parseToolCalls,
} from "../src/effects/ai/providers/wllamaProtocol";
import type { ChatMessage, ToolDef } from "../src/effects/ai/provider";

test("tool allow-list: qwen2.5-instruct / qwen3 / hermes yes, others no", () => {
  assert.equal(wllamaModelSupportsTools("…/qwen2.5-3b-instruct-q4_k_m.gguf"), true);
  assert.equal(wllamaModelSupportsTools("…/Qwen2.5-1.5B-Instruct-GGUF/…"), true);
  assert.equal(wllamaModelSupportsTools("…/Hermes-3-Llama-3.2-3B.gguf"), true);
  // Qwen3 is tool-tuned by default — its GGUFs usually omit "-instruct".
  assert.equal(wllamaModelSupportsTools("…/Qwen3-0.6B-Q8_0.gguf"), true);
  assert.equal(wllamaModelSupportsTools("…/Qwen3-1.7B-Q4_K_M.gguf"), true);
  // IBM Granite is tool-aware by default and emits the same <tool_call> format.
  assert.equal(wllamaModelSupportsTools("…/granite-4.0-350m-Q4_K_M.gguf"), true);
  assert.equal(wllamaModelSupportsTools("…/granite-4.0-h-350m-Q4_K_M.gguf"), true);
  // Qwen2.5 BASE (no "instruct") is not a chat/tool model → plain chat only.
  assert.equal(wllamaModelSupportsTools("…/qwen2.5-0.5b-q4_k_m.gguf"), false);
  // Instruct but not a tool-convention family → plain chat only.
  assert.equal(wllamaModelSupportsTools("…/llama-3.2-1b-instruct-q4.gguf"), false);
  // Not instruct at all.
  assert.equal(wllamaModelSupportsTools("…/tinyllama-1.1b-chat.gguf"), false);
  assert.equal(wllamaModelSupportsTools(""), false);
});

test("formatToolInstructions lists each tool + the wire convention", () => {
  const tools: ToolDef[] = [
    { name: "set_script", description: "Replace the script.", input_schema: { type: "object" } },
    { name: "capture_preview", description: "See the preview.", input_schema: { type: "object" } },
  ];
  const s = formatToolInstructions(tools);
  assert.match(s, /<tool_call>/);
  assert.match(s, /set_script/);
  assert.match(s, /capture_preview/);
  assert.match(s, /Replace the script\./);
});

test("contentToText: string passthrough + block serialization (images dropped)", () => {
  assert.equal(contentToText("hello"), "hello");

  // Assistant tool_use → a <tool_call> line with name + arguments.
  const asst = contentToText([
    { type: "text", text: "on it" },
    { type: "tool_use", id: "t1", name: "set_script", input: { source: "x" } },
  ]);
  assert.match(asst, /on it/);
  assert.match(asst, /<tool_call>\{"name":"set_script","arguments":\{"source":"x"\}\}<\/tool_call>/);

  // tool_result → <tool_response> with the text; an image block is dropped.
  const res = contentToText([
    {
      type: "tool_result",
      tool_use_id: "t1",
      content: [
        { type: "text", text: "Compile OK" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ],
    },
  ]);
  assert.match(res, /<tool_response>Compile OK<\/tool_response>/);
  assert.doesNotMatch(res, /AAAA/); // image never leaks into the CPU/text path
});

test("messagesToWllama prepends the system turn and flattens content", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "make it blue" },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ];
  const out = messagesToWllama("SYSTEM", history);
  assert.deepEqual(out[0], { role: "system", content: "SYSTEM" });
  assert.deepEqual(out[1], { role: "user", content: "make it blue" });
  assert.deepEqual(out[2], { role: "assistant", content: "done" });
});

test("parseToolCalls extracts calls and strips them from the prose", () => {
  const raw =
    'Sure, updating now.\n' +
    '<tool_call>{"name": "set_script", "arguments": {"source": "void main(){}"}}</tool_call>\n' +
    'and checking perf\n' +
    '<tool_call>{"name":"estimate_performance","arguments":{}}</tool_call>';
  const { calls, text } = parseToolCalls(raw);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { name: "set_script", input: { source: "void main(){}" } });
  assert.deepEqual(calls[1], { name: "estimate_performance", input: {} });
  assert.match(text, /Sure, updating now\./);
  assert.doesNotMatch(text, /<tool_call>/); // blocks removed from the visible reply
});

test("parseToolCalls tolerates malformed JSON (skips it, keeps prose)", () => {
  const raw = 'text <tool_call>{not json}</tool_call> more';
  const { calls, text } = parseToolCalls(raw);
  assert.equal(calls.length, 0);
  assert.match(text, /text/);
  assert.match(text, /more/);
});

test("parseToolCalls: no tool call → empty calls, prose unchanged", () => {
  const { calls, text } = parseToolCalls("just a normal answer");
  assert.equal(calls.length, 0);
  assert.equal(text, "just a normal answer");
});
