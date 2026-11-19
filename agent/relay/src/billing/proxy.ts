/**
 * The Splanc AI proxy: POST /ai/v1/messages (docs/design/ai-billing.md §Proxy).
 *
 * The app sends an Anthropic Messages request body with ITS SESSION TOKEN;
 * the proxy checks it against a strict allowlist, reserves the worst-case
 * charge, calls Anthropic with OUR key (a Worker secret), streams the reply
 * through, meters the final `usage`, and settles the reservation.
 *
 * The key never leaves the server (owner requirement, threat model T1):
 * - upstream headers are built from scratch (the client's are never
 *   forwarded, the key is never sent anywhere but api.anthropic.com);
 * - response headers are built from scratch (never the upstream's, never the
 *   request's);
 * - upstream error bodies are NEVER passed through: the client gets our own
 *   error shape with Anthropic's error `type` only;
 * - every SSE frame and every log line passes `redact()`, which masks the key
 *   and anything shaped like an Anthropic key;
 * - log lines carry ids, token counts and statuses, never prompt or reply text.
 */

import type { Ledger } from "./ledger";
import {
  MICRO,
  ZERO_USAGE,
  affordableMaxTokens,
  chargeMicro,
  listCostUsd,
  reserveMicro,
  type PricingConfig,
  type Usage,
} from "./pricing";

export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
/** The biggest request body accepted (images are base64 in the body). */
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
/** Below this many affordable output tokens a request is refused (402)
 * rather than started with a uselessly small max_tokens. */
export const MIN_USEFUL_MAX_TOKENS = 1024;
/** Conservative per-image prompt-token estimate for the reservation. */
export const IMAGE_TOKEN_ESTIMATE = 5000;

/** What the proxy needs from the account's ledger (Ledger, or the DO client). */
export type LedgerClient = Pick<Ledger, "reserve" | "settle" | "release">;

/** Month-to-date list cost of the whole Anthropic ORGANIZATION (every user),
 * in µUSD: the Worker backs it with the Directory DO (`org:spend:<YYYY-MM>`). */
export interface OrgSpend {
  get(): Promise<number>;
  /** Add `microUsd`; returns the new month-to-date total. */
  add(microUsd: number): Promise<number>;
  /** Ops: add `deltaMicro` to the running credit liability (every account's
   * balance together, µcredits); returns the new total. Optional. */
  liability?(deltaMicro: number): Promise<number>;
}

export interface ProxyDeps {
  pricing: PricingConfig;
  /** Our Anthropic key (Worker secret ANTHROPIC_API_KEY). */
  apiKey: string;
  ledger: LedgerClient;
  /** fetch() toward Anthropic (the tests pass a fake upstream). */
  upstream: (url: string, init: RequestInit) => Promise<Response>;
  /** Structured, content-free log sink (console.log in the Worker). */
  log?: ((event: Record<string, unknown>) => void) | undefined;
  /** Keeps the settle alive after the response (ctx.waitUntil in the Worker). */
  waitUntil?: ((p: Promise<unknown>) => void) | undefined;
  /** Random request ids (tests pin them). */
  newId?: (() => string) | undefined;
  /** The org-wide spend counter (absent = no org guard). */
  org?: OrgSpend | undefined;
}

// -- secrets ---------------------------------------------------------------------------

/** Anything shaped like an Anthropic API / admin key. */
const KEY_SHAPE = /sk-ant-[A-Za-z0-9_-]{8,}/g;

/** Mask `secret` and every Anthropic-key-shaped run in `s`. */
export function redact(s: string, secret: string): string {
  let out = s;
  if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  return out.replace(KEY_SHAPE, "sk-ant-[redacted]");
}

function safeLog(deps: ProxyDeps, ev: Record<string, unknown>): void {
  if (!deps.log) return;
  deps.log(JSON.parse(redact(JSON.stringify(ev), deps.apiKey)) as Record<string, unknown>);
}

// -- request validation ----------------------------------------------------------------

/** Top-level request fields the proxy accepts; anything else is a 400. This
 * keeps out what we can't meter from `usage` alone or don't want to pay for:
 * server tools, MCP servers, fast mode, US-only inference (1.1x), batches,
 * containers, service tiers, fallbacks, betas. */
const ALLOWED_KEYS = new Set([
  "model",
  "max_tokens",
  "system",
  "messages",
  "tools",
  "tool_choice",
  "thinking",
  "output_config",
  "stream",
  "cache_control",
  "metadata",
]);

export interface ProxyError {
  status: number;
  error: string;
  message: string;
}

const fail = (status: number, error: string, message: string): ProxyError => ({ status, error, message });

/** Validate + normalise the client's body. Returns the body to send upstream. */
export function sanitizeRequest(raw: unknown, cfg: PricingConfig): { body: Record<string, unknown>; model: string; maxTokens: number } | ProxyError {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail(400, "invalid_request", "body must be a JSON object");
  const b = raw as Record<string, unknown>;
  for (const k of Object.keys(b)) {
    if (!ALLOWED_KEYS.has(k)) return fail(400, "invalid_request", `field not allowed through Splanc AI credits: ${k}`);
  }
  const model = typeof b["model"] === "string" && b["model"] ? b["model"] : cfg.default_model;
  const m = cfg.models[model];
  if (!m || !m.enabled) return fail(400, "model_not_available", `model not offered with Splanc AI credits: ${model}`);
  if (!Array.isArray(b["messages"]) || b["messages"].length === 0) return fail(400, "invalid_request", "messages: non-empty array");
  const req = b["max_tokens"];
  if (req !== undefined && (!Number.isInteger(req) || (req as number) < 1)) return fail(400, "invalid_request", "max_tokens: integer >= 1");
  const maxTokens = Math.min((req as number | undefined) ?? cfg.max_output_tokens, cfg.max_output_tokens);
  if (b["tools"] !== undefined) {
    if (!Array.isArray(b["tools"])) return fail(400, "invalid_request", "tools: array");
    for (const t of b["tools"] as Record<string, unknown>[]) {
      // Only client (custom) tools: a server tool (web search, code execution,
      // …) bills per use outside `usage` token counts.
      const custom = t && typeof t === "object" && typeof t["name"] === "string" && typeof t["input_schema"] === "object";
      if (!custom || (t["type"] !== undefined && t["type"] !== "custom") || "mcp_server_name" in t) {
        return fail(400, "invalid_request", "only custom tools (name + input_schema) are allowed");
      }
    }
  }
  const oc = b["output_config"];
  if (oc !== undefined) {
    if (!oc || typeof oc !== "object" || Object.keys(oc).some((k) => k !== "effort")) {
      return fail(400, "invalid_request", "output_config: only {effort}");
    }
  }
  const th = b["thinking"] as Record<string, unknown> | undefined;
  if (th !== undefined && (typeof th !== "object" || th === null || th["type"] !== "adaptive")) {
    return fail(400, "invalid_request", "thinking: only {type: \"adaptive\"}");
  }
  // Never forward the client's metadata (it could carry identity); the proxy
  // sets its own (the opaque account id, for Anthropic's abuse tooling).
  const body: Record<string, unknown> = { ...b, model, max_tokens: maxTokens, stream: true };
  delete body["metadata"];
  return { body, model, maxTokens };
}

/** A conservative prompt-token estimate for the reservation: ~3 bytes per
 * token of text (English is ~4), a fixed bound per image. */
export function estimatePromptTokens(body: Record<string, unknown>): number {
  let images = 0;
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o["type"] === "image") {
        images++;
        return null;
      }
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, strip(x)]));
    }
    return v;
  };
  const text = JSON.stringify(strip({ system: body["system"], messages: body["messages"], tools: body["tools"] }));
  return Math.ceil(new TextEncoder().encode(text).length / 3) + images * IMAGE_TOKEN_ESTIMATE;
}

// -- usage metering --------------------------------------------------------------------

const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);

function mergeUsage(base: Usage, u: Record<string, unknown> | undefined): Usage {
  if (!u) return base;
  const cc = u["cache_creation"] as Record<string, unknown> | undefined;
  return {
    input_tokens: "input_tokens" in u ? num(u["input_tokens"]) : base.input_tokens,
    output_tokens: "output_tokens" in u ? num(u["output_tokens"]) : base.output_tokens,
    cache_creation_input_tokens: "cache_creation_input_tokens" in u ? num(u["cache_creation_input_tokens"]) : base.cache_creation_input_tokens,
    cache_read_input_tokens: "cache_read_input_tokens" in u ? num(u["cache_read_input_tokens"]) : base.cache_read_input_tokens,
    cache_creation: cc
      ? { ephemeral_5m_input_tokens: num(cc["ephemeral_5m_input_tokens"]), ephemeral_1h_input_tokens: num(cc["ephemeral_1h_input_tokens"]) }
      : base.cache_creation,
  };
}

/** Tracks one stream's usage: message_start's usage, then each message_delta's
 * (cumulative per the streaming docs). `final` once a message_delta with
 * usage arrived; otherwise the output is estimated from the streamed bytes. */
export class UsageMeter {
  usage: Usage = { ...ZERO_USAGE };
  started = false;
  final = false;
  outBytes = 0;

  onEvent(ev: Record<string, unknown>): void {
    if (ev["type"] === "message_start") {
      this.started = true;
      const msg = ev["message"] as Record<string, unknown> | undefined;
      this.usage = mergeUsage(this.usage, msg?.["usage"] as Record<string, unknown> | undefined);
    } else if (ev["type"] === "message_delta" && ev["usage"]) {
      this.usage = mergeUsage(this.usage, ev["usage"] as Record<string, unknown>);
      this.final = true;
    } else if (ev["type"] === "content_block_delta") {
      const d = (ev["delta"] ?? {}) as Record<string, unknown>;
      for (const k of ["text", "thinking", "partial_json"]) if (typeof d[k] === "string") this.outBytes += (d[k] as string).length;
    }
  }

  /** The usage to bill: the reported one, or (stream cut short) message_start's
   * input plus an output estimate capped at max_tokens. Null = nothing billable
   * happened (no message_start). */
  billable(maxTokens: number): { usage: Usage; estimated: boolean } | null {
    if (this.final) return { usage: this.usage, estimated: false };
    if (!this.started) return null;
    const est = Math.min(maxTokens, Math.max(this.usage.output_tokens, Math.ceil(this.outBytes / 3)));
    return { usage: { ...this.usage, output_tokens: est }, estimated: true };
  }
}

// -- the endpoint ----------------------------------------------------------------------

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

function errorResponse(e: ProxyError, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ error: e.error, message: e.message, ...extra }), { status: e.status, headers: JSON_HEADERS });
}

const REFUSALS: Record<string, [number, string]> = {
  insufficient_balance: [402, "Not enough Splanc AI credit for this request."],
  daily_cap: [402, "You reached today's spending limit for Splanc AI credits."],
  monthly_cap: [402, "You reached this month's spending limit for Splanc AI credits."],
  request_cap: [402, "This request is larger than one request may cost."],
  too_many_concurrent: [429, "Another AI request is still running."],
  rate_limited: [429, "Too many AI requests; wait a minute."],
  inactive: [403, "Splanc AI credits are not available on this account."],
  no_account: [401, "Unknown account."],
  duplicate: [409, "This request id was already used."],
};

export const BUSY_MESSAGE = "Splanc AI credits are busy right now. Try again later.";

/** Map an upstream (Anthropic) failure to OUR error. The upstream body is read
 * only for its error `type`; its message is never shown (it is ours to debug,
 * from the log, redacted). An org rate / spend limit (429) is "busy, try
 * later" for the user and an alert for us. */
function upstreamError(status: number, type: string): ProxyError {
  if (status === 400 || status === 413) return fail(400, "upstream_rejected", `The AI service rejected the request (${type || status}).`);
  if (status === 429 || status === 529 || status >= 500) return fail(503, "ai_credits_busy", BUSY_MESSAGE);
  // 401/403/404 and the rest: our configuration (key, model access, spend
  // limit) — never the user's fault, never details.
  return fail(503, "ai_unavailable", "Splanc AI is unavailable right now.");
}

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Handle POST /ai/v1/messages for an AUTHENTICATED account. Returns an SSE
 * stream (the Anthropic event stream, plus one `splanc_billing` event at the
 * end with the charge and the new balance) or a JSON error.
 */
export async function proxyMessages(req: Request, accountId: string, deps: ProxyDeps): Promise<Response> {
  const cfg = deps.pricing;
  if (Number(req.headers.get("content-length") ?? 0) > MAX_REQUEST_BYTES) return errorResponse(fail(413, "too_large", "request too large"));
  const text = await req.text();
  if (text.length > MAX_REQUEST_BYTES) return errorResponse(fail(413, "too_large", "request too large"));
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return errorResponse(fail(400, "invalid_request", "body is not JSON"));
  }
  const s = sanitizeRequest(raw, cfg);
  if ("status" in s) return errorResponse(s);
  const { body, model } = s;
  let maxTokens = s.maxTokens;

  // The request id is the reservation id: a client retry with the same
  // Idempotency-Key finds its hold instead of reserving twice.
  const idem = req.headers.get("idempotency-key");
  const id = idem && ID_RE.test(idem) ? idem : (deps.newId ?? (() => crypto.randomUUID().replace(/-/g, "")))();

  // The org-wide guard: near the Anthropic organization's monthly limit, stop
  // before calling (a graceful "busy" instead of a 429 halfway through a turn).
  const orgLimit = cfg.org.monthly_limit_usd * MICRO;
  if (deps.org && (await deps.org.get()) >= cfg.org.stop_fraction * orgLimit) {
    safeLog(deps, { ev: "ai_org_spend_stop", account: accountId, limit_usd: cfg.org.monthly_limit_usd, alert: true });
    return errorResponse(fail(503, "ai_credits_busy", BUSY_MESSAGE), { retry_after_s: 3600 });
  }

  const prompt = estimatePromptTokens(body);
  let amount = reserveMicro(cfg, model, prompt, maxTokens);
  let r = await deps.ledger.reserve(id, amount, model, cfg.caps);
  if (!r.ok && r.reason === "insufficient_balance") {
    // Shrink max_tokens to what the balance covers, if that is still useful.
    const fit = Math.min(maxTokens, affordableMaxTokens(cfg, model, prompt, r.available));
    if (fit >= MIN_USEFUL_MAX_TOKENS) {
      maxTokens = fit;
      body["max_tokens"] = fit;
      amount = Math.min(reserveMicro(cfg, model, prompt, fit), r.available);
      r = await deps.ledger.reserve(id, amount, model, cfg.caps);
    }
  }
  if (!r.ok) {
    const [status, message] = REFUSALS[r.reason] ?? [402, "Not available."];
    safeLog(deps, { ev: "ai_refused", account: accountId, id, reason: r.reason, model });
    return errorResponse(fail(status, r.reason, message), { balance_credits: Math.max(0, r.available) / MICRO });
  }

  let up: Response;
  try {
    up = await deps.upstream(ANTHROPIC_URL, {
      method: "POST",
      // Built from scratch: nothing of the client's request headers is sent.
      headers: { "content-type": "application/json", "x-api-key": deps.apiKey, "anthropic-version": ANTHROPIC_VERSION },
      body: JSON.stringify({ ...body, metadata: { user_id: accountId } }),
      signal: req.signal,
    });
  } catch (e) {
    await deps.ledger.release(id);
    safeLog(deps, { ev: "ai_upstream_unreachable", alert: true, account: accountId, id, model, detail: String(e) });
    return errorResponse(fail(503, "ai_credits_busy", BUSY_MESSAGE));
  }
  if (!up.ok || up.body === null) {
    // Anthropic does not bill a request it rejected; drop the hold.
    const errText = await up.text().catch(() => "");
    let type = "";
    try {
      type = String((JSON.parse(errText) as { error?: { type?: unknown } }).error?.type ?? "");
    } catch {
      // not JSON
    }
    await deps.ledger.release(id);
    // Anthropic's org spend limit: 429 with error_code enforced_spend_limit_reached.
    const spendLimit = up.status === 429 && errText.includes("enforced_spend_limit_reached");
    safeLog(deps, {
      ev: spendLimit ? "ai_org_spend_limit_hit" : "ai_upstream_error",
      ...(spendLimit || up.status === 429 ? { alert: true } : {}),
      account: accountId,
      id,
      model,
      status: up.status,
      type,
      body: errText.slice(0, 500),
    });
    return errorResponse(upstreamError(up.status, /^[a-z_]{1,40}$/.test(type) ? type : ""));
  }

  const meter = new UsageMeter();
  const reader = up.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let settled: Promise<{ chargedMicro: number; balanceMicro: number } | null> | null = null;
  let cancelled = false;

  const settle = (): Promise<{ chargedMicro: number; balanceMicro: number } | null> => {
    settled ??= (async () => {
      const bill = meter.billable(maxTokens);
      if (!bill) {
        await deps.ledger.release(id);
        safeLog(deps, { ev: "ai_released", account: accountId, id, model });
        return null;
      }
      const charge = chargeMicro(cfg, model, bill.usage);
      const listMicroUsd = Math.ceil(listCostUsd(cfg.models[model]!, bill.usage) * MICRO);
      let orgTotal = -1;
      if (deps.org) {
        const total = await deps.org.add(listMicroUsd).catch(() => -1);
        orgTotal = total;
        const alertAt = cfg.org.alert_fraction * orgLimit;
        if (total >= alertAt && total - listMicroUsd < alertAt) {
          safeLog(deps, { ev: "ai_org_spend_alert", alert: true, month_to_date_usd: total / MICRO, limit_usd: cfg.org.monthly_limit_usd });
        }
      }
      const { entry, replay, activity } = await deps.ledger.settle(
        id,
        charge,
        { model, usage: bill.usage, pricing_version: cfg.version, estimated: bill.estimated },
        Math.round(cfg.max_overdraft_credits * MICRO),
      );
      const low = cfg.low_balance_credits * MICRO;
      if (!replay) {
        safeLog(deps, {
          ev: "ai_settled",
          account: accountId,
          id,
          model,
          usage: bill.usage,
          // Flat token counts for the ops push (ops.ts keeps only these).
          input_tokens: bill.usage.input_tokens,
          output_tokens: bill.usage.output_tokens,
          cache_read_tokens: bill.usage.cache_read_input_tokens,
          cache_write_tokens: bill.usage.cache_creation_input_tokens,
          estimated: bill.estimated,
          list_usd: listMicroUsd / MICRO,
          ...(orgTotal >= 0
            ? { org_month_to_date_usd: orgTotal / MICRO, org_limit_usd: cfg.org.monthly_limit_usd, org_fraction: orgTotal / orgLimit }
            : {}),
          reserved: amount,
          charged: -entry.amount,
          credits_charged: -entry.amount / MICRO,
          usd_charged: -entry.amount / MICRO / cfg.credits_per_usd,
          written_off: entry.written_off ?? 0,
          pricing_version: cfg.version,
          ...(activity ? { active_day: activity.day, active_week: activity.week, active_month: activity.month, paying: activity.paying } : {}),
          low_balance: entry.balance < low && entry.balance - entry.amount >= low,
        });
      }
      if (deps.org?.liability && !replay && entry.amount !== 0) {
        // The liability counter is ops-only: never delays or fails the request.
        const p = deps.org
          .liability(entry.amount)
          .then((t) => safeLog(deps, { ev: "ai_liability", liability_credits: t / MICRO, delta_credits: entry.amount / MICRO }))
          .catch(() => undefined);
        deps.waitUntil?.(p);
      }
      return { chargedMicro: -entry.amount, balanceMicro: entry.balance };
    })();
    return settled;
  };

  /** Re-emit one SSE frame (redacted) and feed its data to the meter. */
  const frameOut = (frame: string): string => {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        meter.onEvent(JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
      } catch {
        // a non-JSON data line is passed through unmetered
      }
    }
    return redact(frame, deps.apiKey) + "\n\n";
  };

  const out = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // Read until at least one whole frame is out (a pull that enqueues
        // nothing is not called again).
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          const chunk = frames.map(frameOut).join("");
          if (chunk) {
            if (!cancelled) controller.enqueue(encoder.encode(chunk));
            return;
          }
        }
        if (cancelled) return; // cancel() settles
        if (buffer.trim()) controller.enqueue(encoder.encode(frameOut(buffer)));
        const res = await settle();
        if (res) {
          const ev = { type: "splanc_billing", request_id: id, charged_credits: res.chargedMicro / MICRO, balance_credits: res.balanceMicro / MICRO };
          controller.enqueue(encoder.encode(`event: splanc_billing\ndata: ${JSON.stringify(ev)}\n\n`));
        }
        controller.close();
      } catch (e) {
        // Upstream broke mid-stream: bill what was used (estimated), end the stream.
        if (!cancelled) safeLog(deps, { ev: "ai_stream_error", account: accountId, id, model, detail: String(e) });
        await settle().catch(() => null);
        if (!cancelled) controller.error(new Error("stream interrupted"));
      }
    },
    async cancel() {
      // The app hung up: stop generating (stop paying), bill what was used.
      cancelled = true;
      await reader.cancel().catch(() => undefined);
      const p = settle();
      deps.waitUntil?.(p);
      await p.catch(() => null);
    },
  });

  return new Response(out, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-splanc-request-id": id },
  });
}
