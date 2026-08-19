/**
 * The chat-path SSE stream reader (consumeChatStream in effects/ai/generate.ts):
 * it reconstructs the assistant `content` blocks (thinking+signature, text,
 * tool_use with parsed input) exactly as the non-streaming response would, and
 * fires live status while the response streams — including the set_script
 * `summary` field, which is emitted first so the UI can show it before the (big)
 * source finishes. The fixture is chunked at awkward boundaries (mid-frame,
 * mid-JSON) to exercise the buffering + partial-field extraction.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { consumeChatStream, withCacheControl } from "../src/effects/ai/generate";

// A realistic Anthropic streaming sequence: thinking → text → set_script tool_use
// (summary before source) → stop_reason tool_use. `event:` lines are ignored by
// the reader (it keys off `data:`), matching the real wire format.
const SSE = [
  'event: content_block_start\n',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Plan the sparks."}}\n\n',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"SIGabc"}}\n\n',
  'data: {"type":"content_block_stop","index":0}\n\n',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"I\'ll add "}}\n\n',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"sparks."}}\n\n',
  'data: {"type":"content_block_stop","index":1}\n\n',
  'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"set_script","input":{}}}\n\n',
  'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"summary\\":\\"adding "}}\n\n',
  'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"sparks\\",\\"source\\":\\"void main(){}\\"}"}}\n\n',
  'data: {"type":"content_block_stop","index":2}\n\n',
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{}}\n\n',
  'data: {"type":"message_stop"}\n\n',
].join("");

function streamOf(text: string, chunk: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(i, i + chunk));
      i += chunk;
    },
  });
}

test("reconstructs content blocks + stop_reason across chunk boundaries", async () => {
  // 7 bytes/chunk splits frames and the tool-input JSON mid-token.
  const { content, stop_reason } = await consumeChatStream(streamOf(SSE, 7));
  assert.equal(stop_reason, "tool_use");
  assert.equal(content.length, 3);

  const [think, text, tool] = content as unknown as [
    { type: string; thinking: string; signature: string },
    { type: string; text: string },
    { type: string; id: string; name: string; input: { summary: string; source: string } },
  ];
  assert.equal(think.type, "thinking");
  assert.equal(think.thinking, "Plan the sparks.");
  assert.equal(think.signature, "SIGabc"); // preserved so history re-sends validly

  assert.equal(text.type, "text");
  assert.equal(text.text, "I'll add sparks.");

  assert.equal(tool.type, "tool_use");
  assert.equal(tool.name, "set_script");
  assert.deepEqual(tool.input, { summary: "adding sparks", source: "void main(){}" });
});

test("fires live status: Thinking → tool verb → model summary; streams text", async () => {
  const status: string[] = [];
  const textParts: string[] = [];
  await consumeChatStream(streamOf(SSE, 5), {
    onStatus: (s) => status.push(s),
    onText: (t) => textParts.push(t),
  });

  // Thinking first, then the fixed set_script verb the moment the tool starts,
  // then the model's own summary once the `summary` field has streamed in.
  assert.ok(status.includes("Thinking…"), `got ${JSON.stringify(status)}`);
  assert.ok(status.includes("Writing the effect code…"), `got ${JSON.stringify(status)}`);
  assert.ok(status.includes("adding sparks"), `got ${JSON.stringify(status)}`);
  // the summary label appears AFTER the fixed verb (verb on tool start, summary as it streams)
  assert.ok(
    status.lastIndexOf("Writing the effect code…") < status.indexOf("adding sparks"),
    `order wrong: ${JSON.stringify(status)}`,
  );
  // text streamed in order
  assert.equal(textParts.join(""), "I'll add sparks.");
});

test("chunk size is irrelevant (whole-stream in one read)", async () => {
  const { content, stop_reason } = await consumeChatStream(streamOf(SSE, SSE.length));
  assert.equal(stop_reason, "tool_use");
  assert.equal(content.length, 3);
});

// ---------------------------------------------------------------------------
// withCacheControl: adds a prompt-cache breakpoint on the LAST content block
// without mutating the stored history (which is re-sent every tool-loop round).
// ---------------------------------------------------------------------------

test("withCacheControl: bare string becomes one cached text block", () => {
  const out = withCacheControl("hello ctx") as Array<Record<string, unknown>>;
  assert.deepEqual(out, [
    { type: "text", text: "hello ctx", cache_control: { type: "ephemeral" } },
  ]);
});

test("withCacheControl: marks only the last block, does not mutate input", () => {
  const original = [
    { type: "text", text: "first" },
    { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "r" }] },
  ] as never;
  const out = withCacheControl(original) as Array<Record<string, unknown>>;

  // last block gets the breakpoint; earlier blocks are untouched
  assert.equal(out[0]!.cache_control, undefined);
  assert.deepEqual(out[1]!.cache_control, { type: "ephemeral" });
  assert.equal(out[1]!.tool_use_id, "t1");

  // the ORIGINAL array/blocks are unchanged (no breakpoint leaked into history)
  assert.equal((original as Array<Record<string, unknown>>)[1]!.cache_control, undefined);
});

test("withCacheControl: empty array is returned unchanged", () => {
  const empty: never[] = [];
  assert.equal(withCacheControl(empty as never), empty);
});
