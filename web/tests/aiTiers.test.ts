/**
 * AI tiers + the first-prompt "Set up AI" sheet (docs/design/ai-tiers.md),
 * under the fake DOM with a fake OpenRouter (no network):
 *   - the tier is derived from the AI config (free = OpenRouter + a `:free`
 *     model; paid = the ai-billing "credits" kind; everything else = self);
 *   - the paid-tier seam stays "coming soon" until the credits provider exists;
 *   - first prompt → sheet → setup → the SAME prompt is sent: in-sheet (pasted
 *     OpenRouter key, Anthropic key, iOS pasted code) and across the OpenRouter
 *     redirect (prompt kept, key exchanged on return, route restored);
 *   - dismissing keeps nothing; a detour to Settings keeps the prompt.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { installFakeDom, typeInto, asFake, type FakeElement } from "./fakeDom";

const dom = installFakeDom();

import { defaultConfig, getAiConfig, isAiConfigured, updateAiConfig } from "../src/effects/ai/provider";
import { DEFAULT_FREE_MODEL } from "../src/effects/ai/providers/openrouter";
import {
  AI_CREDITS_FLAG,
  applyAnthropicKey,
  applyFreeTier,
  paidTierEnabled,
  paidTierSupported,
  peekPendingAsk,
  savePendingAsk,
  selectPaidTier,
  takePendingAsk,
  tierOf,
} from "../src/effects/ai/tiers";
import { finishOpenRouterRedirect, openModelSetup, TIER_COPY } from "../src/ui/screens/aiTierSheet";

// -- fakes -----------------------------------------------------------------------------

interface FakeLocation {
  href: string;
  origin: string;
  pathname: string;
  search: string;
  hash: string;
  host: string;
  protocol: string;
  assigned: string[];
  assign(url: string): void;
}

function setUrl(loc: FakeLocation, href: string): void {
  const u = new URL(href);
  loc.href = href;
  loc.origin = u.origin;
  loc.pathname = u.pathname;
  loc.search = u.search;
  loc.hash = u.hash;
  loc.host = u.host;
  loc.protocol = u.protocol;
}

let loc: FakeLocation;
let replaced: string[];
let opened: string[];
let requests: { url: string; body: unknown; auth: string | undefined }[];
/** Fake OpenRouter: /key accepts "sk-or-good", /auth/keys mints a key. */
const fakeFetch: typeof fetch = async (url, init) => {
  const u = String(url);
  const auth = (init?.headers as Record<string, string> | undefined)?.["authorization"];
  requests.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null, auth });
  if (u.endsWith("/api/v1/key")) {
    return auth === "Bearer sk-or-good"
      ? new Response(JSON.stringify({ data: { free_model_daily_requests: { used: 0, limit: 50, remaining: 50 } } }))
      : new Response(JSON.stringify({ error: { code: 401, message: "User not found." } }), { status: 401 });
  }
  if (u.endsWith("/api/v1/auth/keys")) return new Response(JSON.stringify({ key: "sk-or-oauth" }));
  return new Response("not found", { status: 404 });
};

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

function btn(label: string): FakeElement {
  const b = asFake(document.body)
    .querySelectorAll("button")
    .find((x) => x.textContent.includes(label));
  if (!b) throw new Error(`no button "${label}"`);
  return b;
}
function sheetText(): string {
  return asFake(document.body).querySelector(".k-sheet")?.textContent ?? "";
}
function inputWithPlaceholder(p: string): FakeElement {
  const i = asFake(document.body)
    .querySelectorAll("input")
    .find((x) => (x.getAttribute("placeholder") ?? "").includes(p));
  if (!i) throw new Error(`no input "${p}"`);
  return i;
}
function closeSheets(): void {
  for (const s of asFake(document.body).querySelectorAll(".k-sheet-scrim")) s.click();
  for (const sel of [".k-sheet-scrim", ".k-sheet", ".k-toast"]) {
    for (const el of asFake(document.body).querySelectorAll(sel)) el.remove();
  }
}

beforeEach(() => {
  localStorage.clear();
  updateAiConfig(defaultConfig());
  loc = {
    href: "",
    origin: "",
    pathname: "",
    search: "",
    hash: "",
    host: "",
    protocol: "",
    assigned: [],
    assign(url: string) {
      this.assigned.push(url);
    },
  };
  setUrl(loc, "https://splanc.io/app/#/effects/edit/e1");
  replaced = [];
  opened = [];
  requests = [];
  const g = globalThis as Record<string, unknown>;
  g["location"] = loc;
  g["history"] = { replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) };
  g["fetch"] = fakeFetch;
  (dom.window as unknown as Record<string, unknown>)["open"] = (url: string) => {
    opened.push(url);
    return null;
  };
  delete g["Capacitor"];
});

afterEach(async () => {
  closeSheets();
  await settle();
  localStorage.clear();
  updateAiConfig(defaultConfig());
  delete (globalThis as Record<string, unknown>)["Capacitor"];
});

// -- tier model ------------------------------------------------------------------------

test("tierOf: nothing configured → null; free = OpenRouter + :free; others = self", () => {
  assert.equal(tierOf(), null);
  applyFreeTier("sk-or-x");
  assert.equal(tierOf(), "free");
  assert.equal(getAiConfig().cloud.vendors.openrouter.model, DEFAULT_FREE_MODEL);
  assert.equal(getAiConfig().cloud.vendors.openrouter.baseUrl, "https://openrouter.ai/api/v1");
  // a paid OpenRouter model with the same key is self-serve
  const cfg = getAiConfig();
  updateAiConfig({
    cloud: { ...cfg.cloud, vendors: { ...cfg.cloud.vendors, openrouter: { ...cfg.cloud.vendors.openrouter, model: "anthropic/claude-sonnet-5.5" } } },
  });
  assert.equal(tierOf(), "self");
  applyAnthropicKey("sk-ant-x");
  assert.equal(tierOf(), "self");
  // a non-free model id given to applyFreeTier falls back to the default free model
  applyFreeTier("sk-or-x", "openai/gpt-5");
  assert.equal(getAiConfig().cloud.vendors.openrouter.model, DEFAULT_FREE_MODEL);
});

test("paid seam: flag off → off; flag on but no credits provider in this build → not selectable", () => {
  assert.equal(paidTierEnabled(), false);
  assert.equal(paidTierSupported(), false);
  localStorage.setItem(AI_CREDITS_FLAG, "1");
  assert.equal(paidTierEnabled(), true);
  const before = JSON.stringify(getAiConfig());
  // On a tree without agent/ai-billing the "credits" kind normalizes away.
  const supported = paidTierSupported();
  assert.equal(selectPaidTier(), supported);
  if (!supported) assert.equal(JSON.stringify(getAiConfig()), before, "config untouched");
});

test("pending prompt: per route, taken once, expires", () => {
  savePendingAsk("#/effects/edit/e1", "a slow rainbow", 1000);
  assert.equal(takePendingAsk("#/effects/edit/other", 1001), null);
  assert.equal(takePendingAsk("#/effects/edit/e1", 1002), "a slow rainbow");
  assert.equal(takePendingAsk("#/effects/edit/e1", 1003), null);
  savePendingAsk("#/x", "old", 0);
  assert.equal(takePendingAsk("#/x", 31 * 60 * 1000), null);
});

// -- the sheet ---------------------------------------------------------------------------

test("sheet: three tiers with cost/quality/limits/privacy; paid shows Coming soon", async () => {
  const p = openModelSetup({ ask: "a slow rainbow" });
  dom.flushAnimationFrames();
  const text = sheetText();
  assert.match(text, /Set up AI/);
  assert.match(text, /a slow rainbow/);
  for (const t of ["free", "paid", "self"] as const) {
    assert.ok(text.includes(TIER_COPY[t].title), t);
    assert.ok(text.includes(TIER_COPY[t].privacy), `${t} privacy`);
    assert.ok(text.includes(TIER_COPY[t].limits), `${t} limits`);
  }
  assert.equal(btn("Coming soon").disabled, true);
  // the free tier is preselected for a new user
  assert.ok(asFake(document.body).querySelector(".aitier-card--free")!.classList.contains("aitier-card--current"));
  closeSheets();
  assert.equal(await p, false);
  assert.equal(peekPendingAsk(), null, "dismissed → prompt not kept");
});

test("first prompt → free tier with a pasted OpenRouter key → resolves so the prompt is sent", async () => {
  const p = openModelSetup({ ask: "a slow rainbow", route: "#/effects/edit/e1" });
  btn("I have an OpenRouter key").click();
  typeInto(inputWithPlaceholder("sk-or-"), "sk-or-good");
  btn("Use key").click();
  assert.equal(await p, true);
  assert.equal(tierOf(), "free");
  assert.equal(getAiConfig().cloud.vendors.openrouter.key, "sk-or-good");
  assert.ok(requests.some((r) => r.url.endsWith("/api/v1/key") && r.auth === "Bearer sk-or-good"));
  assert.equal(peekPendingAsk(), null, "sent by the caller, not kept");
});

test("a rejected OpenRouter key shows the error and keeps the sheet open", async () => {
  let settled = false;
  void openModelSetup({ ask: "x" }).then(() => (settled = true));
  btn("I have an OpenRouter key").click();
  typeInto(inputWithPlaceholder("sk-or-"), "sk-or-bad");
  btn("Use key").click();
  await settle();
  assert.equal(settled, false);
  assert.equal(isAiConfigured(), false);
  assert.match(asFake(document.body).querySelector(".aitier-err")!.textContent, /didn't accept the key/);
});

test("first prompt → Connect OpenRouter (PWA redirect) → back with ?code → key stored, prompt still pending for the editor", async () => {
  const p = openModelSetup({ ask: "campfire embers", route: "#/effects/edit/e1" });
  btn("Connect OpenRouter").click();
  assert.equal(await p, false, "setup continues off-page");
  assert.equal(loc.assigned.length, 1);
  const auth = new URL(loc.assigned[0]!);
  assert.equal(auth.origin + auth.pathname, "https://openrouter.ai/auth");
  assert.equal(auth.searchParams.get("callback_url"), "https://splanc.io/app/");
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.deepEqual(peekPendingAsk(), { route: "#/effects/edit/e1", ask: "campfire embers" });

  // OpenRouter sends the browser back: fresh page load with ?code&state.
  setUrl(loc, `https://splanc.io/app/?code=ONE-TIME&state=${auth.searchParams.get("state")}`);
  await finishOpenRouterRedirect();
  assert.equal(tierOf(), "free");
  assert.equal(getAiConfig().cloud.vendors.openrouter.key, "sk-or-oauth");
  const exchange = requests.find((r) => r.url.endsWith("/api/v1/auth/keys"));
  assert.deepEqual(Object.keys(exchange!.body as object).sort(), ["code", "code_challenge_method", "code_verifier"]);
  assert.equal((exchange!.body as { code: string }).code, "ONE-TIME");
  assert.deepEqual(replaced, ["https://splanc.io/app/#/effects/edit/e1"], "code stripped, route restored");
  // the editor, mounting on that route, takes and sends the kept prompt
  assert.equal(takePendingAsk("#/effects/edit/e1"), "campfire embers");
});

test("iOS app: Connect opens OpenRouter in the browser (no callback) and the pasted code finishes", async () => {
  (globalThis as Record<string, unknown>)["Capacitor"] = { isNativePlatform: () => true, getPlatform: () => "ios" };
  const p = openModelSetup({ ask: "fireflies" });
  btn("Connect OpenRouter").click();
  await settle();
  assert.equal(loc.assigned.length, 0);
  assert.equal(opened.length, 1);
  assert.equal(new URL(opened[0]!).searchParams.has("callback_url"), false);
  typeInto(inputWithPlaceholder("Code from OpenRouter"), "PASTED-CODE");
  btn("Finish").click();
  assert.equal(await p, true);
  assert.equal(tierOf(), "free");
});

test("self-serve: an Anthropic key in the sheet is enough", async () => {
  const p = openModelSetup({ ask: "aurora" });
  typeInto(inputWithPlaceholder("Anthropic API key"), "sk-ant-abc");
  btn("Use Anthropic key").click();
  assert.equal(await p, true);
  assert.equal(tierOf(), "self");
  assert.equal(getAiConfig().cloud.vendor, "anthropic");
});

test("self-serve: endpoint / on-device go to Settings ▸ AI and keep the prompt", async () => {
  const p = openModelSetup({ ask: "lava lamp", route: "#/effects/edit/e1" });
  btn("OpenAI-compatible endpoint").click();
  assert.equal(await p, false);
  assert.equal(loc.hash, "#/settings/ai");
  assert.equal(getAiConfig().kind, "local");
  assert.deepEqual(peekPendingAsk(), { route: "#/effects/edit/e1", ask: "lava lamp" });
});

test("another tab finishing setup (storage event) completes the open sheet", async () => {
  const p = openModelSetup({ ask: "x" });
  const cfg = defaultConfig();
  cfg.cloud.vendors.anthropic.key = "sk-ant-other-tab";
  const ev = Object.assign(new Event("storage"), { key: "ledmapper.ai.config", newValue: JSON.stringify(cfg) });
  (dom.window as unknown as EventTarget).dispatchEvent(ev);
  assert.equal(await p, true);
  assert.equal(getAiConfig().cloud.vendors.anthropic.key, "sk-ant-other-tab");
});
