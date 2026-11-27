/**
 * Business observability: the ONE path from the relay to Grafana Cloud Logs
 * (docs/design/ops-grafana.md). Billing, agent feedback and (in web/_worker.js,
 * a JS twin of this file) the shared demo relay emit content-free events;
 * this module turns each into an allowlisted Loki line and pushes it.
 *
 * The privacy guarantee lives HERE, not at the call sites: `opsLine` keeps only
 * the fields `OPS_SCHEMA` names for that event, each checked against its type
 * (a finite number, a boolean, or a short token / version string matching a
 * strict pattern). Anything else is dropped: account ids, request ids,
 * Checkout session ids, transaction ids, error `detail` / upstream `body` text,
 * IPs, emails, prompts, replies, notes. An unknown event is not pushed at all.
 * No per-account id is pushed in any form, hashed or not: "active accounts"
 * and the credit liability are computed where the data lives (the account's
 * ledger / the Directory DO) and arrive as flags and totals.
 *
 * Off unless all three Worker settings exist (no credentials in-repo):
 *   GRAFANA_LOKI_PUSH_URL   https://logs-prod-XXX.grafana.net/loki/api/v1/push
 *   GRAFANA_LOKI_USER       the Grafana Cloud Logs instance (user) id
 *   GRAFANA_LOKI_TOKEN      SECRET: an access-policy token with logs:write only
 * OPS_ENV (optional) overrides the `env` label (production / sandbox /
 * synthetic); billing defaults to AI_BILLING, everything else to production.
 *
 * Why Loki and not Prometheus remote-write: a Worker can POST JSON with fetch();
 * remote-write needs protobuf + snappy, and a Worker has no long-lived process
 * to hold counters. Every series the dashboards need is a count or a sum of
 * these events (LogQL `count_over_time`, `sum_over_time … unwrap`), or a total
 * that already sits in the line (`last_over_time … unwrap`).
 */

export const OPS_SERVICE = "splanc-relay";
export type OpsComponent = "ai-billing" | "feedback" | "demo-relay";

/** A field's type. Strings are never free text: they must match a pattern. */
type Field = "num" | "bool" | "token" | "version" | "day" | readonly string[];

const PATTERNS: Record<"token" | "version" | "day", RegExp> = {
  // model ids, skus, reasons, kinds, enum-ish labels, fnv signatures
  token: /^[A-Za-z0-9][A-Za-z0-9_.:/,\-]{0,63}$/,
  // app / firmware versions: 1.6.0, app-v1.3.0, 1.6.0-rc1+abc123
  version: /^[A-Za-z0-9][A-Za-z0-9_.+\-]{0,31}$/,
  day: /^\d{4}-\d{2}-\d{2}$/,
};

const REFUND_KINDS = ["refund", "revoke", "chargeback", "partial_refund"] as const;
const CHANNELS = ["apple", "web", "google"] as const;
const REFUND_PREFERENCES = ["GRANT_FULL", "GRANT_PRORATED", "DECLINE"] as const;
const STORE_ENVS = ["sandbox", "production"] as const;

/** Every event that may reach Grafana, its component, and its allowed fields. */
export const OPS_SCHEMA: Record<string, { component: OpsComponent; service?: string; fields: Record<string, Field> }> = {
  // -- billing (agent/relay/src/billing) -------------------------------------------
  ai_settled: {
    component: "ai-billing",
    fields: {
      model: "token",
      estimated: "bool",
      pricing_version: "num",
      input_tokens: "num",
      output_tokens: "num",
      cache_read_tokens: "num",
      cache_write_tokens: "num",
      list_usd: "num", // Anthropic list cost of this request
      credits_charged: "num",
      usd_charged: "num", // credits_charged at the credit's list value
      reserved: "num", // µcredits
      charged: "num", // µcredits
      written_off: "num", // µcredits
      org_month_to_date_usd: "num",
      org_limit_usd: "num",
      org_fraction: "num",
      active_day: "bool", // the account's first charged request today (UTC)
      active_week: "bool", // … this ISO week
      active_month: "bool", // … this month
      paying: "bool", // the account has bought credits at least once
      low_balance: "bool", // this request took the balance below the low mark
    },
  },
  ai_refused: { component: "ai-billing", fields: { reason: "token", model: "token" } },
  ai_released: { component: "ai-billing", fields: { model: "token" } },
  ai_upstream_error: { component: "ai-billing", fields: { status: "num", type: "token", model: "token" } },
  ai_upstream_unreachable: { component: "ai-billing", fields: { model: "token" } },
  ai_stream_error: { component: "ai-billing", fields: { model: "token" } },
  ai_holds_expired: { component: "ai-billing", fields: { count: "num" } },
  ai_org_spend_alert: { component: "ai-billing", fields: { month_to_date_usd: "num", limit_usd: "num" } },
  ai_org_spend_stop: { component: "ai-billing", fields: { limit_usd: "num" } },
  ai_org_spend_limit_hit: { component: "ai-billing", fields: { status: "num", type: "token" } },
  ai_account_opened: { component: "ai-billing", fields: { trial_credits: "num" } },
  ai_account_closed: { component: "ai-billing", fields: { forfeited_credits: "num" } },
  /** The running credit liability (Directory DO counter) after a change: one
   * stream, so `last_over_time` reads the current total. */
  ai_liability: { component: "ai-billing", fields: { liability_credits: "num", delta_credits: "num" } },
  ai_account_suspended: { component: "ai-billing", fields: { reason: "token" } },
  ai_account_reinstated: { component: "ai-billing", fields: { reason: "token" } },
  ai_purchase: {
    component: "ai-billing",
    fields: {
      channel: CHANNELS,
      sku: "token",
      replay: "bool",
      credits: "num",
      usd_gross: "num",
      usd_fee: "num", // the store's / Stripe's cut, estimated from the pricing config
      usd_net: "num",
      first_purchase: "bool",
    },
  },
  ai_refund: {
    component: "ai-billing",
    fields: { channel: CHANNELS, kind: REFUND_KINDS, fraction: "num", matched: "bool", credits: "num", usd_est: "num" },
  },
  ai_consumption_sent: { component: "ai-billing", fields: { consumption_milli: "num", preference: REFUND_PREFERENCES } },
  ai_consumption_skipped: { component: "ai-billing", fields: { reason: "token" } },
  ai_consumption_failed: { component: "ai-billing", fields: { reason: "token" } },
  /** An App Store Server Notification v2 that verified (type / subtype are
   * Apple's enums; `ignored`: another environment, or a problem a retry
   * can't fix). */
  ai_apple_notification: { component: "ai-billing", fields: { type: "token", subtype: "token", environment: STORE_ENVS, ignored: "bool" } },
  ai_reconcile_usage: {
    component: "ai-billing",
    fields: { day: "day", ledger_usd: "num", anthropic_usd: "num", diff_usd: "num", mismatch_fraction: "num" },
  },
  ai_reconcile_store: { component: "ai-billing", fields: { day: "day", credited: "num", store: "num", missing_count: "num", unknown_count: "num" } },
  ai_billing_error: { component: "ai-billing", fields: { path: "token" } },
  ai_billing_bad_pricing: { component: "ai-billing", fields: {} },
  ai_metrics_push_failed: { component: "ai-billing", fields: { status: "num" } },
  ai_checkout_created: { component: "ai-billing", fields: { sku: "token" } },
  ai_checkout_failed: { component: "ai-billing", fields: { sku: "token" } },
  ai_checkout_region_refused: { component: "ai-billing", fields: { country: "token" } },
  ai_webhook_rejected: { component: "ai-billing", fields: { channel: CHANNELS, reason: "token" } },
  ai_purchase_rejected: { component: "ai-billing", fields: { channel: CHANNELS, code: "token" } },
  // Verified email + account recovery (billing/email.ts). Never the address,
  // its hash, the account id or the provider's error text.
  ai_recover_requested: { component: "ai-billing", fields: { known: "bool" } },
  ai_account_recovered: { component: "ai-billing", fields: { revoked_others: "bool" } },
  ai_email_verified: { component: "ai-billing", fields: { replaced: "bool" } },
  ai_email_removed: { component: "ai-billing", fields: {} },
  ai_email_failed: { component: "ai-billing", fields: {} },

  // -- agent feedback (agent/relay/src/feedback.ts) ---------------------------------
  fb_received: {
    component: "feedback",
    fields: {
      surface: ["web-editor", "web-acid", "mcp", "bridge"],
      reasons: "token", // the reason chip ids, comma-joined (fixed vocabulary)
      reason_count: "num",
      signature: "token", // fnv1a of tool/error class/flags/reasons/versions
      tool: "token", // the failing tool's name (a fixed tool vocabulary)
      app: "version",
      firmware: "version",
      ai: "token", // provider kind/vendor/model ids
      via: ["bridge", "anonymous"],
      sections: "num",
      bytes: "num",
    },
  },
  /** One per reason chip of a received report, so dashboards can `sum by (reason)`. */
  fb_reason: { component: "feedback", fields: { reason: "token", surface: ["web-editor", "web-acid", "mcp", "bridge"], app: "version" } },
  fb_duplicate: { component: "feedback", fields: {} },
  fb_rate_limited: { component: "feedback", fields: { via: ["bridge", "anonymous"] } },
  fb_rejected: { component: "feedback", fields: { status: "num" } },
  fb_status: {
    component: "feedback",
    fields: {
      status: ["received", "reproduced", "not_reproduced", "fixed", "wontfix"],
      prev: ["received", "reproduced", "not_reproduced", "fixed", "wontfix"],
      age_h: "num", // hours since the report was received
      signature: "token",
      tool: "token",
      app: "version",
      firmware: "version",
    },
  },
  fb_deleted: { component: "feedback", fields: { by: ["reporter", "admin"] } },

  // -- shared demo relay (web/_worker.js; mirrored there in JS) ---------------------
  demo_request: {
    component: "demo-relay",
    service: "splanc-pages",
    fields: { outcome: "token", status: "num", model: "token", attempts: "num", ms: "num", images: "bool" },
  },
};

export const OPS_EVENTS = Object.keys(OPS_SCHEMA);

function keep(v: unknown, t: Field): unknown {
  if (Array.isArray(t)) return typeof v === "string" && t.includes(v) ? v : undefined;
  switch (t) {
    case "num":
      return typeof v === "number" && Number.isFinite(v) ? v : undefined;
    case "bool":
      return typeof v === "boolean" ? v : undefined;
    default:
      return typeof v === "string" && PATTERNS[t as "token" | "version" | "day"].test(v) ? v : undefined;
  }
}

/**
 * The Loki line for an event: `ev`, `alert` (when true) and ONLY the fields
 * the schema allows, each type-checked. null for an event not in the schema.
 */
export function opsLine(ev: Record<string, unknown>): Record<string, unknown> | null {
  const name = String(ev["ev"] ?? "");
  const spec = Object.prototype.hasOwnProperty.call(OPS_SCHEMA, name) ? OPS_SCHEMA[name] : undefined;
  if (!spec) return null;
  const out: Record<string, unknown> = { ev: name };
  if (ev["alert"] === true) out["alert"] = true;
  for (const [k, t] of Object.entries(spec.fields)) {
    const v = keep(ev[k], t);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** The Loki push body. Low-cardinality labels only (service, component, env,
 * event, alert); everything else is in the JSON line. Lines not in the schema
 * are dropped. */
export function lokiPayload(events: Record<string, unknown>[], envName: string, nowMs: number) {
  const streams = new Map<string, { stream: Record<string, string>; values: [string, string][] }>();
  for (const [i, raw] of events.entries()) {
    const ev = opsLine(raw);
    if (!ev) continue;
    const event = String(ev["ev"]);
    const alert = ev["alert"] === true ? "true" : "false";
    const key = `${event}|${alert}`;
    let s = streams.get(key);
    if (!s) {
      const spec = OPS_SCHEMA[event]!;
      s = { stream: { service: spec.service ?? OPS_SERVICE, component: spec.component, env: envName, event, alert }, values: [] };
      streams.set(key, s);
    }
    // ns timestamps; +i keeps lines of one batch ordered and distinct.
    s.values.push([`${BigInt(nowMs) * 1_000_000n + BigInt(i)}`, JSON.stringify(ev)]);
  }
  return { streams: [...streams.values()] };
}

export interface OpsEnv {
  GRAFANA_LOKI_PUSH_URL?: string | undefined;
  GRAFANA_LOKI_USER?: string | undefined;
  GRAFANA_LOKI_TOKEN?: string | undefined;
  OPS_ENV?: string | undefined;
  AI_BILLING?: string | undefined;
}

export const grafanaConfigured = (env: OpsEnv) => !!(env.GRAFANA_LOKI_PUSH_URL && env.GRAFANA_LOKI_USER && env.GRAFANA_LOKI_TOKEN);

const ENV_RE = /^[a-z][a-z0-9-]{0,19}$/;
/** The `env` label: OPS_ENV, else `fallback` (billing: AI_BILLING). */
export function opsEnvName(env: OpsEnv, fallback = "production"): string {
  const v = env.OPS_ENV || fallback;
  return ENV_RE.test(v) ? v : "unknown";
}

/**
 * Push events to Grafana Cloud Logs in the background. Never throws, never
 * delays the caller; returns the promise (also handed to waitUntil). A failed
 * push is reported to `onFail` with the HTTP status only.
 */
export function opsPush(
  env: OpsEnv,
  events: Record<string, unknown>[],
  opts: {
    envName?: string | undefined;
    fetchImpl?: typeof fetch | undefined;
    waitUntil?: ((p: Promise<unknown>) => void) | undefined;
    now?: (() => number) | undefined;
    onFail?: ((status: number) => void) | undefined;
  } = {},
): Promise<void> {
  if (!grafanaConfigured(env)) return Promise.resolve();
  const body = lokiPayload(events, opts.envName ?? opsEnvName(env), (opts.now ?? Date.now)());
  if (!body.streams.length) return Promise.resolve();
  let p: Promise<void>;
  try {
    p = (opts.fetchImpl ?? fetch)(env.GRAFANA_LOKI_PUSH_URL!, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${btoa(`${env.GRAFANA_LOKI_USER}:${env.GRAFANA_LOKI_TOKEN}`)}` },
      body: JSON.stringify(body),
    }).then(
      (r) => {
        if (!r.ok) opts.onFail?.(r.status);
      },
      () => opts.onFail?.(0),
    );
  } catch {
    p = Promise.resolve();
  }
  opts.waitUntil?.(p);
  return p;
}
