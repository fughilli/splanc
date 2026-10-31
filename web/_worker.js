// Cloudflare Pages advanced-mode Worker (deployed as <deploy-root>/_worker.js).
//
// GET /gh-asset CORS-proxies a GitHub release-asset
// download: GitHub's asset CDN (release-assets.githubusercontent.com, reached via a
// redirect from github.com/.../releases/download/...) sends NO CORS headers, so the
// webapp's in-browser flasher can't fetch a release firmware .tar directly. This
// fetches it server-side (no CORS there) and re-serves it with
// Access-Control-Allow-Origin. Locked to this repo's release URLs — not an open proxy.
//
// The effects demo endpoint below relays only an approved model list. The cloud relay's
// public paths (RELAY_PATHS, below) are forwarded to the splanc-relay Worker. On
// splanc.pages.dev every other request 301s to https://splanc.io/app (retiredOrigin,
// below); on other hosts (ledmapper.pages.dev) it passes through to the static site
// via env.ASSETS.
//
// Advanced mode (one _worker.js) is used instead of a functions/ directory because
// `wrangler pages deploy <dir>` did not compile a nested functions/ dir on this
// project (it uploaded the source as a static asset and never routed it). Pages
// always executes _worker.js, so routing here is deterministic. GitHub Pages can't
// run it, so the client targets the absolute Cloudflare URL — hence the open CORS.

const ALLOW_PREFIX = "https://github.com/fughilli/splanc/releases/download/";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-max-age": "86400",
};

async function ghAsset(request) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  const target = new URL(request.url).searchParams.get("url");
  if (!target || !target.startsWith(ALLOW_PREFIX)) {
    return new Response("gh-asset: url must be a splanc release-download URL", {
      status: 400,
      headers: CORS,
    });
  }
  let upstream;
  try {
    upstream = await fetch(target, { redirect: "follow" });
  } catch (e) {
    return new Response(`gh-asset: upstream fetch failed (${e})`, { status: 502, headers: CORS });
  }
  if (!upstream.ok) {
    return new Response(`gh-asset: upstream returned ${upstream.status}`, { status: 502, headers: CORS });
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...CORS,
      "content-type": "application/octet-stream",
      // Release assets are immutable per tag — let the browser cache the tar.
      "cache-control": "public, max-age=3600",
    },
  });
}

// Public effects-demo relay. Credentials never enter a browser or static asset.
// Order = fallback order. Claude leads (owner, 2026-10-30: the free models wrote
// poor effects; the OpenRouter key is topped up to pay for a good demo). Each
// paid model is capped at its own list price (USD per million tokens), so a
// provider price change can't silently cost more. When the key's credit runs out
// (402) the relay falls through to the zero-priced models instead of failing.
// Nemotron leads the free tail: in the 2026-10-29 live check it answered every
// Acid Mode request (1.7-2.5 s) while MiniMax (low reasoning) never did.
const FREE = Object.freeze({ prompt: 0, completion: 0, request: 0, image: 0 });
// Claude 5.5 on OpenRouter rejects {enabled: false} ("Reasoning is mandatory for
// this endpoint", 400); low effort answered a short prompt in 0.7-0.8 s.
const CLAUDE_REASONING = Object.freeze({ effort: "low" });
const DEMO_MODEL_SPECS = Object.freeze([
  { id: "anthropic/claude-sonnet-5.5", maxPrice: { prompt: 2, completion: 10, request: 0, image: 0 }, reasoning: CLAUDE_REASONING },
  { id: "anthropic/claude-haiku-5.5", maxPrice: { prompt: 0.1, completion: 0.5, request: 0, image: 0 }, reasoning: CLAUDE_REASONING },
  { id: "nvidia/nemotron-3.5-super-vl:free", maxPrice: FREE },
  // MiniMax defaults to max reasoning; this is an interactive editor.
  { id: "minimax/minimax-m3.1-flash:free", maxPrice: FREE, reasoning: { effort: "low" } },
  { id: "google/gemma-4-31b-it:free", maxPrice: FREE },
]);
export const DEMO_MODELS = Object.freeze(DEMO_MODEL_SPECS.map(m => m.id));
const DEMO_PATH = "/api/demo-ai/chat/completions";
const DEMO_ORIGINS = new Set([
  "https://splanc.io", "https://www.splanc.io", "https://splanc.pages.dev",
  "https://ledmapper.pages.dev", "https://fughilli.github.io",
  // The iOS (Capacitor) app's page origin. Origin is a hotlink guard, not
  // authentication (any non-browser client can send it); the limits below are
  // what protect the shared quota.
  "capacitor://localhost",
]);
export const DEMO_TOOLS = new Set([
  "set_script", "capture_preview", "estimate_performance", "list_midi_controls", "set_midi_mapping",
]);
const BODY_LIMIT = 2 * 1024 * 1024;
const obj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const textValue = (v, max = 100000) => typeof v === "string" && v.length <= max;
const onlyKeys = (v, keys) => obj(v) && Object.keys(v).every(k => keys.includes(k));

async function boundedJson(message, limit = BODY_LIMIT, signal) {
  if (signal?.aborted) throw new Error("cancelled");
  if (Number(message.headers.get("content-length")) > limit) throw new RangeError("body size");
  if (!message.body) throw new SyntaxError("missing body");
  const reader = message.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const decoder = new TextDecoder();
  let bytes = 0, body = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new RangeError("body size");
      body += decoder.decode(value, { stream: true });
    }
    if (signal?.aborted) throw new Error("cancelled");
    return JSON.parse(body + decoder.decode());
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function validToolCall(call) {
  if (!onlyKeys(call, ["id", "type", "function"]) || !textValue(call.id, 256) || !call.id || call.type !== "function") return false;
  if (!onlyKeys(call.function, ["name", "arguments"]) || !DEMO_TOOLS.has(call.function.name) || !textValue(call.function.arguments)) return false;
  try { return obj(JSON.parse(call.function.arguments)); } catch { return false; }
}
function validContent(content) {
  if (content === null || textValue(content)) return true;
  return Array.isArray(content) && content.length <= 16 && content.every(part => {
    if (part?.type === "text") return onlyKeys(part, ["type", "text"]) && textValue(part.text);
    // Only inline preview pixels. Never make a provider fetch a visitor-supplied URL.
    return onlyKeys(part, ["type", "image_url"]) && part.type === "image_url" &&
      onlyKeys(part.image_url, ["url"]) && typeof part.image_url.url === "string" &&
      /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(part.image_url.url);
  });
}
function validPayload(body) {
  if (!onlyKeys(body, ["messages", "tools", "max_tokens"])) return false;
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 128) return false;
  if (!body.messages.every(m => onlyKeys(m, ["role", "content", "tool_calls", "tool_call_id"]) &&
    ["system", "user", "assistant", "tool"].includes(m.role) && validContent(m.content ?? null) &&
    (m.tool_calls === undefined || (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length <= 8 && m.tool_calls.every(validToolCall))) &&
    (m.role !== "tool" || (textValue(m.tool_call_id, 256) && !!m.tool_call_id)))) return false;
  if (body.max_tokens !== undefined && (!Number.isInteger(body.max_tokens) || body.max_tokens < 1)) return false;
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 5 || !body.tools.every(t =>
    onlyKeys(t, ["type", "function"]) && t.type === "function" &&
    onlyKeys(t.function, ["name", "description", "parameters"]) && DEMO_TOOLS.has(t.function.name) &&
    textValue(t.function.description, 20000) && obj(t.function.parameters)))) return false;
  return true;
}
function completion(json, tools) {
  const choice = json?.choices?.[0];
  const m = choice?.message;
  if (json?.error || !obj(m) || m.role !== "assistant") return null;
  if (m.refusal || choice.finish_reason === "content_filter") return { refusal: true };
  // Provider aggregators may retain streaming indices or other transport fields.
  // Validate and forward only the tool-call fields consumed by the client.
  const calls = m.tool_calls == null ? undefined : Array.isArray(m.tool_calls) ? m.tool_calls.map(c => ({
    id: c?.id, type: c?.type,
    function: { name: c?.function?.name, arguments: c?.function?.arguments },
  })) : m.tool_calls;
  const requested = new Set((tools ?? []).map(t => t.function.name));
  if (calls !== undefined && (!Array.isArray(calls) || calls.length > 8 ||
      !calls.every(c => validToolCall(c) && requested.has(c.function.name)))) return null;
  if (!["stop", "tool_calls"].includes(choice.finish_reason)) return null; // Never execute truncated/failed edits.
  if (!(typeof m.content === "string" && m.content.trim()) && !calls?.length) return null;
  return {
    choices: [{ message: { role: "assistant", content: typeof m.content === "string" ? m.content : "", ...(calls?.length ? { tool_calls: calls } : {}) },
      finish_reason: calls?.length ? "tool_calls" : "stop" }],
  };
}

// The isolate budget is a coarse burst guard, not globally coordinated abuse
// prevention. Operators can bind AI_RATE_LIMITER for Cloudflare edge enforcement.
// Every upstream request is additionally capped at its model's list price.
//
// Sizing (2026-10-29): the key has credit, so OpenRouter allows ~1000 free-model
// requests/day and ~20/minute. A crowd at a Halloween stoop shares that, and an
// Acid Mode prompt costs 1-3 requests. So: 20/minute per isolate (the upstream
// per-minute cap; more only buys upstream 429s), and per client 6/minute (a prompt
// plus repairs, twice) and 30/hour (~10-15 prompts), so one visitor can burn at
// most a few percent of the day.
export const DEMO_LIMITS = Object.freeze({
  perMinute: 20, inFlight: 8, clientPerMinute: 6, clientPerHour: 30, clientActive: 2, clients: 2000,
});

/** Rate-limit key for a visitor: the IPv4 address, or the /64 of an IPv6 one.
 * Phones on cellular are usually IPv6 and rotate privacy addresses inside their
 * /64, so the /64 is the device; a carrier-NAT IPv4 may be shared (the hourly
 * cap still leaves room for a few visitors per address). */
export function clientKey(ip) {
  if (!ip || !ip.includes(":")) return ip || "unknown";
  const [head] = ip.split("%");
  let groups;
  if (head.includes("::")) {
    const [l, r] = head.split("::");
    const left = l ? l.split(":") : [], right = r ? r.split(":") : [];
    groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  } else groups = head.split(":");
  return groups.slice(0, 4).map(g => (g || "0").toLowerCase().replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

export function createDemoRelay({ fetchImpl = (...args) => fetch(...args), now = Date.now,
  attemptMs = 30000, totalMs = 70000, limits = DEMO_LIMITS } = {}) {
  const clients = new Map();
  let windowStart = 0, requests = 0, inFlight = 0;
  return async function demoAi(request, env) {
    const origin = request.headers.get("origin");
    const allowed = DEMO_ORIGINS.has(origin) || (env.DEMO_DEV_ORIGIN && origin === env.DEMO_DEV_ORIGIN);
    const headers = { "content-type": "application/json", "cache-control": "no-store", vary: "Origin" };
    if (allowed) Object.assign(headers, {
      "access-control-allow-origin": origin, "access-control-allow-methods": "POST, GET, OPTIONS",
      "access-control-allow-headers": "Content-Type", "access-control-max-age": "600",
      "access-control-expose-headers": "Retry-After",
    });
    const reply = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { ...headers, ...extra } });
    const error = (status, code, extra) => reply(status, { error: { code } }, extra);
    if (!allowed) return error(403, "origin_not_allowed");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method === "GET") return reply(200, { configured: Boolean(env.OPENROUTER_API_KEY), models: DEMO_MODELS });
    if (request.method !== "POST") return error(405, "method_not_allowed", { allow: "POST, GET, OPTIONS" });
    if (!env.OPENROUTER_API_KEY) return error(503, "not_configured");
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return error(415, "json_required");
    if (request.signal.aborted) return error(499, "cancelled");
    const stamp = now();
    if (stamp - windowStart >= 60000) { windowStart = stamp; requests = 0; }
    for (const [key, value] of clients) {
      if (stamp - value.start >= 60000) { value.start = stamp; value.count = 0; }
      if (stamp - value.hourStart >= 3600000) {
        if (value.active === 0) clients.delete(key);
        else { value.hourStart = stamp; value.hourCount = 0; }
      }
    }
    const ip = clientKey(request.headers.get("cf-connecting-ip"));
    const client = clients.get(ip) ?? { start: stamp, count: 0, hourStart: stamp, hourCount: 0, active: 0 };
    // Busy for everyone (try again in a minute) vs this visitor's own share.
    if (requests >= limits.perMinute || inFlight >= limits.inFlight || (clients.size >= limits.clients && !clients.has(ip))) {
      return error(429, "demo_busy", { "retry-after": String(Math.max(1, Math.ceil((windowStart + 60000 - stamp) / 1000))) });
    }
    if (client.count >= limits.clientPerMinute || client.active >= limits.clientActive) {
      return error(429, "client_rate_limited", { "retry-after": String(Math.max(1, Math.ceil((client.start + 60000 - stamp) / 1000))) });
    }
    if (client.hourCount >= limits.clientPerHour) {
      return error(429, "client_hourly_limit", { "retry-after": String(Math.max(1, Math.ceil((client.hourStart + 3600000 - stamp) / 1000))) });
    }
    if (env.AI_RATE_LIMITER) {
      try {
        if (!(await env.AI_RATE_LIMITER.limit({ key: ip })).success) return error(429, "demo_busy", { "retry-after": "60" });
      } catch { return error(503, "limiter_unavailable"); }
    }
    client.count++; client.hourCount++; client.active++; requests++; inFlight++; clients.set(ip, client);
    const total = new AbortController();
    const cancel = () => total.abort();
    request.signal.addEventListener("abort", cancel, { once: true });
    if (request.signal.aborted) cancel();
    const deadline = setTimeout(cancel, totalMs);
    try {
      let body;
      try {
        body = await boundedJson(request, BODY_LIMIT, total.signal);
      } catch (e) {
        if (total.signal.aborted) return error(request.signal.aborted ? 499 : 504, "cancelled_or_timed_out");
        return error(e instanceof RangeError ? 413 : 400, "invalid_request");
      }
      if (!validPayload(body)) return error(400, "invalid_request");
      const attempts = [];
      for (const { id: model, maxPrice, reasoning } of DEMO_MODEL_SPECS) {
        if (total.signal.aborted) break;
        const diagnostic = { model, outcome: "pending" };
        attempts.push(diagnostic);
        const attempt = new AbortController();
        const stop = () => attempt.abort();
        total.signal.addEventListener("abort", stop, { once: true });
        const timer = setTimeout(stop, attemptMs);
        try {
          const result = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
            // Workers supports manual/follow, not the Fetch standard error mode.
            // Never follow a redirect carrying the server credential.
            method: "POST", redirect: "manual", signal: attempt.signal,
            headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "content-type": "application/json",
              "HTTP-Referer": "https://splanc.io", "X-OpenRouter-Title": "Splanc effects playground" },
            body: JSON.stringify({ model, messages: body.messages, stream: false,
              max_tokens: Math.min(body.max_tokens ?? 4000, 4000),
              // Optional reasoning off (latency) unless the model needs a setting.
              reasoning: reasoning ?? { enabled: false },
              ...(body.tools?.length ? { tools: body.tools, tool_choice: "auto" } : {}),
              provider: { max_price: maxPrice, require_parameters: true },
            }),
          });
          if (result.status >= 300 && result.status < 400) {
            await result.body?.cancel();
            return error(503, "upstream_redirect");
          }
          let json;
          try { json = await boundedJson(result, BODY_LIMIT, attempt.signal); } catch (e) {
            // A 200 response can send headers and then stall. Preserve the
            // deadline classification instead of calling an aborted body JSON.
            if (attempt.signal.aborted) throw e;
          }
          if (total.signal.aborted) break;
          const status = result.ok && json?.error ? Number(json.error.code) || 502 : result.status;
          diagnostic.status = status;
          diagnostic.outcome = status >= 400 ? "upstream_error" : "invalid_completion";
          if (status === 429) {
            diagnostic.outcome = "rate_limited";
            // Only an explicitly identified provider quota may use a different model.
            // A platform quota (or ambiguous 429) stops immediately, never key-rotates.
            const metadata = json?.error?.metadata;
            const provider = metadata?.provider_name;
            const providerQuota = typeof provider === "string" && provider.trim() && provider.toLowerCase() !== "openrouter" && (
              Number(metadata.provider_code) === 429 ||
              ["rate_limited", "rate_limit_exceeded"].includes(metadata.provider_code) ||
              metadata.error_type === "rate_limit_exceeded" ||
              (json.error.message === "Provider returned error" && typeof metadata.raw === "string")
            );
            const quotaHeaders = new Headers(obj(metadata?.headers) ? metadata.headers : {});
            const exhausted = h => h.has("x-ratelimit-remaining") && Number(h.get("x-ratelimit-remaining")) === 0;
            const platformQuota = exhausted(result.headers) || exhausted(quotaHeaders) ||
              String(metadata?.limit_source ?? "").startsWith("openrouter_");
            if (!providerQuota || platformQuota) {
              const retry = result.headers.get("retry-after") || quotaHeaders.get("retry-after") || "60";
              return reply(429, { error: { code: "rate_limited", scope: platformQuota ? "platform" : "unknown" } }, { "retry-after": retry });
            }
            continue;
          }
          // Out of credit: the paid models can't run, the zero-priced ones still can.
          // A paid model the key can't use (out of credit, or a key/account
          // guardrail that rejects it) falls through to the zero-priced models.
          if ((status === 402 || status === 400) && maxPrice !== FREE) {
            console.warn("demo-ai: paid model rejected, falling back", model, status,
              String(json?.error?.message ?? "").slice(0, 200));
            continue;
          }
          if ([401, 402, 403].includes(status)) return error(503, "provider_unavailable");
          if ([404, 408].includes(status) || status >= 500) continue;
          if (status >= 400) return error(400, "upstream_rejected_request");
          if (json?.choices?.[0]?.finish_reason === "length") diagnostic.outcome = "output_limit";
          const message = json?.choices?.[0]?.message;
          if (!json) diagnostic.outcome = "invalid_json";
          else if (!obj(message)) diagnostic.outcome = "missing_message";
          else if (message.role !== "assistant") diagnostic.outcome = "invalid_role";
          else if (message.tool_calls?.length) diagnostic.outcome = "invalid_tool_calls";
          else if (diagnostic.outcome !== "output_limit") diagnostic.outcome = "empty_or_invalid_finish";
          const parsed = completion(json, body.tools);
          if (parsed?.refusal) return error(422, "request_declined");
          if (parsed) return reply(200, { ...parsed, model });
        } catch {
          diagnostic.outcome = attempt.signal.aborted ? "timeout" : "transport_error";
          // Network failures/attempt deadlines may try the next model.
          // A visitor cancellation or overall deadline exits below.
        } finally {
          clearTimeout(timer);
          total.signal.removeEventListener("abort", stop);
        }
      }
      // Fixed model IDs, numeric status and our own outcome vocabulary only.
      // Never expose provider raw payloads, prompts, generated code or credentials.
      return reply(request.signal.aborted ? 499 : total.signal.aborted ? 504 : 503, {
        error: { code: request.signal.aborted ? "cancelled" : "models_unavailable" }, attempts,
      });
    } finally {
      clearTimeout(deadline);
      request.signal.removeEventListener("abort", cancel);
      inFlight--; client.active--;
    }
  };
}
const demoAi = createDemoRelay();

// The cloud relay (agent/relay, docs/design/cloud-relay.md) is its own Worker; its
// public address is https://splanc.pages.dev so it carries no account name. These
// paths go to it through the RELAY service binding on the splanc Pages project, with
// the request URL unchanged: the relay derives its OAuth issuer and MCP URLs from it.
// The relay's landing page (/) and the other .well-known paths stay with the site.
export const RELAY_PATHS = new Set([
  "/mcp", "/healthz", "/register", "/authorize", "/token", "/revoke", "/pair",
  "/bridge/register", "/bridge/connect", "/live", "/bugs",
  "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server", "/.well-known/openid-configuration",
]);

export function relayRoute(request, url, env) {
  if (!RELAY_HOST.test(url.hostname)) return null;
  if (!RELAY_PATHS.has(url.pathname.replace(/\/+$/, ""))) return null;
  if (!env.RELAY) return new Response(JSON.stringify({ error: "relay not bound" }), {
    status: 503, headers: { "content-type": "application/json" },
  });
  return env.RELAY.fetch(request);
}

// splanc.pages.dev is retired as an app origin: the app lives at https://splanc.io/app
// (GitHub Pages). Every non-API path there 301s to the same path under splanc.io/app,
// except the agent entry points, which live at the splanc.io root. The API routes
// above keep working (the app on splanc.io calls them by absolute URL). Preview
// deployments (<hash>.splanc.pages.dev) redirect too; ledmapper.pages.dev is left
// alone (firmware's landing page still names it).
const RETIRED_HOST = /(^|\.)splanc\.pages\.dev$/;
// Production only: preview deployments (<hash>.splanc.pages.dev) have no binding.
const RELAY_HOST = /^splanc\.pages\.dev$/;
const SITE_ROOT_PATH = /^\/(AGENTS\.md|llms\.txt|agent(\/|$)|\.well-known(\/|$))/;
// A browser that installed the PWA from this origin keeps serving it from its
// service worker without asking the network, and a service worker script can't be
// redirected. So /sw.js answers with a worker that unregisters itself and reloads its
// pages, which then hit the network and the redirect.
const RETIRE_SW = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: "window" })) c.navigate(c.url);
})()));
`;

export function retiredOrigin(url) {
  if (!RETIRED_HOST.test(url.hostname)) return null;
  if (url.pathname === "/sw.js") {
    return new Response(RETIRE_SW, {
      headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const base = SITE_ROOT_PATH.test(url.pathname) ? "https://splanc.io" : "https://splanc.io/app";
  return new Response(null, {
    status: 301,
    headers: { location: `${base}${url.pathname}${url.search}`, "cache-control": "public, max-age=86400" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === DEMO_PATH) return demoAi(request, env);
    if (url.pathname === "/gh-asset") return ghAsset(request);
    const relayed = relayRoute(request, url, env);
    if (relayed) return relayed;
    const moved = retiredOrigin(url);
    if (moved) return moved;
    // Everything else is the static site (env.ASSETS honors the SPA not-found rule).
    return env.ASSETS.fetch(request);
  },
};
