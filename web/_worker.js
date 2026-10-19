// Cloudflare Pages advanced-mode Worker (deployed as <deploy-root>/_worker.js).
//
// GET /gh-asset CORS-proxies a GitHub release-asset
// download: GitHub's asset CDN (release-assets.githubusercontent.com, reached via a
// redirect from github.com/.../releases/download/...) sends NO CORS headers, so the
// webapp's in-browser flasher can't fetch a release firmware .tar directly. This
// fetches it server-side (no CORS there) and re-serves it with
// Access-Control-Allow-Origin. Locked to this repo's release URLs — not an open proxy.
//
// The effects demo endpoint below relays only approved free models. Every other
// request passes through to the static site via env.ASSETS, so the app,
// wasm bundles, and SPA fallback behave exactly as before.
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
export const FREE_DEMO_MODELS = Object.freeze([
  "minimax/minimax-m3.1-flash:free",
  "nvidia/nemotron-3.5-super-vl:free",
  "google/gemma-4-31b-it:free",
]);
const DEMO_PATH = "/api/demo-ai/chat/completions";
const DEMO_ORIGINS = new Set([
  "https://splanc.io", "https://www.splanc.io", "https://splanc.pages.dev",
  "https://ledmapper.pages.dev", "https://fughilli.github.io",
]);
const DEMO_TOOLS = new Set([
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
  const calls = m.tool_calls;
  const requested = new Set((tools ?? []).map(t => t.function.name));
  if (calls !== undefined && (!Array.isArray(calls) || calls.length > 8 ||
      !calls.every(c => validToolCall(c) && requested.has(c.function.name)))) return null;
  if (!["stop", "tool_calls"].includes(choice.finish_reason)) return null; // Never execute truncated/failed edits.
  if (!(typeof m.content === "string" && m.content.trim()) && !calls?.length) return null;
  return {
    choices: [{ message: { role: "assistant", content: m.content ?? "", ...(calls?.length ? { tool_calls: calls } : {}) },
      finish_reason: calls?.length ? "tool_calls" : "stop" }],
  };
}

// The isolate budget is a coarse burst guard, not globally coordinated abuse
// prevention. Operators can bind AI_RATE_LIMITER for Cloudflare edge enforcement.
// Every upstream request is additionally constrained to zero-priced models.
export function createDemoRelay({ fetchImpl = (...args) => fetch(...args), now = Date.now,
  attemptMs = 45000, totalMs = 100000 } = {}) {
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
    if (request.method === "GET") return reply(200, { configured: Boolean(env.OPENROUTER_API_KEY), models: FREE_DEMO_MODELS });
    if (request.method !== "POST") return error(405, "method_not_allowed", { allow: "POST, GET, OPTIONS" });
    if (!env.OPENROUTER_API_KEY) return error(503, "not_configured");
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return error(415, "json_required");
    if (request.signal.aborted) return error(499, "cancelled");
    const stamp = now();
    if (stamp - windowStart >= 60000) { windowStart = stamp; requests = 0; }
    for (const [key, value] of clients) if (stamp - value.start >= 60000) clients.delete(key);
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const client = clients.get(ip) ?? { start: stamp, count: 0, active: 0 };
    if (requests >= 120 || inFlight >= 8 || client.count >= 24 || client.active >= 2 || (clients.size >= 2000 && !clients.has(ip))) {
      return error(429, "demo_busy", { "retry-after": "60" });
    }
    if (env.AI_RATE_LIMITER) {
      try {
        if (!(await env.AI_RATE_LIMITER.limit({ key: ip })).success) return error(429, "demo_busy", { "retry-after": "60" });
      } catch { return error(503, "limiter_unavailable"); }
    }
    client.count++; client.active++; requests++; inFlight++; clients.set(ip, client);
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
      for (const model of FREE_DEMO_MODELS) {
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
              ...(body.tools?.length ? { tools: body.tools, tool_choice: "auto" } : {}),
              provider: { max_price: { prompt: 0, completion: 0, request: 0, image: 0 }, require_parameters: true },
            }),
          });
          if (result.status >= 300 && result.status < 400) {
            await result.body?.cancel();
            return error(503, "upstream_redirect");
          }
          let json;
          try { json = await boundedJson(result, BODY_LIMIT, attempt.signal); } catch { /* Treat malformed upstream output as unavailable. */ }
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
          if ([401, 402, 403].includes(status)) return error(503, "provider_unavailable");
          if ([404, 408].includes(status) || status >= 500) continue;
          if (status >= 400) return error(400, "upstream_rejected_request");
          if (json?.choices?.[0]?.finish_reason === "length") diagnostic.outcome = "output_limit";
          const parsed = completion(json, body.tools);
          if (parsed?.refusal) return error(422, "request_declined");
          if (parsed) return reply(200, { ...parsed, model });
        } catch {
          diagnostic.outcome = attempt.signal.aborted ? "timeout" : "transport_error";
          // Network failures/attempt deadlines may try the next free model.
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === DEMO_PATH) return demoAi(request, env);
    if (url.pathname === "/gh-asset") return ghAsset(request);
    // Everything else is the static site (env.ASSETS honors the SPA not-found rule).
    return env.ASSETS.fetch(request);
  },
};
