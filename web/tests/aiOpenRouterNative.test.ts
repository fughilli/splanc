/**
 * iOS one-tap "Connect OpenRouter" + free-tier vision (owner decisions on #548,
 * docs/design/ai-tiers.md):
 *   - native mode: the authorize URL points OpenRouter at the https bounce page;
 *     the bounce page (web/public/oauth-callback.html, run here in a sandbox)
 *     forwards ONLY code/state/error to splanc://oauth/openrouter; the app checks
 *     state and exchanges the code; the sheet does it all in one tap through a
 *     fake WebAuth plugin (cancel and failure paths too);
 *   - vision is on only for a 1000/day account, and an image turn on a
 *     text-only free model is routed to the free vision models.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { runInNewContext } from "node:vm";
import { asFake, installFakeDom, type FakeElement } from "./fakeDom";

const dom = installFakeDom();

import { defaultConfig, getAiConfig, updateAiConfig } from "../src/effects/ai/provider";
import {
  NATIVE_CALLBACK_SCHEME,
  NATIVE_CALLBACK_URL,
  beginOAuth,
  completeOAuthNative,
  type KVStore,
} from "../src/effects/ai/openrouterOAuth";
import {
  DEFAULT_FREE_MODEL,
  FREE_MODELS,
  FREE_VISION_MODELS,
  VISION_MIN_DAILY_LIMIT,
  cachedFreeDailyLimit,
  fetchOpenRouterKeyInfo,
  freeTierVision,
  openRouterError,
  openRouterRequestBody,
  recordFreeDailyLimit,
} from "../src/effects/ai/providers/openrouter";
import { applyFreeTier, refreshFreeTierLimit, tierOf } from "../src/effects/ai/tiers";
import { openModelSetup } from "../src/ui/screens/aiTierSheet";
import type { ChatMessage } from "../src/effects/ai/provider";

function memStore(): KVStore {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

const keyFetch: typeof fetch = async (url) => {
  const u = String(url);
  if (u.endsWith("/auth/keys")) return new Response(JSON.stringify({ key: "sk-or-native" }));
  if (u.endsWith("/key")) {
    return new Response(JSON.stringify({ data: { free_model_daily_requests: { used: 1, limit: 1000, remaining: 999 } } }));
  }
  return new Response("{}", { status: 404 });
};

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}
function btn(label: string): FakeElement {
  const b = asFake(document.body).querySelectorAll("button").find((x) => x.textContent.includes(label));
  if (!b) throw new Error(`no button "${label}"`);
  return b;
}

beforeEach(() => {
  localStorage.clear();
  updateAiConfig(defaultConfig());
  (globalThis as Record<string, unknown>)["fetch"] = keyFetch;
  (globalThis as Record<string, unknown>)["location"] = { href: "capacitor://localhost/#/effects/edit/e1", hash: "#/effects/edit/e1" };
});
afterEach(async () => {
  for (const s of asFake(document.body).querySelectorAll(".k-sheet-scrim")) s.click();
  for (const sel of [".k-sheet-scrim", ".k-sheet", ".k-toast"]) for (const el of asFake(document.body).querySelectorAll(sel)) el.remove();
  await settle();
  delete (globalThis as Record<string, unknown>)["Capacitor"];
  localStorage.clear();
});

// -- native OAuth -----------------------------------------------------------------

test("native mode: OpenRouter is sent to the https bounce page; the splanc:// return is checked and exchanged", async () => {
  const store = memStore();
  const { url, pending } = await beginOAuth({ mode: "native", returnHash: "#/x", model: "m:free", storage: store });
  assert.equal(new URL(url).searchParams.get("callback_url"), NATIVE_CALLBACK_URL);
  assert.equal(NATIVE_CALLBACK_SCHEME, "splanc");
  const r = await completeOAuthNative(`splanc://oauth/openrouter?code=C1&state=${pending.state}`, { storage: store, fetchImpl: keyFetch });
  assert.equal(r.key, "sk-or-native");
});

test("native mode: missing or wrong state, provider errors and replays are refused", async () => {
  for (const bad of ["splanc://oauth/openrouter?code=C1", "splanc://oauth/openrouter?code=C1&state=forged"]) {
    const store = memStore();
    await beginOAuth({ mode: "native", returnHash: "", model: "m:free", storage: store });
    await assert.rejects(completeOAuthNative(bad, { storage: store, fetchImpl: keyFetch }), /didn't match/);
  }
  const store = memStore();
  await beginOAuth({ mode: "native", returnHash: "", model: "m:free", storage: store });
  await assert.rejects(completeOAuthNative("splanc://oauth/openrouter?error=access_denied", { storage: store }), /cancelled/);
  await assert.rejects(completeOAuthNative("splanc://oauth/openrouter?code=C&state=S", { storage: store }), /expired/, "single use");
});

/** Run the bounce page's script with a given location; returns where it sent us. */
function runBounce(search: string): { target: string; href: string | null } {
  const rel = "public/oauth-callback.html";
  const hit = [resolve(__dirname, "../..", rel), resolve("web", rel), resolve(rel)].find((p) => existsSync(p));
  assert.ok(hit, "bounce page in test data");
  const html = readFileSync(hit, "utf8");
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
  let target = "";
  let href: string | null = null;
  runInNewContext(script, {
    URLSearchParams,
    location: { search, replace: (u: string) => (target = u) },
    document: { getElementById: () => ({ setAttribute: (_k: string, v: string) => (href = v) }) },
  });
  return { target, href };
}

test("bounce page forwards only code/state/error to splanc://oauth/openrouter", () => {
  const ok = runBounce("?code=abc&state=xyz&evil=1&redirect=https://x.example");
  assert.equal(ok.target, "splanc://oauth/openrouter?code=abc&state=xyz");
  assert.equal(ok.href, ok.target);
  assert.equal(runBounce("?error=access_denied").target, "splanc://oauth/openrouter?error=access_denied");
  assert.ok(runBounce(`?code=${"a".repeat(5000)}`).target.length < 2200, "values are bounded");
});

// -- the sheet, one tap -----------------------------------------------------------------

function fakeIosApp(start: (o: { url: string; callbackScheme: string }) => Promise<{ url: string }>): string[] {
  const calls: string[] = [];
  (globalThis as Record<string, unknown>)["Capacitor"] = {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
    isPluginAvailable: (n: string) => n === "WebAuth",
    registerPlugin: () => ({
      start: (o: { url: string; callbackScheme: string }) => {
        calls.push(o.url);
        return start(o);
      },
    }),
  };
  return calls;
}

test("iOS one tap: Connect → system sign-in sheet → back with the code → free tier, prompt sent", async () => {
  const calls = fakeIosApp(async ({ url, callbackScheme }) => {
    assert.equal(callbackScheme, "splanc");
    const state = new URL(url).searchParams.get("state");
    return { url: `splanc://oauth/openrouter?code=ONE&state=${state}` };
  });
  const p = openModelSetup({ ask: "a heartbeat pulse" });
  btn("Connect OpenRouter").click();
  assert.equal(await p, true);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0]!).searchParams.get("callback_url"), NATIVE_CALLBACK_URL);
  assert.equal(tierOf(), "free");
  assert.equal(getAiConfig().cloud.vendors.openrouter.key, "sk-or-native");
});

test("iOS: closing the sign-in sheet is quiet; a failure offers the code fallback", async () => {
  fakeIosApp(async () => Promise.reject(Object.assign(new Error("x"), { code: "canceled" })));
  let settled = false;
  void openModelSetup({ ask: "x" }).then(() => (settled = true));
  btn("Connect OpenRouter").click();
  await settle();
  assert.equal(settled, false);
  assert.equal(asFake(document.body).querySelector(".aitier-err")!.hidden, true);
  assert.equal(btn("Sign in with a code instead").hidden, true);

  for (const s of asFake(document.body).querySelectorAll(".k-sheet-scrim")) s.click();
  for (const sel of [".k-sheet-scrim", ".k-sheet"]) for (const el of asFake(document.body).querySelectorAll(sel)) el.remove();
  await settle();
  fakeIosApp(async () => Promise.reject(Object.assign(new Error("no window"), { code: "failed" })));
  void openModelSetup({ ask: "x" });
  btn("Connect OpenRouter").click();
  await settle();
  assert.match(asFake(document.body).querySelector(".aitier-err")!.textContent, /no window/);
  assert.equal(btn("Sign in with a code instead").hidden, false);
});

// -- free-tier vision (1000/day only) ------------------------------------------------------

test("vision: off by default and at 50/day, on at 1000/day, never for the private model", () => {
  assert.equal(freeTierVision(DEFAULT_FREE_MODEL), false);
  recordFreeDailyLimit(50);
  assert.equal(freeTierVision(DEFAULT_FREE_MODEL), false);
  recordFreeDailyLimit(VISION_MIN_DAILY_LIMIT);
  assert.equal(freeTierVision(DEFAULT_FREE_MODEL), true);
  assert.equal(freeTierVision(FREE_MODELS.find((m) => m.private)!.id), false);
  assert.equal(freeTierVision("anthropic/claude-sonnet-5.5"), false, "paid OpenRouter models unchanged");
});

test("vision: the limit comes from GET /key and from a daily-limit 429", async () => {
  await fetchOpenRouterKeyInfo("k", keyFetch);
  assert.equal(cachedFreeDailyLimit()?.limit, 1000);
  openRouterError(429, { error: { message: "Rate limit exceeded: free-models-per-day", metadata: { headers: { "X-RateLimit-Limit": "50" } } } });
  assert.equal(cachedFreeDailyLimit()?.limit, 50);
});

test("vision: refresh at boot only when stale; a new key forgets the old key's limit", async () => {
  applyFreeTier("sk-or-a");
  let n = 0;
  const counting: typeof fetch = async (u, i) => (n++, keyFetch(u, i));
  await refreshFreeTierLimit(1000, counting, Date.now());
  assert.equal(n, 1);
  await refreshFreeTierLimit(60_000, counting, Date.now());
  assert.equal(n, 1, "fresh: no request");
  applyFreeTier("sk-or-b");
  assert.equal(cachedFreeDailyLimit(), null);
});

test("an image turn on a text-only free model goes to the free vision models", () => {
  const withImage: ChatMessage[] = [
    { role: "user", content: "nicer" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "capture_preview", input: {} }] },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "YQ==" } }] },
      ],
    },
  ];
  const body = openRouterRequestBody({ key: "k", model: DEFAULT_FREE_MODEL, vision: true }, withImage, { system: "", tools: [] });
  assert.equal(body.model, FREE_VISION_MODELS[0]);
  assert.ok(((body.models as string[] | undefined) ?? [body.model as string]).every((m) => FREE_VISION_MODELS.includes(m)));
  const text = openRouterRequestBody({ key: "k", model: DEFAULT_FREE_MODEL }, [{ role: "user", content: "x" }], { system: "", tools: [] });
  assert.equal(text.model, DEFAULT_FREE_MODEL);
});
