/**
 * "Splanc AI credits" on the client (providers/credits.ts,
 * docs/design/ai-billing.md):
 *
 * - OFF by default: without the flag the kind normalises back to Cloud and is
 *   never "configured";
 * - with the flag + a session it calls OUR proxy with the session token only
 *   (no Anthropic key, no direct-browser header), with the very same body the
 *   BYO-key provider sends, and reads the live balance from `splanc_billing`;
 * - the BYO-key request is unchanged (same headers, same body);
 * - iOS buys through Apple and never shows the web checkout.
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { defaultConfig, isAiConfigured, kindLabel, normalizeConfig, type SendOptions } from "../src/effects/ai/provider";
import { makeAnthropicProvider, messagesRequestBody } from "../src/effects/ai/providers/anthropic";
import {
  aiCreditsEnabled,
  creditsErrorMessage,
  fetchCreditsBalance,
  formatCredits,
  makeCreditsProvider,
  mayShowWebCheckout,
  purchaseChannel,
  setCreditsSession,
} from "../src/effects/ai/providers/credits";

class MemStore {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}
const g = globalThis as unknown as { localStorage: MemStore; Capacitor?: unknown };

beforeEach(() => {
  g.localStorage = new MemStore();
  delete g.Capacitor;
});

const SSE =
  'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n\n' +
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Blue it is."}}\n\n' +
  'data: {"type":"content_block_stop","index":0}\n\n' +
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n' +
  'event: splanc_billing\ndata: {"type":"splanc_billing","request_id":"r1","charged_credits":0.2,"balance_credits":49.8}\n\n';

const OPTS: SendOptions = { system: "sys", tools: [{ name: "set_script", description: "d", input_schema: { type: "object" } }] };
const MSGS = [{ role: "user" as const, content: "make it blue" }];

function captureFetch(status = 200, body: string = SSE) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status, headers: { "content-type": status === 200 ? "text/event-stream" : "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test("off by default: the credits kind falls back to Cloud and is never ready", () => {
  assert.equal(aiCreditsEnabled(), false);
  assert.equal(normalizeConfig({ kind: "credits" }).kind, "cloud");
  const c = defaultConfig();
  c.kind = "credits";
  setCreditsSession({ account_id: "acct_x", token: "sst1.t" });
  assert.equal(isAiConfigured(c), false);
});

test("flag on: ready only with a session", () => {
  g.localStorage.setItem("splanc.flags.aiCredits", "1");
  assert.equal(normalizeConfig({ kind: "credits" }).kind, "credits");
  assert.equal(normalizeConfig({ kind: "credits" }).credits.model, "claude-sonnet-5-5");
  const c = defaultConfig();
  c.kind = "credits";
  assert.equal(isAiConfigured(c), false);
  setCreditsSession({ account_id: "acct_x", token: "sst1.t" });
  assert.equal(isAiConfigured(c), true);
  assert.equal(kindLabel("credits"), "Splanc AI credits");
});

test("the credits provider calls our proxy with the session token only", async () => {
  g.localStorage.setItem("splanc.flags.aiCredits", "1");
  g.localStorage.setItem("splanc.aiCredits.relay", "https://relay.example/");
  setCreditsSession({ account_id: "acct_x", token: "sst1.session" });
  const f = captureFetch();
  const billed: number[] = [];
  const p = makeCreditsProvider({ model: "claude-opus-5-5", fetchImpl: f.fn, onBilling: (e) => billed.push(e.balance_credits) });
  const r = await p.send(MSGS, OPTS);
  assert.equal(f.calls[0]!.url, "https://relay.example/ai/v1/messages");
  const h = f.calls[0]!.init.headers as Record<string, string>;
  assert.deepEqual(Object.keys(h).sort(), ["authorization", "content-type"]);
  assert.equal(h["authorization"], "Bearer sst1.session");
  assert.equal(f.calls[0]!.init.body, JSON.stringify(messagesRequestBody("claude-opus-5-5", MSGS, OPTS)));
  assert.deepEqual(r.content, [{ type: "text", text: "Blue it is." }]);
  assert.equal(r.stop_reason, "end_turn");
  assert.deepEqual(billed, [49.8]);
});

test("proxy refusals become friendly errors; no session = sign in", async () => {
  g.localStorage.setItem("splanc.flags.aiCredits", "1");
  await assert.rejects(makeCreditsProvider({ model: "" }).send(MSGS, OPTS), /Sign in/);
  setCreditsSession({ account_id: "acct_x", token: "sst1.session" });
  const f = captureFetch(402, JSON.stringify({ error: "insufficient_balance", message: "Not enough Splanc AI credit for this request." }));
  await assert.rejects(makeCreditsProvider({ model: "", fetchImpl: f.fn }).send(MSGS, OPTS), /Not enough Splanc AI credit/);
  assert.match(creditsErrorMessage(503, null), /unavailable/);
  assert.equal(formatCredits(1234.56), "1,234.5 credits");
});

test("balance is a stub that answers null when off or signed out", async () => {
  const f = captureFetch(200, JSON.stringify({ balance_credits: 5, available_credits: 5, held_credits: 0, low: true, status: "active" }));
  assert.equal(await fetchCreditsBalance(f.fn), null);
  g.localStorage.setItem("splanc.flags.aiCredits", "1");
  assert.equal(await fetchCreditsBalance(f.fn), null);
  setCreditsSession({ account_id: "acct_x", token: "sst1.session" });
  assert.equal((await fetchCreditsBalance(f.fn))?.low, true);
});

test("the BYO-key request is unchanged", async () => {
  const realFetch = globalThis.fetch;
  const f = captureFetch();
  globalThis.fetch = f.fn;
  try {
    await makeAnthropicProvider({ key: "sk-ant-user-own", model: "claude-opus-4-8" }).send(MSGS, OPTS);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(f.calls[0]!.url, "https://api.anthropic.com/v1/messages");
  assert.deepEqual(f.calls[0]!.init.headers, {
    "content-type": "application/json",
    "x-api-key": "sk-ant-user-own",
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  });
  // Byte-for-byte the body the provider sent before the refactor.
  assert.equal(
    f.calls[0]!.init.body,
    JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      stream: true,
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
      tools: OPTS.tools,
      messages: [{ role: "user", content: [{ type: "text", text: "make it blue", cache_control: { type: "ephemeral" } }] }],
    }),
  );
});

test("iOS buys through Apple and never shows the web checkout", () => {
  assert.equal(purchaseChannel(), "web");
  assert.equal(mayShowWebCheckout(), true);
  g.Capacitor = { isNativePlatform: () => true, getPlatform: () => "ios" };
  assert.equal(purchaseChannel(), "apple");
  assert.equal(mayShowWebCheckout(), false);
  g.Capacitor = { isNativePlatform: () => true, getPlatform: () => "android" };
  assert.equal(purchaseChannel(), "web");
});
