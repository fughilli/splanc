/**
 * The OpenRouter provider (free tier, docs/design/ai-tiers.md) against a fake
 * OpenRouter: the request it sends (free-model fallbacks, reasoning off, tool
 * mapping, attribution headers), the SSE stream reassembly (text + tool-call
 * deltas split at awkward boundaries, the streamed set_script summary as the
 * status), in-stream errors, and the HTTP error mapping the app shows to people
 * (daily free limit with its reset time, per-minute limit, busy upstream,
 * revoked key, credit problems, missing model / privacy-blocked model).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_FREE_MODEL,
  FREE_MODELS,
  OpenRouterError,
  consumeOpenAiStream,
  describeReset,
  fetchOpenRouterKeyInfo,
  freeFallbacks,
  isFreeTierLimit,
  listFreeToolModels,
  makeOpenRouterProvider,
  openRouterError,
  openRouterRequestBody,
} from "../src/effects/ai/providers/openrouter";
import type { ChatMessage, ToolDef } from "../src/effects/ai/provider";

const TOOLS: ToolDef[] = [
  {
    name: "set_script",
    description: "Replace the script.",
    input_schema: { type: "object", properties: { summary: { type: "string" }, source: { type: "string" } } },
  },
];
const HISTORY: ChatMessage[] = [{ role: "user", content: "a slow rainbow" }];

/** A ReadableStream that yields `chunks` as separate reads. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(ctl) {
      if (i < chunks.length) ctl.enqueue(enc.encode(chunks[i++]!));
      else ctl.close();
    },
  });
}

/** Re-chunk a full SSE text every `n` chars (mid-line, mid-JSON). */
function rechunk(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;

// A realistic OpenRouter tool-call stream: keep-alive comment, a little text,
// then set_script whose arguments arrive in fragments (summary first).
const TOOL_STREAM =
  ": OPENROUTER PROCESSING\n\n" +
  sse({ choices: [{ delta: { role: "assistant", content: "Here " } }] }) +
  sse({ choices: [{ delta: { content: "goes." } }] }) +
  sse({
    choices: [
      { delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "set_script", arguments: "" } }] } },
    ],
  }) +
  sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"summary":"rainbow ' } }] } }] }) +
  sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'sweep","source":"vec3 shade() ' } }] } }] }) +
  sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{ return vec3(1.0); }\\n"}' } }] } }] }) +
  sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) +
  "data: [DONE]\n\n";

test("stream: text + a fragmented set_script call reassemble into neutral blocks", async () => {
  for (const n of [7, 13, 64, 10_000]) {
    const texts: string[] = [];
    const statuses: string[] = [];
    const r = await consumeOpenAiStream(streamOf(rechunk(TOOL_STREAM, n)), {
      onText: (d) => texts.push(d),
      onStatus: (s) => statuses.push(s),
    });
    assert.equal(r.stop_reason, "tool_use", `chunk ${n}`);
    assert.deepEqual(r.content, [
      { type: "text", text: "Here goes." },
      {
        type: "tool_use",
        id: "call_1",
        name: "set_script",
        input: { summary: "rainbow sweep", source: "vec3 shade() { return vec3(1.0); }\n" },
      },
    ]);
    assert.equal(texts.join(""), "Here goes.");
    assert.equal(statuses[0], "Writing the effect code…");
    assert.equal(statuses.at(-1), "rainbow sweep", `chunk ${n}: ${statuses.join(" | ")}`);
  }
});

test("stream: two parallel tool calls keep their index order; 'stop' with calls is still tool_use", async () => {
  const s =
    sse({ choices: [{ delta: { tool_calls: [{ index: 1, id: "b", function: { name: "capture_preview", arguments: "{}" } }] } }] }) +
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "set_script", arguments: '{"summary":"x","source":"y"}' } }] } }] }) +
    sse({ choices: [{ delta: {}, finish_reason: "stop" }] });
  const r = await consumeOpenAiStream(streamOf([s]));
  assert.equal(r.stop_reason, "tool_use");
  assert.deepEqual(
    r.content.map((b) => (b.type === "tool_use" ? b.id : b.type)),
    ["a", "b"],
  );
});

test("stream: plain answer ends the turn; length cut-off is max_tokens", async () => {
  const done = await consumeOpenAiStream(
    streamOf([sse({ choices: [{ delta: { content: "It uses hue." }, finish_reason: "stop" }] })]),
  );
  assert.deepEqual(done, { content: [{ type: "text", text: "It uses hue." }], stop_reason: "end_turn" });
  const cut = await consumeOpenAiStream(
    streamOf([sse({ choices: [{ delta: { content: "It" }, finish_reason: "length" }] })]),
  );
  assert.equal(cut.stop_reason, "max_tokens");
});

test("stream: reasoning deltas show Thinking… once; malformed tool JSON degrades to {}", async () => {
  const statuses: string[] = [];
  const r = await consumeOpenAiStream(
    streamOf([
      sse({ choices: [{ delta: { reasoning: "hmm" } }] }),
      sse({ choices: [{ delta: { reasoning: "more" } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "set_script", arguments: '{"source": "x' } }] }, finish_reason: "tool_calls" }] }),
    ]),
    { onStatus: (s) => statuses.push(s) },
  );
  assert.deepEqual(statuses.filter((s) => s === "Thinking…").length, 1);
  assert.deepEqual(r.content, [{ type: "tool_use", id: "c", name: "set_script", input: {} }]);
});

test("stream: an in-stream provider error throws a typed OpenRouterError", async () => {
  await assert.rejects(
    consumeOpenAiStream(
      streamOf([
        sse({ choices: [{ delta: { content: "par" } }] }),
        sse({ error: { code: 502, message: "Provider disconnected" }, choices: [{ delta: {}, finish_reason: "error" }] }),
      ]),
    ),
    (e: unknown) => e instanceof OpenRouterError && e.kind === "unavailable",
  );
});

test("request body: free model → :free fallbacks only, reasoning off, OpenAI tools", () => {
  const body = openRouterRequestBody({ key: "k", model: DEFAULT_FREE_MODEL }, HISTORY, {
    system: "SYS",
    tools: TOOLS,
    maxTokens: undefined,
  });
  assert.equal(body.model, DEFAULT_FREE_MODEL);
  assert.equal(body.stream, true);
  assert.deepEqual(body.reasoning, { enabled: false });
  const models = body.models as string[];
  assert.equal(models[0], DEFAULT_FREE_MODEL);
  assert.ok(models.length >= 2 && models.length <= 3);
  assert.ok(models.every((m) => m.endsWith(":free")));
  assert.deepEqual((body.messages as { role: string }[]).map((m) => m.role), ["system", "user"]);
  assert.deepEqual(body.tools, [
    { type: "function", function: { name: "set_script", description: "Replace the script.", parameters: TOOLS[0]!.input_schema } },
  ]);
  assert.equal(body.tool_choice, "auto");
});

test("request body: a paid OpenRouter model gets no fallbacks and keeps its reasoning default", () => {
  const body = openRouterRequestBody({ key: "k", model: "anthropic/claude-sonnet-5.5" }, HISTORY, {
    system: "",
    tools: [],
  });
  assert.equal(body.models, undefined);
  assert.equal(body.reasoning, undefined);
  assert.equal(body.tools, undefined);
  // and fallbacks can be turned off for free models too
  const solo = openRouterRequestBody({ key: "k", model: DEFAULT_FREE_MODEL, fallbacks: false }, HISTORY, {
    system: "",
    tools: [],
  });
  assert.equal(solo.models, undefined);
});

test("freeFallbacks never includes a paid id and starts with the chosen model", () => {
  assert.deepEqual(freeFallbacks("x/custom:free"), ["x/custom:free", FREE_MODELS[0]!.id, FREE_MODELS[1]!.id]);
  assert.deepEqual(freeFallbacks(FREE_MODELS[1]!.id)[0], FREE_MODELS[1]!.id);
});

test("a private free model enforces data_collection=deny and only falls back to private models", () => {
  const priv = FREE_MODELS.find((m) => m.private)!;
  const body = openRouterRequestBody({ key: "k", model: priv.id }, HISTORY, { system: "", tools: [] });
  assert.deepEqual(body.provider, { data_collection: "deny" });
  const chain = (body.models as string[] | undefined) ?? [priv.id];
  assert.ok(chain.every((id) => FREE_MODELS.find((m) => m.id === id)?.private), chain.join());
  // the default (non-private) model sends no provider restriction
  assert.equal(openRouterRequestBody({ key: "k", model: DEFAULT_FREE_MODEL }, HISTORY, { system: "", tools: [] }).provider, undefined);
});

test("provider: sends to /chat/completions with the user's key + attribution, returns blocks", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fake: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return new Response(streamOf([TOOL_STREAM]), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const p = makeOpenRouterProvider({ key: " sk-or-user ", model: DEFAULT_FREE_MODEL, fetchImpl: fake });
  assert.deepEqual(p.capabilities, { tools: true, vision: false });
  const r = await p.send(HISTORY, { system: "SYS", tools: TOOLS });
  assert.equal(r.stop_reason, "tool_use");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://openrouter.ai/api/v1/chat/completions");
  const h = calls[0]!.init.headers as Record<string, string>;
  assert.equal(h["authorization"], "Bearer sk-or-user");
  assert.equal(h["X-Title"], "Splanc");
  assert.equal(JSON.parse(String(calls[0]!.init.body)).model, DEFAULT_FREE_MODEL);
});

test("provider: no key → a 'connect OpenRouter' error, no request", async () => {
  let n = 0;
  const p = makeOpenRouterProvider({ key: "", model: DEFAULT_FREE_MODEL, fetchImpl: async () => (n++, new Response("")) });
  await assert.rejects(p.send(HISTORY, { system: "", tools: [] }), /isn't connected/);
  assert.equal(n, 0);
});

/** The provider against a fake that answers with an error status + body. */
async function sendError(status: number, body: unknown): Promise<OpenRouterError> {
  const p = makeOpenRouterProvider({
    key: "k",
    model: DEFAULT_FREE_MODEL,
    fetchImpl: async () => new Response(JSON.stringify(body), { status }),
  });
  try {
    await p.send(HISTORY, { system: "", tools: [] });
  } catch (e) {
    assert.ok(e instanceof OpenRouterError, String(e));
    return e;
  }
  throw new Error("expected a rejection");
}

test("429 daily free allowance → daily_limit with the reset time and the other-tier hint", async () => {
  const reset = Date.now() + 5 * 3600 * 1000;
  const e = await sendError(429, {
    error: {
      code: 429,
      message: "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day",
      metadata: { headers: { "X-RateLimit-Limit": "50", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(reset) } },
    },
  });
  assert.equal(e.kind, "daily_limit");
  assert.equal(e.resetAt, reset);
  assert.match(e.message, /today's free OpenRouter requests \(50 per day\)/);
  assert.match(e.message, /It resets at \d\d:\d\d/);
  assert.match(e.message, /another tier/);
  assert.ok(isFreeTierLimit(e));
});

test("429 per-minute → rate_limited; 429 from the upstream provider → upstream_busy", async () => {
  const rpm = await sendError(429, {
    error: {
      code: 429,
      message: "Rate limit exceeded: free-models-per-min.",
      metadata: { headers: { "X-RateLimit-Limit": "20", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(Date.now() + 30_000) } },
    },
  });
  assert.equal(rpm.kind, "rate_limited");
  assert.match(rpm.message, /20 a minute.*Try again in \d+ s/);
  assert.ok(isFreeTierLimit(rpm));

  const up = await sendError(429, {
    error: { code: 429, message: "Provider returned error", metadata: { provider_name: "Google AI Studio", raw: "quota" } },
  });
  assert.equal(up.kind, "upstream_busy");
  assert.match(up.message, /Google AI Studio/);
  assert.ok(!isFreeTierLimit(up));
});

test("401 / 402 / 404 / 503 map to auth / payment / model_unavailable / unavailable", async () => {
  assert.equal((await sendError(401, { error: { code: 401, message: "User not found." } })).kind, "auth");
  const pay = await sendError(402, { error: { code: 402, message: "x", metadata: { limit_source: "openrouter_key_limit" } } });
  assert.equal(pay.kind, "payment");
  assert.match(pay.message, /credit limit/);
  const gone = await sendError(404, { error: { code: 404, message: "No endpoints found for x/y:free." } });
  assert.equal(gone.kind, "model_unavailable");
  const privacy = await sendError(404, {
    error: { code: 404, message: "No endpoints found matching your data policy (Free model training)." },
  });
  assert.equal(privacy.kind, "model_unavailable");
  assert.match(privacy.message, /Free model training/);
  assert.equal((await sendError(503, { error: { code: 503, message: "down" } })).kind, "unavailable");
});

test("network failure → unavailable (but a user abort is passed through)", async () => {
  const p = makeOpenRouterProvider({
    key: "k",
    model: DEFAULT_FREE_MODEL,
    fetchImpl: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  await assert.rejects(p.send(HISTORY, { system: "", tools: [] }), (e: unknown) => e instanceof OpenRouterError && e.kind === "unavailable");
  const ac = new AbortController();
  ac.abort();
  const aborting = makeOpenRouterProvider({
    key: "k",
    model: DEFAULT_FREE_MODEL,
    fetchImpl: async () => {
      throw new DOMException("aborted", "AbortError");
    },
  });
  await assert.rejects(aborting.send(HISTORY, { system: "", tools: [], signal: ac.signal }), /aborted/);
});

test("openRouterError parses seconds deltas, epoch seconds and epoch ms resets", () => {
  const now = 1_800_000_000_000;
  const at = (v: string): number | undefined =>
    openRouterError(429, { error: { message: "x", metadata: { headers: { "X-RateLimit-Reset": v } } } }, now).resetAt;
  assert.equal(at("30"), now + 30_000);
  assert.equal(at("1800000060"), 1_800_000_060_000);
  assert.equal(at("1800000090000"), 1_800_000_090_000);
  assert.equal(describeReset(now + 30_000, now), " Try again in 30 s.");
  assert.equal(describeReset(now + 20 * 60_000, now), " Try again in 20 min.");
});

test("GET /key → today's free-model allowance", async () => {
  let auth = "";
  const info = await fetchOpenRouterKeyInfo("sk-or-x", async (_u, init) => {
    auth = (init!.headers as Record<string, string>)["authorization"]!;
    return new Response(
      JSON.stringify({ data: { label: "Splanc", is_free_tier: true, free_model_daily_requests: { used: 12, limit: 50, remaining: 38 } } }),
    );
  });
  assert.equal(auth, "Bearer sk-or-x");
  assert.deepEqual(info, { freeDaily: { used: 12, limit: 50, remaining: 38 }, isFreeTier: true, label: "Splanc" });
  await assert.rejects(
    fetchOpenRouterKeyInfo("bad", async () => new Response(JSON.stringify({ error: { message: "nope" } }), { status: 401 })),
    (e: unknown) => e instanceof OpenRouterError && e.kind === "auth",
  );
});

test("listFreeToolModels keeps only :free models that advertise tools", async () => {
  const list = await listFreeToolModels(async () =>
    new Response(
      JSON.stringify({
        data: [
          { id: "a/b:free", name: "A", supported_parameters: ["tools"], architecture: { input_modalities: ["text", "image"] } },
          { id: "c/d:free", name: "C", supported_parameters: ["temperature"] },
          { id: "e/f", name: "Paid", supported_parameters: ["tools"] },
        ],
      }),
    ),
  );
  assert.deepEqual(list, [{ id: "a/b:free", name: "A", vision: true }]);
});
