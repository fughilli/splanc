/**
 * Splanc AI credits (docs/design/ai-billing.md), sandbox scaffold, all offline:
 *
 * - pricing: the default config validates; per-token metering (cache writes by
 *   TTL, cache reads, Haiku's long-context tier, the per-request floor);
 *   per-channel pack credits and the margin guard that refuses a pack that
 *   would lose money after the store's cut;
 * - the ledger: reserve-then-settle under CONCURRENCY (a storage that yields
 *   on every call, so unlocked code would race), idempotent settle / credit /
 *   clawback, overdraft cap + write-off, caps, hold expiry, account closing,
 *   and the cached balance always equal to the sum of the append-only entries;
 * - the proxy against a FAKE upstream (no Anthropic call, no real key):
 *   allowlist, metering from the final usage, shrinking max_tokens to the
 *   balance, upstream errors released uncharged, a client hang-up billed from
 *   an estimate;
 * - THE KEY NEVER REACHES THE CLIENT: a canary key the fake upstream echoes in
 *   error bodies, SSE frames and headers never appears in any response, header
 *   or log line, and the client's own headers are never forwarded;
 * - the relay routes: off (503) unless explicitly configured for the sandbox;
 *   account -> 18+ -> fake purchases -> refund -> proxy -> delete; and the
 *   Anthropic org spend-limit guard (alert, graceful "busy", the 429).
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { BillingAccount, mintSession, verifySession } from "../relay/src/billing/account";
import { billingEndpoint, billingReady, type BillingContext } from "../relay/src/billing/endpoint";
import { HOLD_TTL_MS, Ledger, lotConsumption } from "../relay/src/billing/ledger";
import { BILLING_EVENTS, eventSink, lokiPayload, purchaseMoney, reconcileStore, reconcileUsage } from "../relay/src/billing/metrics";
import { OPS_SCHEMA } from "../relay/src/ops";
import {
  DEFAULT_PRICING,
  MICRO,
  chargeMicro,
  listCostUsd,
  packCredits,
  packMargin,
  publicPricing,
  reserveMicro,
  validatePricing,
  type Caps,
  type PricingConfig,
  type Usage,
} from "../relay/src/billing/pricing";
import { estimatePromptTokens, proxyMessages, redact, sanitizeRequest, type ProxyDeps } from "../relay/src/billing/proxy";
import { FakeConsumptionSender, FakeStoreVerifier, MemoryClaims, accountRefFor, applyPurchase, applyRefund, consumptionRequestFor } from "../relay/src/billing/purchases";
import { Directory } from "../relay/src/directory";
import type { Env } from "../relay/src/platform";
import { MemStorage, namespace } from "./billingFakes";

// -- fakes -----------------------------------------------------------------------------


const CAPS: Caps = { per_request_max_credits: 0, daily_credits: 0, monthly_credits: 0, concurrent_requests: 1000, requests_per_minute: 1000 };
const usage = (p: Partial<Usage>): Usage => ({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...p });
const cfg = (patch: Partial<PricingConfig> = {}): PricingConfig => ({ ...structuredClone(DEFAULT_PRICING), ...patch });

// -- pricing ---------------------------------------------------------------------------

describe("pricing", () => {
  test("the default config validates", () => {
    const v = validatePricing(JSON.stringify(DEFAULT_PRICING));
    assert.equal(v.ok, true, v.ok ? "" : v.errors.join("\n"));
  });

  test("list cost per token class (Opus 5.5: $4 in, $20 out, $5/$8 writes, $0.20 reads)", () => {
    const m = DEFAULT_PRICING.models["claude-opus-5-5"]!;
    const u = usage({
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 2_000_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
    });
    assert.equal(listCostUsd(m, u), 4 + 20 + 5 + 8 + 0.2);
    // Without the TTL split every write is priced as 5-minute.
    assert.equal(listCostUsd(m, usage({ cache_creation_input_tokens: 1_000_000 })), 5);
  });

  test("Haiku 5.5 switches the WHOLE request to long-context rates above 100K prompt tokens", () => {
    const m = DEFAULT_PRICING.models["claude-haiku-5-5"]!;
    const small = usage({ input_tokens: 50_000, cache_read_input_tokens: 50_000, output_tokens: 1000 });
    const big = usage({ input_tokens: 50_000, cache_read_input_tokens: 50_001, output_tokens: 1000 });
    assert.ok(Math.abs(listCostUsd(m, small) - (50_000 * 0.1 + 50_000 * 0.01 + 1000 * 0.5) / 1e6) < 1e-12);
    assert.ok(Math.abs(listCostUsd(m, big) - (50_000 * 0.5 + 50_001 * 0.05 + 1000 * 2.5) / 1e6) < 1e-12);
  });

  test("charge = list x (1 + usage_markup) in µcredits, rounded up, with a floor", () => {
    const c = cfg();
    // 1000 out tokens of Sonnet 5.5 = $0.01 = 1 credit at 100 credits/$.
    assert.equal(chargeMicro(c, "claude-sonnet-5-5", usage({ output_tokens: 1000 })), 1 * MICRO);
    assert.equal(chargeMicro(cfg({ usage_markup: 0.5 }), "claude-sonnet-5-5", usage({ output_tokens: 1000 })), 1.5 * MICRO);
    // The floor: one token costs min_request_credits.
    assert.equal(chargeMicro(c, "claude-haiku-5-5", usage({ input_tokens: 1 })), 0.1 * MICRO);
    assert.throws(() => chargeMicro(c, "claude-unknown", usage({})));
  });

  test("the reservation bounds the charge for any usage within the estimate", () => {
    const c = cfg();
    for (const model of Object.keys(c.models)) {
      const r = reserveMicro(c, model, 20_000, 4000);
      for (const u of [
        usage({ input_tokens: 20_000, output_tokens: 4000 }),
        usage({ cache_creation_input_tokens: 20_000, cache_creation: { ephemeral_1h_input_tokens: 20_000 }, output_tokens: 4000 }),
        usage({ cache_read_input_tokens: 19_000, input_tokens: 1000, output_tokens: 4000 }),
      ]) {
        assert.ok(chargeMicro(c, model, u) <= r, `${model}: ${chargeMicro(c, model, u)} > ${r}`);
      }
    }
  });

  test("packs: credits from the channel markup, margins after the channel fee", () => {
    const c = cfg();
    const apple = c.packs.find((p) => p.channel === "apple" && p.price_usd === 4.99)!;
    const web = c.packs.find((p) => p.channel === "web" && p.price_usd === 10)!;
    assert.equal(packCredits(c, apple), 356); // 4.99 / 1.40 x 100
    assert.equal(packCredits(c, web), 833); // 10 / 1.20 x 100
    const ma = packMargin(c, apple);
    assert.ok(ma.margin > 0.15 && ma.margin < 0.17, String(ma.margin)); // net 4.24, cost 3.56
    const mw = packMargin(c, web);
    assert.ok(mw.margin > 0.105 && mw.margin < 0.115, String(mw.margin)); // net 9.36 (Stripe + Stripe Tax), cost 8.33
    // Credits bought anywhere are the same unit: the overrides win.
    assert.equal(packCredits(c, { ...apple, credits: 300 }), 300);
  });

  test("a markup smaller than the store's cut is refused (it would lose money)", () => {
    const c = cfg();
    c.channels.apple = { fee_percent: 0.3, fee_fixed_usd: 0, markup: 0.25 }; // Apple 30 %, 25 % markup
    const v = validatePricing(c);
    assert.equal(v.ok, false);
    assert.match(v.ok ? "" : v.errors.join("\n"), /apple:dev\.splanc\.app\.credits\.small\): margin -\d/);
    c.channels.apple.markup = 0.5; // 4.99/1.5 = 332 credits: $3.32 cost vs $3.49 net = 4.9 %, under min_margin 5 %
    assert.equal(validatePricing(c).ok, false);
    c.channels.apple.markup = 0.55; // 321 credits: $3.21 cost vs $3.49 net = 8 %
    assert.equal(validatePricing(c).ok, true);
  });

  test("strict: unknown / missing keys, bad models, bad channels are refused whole", () => {
    assert.equal(validatePricing("{").ok, false);
    assert.equal(validatePricing({ ...DEFAULT_PRICING, markup: 0.2 }).ok, false); // a typo'd key
    const { trial_credits: _t, ...missing } = DEFAULT_PRICING;
    void _t;
    assert.equal(validatePricing(missing).ok, false);
    assert.equal(validatePricing({ ...DEFAULT_PRICING, default_model: "claude-nope" }).ok, false);
    assert.equal(validatePricing({ ...DEFAULT_PRICING, models: { "gpt-4o": DEFAULT_PRICING.models["claude-opus-5-5"] } }).ok, false);
    assert.equal(validatePricing({ ...DEFAULT_PRICING, channels: { ...DEFAULT_PRICING.channels, google: { fee_percent: 0.15, fee_fixed_usd: 0, markup: 0.3 } } }).ok, false);
    const dup = cfg();
    dup.packs.push({ ...dup.packs[0]! });
    assert.equal(validatePricing(dup).ok, false);
  });

  test("the public view hides fees, markups and margins and filters packs by channel", () => {
    const pub = publicPricing(cfg(), "apple");
    const text = JSON.stringify(pub);
    assert.ok(pub.packs.every((p) => p.channel === "apple"));
    assert.ok(!/fee|markup|margin|price_usd|web\.credits/.test(text), text);
    assert.equal(pub.models.find((m) => m.id === "claude-sonnet-5-5")?.credits_per_mtok.output, 1000);
  });
});

// -- ledger ----------------------------------------------------------------------------

async function newLedger(trialCredits = 10, clock = { t: Date.UTC(2026, 10, 18, 12) }) {
  const s = new MemStorage();
  const l = new Ledger(s, () => clock.t);
  await l.open("acct_test", trialCredits * MICRO);
  return { l, s, clock };
}

async function consistent(l: Ledger) {
  const a = await l.audit();
  assert.equal(a.cached, a.summed, "cached balance == sum of entries");
  assert.equal(a.held, a.heldSummed, "cached held == sum of holds");
}

describe("ledger", () => {
  test("open is idempotent and grants the trial once", async () => {
    const { l } = await newLedger(10);
    await l.open("acct_test", 10 * MICRO);
    assert.equal((await l.getAccount())!.balance, 10 * MICRO);
    assert.equal((await l.statement()).length, 1);
    await consistent(l);
  });

  test("50 concurrent reserves never over-commit the balance", async () => {
    const { l } = await newLedger(10);
    const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => l.reserve(`req${i}xxxx`, 1.5 * MICRO, "m", CAPS)));
    assert.equal(rs.filter((r) => r.ok).length, 6); // floor(10 / 1.5)
    assert.ok(rs.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "insufficient_balance"));
    const a = (await l.getAccount())!;
    assert.equal(a.held, 9 * MICRO);
    assert.ok(a.balance - a.held >= 0);
    await consistent(l);
  });

  test("concurrent settles + reserves stay consistent; settle is idempotent", async () => {
    const { l } = await newLedger(100);
    const ids = Array.from({ length: 20 }, (_, i) => `req${i}xxxx`);
    await Promise.all(ids.map((id) => l.reserve(id, 4 * MICRO, "m", CAPS)));
    const meta = { model: "m", usage: usage({ output_tokens: 10 }), pricing_version: 1 };
    // Each settled twice, concurrently, while new reserves arrive.
    await Promise.all([
      ...ids.flatMap((id) => [l.settle(id, 3 * MICRO, meta, 0), l.settle(id, 3 * MICRO, meta, 0)]),
      ...Array.from({ length: 10 }, (_, i) => l.reserve(`late${i}xxxx`, 1 * MICRO, "m", CAPS)),
    ]);
    const a = (await l.getAccount())!;
    assert.equal(a.balance, 100 * MICRO - 20 * 3 * MICRO);
    assert.equal(a.held, 10 * MICRO);
    assert.equal((await l.statement(1000)).filter((e) => e.kind === "usage").length, 20);
    await consistent(l);
    // A settled id can't be reserved again.
    const again = await l.reserve(ids[0]!, MICRO, "m", CAPS);
    assert.equal(again.ok ? "" : again.reason, "duplicate");
  });

  test("a retried reserve returns the same hold", async () => {
    const { l } = await newLedger(10);
    const a = await l.reserve("same-id-1", MICRO, "m", CAPS);
    const b = await l.reserve("same-id-1", MICRO, "m", CAPS);
    assert.ok(a.ok && b.ok && b.replay && a.hold.id === b.hold.id);
    assert.equal((await l.getAccount())!.held, MICRO);
  });

  test("a charge above the hold is debited up to the overdraft; the rest is written off", async () => {
    const { l } = await newLedger(1);
    await l.reserve("req-over-1", MICRO, "m", CAPS);
    const { entry } = await l.settle("req-over-1", 5 * MICRO, { model: "m", usage: usage({}), pricing_version: 1 }, 2 * MICRO);
    assert.equal(entry.amount, -3 * MICRO);
    assert.equal(entry.balance, -2 * MICRO);
    assert.equal(entry.written_off, 2 * MICRO);
    const r = await l.reserve("req-over-2", 1, "m", CAPS);
    assert.equal(r.ok ? "" : r.reason, "insufficient_balance");
    await consistent(l);
  });

  test("release and hold expiry return the reservation uncharged", async () => {
    const { l, clock } = await newLedger(10);
    await l.reserve("req-rel-1", 3 * MICRO, "m", CAPS);
    await l.reserve("req-exp-1", 3 * MICRO, "m", CAPS);
    assert.equal(await l.release("req-rel-1"), true);
    assert.equal(await l.release("req-rel-1"), false);
    assert.deepEqual(await l.expireHolds(), []);
    clock.t += HOLD_TTL_MS + 1;
    assert.deepEqual(await l.expireHolds(), ["req-exp-1"]);
    const a = (await l.getAccount())!;
    assert.equal(a.balance, 10 * MICRO);
    assert.equal(a.held, 0);
    await consistent(l);
  });

  test("purchases credit once; a refund claws back once, even below zero", async () => {
    const { l } = await newLedger(0);
    const c1 = await l.credit("purchase", "apple:tx1", 400 * MICRO, { channel: "apple", sku: "s" });
    const c2 = await l.credit("purchase", "apple:tx1", 400 * MICRO, { channel: "apple", sku: "s" });
    assert.equal(c1.replay, false);
    assert.equal(c2.replay, true);
    await l.reserve("spend-1xxx", 300 * MICRO, "m", CAPS);
    await l.settle("spend-1xxx", 300 * MICRO, { model: "m", usage: usage({}), pricing_version: 1 }, 0);
    const r1 = await l.clawback("apple:tx1");
    const r2 = await l.clawback("apple:tx1");
    assert.equal(r1.entry?.amount, -400 * MICRO);
    assert.equal(r2.replay, true);
    assert.equal((await l.getAccount())!.balance, -300 * MICRO);
    assert.equal((await l.clawback("apple:never")).entry, null);
    const r = await l.reserve("spend-2xxx", 1, "m", CAPS);
    assert.equal(r.ok ? "" : r.reason, "insufficient_balance");
    await consistent(l);
  });

  test("caps: per request, concurrency, per minute, daily", async () => {
    const { l } = await newLedger(1000);
    const caps: Caps = { per_request_max_credits: 50, daily_credits: 100, monthly_credits: 0, concurrent_requests: 2, requests_per_minute: 3 };
    const why = async (id: string, credits: number) => {
      const r = await l.reserve(id, credits * MICRO, "m", caps);
      return r.ok ? "ok" : r.reason;
    };
    assert.equal(await why("cap-big-1", 51), "request_cap");
    assert.equal(await why("cap-a-0001", 40), "ok");
    assert.equal(await why("cap-b-0001", 40), "ok");
    assert.equal(await why("cap-c-0001", 1), "too_many_concurrent");
    await l.settle("cap-a-0001", 40 * MICRO, { model: "m", usage: usage({}), pricing_version: 1 }, 0);
    // 40 spent + 40 held + 30 > 100 daily.
    assert.equal(await why("cap-d-0001", 30), "daily_cap");
    assert.equal(await why("cap-e-0001", 10), "ok");
    await l.release("cap-e-0001");
    assert.equal(await why("cap-f-0001", 1), "rate_limited"); // 3 reserves this minute
  });

  test("suspension blocks spending; closing forfeits the balance and drops holds", async () => {
    const { l } = await newLedger(10);
    await l.setStatus("suspended");
    const r = await l.reserve("susp-0001", MICRO, "m", CAPS);
    assert.equal(r.ok ? "" : r.reason, "inactive");
    await l.setStatus("active");
    await l.reserve("open-hold-1", MICRO, "m", CAPS);
    const a = await l.close();
    assert.equal(a.status, "closed");
    assert.equal(a.balance, 0);
    assert.equal(a.held, 0);
    await assert.rejects(l.credit("purchase", "apple:late", MICRO));
    await consistent(l);
  });
});

// -- proxy -----------------------------------------------------------------------------

const CANARY = "sk-ant-api03-CANARYcanaryCANARY0123456789-xyzXYZ";

const sse = (events: Record<string, unknown>[]) => events.map((e) => `event: ${String(e["type"])}\ndata: ${JSON.stringify(e)}\n\n`).join("");

function happyStream(u: Partial<Usage>, text = "Here is your effect."): string {
  return sse([
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], usage: { input_tokens: u.input_tokens ?? 0, cache_read_input_tokens: u.cache_read_input_tokens ?? 0, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: u.output_tokens ?? 0 } },
    { type: "message_stop" },
  ]);
}

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function fakeUpstream(reply: (c: Captured) => Response) {
  const calls: Captured[] = [];
  const fn = async (url: string, init: RequestInit) => {
    const c = { url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) as Record<string, unknown> };
    calls.push(c);
    return reply(c);
  };
  return { fn, calls };
}

/** A stream that delivers `text` in small chunks (frames split across reads). */
function chunked(text: string, size = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= bytes.length) return c.close();
      c.enqueue(bytes.slice(i, i + size));
      i += size;
    },
  });
}

const chatBody = (extra: Record<string, unknown> = {}) => ({
  model: "claude-sonnet-5-5",
  max_tokens: 4000,
  system: [{ type: "text", text: "You write LED effects.", cache_control: { type: "ephemeral" } }],
  thinking: { type: "adaptive" },
  output_config: { effort: "medium" },
  stream: true,
  tools: [{ name: "set_script", description: "set the effect", input_schema: { type: "object" } }],
  messages: [{ role: "user", content: "make it blue" }],
  ...extra,
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://relay/ai/v1/messages", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

async function proxyFixture(trial = 100, reply?: (c: Captured) => Response) {
  const { l } = await newLedger(trial);
  const up = fakeUpstream(reply ?? (() => new Response(chunked(happyStream({ input_tokens: 2000, output_tokens: 500 })), { headers: { "content-type": "text/event-stream" } })));
  const logs: string[] = [];
  let n = 0;
  const deps: ProxyDeps = {
    pricing: cfg(),
    apiKey: CANARY,
    ledger: l,
    upstream: up.fn,
    log: (e) => logs.push(JSON.stringify(e)),
    newId: () => `reqid${String(++n).padStart(6, "0")}`,
  };
  return { l, up, logs, deps };
}

async function readAll(r: Response): Promise<string> {
  return r.text();
}

describe("proxy", () => {
  test("sanitize: allowlist, model, max_tokens clamp, custom tools only", () => {
    const c = cfg();
    const ok = sanitizeRequest(chatBody({ max_tokens: 999_999, metadata: { user_id: "someone@example.com" } }), c);
    assert.ok(!("status" in ok));
    if (!("status" in ok)) {
      assert.equal(ok.maxTokens, c.max_output_tokens);
      assert.equal(ok.body["stream"], true);
      assert.equal(ok.body["metadata"], undefined);
    }
    const bad = (b: Record<string, unknown>) => {
      const r = sanitizeRequest(b, c);
      return "status" in r ? r.status : 200;
    };
    assert.equal(bad(chatBody({ speed: "fast" })), 400);
    assert.equal(bad(chatBody({ inference_geo: "us" })), 400);
    assert.equal(bad(chatBody({ fallbacks: "default" })), 400);
    assert.equal(bad(chatBody({ tools: [{ type: "web_search_20260209", name: "web_search" }] })), 400);
    assert.equal(bad(chatBody({ model: "claude-fable-5-2" })), 400);
    assert.equal(bad(chatBody({ output_config: { effort: "low", task_budget: {} } })), 400);
    assert.equal(bad(chatBody({ messages: [] })), 400);
  });

  test("prompt estimate: text by bytes, images by a fixed bound", () => {
    const img = { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(3_000_000) } };
    const t = estimatePromptTokens({ messages: [{ role: "user", content: [img, { type: "text", text: "hi" }] }] });
    assert.ok(t > 5000 && t < 5100, String(t));
  });

  test("streams the reply through, meters the final usage, settles, appends the billing event", async () => {
    const { l, up, deps } = await proxyFixture();
    const r = await proxyMessages(post(chatBody()), "acct_test", deps);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "text/event-stream");
    const text = await readAll(r);
    assert.ok(text.startsWith(happyStream({ input_tokens: 2000, output_tokens: 500 })), "upstream frames pass unchanged");
    const billing = /event: splanc_billing\ndata: (.*)\n\n$/.exec(text);
    assert.ok(billing, text.slice(-300));
    const want = chargeMicro(cfg(), "claude-sonnet-5-5", usage({ input_tokens: 2000, output_tokens: 500 }));
    assert.equal(JSON.parse(billing![1]!).charged_credits, want / MICRO);
    const a = (await l.getAccount())!;
    assert.equal(a.balance, 100 * MICRO - want);
    assert.equal(a.held, 0);
    // What went upstream: our key, our version, stream on, no client metadata.
    assert.equal(up.calls.length, 1);
    assert.equal(up.calls[0]!.url, "https://api.anthropic.com/v1/messages");
    assert.deepEqual((up.calls[0]!.body["metadata"] as Record<string, unknown>), { user_id: "acct_test" });
    await consistent(l);
  });

  test("a low balance shrinks max_tokens; too low is a 402 with nothing sent", async () => {
    const { up, deps } = await proxyFixture(1); // 1 credit = $0.01 of Sonnet
    const r = await proxyMessages(post(chatBody({ max_tokens: 16000 })), "acct_test", deps);
    assert.equal(r.status, 402);
    assert.equal(up.calls.length, 0);
    const f2 = await proxyFixture(10); // $0.10 affords ~10K Sonnet output tokens
    const r2 = await proxyMessages(post(chatBody({ max_tokens: 16000 })), "acct_test", f2.deps);
    assert.equal(r2.status, 200);
    await r2.text();
    const mt = f2.up.calls[0]!.body["max_tokens"] as number;
    assert.ok(mt >= 1024 && mt < 16000, String(mt));
  });

  test("an upstream rejection is released uncharged and never passed through", async () => {
    for (const [status, ours] of [
      [400, 400],
      [401, 503],
      [403, 503],
      [429, 503],
      [529, 503],
      [500, 503],
    ] as const) {
      const { l, deps, logs } = await proxyFixture(100, () =>
        new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${CANARY}` } }), {
          status,
          headers: { "x-echo": CANARY },
        }),
      );
      const r = await proxyMessages(post(chatBody()), "acct_test", deps);
      assert.equal(r.status, ours, `upstream ${status}`);
      const body = await r.text();
      assert.ok(!body.includes("x-api-key") && !body.includes("CANARY"), body);
      assert.equal(r.headers.get("x-echo"), null);
      const a = (await l.getAccount())!;
      assert.equal(a.balance, 100 * MICRO);
      assert.equal(a.held, 0);
      assert.ok(logs.every((x) => !x.includes(CANARY)));
    }
  });

  test("a client hang-up stops the upstream and bills an estimate", async () => {
    let cancelled = false;
    const head = sse([
      { type: "message_start", message: { usage: { input_tokens: 3000, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x".repeat(300) } },
    ]);
    const { l, deps } = await proxyFixture(100, () => {
      let sent = false;
      return new Response(
        new ReadableStream({
          pull(c) {
            if (!sent) {
              sent = true;
              c.enqueue(new TextEncoder().encode(head));
            }
            // then hang, like a long generation
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    });
    const r = await proxyMessages(post(chatBody()), "acct_test", deps);
    const reader = r.body!.getReader();
    await reader.read();
    await reader.cancel();
    assert.equal(cancelled, true);
    const e = (await l.statement(1))[0]!;
    assert.equal(e.kind, "usage");
    assert.equal(e.estimated, true);
    assert.equal(e.usage?.input_tokens, 3000);
    assert.equal(e.usage?.output_tokens, 100); // 300 bytes / 3
    assert.equal((await l.getAccount())!.held, 0);
  });

  test("a retry with the same Idempotency-Key after completion is refused (409)", async () => {
    const { deps } = await proxyFixture();
    const h = { "idempotency-key": "client-req-0001" };
    assert.equal((await proxyMessages(post(chatBody(), h), "acct_test", deps).then(async (r) => (await r.text(), r))).status, 200);
    assert.equal((await proxyMessages(post(chatBody(), h), "acct_test", deps)).status, 409);
  });
});

// -- the Anthropic organization's spend limit -------------------------------------------

function memOrg(start = 0) {
  let total = start;
  return { get: async () => total, add: async (n: number) => (total += n), get total() { return total; } };
}

describe("org spend limit", () => {
  test("the month-to-date counter grows by list cost; crossing the alert line logs one alert", async () => {
    const c = cfg();
    const limit = c.org.monthly_limit_usd * MICRO;
    const org = memOrg(Math.floor(limit * 0.8) - 1);
    const { deps, logs } = await proxyFixture();
    deps.org = org;
    for (let i = 0; i < 2; i++) await (await proxyMessages(post(chatBody()), "acct_test", deps)).text();
    const list = Math.ceil(listCostUsd(c.models["claude-sonnet-5-5"]!, usage({ input_tokens: 2000, output_tokens: 500 })) * MICRO);
    assert.equal(org.total, Math.floor(limit * 0.8) - 1 + 2 * list);
    assert.equal(logs.filter((l) => l.includes('"ai_org_spend_alert"')).length, 1);
  });

  test("near the limit the proxy answers busy without calling Anthropic", async () => {
    const c = cfg();
    const { deps, up, l, logs } = await proxyFixture();
    deps.org = memOrg(c.org.monthly_limit_usd * MICRO * c.org.stop_fraction);
    const r = await proxyMessages(post(chatBody()), "acct_test", deps);
    assert.equal(r.status, 503);
    const b = (await r.json()) as { error: string; message: string };
    assert.equal(b.error, "ai_credits_busy");
    assert.match(b.message, /busy right now\. Try again later/);
    assert.equal(up.calls.length, 0);
    assert.equal((await l.getAccount())!.held, 0);
    assert.ok(logs.some((x) => x.includes('"ai_org_spend_stop"') && x.includes('"alert":true')));
  });

  test("Anthropic's own spend-limit 429 becomes busy + an alert, released uncharged", async () => {
    const { deps, l, logs } = await proxyFixture(100, () =>
      new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "spend limit" }, error_code: "enforced_spend_limit_reached" }), { status: 429 }),
    );
    const r = await proxyMessages(post(chatBody()), "acct_test", deps);
    assert.equal(r.status, 503);
    assert.equal(((await r.json()) as { error: string }).error, "ai_credits_busy");
    assert.equal((await l.getAccount())!.balance, 100 * MICRO);
    assert.ok(logs.some((x) => x.includes('"ai_org_spend_limit_hit"') && x.includes('"alert":true')));
  });
});

// -- the key never reaches a client ----------------------------------------------------

describe("secrets", () => {
  test("redact masks the key and anything key-shaped", () => {
    assert.equal(redact(`a ${CANARY} b`, CANARY), "a [redacted] b");
    assert.equal(redact("x sk-ant-admin01-abcdefghijk y", CANARY), "x sk-ant-[redacted] y");
  });

  test("the canary key never appears in any response, header or log, whatever the upstream echoes", async () => {
    // The upstream echoes the key everywhere it can: headers, SSE frames, the
    // usage block, a mid-stream error.
    const evil = sse([
      { type: "message_start", message: { id: CANARY, usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `your key is ${CANARY}` } },
      { type: "error", error: { type: "overloaded_error", message: `key ${CANARY}` } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } },
    ]);
    const { deps, logs, up } = await proxyFixture(100, () => new Response(chunked(evil, 5), { headers: { "x-api-key": CANARY, "set-cookie": CANARY } }));
    const clientSecret = "client-session-token-should-not-travel";
    const r = await proxyMessages(post(chatBody(), { authorization: `Bearer ${clientSecret}`, "x-api-key": "client-supplied" }), "acct_test", deps);
    const text = await r.text();
    assert.ok(!text.includes(CANARY), "body");
    r.headers.forEach((v, k) => assert.ok(!v.includes(CANARY) && k !== "set-cookie", `header ${k}`));
    assert.ok(logs.length > 0 && logs.every((x) => !x.includes(CANARY)), "logs");
    // Upstream: exactly our key, nothing of the client's headers.
    const h = up.calls[0]!.headers;
    assert.equal(h.get("x-api-key"), CANARY);
    assert.equal(h.get("authorization"), null);
    const names: string[] = [];
    h.forEach((_v, k) => names.push(k));
    assert.deepEqual(names.sort(), ["anthropic-version", "content-type", "x-api-key"]);
    assert.ok(!JSON.stringify(up.calls[0]!.body).includes(clientSecret));
  });

  test("every relay billing route (errors included) is free of the key", async () => {
    const env = await sandboxEnv();
    const logs: string[] = [];
    const ctx = ctxFor(logs, () => new Response(`{"error":{"type":"x","message":"${CANARY}"}}`, { status: 500 }));
    const acct = (await (await billingEndpoint(new Request("https://relay/billing/account", { method: "POST" }), env, ctx, "/billing/account")).json()) as { token: string };
    const auth = { authorization: `Bearer ${acct.token}` };
    const reqs: [string, RequestInit][] = [
      ["/billing/pricing", {}],
      ["/billing/pricing?channel=web", {}],
      ["/billing/balance", { headers: auth }],
      ["/billing/statement", { headers: auth }],
      ["/ai/v1/messages", { method: "POST", headers: auth, body: JSON.stringify(chatBody()) }],
      ["/ai/v1/messages", { method: "POST", headers: auth, body: "{not json" }],
      ["/ai/v1/messages", { method: "POST", body: JSON.stringify(chatBody()) }],
      ["/billing/purchase/apple", { method: "POST", headers: auth, body: "{}" }],
      ["/billing/notify/apple", { method: "POST", body: "{}" }],
    ];
    for (const [p, init] of reqs) {
      const r = await billingEndpoint(new Request(`https://relay${p}`, init), env, ctx, new URL(`https://relay${p}`).pathname);
      const text = await r.text();
      assert.ok(!text.includes(CANARY) && !text.includes("ANTHROPIC_API_KEY"), `${p}: ${text}`);
      r.headers.forEach((v) => assert.ok(!v.includes(CANARY), p));
    }
    assert.ok(logs.every((x) => !x.includes(CANARY)), logs.join("\n"));
  });
});

// -- the relay routes ------------------------------------------------------------------

const SECRET = "dGVzdC1zZXNzaW9uLXNlY3JldC0zMi1ieXRlcy1sb25nISE";
const STORE_KEY = "fake-store-test-key";

async function sandboxEnv(patch: Partial<Env> = {}): Promise<Env> {
  const env = {} as Env;
  Object.assign(env, {
    AI_BILLING: "sandbox",
    AI_PRICING: JSON.stringify(DEFAULT_PRICING),
    ANTHROPIC_API_KEY: CANARY,
    BILLING_TOKEN_SECRET: SECRET,
    AI_BILLING_FAKE_STORE_KEY: STORE_KEY,
    BILLING: namespace((s) => new BillingAccount(s, env)),
    DIRECTORY: namespace((s) => new Directory(s, env)),
    BRIDGE: namespace(() => ({ fetch: async () => new Response("no", { status: 404 }) })),
    ...patch,
  });
  return env;
}

function ctxFor(logs: string[], reply?: () => Response): BillingContext {
  return {
    json: (o, status = 200, extra = {}) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...extra } }),
    clientIp: "198.51.100.7",
    upstream: async () => (reply ? reply() : new Response(happyStream({ input_tokens: 1000, output_tokens: 200 }))),
    log: (e) => logs.push(JSON.stringify(e)),
  };
}

const call = async (env: Env, ctx: BillingContext, path: string, init: RequestInit = {}) => {
  const r = await billingEndpoint(new Request(`https://relay${path}`, init), env, ctx, new URL(`https://relay${path}`).pathname);
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> };
};

describe("relay routes", () => {
  test("off unless explicitly configured for the sandbox", async () => {
    const ctx = ctxFor([]);
    for (const patch of [
      { AI_BILLING: undefined },
      { AI_BILLING: "1" },
      { AI_BILLING: "production" },
      { ANTHROPIC_API_KEY: undefined },
      { BILLING_TOKEN_SECRET: undefined },
      { STRIPE_SECRET_KEY: "sk_live_x", STRIPE_WEBHOOK_SECRET: "whsec_x" },
      { BILLING: undefined },
      { AI_PRICING: undefined },
      { AI_PRICING: JSON.stringify({ ...DEFAULT_PRICING, markup: 1 }) },
    ] as Partial<Env>[]) {
      const env = await sandboxEnv(patch);
      assert.ok("off" in billingReady(env), JSON.stringify(Object.keys(patch)));
      for (const p of ["/billing/pricing", "/billing/account", "/ai/v1/messages"]) {
        const r = await call(env, ctx, p, { method: p === "/billing/pricing" ? "GET" : "POST" });
        assert.equal(r.status, 503);
        assert.equal(r.body["error"], "not_configured");
      }
    }
  });

  test("sessions: signed, expiring, bound to the account", async () => {
    const t = 1_800_000_000;
    const tok = await mintSession(SECRET, "acct_abcdefghijklmnopqrst", t);
    assert.equal(await verifySession(SECRET, tok, t + 1), "acct_abcdefghijklmnopqrst");
    assert.equal(await verifySession(SECRET, tok, t + 181 * 86400), null);
    assert.equal(await verifySession(SECRET, tok.replace("acct_abcdefghijklmnopqrst", "acct_bbcdefghijklmnopqrst"), t + 1), null);
    assert.equal(await verifySession("b3RoZXItc2VjcmV0LW90aGVyLXNlY3JldC1vdGhlci0", tok, t + 1), null);
  });

  test("account -> 18+ -> fake purchases -> refund -> AI -> delete", async () => {
    const env = await sandboxEnv();
    const logs: string[] = [];
    const ctx = ctxFor(logs);
    const made = await call(env, ctx, "/billing/account", { method: "POST" });
    assert.equal(made.status, 201);
    assert.equal(made.body["balance_credits"], 0); // no free credit (owner decision)
    const auth = { authorization: `Bearer ${String(made.body["token"])}` };
    // An empty balance: the AI refuses before calling anything.
    assert.equal((await call(env, ctx, "/ai/v1/messages", { method: "POST", headers: auth, body: JSON.stringify(chatBody()) })).status, 402);
    // Buying is 18+: the app asks once and records it.
    assert.equal((await call(env, ctx, "/billing/balance", { headers: auth })).body["adult"], false);
    assert.equal((await call(env, ctx, "/billing/age", { method: "POST", headers: auth, body: "{}" })).status, 400);
    assert.equal((await call(env, ctx, "/billing/age", { method: "POST", headers: auth, body: JSON.stringify({ confirm: true }) })).status, 200);
    assert.equal((await call(env, ctx, "/billing/balance", { headers: auth })).body["adult"], true);
    const accountId = String(made.body["account_id"]);
    assert.equal(made.body["account_ref"], await accountRefFor(accountId));

    // iOS asks for its own packs only.
    const pricing = await call(env, ctx, "/billing/pricing?channel=apple");
    assert.ok((pricing.body["packs"] as { channel: string }[]).every((p) => p.channel === "apple"));

    // Buy the small Apple pack (the fake store signs it for this account).
    const store = new FakeStoreVerifier("apple", STORE_KEY);
    const receipt = await store.sign({ sku: "dev.splanc.app.credits.small", transactionId: "2000000000000001", purchasedAt: 0, accountRef: await accountRefFor(accountId) });
    const buy = await call(env, ctx, "/billing/purchase/apple", { method: "POST", headers: auth, body: JSON.stringify(receipt) });
    assert.equal(buy.status, 201);
    assert.equal(buy.body["credited_credits"], 356);
    const again = await call(env, ctx, "/billing/purchase/apple", { method: "POST", headers: auth, body: JSON.stringify(receipt) });
    assert.equal(again.status, 200);
    assert.equal(again.body["replay"], true);
    assert.equal(again.body["balance_credits"], 356);
    const receipt2 = await store.sign({ sku: "dev.splanc.app.credits.medium", transactionId: "2000000000000002", purchasedAt: 0, accountRef: await accountRefFor(accountId) });
    const buy2 = await call(env, ctx, "/billing/purchase/apple", { method: "POST", headers: auth, body: JSON.stringify(receipt2) });
    assert.equal(buy2.body["balance_credits"], 356 + 713);

    // The same receipt on another account is refused.
    const other = await call(env, ctx, "/billing/account", { method: "POST" });
    const steal = await call(env, ctx, "/billing/purchase/apple", { method: "POST", headers: { authorization: `Bearer ${String(other.body["token"])}` }, body: JSON.stringify(receipt) });
    assert.equal(steal.status, 403);
    // A tampered receipt is refused.
    const forged = await call(env, ctx, "/billing/purchase/apple", { method: "POST", headers: auth, body: JSON.stringify({ ...receipt, payload: receipt.payload.replace("small", "large") }) });
    assert.equal(forged.status, 400);

    // Apple refunds it: the server notification claws the credits back (once).
    const n = await store.signRefund("2000000000000001");
    for (let i = 0; i < 2; i++) {
      const r = await call(env, ctx, "/billing/notify/apple", { method: "POST", headers: { "x-fake-signature": n.sig }, body: n.body });
      assert.equal(r.status, 200);
    }
    let bal = await call(env, ctx, "/billing/balance", { headers: auth });
    assert.equal(bal.body["balance_credits"], 713);

    // Spend through the proxy.
    const ai = await billingEndpoint(new Request("https://relay/ai/v1/messages", { method: "POST", headers: auth, body: JSON.stringify(chatBody()) }), env, ctx, "/ai/v1/messages");
    assert.equal(ai.status, 200);
    await ai.text();
    bal = await call(env, ctx, "/billing/balance", { headers: auth });
    const spent = chargeMicro(DEFAULT_PRICING, "claude-sonnet-5-5", usage({ input_tokens: 1000, output_tokens: 200 })) / MICRO;
    assert.equal(bal.body["balance_credits"], 713 - spent);
    assert.equal(bal.body["held_credits"], 0);
    const st = await call(env, ctx, "/billing/statement", { headers: auth });
    assert.deepEqual((st.body["entries"] as { kind: string }[]).map((e) => e.kind), ["usage", "refund", "purchase", "purchase"]);
    assert.ok(!JSON.stringify(st.body).includes("make it blue"), "no prompt content in the ledger");

    // No auth, no AI.
    assert.equal((await call(env, ctx, "/ai/v1/messages", { method: "POST", body: JSON.stringify(chatBody()) })).status, 401);

    // Delete the account: the balance is forfeited and the AI refuses.
    assert.equal((await call(env, ctx, "/billing/account", { method: "DELETE", headers: auth })).status, 200);
    const after = await call(env, ctx, "/ai/v1/messages", { method: "POST", headers: auth, body: JSON.stringify(chatBody()) });
    assert.equal(after.status, 403);
    assert.ok(logs.every((x) => !x.includes("make it blue")), "no prompt content in the logs");
  });

  test("claims: one transaction credits one account", async () => {
    const claims = new MemoryClaims();
    const p = cfg();
    const s1 = new Ledger(new MemStorage());
    await s1.open("acct_a", 0);
    const purchase = { channel: "web" as const, sku: "web.credits.10", transactionId: "cs_test_1", environment: "sandbox" as const, purchasedAt: 0, accountRef: await accountRefFor("acct_a") };
    await applyPurchase({ ledger: s1, claims, pricing: p, accountId: "acct_a", purchase, environment: "sandbox" });
    // Even with a matching account ref, a second account can't claim it.
    await assert.rejects(
      applyPurchase({ ledger: s1, claims, pricing: p, accountId: "acct_b", purchase: { ...purchase, accountRef: await accountRefFor("acct_b") }, environment: "sandbox" }),
      /already credited another account/,
    );
    await assert.rejects(applyPurchase({ ledger: s1, claims, pricing: p, accountId: "acct_a", purchase: { ...purchase, environment: "production" }, environment: "sandbox" }), /production purchase/);
    const r = await applyRefund({ ledgerFor: () => s1, claims, refund: { channel: "web", transactionId: "cs_test_1", kind: "chargeback", environment: "sandbox" } });
    assert.equal(r?.accountId, "acct_a");
    assert.equal(r?.entry?.amount, -833 * MICRO);
  });
});

// -- Apple consumption requests ---------------------------------------------------------

describe("apple consumption requests", () => {
  test("FIFO attribution: older lots are spent first; a refund ends its lot", async () => {
    const { l } = await newLedger(0);
    await l.credit("purchase", "apple:A", 100 * MICRO);
    await l.credit("purchase", "apple:B", 100 * MICRO);
    await l.reserve("spend-a-001", 150 * MICRO, "m", CAPS);
    await l.settle("spend-a-001", 150 * MICRO, { model: "m", usage: usage({}), pricing_version: 1 }, 0);
    const entries = await l.statement(100);
    assert.deepEqual(lotConsumption(entries, "apple:A"), { granted: 100 * MICRO, spent: 100 * MICRO, fraction: 1, refunded: false });
    assert.equal(lotConsumption(entries, "apple:B")!.fraction, 0.5);
    await l.clawback("apple:B");
    const b = await l.consumptionOf("apple:B");
    assert.equal(b!.refunded, true);
    assert.equal(b!.fraction, 0.5);
    assert.equal(await l.consumptionOf("apple:nope"), null);
  });

  test("the ConsumptionRequest: milliunits, delivery, preference by use", () => {
    assert.deepEqual(consumptionRequestFor({ fraction: 0 }), {
      customerConsented: true,
      consumptionPercentage: 0,
      deliveryStatus: "DELIVERED",
      refundPreference: "GRANT_FULL",
      sampleContentProvided: true,
    });
    assert.equal(consumptionRequestFor({ fraction: 0.25 }).consumptionPercentage, 25_000);
    assert.equal(consumptionRequestFor({ fraction: 0.25 }).refundPreference, "GRANT_PRORATED");
    assert.equal(consumptionRequestFor({ fraction: 1 }).refundPreference, "DECLINE");
    assert.equal(consumptionRequestFor(null).deliveryStatus, "UNDELIVERED_OTHER");
  });

  test("answered only with consent; withdrawn consent stops it; failures make Apple retry", async () => {
    const env = await sandboxEnv();
    const logs: string[] = [];
    const sender = new FakeConsumptionSender();
    const ctx = { ...ctxFor(logs), consumption: sender };
    const made = await call(env, ctx, "/billing/account", { method: "POST" });
    const auth = { authorization: `Bearer ${String(made.body["token"])}` };
    const accountId = String(made.body["account_id"]);
    const store = new FakeStoreVerifier("apple", STORE_KEY);
    const receipt = await store.sign({ sku: "dev.splanc.app.credits.small", transactionId: "3000000000000001", purchasedAt: 0, accountRef: await accountRefFor(accountId) });
    await call(env, ctx, "/billing/purchase/apple", { method: "POST", headers: auth, body: JSON.stringify(receipt) });
    const n = await store.signConsumptionRequest("3000000000000001");
    const notify = () => call(env, ctx, "/billing/notify/apple", { method: "POST", headers: { "x-fake-signature": n.sig }, body: n.body });

    // No consent yet: don't respond to Apple.
    assert.equal((await notify()).status, 200);
    assert.equal(sender.sent.length, 0);
    assert.ok(logs.some((x) => x.includes('"ai_consumption_skipped"') && x.includes("no_consent")));

    // The user opts in (purchase flow or settings).
    assert.equal((await call(env, ctx, "/billing/consent", { method: "POST", headers: auth, body: "{}" })).status, 400);
    assert.equal((await call(env, ctx, "/billing/consent", { method: "POST", headers: auth, body: JSON.stringify({ apple_consumption: true }) })).status, 200);
    assert.equal((await call(env, ctx, "/billing/balance", { headers: auth })).body["apple_consumption_consent"], true);
    assert.equal((await notify()).status, 200);
    assert.equal(sender.sent.length, 1);
    assert.equal(sender.sent[0]!.transactionId, "3000000000000001");
    assert.deepEqual(sender.sent[0]!.body, consumptionRequestFor({ fraction: 0 }));

    // A failing send answers 500 (Apple retries) and alerts.
    const failing = { ...ctx, consumption: { send: async () => { throw new Error("app store api 500"); } } };
    assert.equal((await call(env, failing, "/billing/notify/apple", { method: "POST", headers: { "x-fake-signature": n.sig }, body: n.body })).status, 500);
    assert.ok(logs.some((x) => x.includes('"ai_consumption_failed"') && x.includes('"alert":true')));

    // Withdrawn: nothing more is sent.
    await call(env, ctx, "/billing/consent", { method: "POST", headers: auth, body: JSON.stringify({ apple_consumption: false }) });
    await notify();
    assert.equal(sender.sent.length, 1);
    // An unknown transaction is skipped, not an error.
    const unknown = await store.signConsumptionRequest("3999999999999999");
    assert.equal((await call(env, ctx, "/billing/notify/apple", { method: "POST", headers: { "x-fake-signature": unknown.sig }, body: unknown.body })).status, 200);
    for (const x of logs) assert.ok((BILLING_EVENTS as readonly string[]).includes(String(JSON.parse(x).ev)), x);
  });
});

// -- observability ---------------------------------------------------------------------

describe("metrics + alerts", () => {
  test("the Loki push: labelled streams, redacted lines, off without config", async () => {
    const pushes: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      pushes.push({ url, init });
      return new Response("", { status: 204 });
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    const waits: Promise<unknown>[] = [];
    const off = eventSink({ env: {}, secrets: [CANARY], console: (l) => lines.push(l), fetchImpl });
    off({ ev: "ai_settled", detail: CANARY });
    assert.equal(pushes.length, 0);
    assert.ok(!lines[0]!.includes(CANARY));
    const lokiToken = "glc_loki-test-token-not-real-0000";
    const on = eventSink({
      env: { GRAFANA_LOKI_PUSH_URL: "https://logs.example/loki/api/v1/push", GRAFANA_LOKI_USER: "123", GRAFANA_LOKI_TOKEN: lokiToken, AI_BILLING: "sandbox" },
      secrets: [CANARY, lokiToken],
      console: (l) => lines.push(l),
      fetchImpl,
      waitUntil: (p) => waits.push(p),
      now: () => 1_800_000_000_000,
    });
    on({ ev: "ai_org_spend_stop", alert: true, detail: `${CANARY} ${lokiToken}` });
    await Promise.all(waits);
    assert.equal(pushes.length, 1);
    const body = String(pushes[0]!.init.body);
    assert.ok(!body.includes(CANARY) && !body.includes(lokiToken));
    const p = JSON.parse(body) as { streams: { stream: Record<string, string>; values: [string, string][] }[] };
    assert.deepEqual(p.streams[0]!.stream, { service: "splanc-relay", component: "ai-billing", env: "sandbox", event: "ai_org_spend_stop", alert: "true" });
    assert.equal(p.streams[0]!.values[0]![0], "1800000000000000000");
    assert.equal((pushes[0]!.init.headers as Record<string, string>)["authorization"], `Basic ${btoa(`123:${lokiToken}`)}`);
    assert.equal(lokiPayload([{ ev: "ai_refund" }, { ev: "ai_refund" }, { ev: "ai_released" }, { ev: "not_an_event" }], "x", 0).streams.length, 2);
    // The pushed line is the allowlisted one: no detail text, ever.
    assert.equal(p.streams[0]!.values[0]![1], JSON.stringify({ ev: "ai_org_spend_stop", alert: true }));
  });

  test("purchase money: gross, the channel fee estimate, net", () => {
    const c = cfg();
    const web = purchaseMoney(c, "web", "web.credits.10", 833 * MICRO);
    assert.deepEqual(web, { credits: 833, usd_gross: 10, usd_fee: 0.64, usd_net: 9.36 }); // 3.4 % + 30 c
    const apple = purchaseMoney(c, "apple", "dev.splanc.app.credits.small", 356 * MICRO);
    assert.equal(apple.usd_fee, 0.75); // 15 %
    assert.equal(purchaseMoney(c, "web", "no.such.pack", 0).usd_gross, 0);
  });

  test("the ops push of a whole billing flow: allowlisted fields only, no account / request ids", async () => {
    const pushed: Record<string, unknown>[] = [];
    const labels: Record<string, string>[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const p = JSON.parse(String(init.body)) as { streams: { stream: Record<string, string>; values: [string, string][] }[] };
      for (const st of p.streams) {
        labels.push(st.stream);
        for (const [, line] of st.values) pushed.push(JSON.parse(line) as Record<string, unknown>);
      }
      return new Response("", { status: 204 });
    }) as unknown as typeof fetch;
    const grafana = { GRAFANA_LOKI_PUSH_URL: "https://logs.example/loki/api/v1/push", GRAFANA_LOKI_USER: "1", GRAFANA_LOKI_TOKEN: "glc_test_token_not_real_000" };
    const env = await sandboxEnv(grafana);
    const raw: string[] = [];
    const ctx: BillingContext = { ...ctxFor(raw), log: eventSink({ env, secrets: [CANARY], console: (l) => raw.push(l), fetchImpl }) };
    const made = await call(env, ctx, "/billing/account", { method: "POST" });
    const accountId = String(made.body["account_id"]);
    const auth = { authorization: `Bearer ${String(made.body["token"])}` };
    await call(env, ctx, "/billing/age", { method: "POST", headers: auth, body: JSON.stringify({ confirm: true }) });
    const store = new FakeStoreVerifier("apple", STORE_KEY);
    const receipt = await store.sign({ sku: "dev.splanc.app.credits.small", transactionId: "2000000000000777", purchasedAt: 0, accountRef: await accountRefFor(accountId) });
    assert.equal((await call(env, ctx, "/billing/purchase/apple", { method: "POST", headers: auth, body: JSON.stringify(receipt) })).status, 201);
    assert.equal((await call(env, ctx, "/billing/purchase/apple", { method: "POST", headers: auth, body: JSON.stringify(receipt) })).status, 200); // replay
    for (let i = 0; i < 2; i++) {
      const ai = await billingEndpoint(new Request("https://relay/ai/v1/messages", { method: "POST", headers: auth, body: JSON.stringify(chatBody()) }), env, ctx, "/ai/v1/messages");
      await ai.text();
    }
    const n = await store.signRefund("2000000000000777", "chargeback");
    await call(env, ctx, "/billing/notify/apple", { method: "POST", headers: { "x-fake-signature": n.sig }, body: n.body });
    await call(env, ctx, "/billing/account", { method: "DELETE", headers: auth });
    await new Promise((r) => setTimeout(r, 20)); // the background liability pushes

    // The Worker log still has the ids (Cloudflare's own logs); Grafana never does.
    assert.ok(raw.some((l) => l.includes(accountId)));
    const all = JSON.stringify(pushed);
    for (const bad of [accountId, "acct_", "2000000000000777", CANARY, "198.51.100.7", "make it blue", "Here is your effect"]) assert.ok(!all.includes(bad), bad);
    for (const ev of pushed) {
      const spec = OPS_SCHEMA[String(ev["ev"])];
      assert.ok(spec, String(ev["ev"]));
      for (const k of Object.keys(ev)) assert.ok(k === "ev" || k === "alert" || k in spec.fields, `${String(ev["ev"])}.${k}`);
    }
    for (const l of labels) assert.deepEqual(Object.keys(l).sort(), ["alert", "component", "env", "event", "service"]);

    const purchases = pushed.filter((e) => e["ev"] === "ai_purchase");
    assert.equal(purchases.length, 2);
    assert.deepEqual(
      { ...purchases[0] },
      { ev: "ai_purchase", channel: "apple", sku: "dev.splanc.app.credits.small", replay: false, credits: 356, usd_gross: 4.99, usd_fee: 0.75, usd_net: 4.24, first_purchase: true },
    );
    assert.deepEqual({ ...purchases[1] }, { ev: "ai_purchase", channel: "apple", sku: "dev.splanc.app.credits.small", replay: true });
    const settled = pushed.filter((e) => e["ev"] === "ai_settled");
    assert.equal(settled.length, 2);
    assert.deepEqual(
      settled.map((e) => [e["active_day"], e["active_week"], e["active_month"], e["paying"]]),
      [
        [true, true, true, true],
        [false, false, false, true],
      ],
    );
    assert.equal(settled[0]!["input_tokens"], 1000);
    assert.ok(Number(settled[0]!["credits_charged"]) > 0 && Number(settled[0]!["list_usd"]) > 0);
    const refund = pushed.find((e) => e["ev"] === "ai_refund")!;
    assert.equal(refund["kind"], "chargeback");
    assert.equal(refund["credits"], 356);
    // The liability walks +356, -spend, -spend, -356 (the clawback; the balance
    // goes negative, so closing forfeits nothing): it ends at -spend.
    const liab = pushed.filter((e) => e["ev"] === "ai_liability").map((e) => Number(e["liability_credits"]));
    const spent = settled.reduce((t, e) => t + Number(e["credits_charged"]), 0);
    assert.equal(liab.length, 4, JSON.stringify(liab));
    assert.ok(liab.includes(356));
    assert.ok(liab.some((x) => Math.abs(x + spent) < 1e-6), JSON.stringify({ liab, spent }));
  });

  test("the near-limit alert input: settles carry the org fraction", async () => {
    const { deps, logs } = await proxyFixture();
    deps.org = memOrg(400 * MICRO);
    await (await proxyMessages(post(chatBody()), "acct_test", deps)).text();
    const settled = JSON.parse(logs.find((x) => x.includes('"ai_settled"'))!) as { org_fraction: number; org_limit_usd: number };
    assert.equal(settled.org_limit_usd, 1000);
    assert.ok(settled.org_fraction > 0.4 && settled.org_fraction < 0.41);
  });

  test("settles carry the org month-to-date (the near-limit alert's input)", async () => {
    const { deps, logs } = await proxyFixture();
    deps.org = memOrg(5 * MICRO);
    await (await proxyMessages(post(chatBody()), "acct_test", deps)).text();
    const settled = JSON.parse(logs.find((x) => x.includes('"ai_settled"'))!) as { org_month_to_date_usd: number; list_usd: number };
    assert.ok(Math.abs(settled.org_month_to_date_usd - (5 + settled.list_usd)) < 1e-6);
  });

  test("reconciliation: usage vs Anthropic, credits vs store", () => {
    assert.equal(reconcileUsage("2026-11-18", 100, 101).alert, undefined);
    assert.equal(reconcileUsage("2026-11-18", 100, 110).alert, true);
    const st = reconcileStore("2026-11-18", ["apple:1", "web:cs_2"], ["apple:1", "apple:3"]);
    assert.deepEqual(st.missing, ["apple:3"]);
    assert.deepEqual(st.unknown, ["web:cs_2"]);
    assert.equal(st.alert, true);
    assert.equal(reconcileStore("d", ["apple:1"], ["apple:1"]).alert, undefined);
  });

  test("admin suspension: admin token only; logged for the abuse alert; blocks spending", async () => {
    const env = await sandboxEnv({ BILLING_ADMIN_TOKEN: "admin-test-token-0001" });
    const logs: string[] = [];
    const ctx = ctxFor(logs);
    const made = await call(env, ctx, "/billing/account", { method: "POST" });
    const id = String(made.body["account_id"]);
    const body = JSON.stringify({ account: id, status: "suspended", reason: "aup:test" });
    assert.equal((await call(env, ctx, "/billing/admin/status", { method: "POST", body })).status, 401);
    assert.equal((await call(env, ctx, "/billing/admin/status", { method: "POST", headers: { authorization: "Bearer wrong" }, body })).status, 401);
    assert.equal((await call(env, ctx, "/billing/admin/status", { method: "POST", headers: { authorization: "Bearer admin-test-token-0001" }, body })).status, 200);
    assert.ok(logs.some((x) => x.includes('"ai_account_suspended"')));
    const ai = await call(env, ctx, "/ai/v1/messages", { method: "POST", headers: { authorization: `Bearer ${String(made.body["token"])}` }, body: JSON.stringify(chatBody()) });
    assert.equal(ai.status, 403);
  });
});
