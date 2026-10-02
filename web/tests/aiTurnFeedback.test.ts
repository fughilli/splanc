/**
 * Progress + completion feedback of an AI chat turn (src/effects/ai/generate.ts
 * `chatTurn`, FUG-87). The effect editor's chat narrates a turn entirely through
 * the hooks pinned here: `onThinking(round)` per model round (the spinner +
 * "step N"), `onStatus` labels as the response streams ("Thinking…", a fixed
 * tool verb, the model's own set_script summary), the collapsible live transcript
 * (`onTrace`: prompt in, tokens out, each tool call + result, per round), the
 * resolved final reply (completion), and a clear error when a reply is cut off —
 * after which the chat must still work. The slow on-device CPU path adds a
 * prefill → generation heartbeat so a multi-minute turn never looks frozen.
 *
 * Everything runs the real loop + providers: the network is a fake `fetch`
 * (Anthropic SSE / an OpenAI-compatible JSON server) and the CPU engine a fake
 * `@wllama/wllama` module (see moduleStubs.ts); timers are mocked.
 */

import { stubModule } from "./moduleStubs";

import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";

import { installFakeDom } from "./fakeDom";

installFakeDom(); // `window` (the CPU provider's heartbeat timer) + storage

import { chatTurn, type ChatHooks, type ChatTraceEvent } from "../src/effects/ai/generate";
import { getAiConfig, updateAiConfig, type ChatMessage } from "../src/effects/ai/provider";
import { unloadWllamaModel } from "../src/effects/ai/providers/wllama";

// -- fake network ---------------------------------------------------------------

type SseBlock =
  | { type: "thinking"; text: string }
  | { type: "text"; parts: string[] }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

/** One Anthropic streaming response (SSE) carrying `blocks`, ending with `stop`. */
function anthropicSse(blocks: SseBlock[], stop: string): string {
  const ev: object[] = [];
  blocks.forEach((b, index) => {
    if (b.type === "thinking") {
      ev.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
      ev.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: b.text } });
      ev.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig" } });
    } else if (b.type === "text") {
      ev.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const p of b.parts) ev.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: p } });
    } else {
      ev.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      const json = JSON.stringify(b.input);
      const cut = Math.floor(json.length / 2);
      for (const part of [json.slice(0, cut), json.slice(cut)]) {
        ev.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: part } });
      }
    }
    ev.push({ type: "content_block_stop", index });
  });
  ev.push({ type: "message_delta", delta: { stop_reason: stop }, usage: {} });
  ev.push({ type: "message_stop" });
  return ev.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

/** A byte stream of `text` cut into awkward `chunk`-byte reads. */
function chunked(text: string, chunk = 17): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i >= bytes.length) return c.close();
      c.enqueue(bytes.slice(i, i + chunk));
      i += chunk;
    },
  });
}

const realFetch = globalThis.fetch;
let replies: (() => Response)[] = [];
let sent: { url: string; body: { messages?: unknown[] } }[] = [];

/** Queue the server's responses, one per request, in order. */
function serve(...r: (() => Response)[]): void {
  replies = r;
}
const sse = (body: string) => () => new Response(chunked(body), { status: 200, headers: { "content-type": "text/event-stream" } });
const json = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => {
  sent = [];
  replies = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as { messages?: unknown[] } });
    const next = replies.shift();
    if (!next) throw new Error(`unexpected request to ${String(input)}`);
    return next();
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  mock.timers.reset();
});

function useAnthropic(): void {
  const c = getAiConfig();
  updateAiConfig({
    kind: "cloud",
    cloud: { vendor: "anthropic", vendors: { ...c.cloud.vendors, anthropic: { key: "sk-ant-test", model: "claude-test", baseUrl: "" } } },
  });
}

/** Editor-side tool fulfillment the turn calls back into. */
function editorHooks(extra: Partial<ChatHooks> = {}): ChatHooks {
  return {
    onSetScript: async () => "Compile result: ok",
    onCapturePreview: async () => "data:image/png;base64,AAAA",
    ...extra,
  };
}

const SOURCE = `uniform float speed = 1.0; // ${"x".repeat(200)}\nvoid update() {}\nvec3 shade(Led l) { return vec3(0.0, 0.0, 1.0); }`;

// -- tests ------------------------------------------------------------------------

test("an AI turn reports each round and its live status, then resolves with the final reply [rr:PR-6]", async () => {
  useAnthropic();
  serve(
    sse(
      anthropicSse(
        [
          { type: "thinking", text: "Plan the change." },
          { type: "text", parts: ["I'll make ", "it blue."] },
          { type: "tool_use", id: "tu1", name: "set_script", input: { summary: "making it blue", source: SOURCE } },
        ],
        "tool_use",
      ),
    ),
    sse(anthropicSse([{ type: "text", parts: ["Done — ", "it's blue now."] }], "end_turn")),
  );

  const rounds: number[] = [];
  const status: string[] = [];
  const tools: string[] = [];
  const applied: { source: string; summary: string | undefined }[] = [];
  const history: ChatMessage[] = [{ role: "user", content: "make it blue" }];
  const final = await chatTurn(
    history,
    editorHooks({
      onThinking: (r) => rounds.push(r),
      onStatus: (s) => status.push(s),
      onToolUse: (n) => tools.push(n),
      onSetScript: async (source, summary) => {
        applied.push({ source, summary });
        return "Compile result: ok";
      },
    }),
  );

  // Completion: the turn resolves with the model's closing reply.
  assert.equal(final, "Done — it's blue now.");
  // Progress: one "step" per model round, numbered.
  assert.deepEqual(rounds, [1, 2]);
  // Live status, in order: reasoning, the tool's fixed verb, then the model's
  // own (streamed-first) summary of what it is doing.
  assert.deepEqual(status, ["Thinking…", "Writing the effect code…", "making it blue"]);
  assert.deepEqual(tools, ["set_script"]);
  assert.deepEqual(applied, [{ source: SOURCE, summary: "making it blue" }]);
  assert.equal(sent.length, 2, "one request per round");
});

test("the live model transcript traces every round: prompt in, tokens out, tool calls and results [rr:PR-6]", async () => {
  useAnthropic();
  serve(
    sse(
      anthropicSse(
        [
          { type: "text", parts: ["Checking ", "the cost."] },
          { type: "tool_use", id: "tu1", name: "set_script", input: { summary: "tuning", source: SOURCE } },
          { type: "tool_use", id: "tu2", name: "estimate_performance", input: {} },
        ],
        "tool_use",
      ),
    ),
    sse(anthropicSse([{ type: "text", parts: ["It fits ", "the budget."] }], "end_turn")),
  );

  const trace: ChatTraceEvent[] = [];
  const final = await chatTurn(
    [{ role: "user", content: "make it faster" }],
    editorHooks({
      onEstimatePerformance: async () => {
        throw new Error("no device fleet configured");
      },
      onTrace: (ev) => trace.push(ev),
    }),
  );

  assert.equal(final, "It fits the budget.");
  assert.deepEqual(trace, [
    { kind: "round", round: 1 },
    { kind: "in", text: "make it faster" },
    { kind: "delta", text: "Checking " },
    { kind: "delta", text: "the cost." },
    { kind: "out", text: "Checking the cost." },
    { kind: "tool_call", name: "set_script", input: { summary: "tuning", source: SOURCE } },
    { kind: "tool_result", name: "set_script", text: "Compile result: ok", isError: false },
    { kind: "tool_call", name: "estimate_performance", input: {} },
    { kind: "tool_result", name: "estimate_performance", text: "tool error: no device fleet configured", isError: true },
    { kind: "round", round: 2 },
    { kind: "in", text: "[tool_result Compile result: ok]\n[tool_result (error) tool error: no device fleet configured]" },
    { kind: "delta", text: "It fits " },
    { kind: "delta", text: "the budget." },
    { kind: "out", text: "It fits the budget." },
  ]);
});

test("a provider that can't stream still shows its reply in the transcript and completes [rr:PR-6]", async () => {
  const c = getAiConfig();
  updateAiConfig({ kind: "local", local: { ...c.local, baseUrl: "http://localhost:11434/v1", model: "llama3.1:8b" } });
  serve(json({ choices: [{ message: { role: "assistant", content: "Here is the plan." }, finish_reason: "stop" }] }));

  const trace: ChatTraceEvent[] = [];
  const rounds: number[] = [];
  const final = await chatTurn(
    [{ role: "user", content: "what does this effect do?" }],
    editorHooks({ onTrace: (ev) => trace.push(ev), onThinking: (r) => rounds.push(r) }),
  );

  assert.equal(final, "Here is the plan.");
  assert.deepEqual(rounds, [1]);
  // No token stream, but the authoritative round output still lands in the log.
  assert.deepEqual(trace, [
    { kind: "round", round: 1 },
    { kind: "in", text: "what does this effect do?" },
    { kind: "out", text: "Here is the plan." },
  ]);
});

test("a reply cut off mid tool-call fails the turn with an actionable message and the chat stays usable [rr:PR-6]", async () => {
  useAnthropic();
  serve(
    sse(
      anthropicSse(
        [
          { type: "text", parts: ["Rewriting it."] },
          { type: "tool_use", id: "tu1", name: "set_script", input: { summary: "rewriting" } },
        ],
        "max_tokens",
      ),
    ),
    sse(anthropicSse([{ type: "text", parts: ["Sure — a smaller change."] }], "end_turn")),
  );

  let applied = 0;
  const history: ChatMessage[] = [{ role: "user", content: "rewrite everything" }];
  const hooks = editorHooks({
    onSetScript: async () => {
      applied++;
      return "Compile result: ok";
    },
  });
  await assert.rejects(chatTurn(history, hooks), (e: Error) => {
    assert.match(e.message, /cut off \(stop_reason: max_tokens\)/);
    assert.match(e.message, /try a smaller change, or ask again/);
    return true;
  });
  assert.equal(applied, 0, "the truncated tool call was not executed");
  // The partial assistant turn was rolled back: nothing dangling in history.
  assert.deepEqual(history, [{ role: "user", content: "rewrite everything" }]);

  // The next ask works and never re-sends the unanswered tool_use.
  history.push({ role: "user", content: "just change the colour" });
  assert.equal(await chatTurn(history, hooks), "Sure — a smaller change.");
  assert.doesNotMatch(JSON.stringify(sent[1]!.body.messages), /tool_use/);
});

// -- on-device CPU (wllama) heartbeat -----------------------------------------------

interface PendingCompletion {
  opts: { onData?: (chunk: unknown) => void };
  resolve: () => void;
}
let pendingCompletion: PendingCompletion | null = null;

/** The minimal @wllama/wllama surface the CPU provider drives. */
class FakeWllama {
  private loaded = false;
  async loadModelFromUrl(): Promise<void> {
    this.loaded = true;
  }
  async loadModel(): Promise<void> {
    this.loaded = true;
  }
  isModelLoaded(): boolean {
    return this.loaded;
  }
  async exit(): Promise<void> {
    this.loaded = false;
  }
  createChatCompletion(opts: PendingCompletion["opts"]): Promise<void> {
    return new Promise<void>((resolve) => (pendingCompletion = { opts, resolve }));
  }
}
stubModule("@wllama/wllama/esm/index.js", { Wllama: FakeWllama, ModelManager: class {} });

/** Flush promise continuations (and the provider's async model load). */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
}

test("a slow on-device CPU turn narrates prefill then generation progress until it completes [rr:PR-6]", async () => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  await unloadWllamaModel();
  const c = getAiConfig();
  updateAiConfig({
    kind: "wllama",
    wllama: {
      ...c.wllama,
      model: "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf",
      contextWindowSize: 4096,
    },
  });

  const status: string[] = [];
  const deltas: string[] = [];
  const turn = chatTurn(
    [{ role: "user", content: "make it red" }],
    editorHooks({
      onStatus: (s) => status.push(s),
      onTrace: (ev) => {
        if (ev.kind === "delta") deltas.push(ev.text);
      },
    }),
  );
  await flushAsync();
  assert.ok(pendingCompletion, "the model is running");

  // Up front: how much prompt the CPU must prefill, against the context.
  assert.equal(status.length, 1);
  assert.match(status[0]!, /^prefilling ~\d+ tok \(ctx 4096\)…$/);
  const tok = /~(\d+) tok/.exec(status[0]!)![1];
  // No token yet: the heartbeat keeps ticking the prefill clock.
  mock.timers.tick(2000);
  assert.equal(status.at(-1), `prefilling… (2s, ~${tok}/4096 ctx)`);
  mock.timers.tick(2000);
  assert.equal(status.at(-1), `prefilling… (4s, ~${tok}/4096 ctx)`);

  // First tokens flip it to generation, with a running token count.
  pendingCompletion!.opts.onData?.({ choices: [{ delta: { content: "Making " } }] });
  mock.timers.tick(2000);
  assert.equal(status.at(-1), "generating (1 tok, 6s)");
  pendingCompletion!.opts.onData?.({ choices: [{ delta: { content: "it " } }] });
  pendingCompletion!.opts.onData?.({ choices: [{ delta: { content: "red." } }] });
  mock.timers.tick(2000);
  assert.equal(status.at(-1), "generating (3 tok, 8s)");
  // The tokens stream into the live transcript as they arrive.
  assert.deepEqual(deltas, ["Making ", "it ", "red."]);

  // Completion: the turn resolves with the reply and the heartbeat stops.
  pendingCompletion!.resolve();
  assert.equal(await turn, "Making it red.");
  const seen = status.length;
  mock.timers.tick(20_000);
  assert.equal(status.length, seen, "no progress ticks after the turn ended");
});
