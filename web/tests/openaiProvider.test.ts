/**
 * OpenAI-compatible provider translation tests (FUG-87): the neutral
 * (Anthropic-shaped) message/tool blocks ↔ the OpenAI `/chat/completions` wire
 * shape. These are the load-bearing bits that let a local model drive the same
 * tool-use loop the cloud provider does.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  finishReasonToStop,
  fromOpenAiMessage,
  joinUrl,
  serverRoot,
  toOpenAiMessages,
  toOpenAiTools,
  type OaiMessage,
} from "../src/effects/ai/providers/openaiCompat";
import type { ChatMessage, ToolDef } from "../src/effects/ai/provider";

test("toOpenAiTools wraps neutral tool defs as OpenAI functions", () => {
  const tools: ToolDef[] = [
    { name: "set_script", description: "d", input_schema: { type: "object" } },
  ];
  assert.deepEqual(toOpenAiTools(tools), [
    { type: "function", function: { name: "set_script", description: "d", parameters: { type: "object" } } },
  ]);
});

test("toOpenAiMessages prepends the system prompt and passes string turns", () => {
  const out = toOpenAiMessages("SYS", [{ role: "user", content: "hi" }]);
  assert.deepEqual(out, [
    { role: "system", content: "SYS" },
    { role: "user", content: "hi" },
  ]);
});

test("toOpenAiMessages maps assistant text + tool_use to content + tool_calls", () => {
  const history: ChatMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "thinking" },
        { type: "tool_use", id: "t1", name: "set_script", input: { source: "x" } },
      ],
    },
  ];
  const out = toOpenAiMessages("", history);
  assert.deepEqual(out, [
    {
      role: "assistant",
      content: "thinking",
      tool_calls: [
        { id: "t1", type: "function", function: { name: "set_script", arguments: '{"source":"x"}' } },
      ],
    },
  ]);
});

test("toOpenAiMessages turns tool_result blocks into tool messages", () => {
  const history: ChatMessage[] = [
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok: compiled" }] },
      ],
    },
  ];
  const out = toOpenAiMessages("", history);
  assert.deepEqual(out, [{ role: "tool", tool_call_id: "t1", content: "ok: compiled" }]);
});

test("toOpenAiMessages folds a tool_result image into a trailing user message", () => {
  const history: ChatMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t9",
          content: [
            { type: "text", text: "Live preview rendered:" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
          ],
        },
      ],
    },
  ];
  const out = toOpenAiMessages("", history);
  // The tool message comes first (must follow the assistant tool_calls), then a
  // user message carrying the image so vision models can see it.
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { role: "tool", tool_call_id: "t9", content: "Live preview rendered:" });
  assert.deepEqual(out[1], {
    role: "user",
    content: [
      { type: "text", text: "Rendered preview:" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
    ],
  });
});

test("fromOpenAiMessage extracts plain assistant text", () => {
  const msg: OaiMessage = { role: "assistant", content: "hello" };
  assert.deepEqual(fromOpenAiMessage(msg), [{ type: "text", text: "hello" }]);
});

test("fromOpenAiMessage extracts tool_calls into tool_use blocks", () => {
  const msg: OaiMessage = {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "c1", type: "function", function: { name: "set_script", arguments: '{"source":"x"}' } },
    ],
  };
  assert.deepEqual(fromOpenAiMessage(msg), [
    { type: "tool_use", id: "c1", name: "set_script", input: { source: "x" } },
  ]);
});

test("fromOpenAiMessage tolerates malformed tool arguments", () => {
  const msg: OaiMessage = {
    role: "assistant",
    tool_calls: [{ id: "c2", type: "function", function: { name: "f", arguments: "not json" } }],
  };
  assert.deepEqual(fromOpenAiMessage(msg), [{ type: "tool_use", id: "c2", name: "f", input: {} }]);
});

test("finishReasonToStop maps tool_calls to the loop's tool_use signal", () => {
  assert.equal(finishReasonToStop("tool_calls"), "tool_use");
  assert.equal(finishReasonToStop("stop"), "end_turn");
  assert.equal(finishReasonToStop(null), "end_turn");
  assert.equal(finishReasonToStop(undefined), "end_turn");
});

test("joinUrl / serverRoot handle trailing slashes and the /v1 suffix", () => {
  assert.equal(joinUrl("http://localhost:11434/v1", "/chat/completions"), "http://localhost:11434/v1/chat/completions");
  assert.equal(joinUrl("http://localhost:11434/v1/", "chat/completions"), "http://localhost:11434/v1/chat/completions");
  assert.equal(serverRoot("http://localhost:11434/v1"), "http://localhost:11434");
  assert.equal(serverRoot("http://localhost:11434/v1/"), "http://localhost:11434");
  assert.equal(serverRoot("http://localhost:8080"), "http://localhost:8080");
});
