/**
 * Chat persistence sanitization (FUG-87 review): captured preview images are
 * stripped before saving, and history is trimmed only at safe round boundaries
 * so a truncated conversation never begins on a dangling tool result.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { stripImages, trimHistory } from "../src/store/chatStore";
import type { ChatMessage } from "../src/effects/ai/provider";

test("stripImages replaces image tool-results with a text placeholder", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "hi" },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: [
            { type: "text", text: "Live preview rendered:" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          ],
        },
      ],
    },
  ];
  const out = stripImages(history);
  // Plain string turns are untouched.
  assert.deepEqual(out[0], { role: "user", content: "hi" });
  const tr = out[1]!.content;
  assert.ok(Array.isArray(tr));
  const block = (tr as Extract<ChatMessage["content"], unknown[]>)[0];
  assert.equal(block?.type, "tool_result");
  if (block?.type === "tool_result") {
    assert.deepEqual(block.content, [
      { type: "text", text: "Live preview rendered:" },
      { type: "text", text: "[preview image omitted]" },
    ]);
  }
  // The original is not mutated.
  const origBlock = history[1]!.content;
  assert.ok(Array.isArray(origBlock));
});

test("trimHistory keeps short histories intact", () => {
  const h: ChatMessage[] = [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
  ];
  assert.equal(trimHistory(h), h);
});

test("trimHistory cuts only at a user round boundary, never mid tool-call", () => {
  // Build > 60 messages: alternating rounds of [user, assistant, user(tool_result)].
  const h: ChatMessage[] = [];
  for (let i = 0; i < 40; i++) {
    h.push({ role: "user", content: `ask ${i}` });
    h.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "x", input: {} }] });
    h.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `t${i}`, content: [{ type: "text", text: "ok" }] }],
    });
  }
  const trimmed = trimHistory(h);
  assert.ok(trimmed.length <= 60);
  // Must start on a plain user turn (a round boundary), not a tool_result.
  const first = trimmed[0]!;
  assert.equal(first.role, "user");
  assert.equal(typeof first.content, "string");
});
