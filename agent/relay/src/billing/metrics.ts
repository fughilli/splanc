/**
 * Billing observability (docs/design/ai-billing.md §Observability and alerts).
 *
 * Every billing event is one content-free JSON log line (ids, token counts,
 * credits, USD, statuses; never prompt or reply text, never a credential).
 * The relay writes it to the Worker log AND, when configured, pushes it to
 * Grafana Cloud Logs (Loki's HTTP push API), where Grafana Cloud alerting
 * evaluates the rules below (owner decision: billing alerts go to Grafana
 * Cloud alerting, like the HITL rigs).
 *
 * Off unless all three Worker settings exist (no real credentials in-repo):
 *   GRAFANA_LOKI_PUSH_URL   e.g. https://logs-prod-XXX.grafana.net/loki/api/v1/push
 *   GRAFANA_LOKI_USER       the Grafana Cloud Logs instance (user) id
 *   GRAFANA_LOKI_TOKEN      SECRET: an access-policy token with logs:write only
 *
 * Why Loki and not Prometheus remote-write: a Worker can POST JSON with
 * fetch(); remote-write needs protobuf + snappy. Metrics come from the logs
 * with LogQL (`count_over_time`, `unwrap`), so one write path covers both.
 */

import { redact } from "./proxy";

/** Every billing event the relay emits. The alert rules may only name these. */
export const BILLING_EVENTS = [
  "ai_settled",
  "ai_refused",
  "ai_released",
  "ai_upstream_error",
  "ai_upstream_unreachable",
  "ai_stream_error",
  "ai_holds_expired",
  "ai_org_spend_alert",
  "ai_org_spend_stop",
  "ai_org_spend_limit_hit",
  "ai_account_opened",
  "ai_account_closed",
  "ai_account_suspended",
  "ai_account_reinstated",
  "ai_purchase",
  "ai_refund",
  "ai_consumption_sent",
  "ai_consumption_skipped",
  "ai_consumption_failed",
  "ai_reconcile_usage",
  "ai_reconcile_store",
  "ai_billing_error",
  "ai_billing_bad_pricing",
  "ai_metrics_push_failed",
  "ai_checkout_created",
  "ai_checkout_failed",
  "ai_webhook_rejected",
  "ai_purchase_rejected",
] as const;
export type BillingEvent = (typeof BILLING_EVENTS)[number];

export interface GrafanaEnv {
  GRAFANA_LOKI_PUSH_URL?: string;
  GRAFANA_LOKI_USER?: string;
  GRAFANA_LOKI_TOKEN?: string;
  AI_BILLING?: string;
}

export const grafanaConfigured = (env: GrafanaEnv) => !!(env.GRAFANA_LOKI_PUSH_URL && env.GRAFANA_LOKI_USER && env.GRAFANA_LOKI_TOKEN);

/** The Loki push body for events. Low-cardinality labels only (service,
 * component, env, event, alert); everything else is in the JSON line. */
export function lokiPayload(events: Record<string, unknown>[], envName: string, nowMs: number) {
  const streams = new Map<string, { stream: Record<string, string>; values: [string, string][] }>();
  for (const [i, ev] of events.entries()) {
    const event = String(ev["ev"] ?? "unknown");
    const alert = ev["alert"] === true ? "true" : "false";
    const key = `${event}|${alert}`;
    let s = streams.get(key);
    if (!s) {
      s = { stream: { service: "splanc-relay", component: "ai-billing", env: envName, event, alert }, values: [] };
      streams.set(key, s);
    }
    // ns timestamps; +i keeps lines of one batch ordered and distinct.
    s.values.push([`${BigInt(nowMs) * 1_000_000n + BigInt(i)}`, JSON.stringify(ev)]);
  }
  return { streams: [...streams.values()] };
}

/**
 * The event sink the billing routes log through: the Worker log, plus a
 * fire-and-forget Loki push (kept alive with waitUntil). Every line is
 * redacted against every secret first; a push failure never affects a request.
 */
export function eventSink(opts: {
  env: GrafanaEnv;
  secrets: string[];
  console?: ((line: string) => void) | undefined;
  fetchImpl?: typeof fetch | undefined;
  waitUntil?: ((p: Promise<unknown>) => void) | undefined;
  now?: (() => number) | undefined;
}): (ev: Record<string, unknown>) => void {
  const { env } = opts;
  const scrub = (line: string) => opts.secrets.reduce((l, s) => redact(l, s), line);
  return (ev) => {
    const line = scrub(JSON.stringify(ev));
    (opts.console ?? ((l: string) => console.log(l)))(line);
    if (!grafanaConfigured(env)) return;
    const body = JSON.stringify(lokiPayload([JSON.parse(line) as Record<string, unknown>], env.AI_BILLING ?? "unknown", (opts.now ?? Date.now)()));
    const p = (opts.fetchImpl ?? fetch)(env.GRAFANA_LOKI_PUSH_URL!, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${btoa(`${env.GRAFANA_LOKI_USER}:${env.GRAFANA_LOKI_TOKEN}`)}` },
      body,
    }).then(
      (r) => (r.ok ? undefined : (opts.console ?? console.log)(scrub(JSON.stringify({ ev: "ai_metrics_push_failed", status: r.status })))),
      () => undefined,
    );
    opts.waitUntil?.(p);
  };
}

// -- alert rules -----------------------------------------------------------------------

export interface AlertRule {
  uid: string;
  title: string;
  /** A LogQL metric query over the billing streams. */
  expr: string;
  /** Fire when the query's last value is above this. */
  above: number;
  for: string;
  severity: "page" | "warn";
  summary: string;
}

const SEL = '{service="splanc-relay", component="ai-billing", env="$env"';

/**
 * The billing alert rules (Grafana Cloud alerting). `$env` is the
 * AI_BILLING value (sandbox / production); `orgLimitUsd` comes from the
 * pricing config's `org.monthly_limit_usd`.
 */
export function billingAlertRules(orgLimitUsd: number, alertFraction: number): AlertRule[] {
  return [
    {
      uid: "ai-org-spend-near-limit",
      title: "AI credits: Anthropic org spend near the monthly limit",
      expr: `max(max_over_time(${SEL}, event="ai_settled"} | json | unwrap org_month_to_date_usd [15m]))`,
      above: orgLimitUsd * alertFraction,
      for: "0m",
      severity: "warn",
      summary: `Month-to-date Anthropic spend is above ${Math.round(alertFraction * 100)} % of the US$${orgLimitUsd} org limit: raise the usage tier.`,
    },
    {
      uid: "ai-org-spend-stopped",
      title: "AI credits: stopped at the org spend limit",
      expr: `sum(count_over_time(${SEL}, event=~"ai_org_spend_stop|ai_org_spend_limit_hit"} [10m]))`,
      above: 0,
      for: "0m",
      severity: "page",
      summary: "Users are getting 'Splanc AI credits are busy': the org spend limit is (nearly) hit.",
    },
    {
      uid: "ai-upstream-rate-limited",
      title: "AI credits: Anthropic rate limits / outages",
      expr: `sum(count_over_time(${SEL}, event=~"ai_upstream_error|ai_upstream_unreachable", alert="true"} [10m]))`,
      above: 5,
      for: "5m",
      severity: "warn",
      summary: "Repeated 429s / unreachable upstream: org rate limits or an Anthropic incident.",
    },
    {
      uid: "ai-reconcile-mismatch",
      title: "AI credits: ledger vs Anthropic / store reconciliation mismatch",
      expr: `sum(count_over_time(${SEL}, event=~"ai_reconcile_usage|ai_reconcile_store", alert="true"} [1d]))`,
      above: 0,
      for: "0m",
      severity: "page",
      summary: "The daily reconciliation found a mismatch beyond tolerance (usage billed vs Anthropic's cost, or credits vs store transactions).",
    },
    {
      uid: "ai-refund-spike",
      title: "AI credits: refunds spiking",
      expr: `sum(count_over_time(${SEL}, event="ai_refund"} [1h]))`,
      above: 3,
      for: "0m",
      severity: "warn",
      summary: "More than 3 refunds in an hour.",
    },
    {
      uid: "ai-dispute",
      title: "AI credits: a chargeback / dispute",
      expr: `sum(count_over_time(${SEL}, event="ai_refund"} | json | kind="chargeback" [1h]))`,
      above: 0,
      for: "0m",
      severity: "page",
      summary: "A card dispute was opened: respond in Stripe before the deadline.",
    },
    {
      uid: "ai-account-suspended",
      title: "AI credits: an account was suspended for abuse",
      expr: `sum(count_over_time(${SEL}, event="ai_account_suspended"} [1h]))`,
      above: 0,
      for: "0m",
      severity: "warn",
      summary: "An account was suspended (Usage Policy / abuse). Check whether Anthropic needs telling.",
    },
    {
      uid: "ai-write-offs",
      title: "AI credits: written-off usage",
      expr: `sum(sum_over_time(${SEL}, event="ai_settled"} | json | unwrap written_off [1d]))`,
      above: 500 * 1_000_000, // µcredits: more than 500 credits (US$5) a day
      for: "0m",
      severity: "warn",
      summary: "Requests cost more than their reservation beyond the overdraft: check the reservation estimate.",
    },
    {
      uid: "ai-web-payments",
      title: "AI credits: web checkout / Stripe webhook problems",
      expr: `sum(count_over_time(${SEL}, event=~"ai_checkout_failed|ai_purchase_rejected"} [1h]))`,
      above: 0,
      for: "0m",
      severity: "page",
      summary: "A paid Stripe checkout wasn't credited (rejected purchase), or checkout sessions can't be created.",
    },
    {
      uid: "ai-webhook-signatures",
      title: "AI credits: Stripe webhook signatures failing",
      expr: `sum(count_over_time(${SEL}, event="ai_webhook_rejected"} [1h]))`,
      above: 5,
      for: "0m",
      severity: "warn",
      summary: "Webhook calls with bad signatures: a rotated signing secret, or someone probing the endpoint.",
    },
    {
      uid: "ai-consumption-failed",
      title: "AI credits: Apple consumption answer failed",
      expr: `sum(count_over_time(${SEL}, event="ai_consumption_failed"} [1h]))`,
      above: 0,
      for: "0m",
      severity: "warn",
      summary: "A CONSUMPTION_REQUEST could not be answered (12-hour deadline; Apple retries the notification).",
    },
  ];
}

/** Grafana alerting provisioning JSON for the rules (POST
 * /api/v1/provisioning/alert-rules, one per rule), against the Loki
 * datasource `lokiUid`. Applied by a sync step once credentials exist. */
export function grafanaProvisioning(rules: AlertRule[], opts: { lokiUid: string; folderUid: string; env: string }) {
  return rules.map((r) => ({
    uid: r.uid,
    title: r.title,
    ruleGroup: "ai-billing",
    folderUID: opts.folderUid,
    condition: "C",
    for: r.for,
    noDataState: "OK",
    execErrState: "Error",
    labels: { service: "splanc-relay", component: "ai-billing", severity: r.severity },
    annotations: { summary: r.summary },
    data: [
      {
        refId: "A",
        datasourceUid: opts.lokiUid,
        relativeTimeRange: { from: 3600, to: 0 },
        model: { refId: "A", expr: r.expr.split("$env").join(opts.env), queryType: "range" },
      },
      { refId: "B", datasourceUid: "__expr__", model: { refId: "B", type: "reduce", expression: "A", reducer: "last" } },
      {
        refId: "C",
        datasourceUid: "__expr__",
        model: { refId: "C", type: "threshold", expression: "B", conditions: [{ evaluator: { type: "gt", params: [r.above] } }] },
      },
    ],
  }));
}

// -- reconciliation --------------------------------------------------------------------

/**
 * Daily: what the ledger billed at list price vs what Anthropic reports it
 * cost (Usage & Cost Admin API, the same day and key). Beyond `tolerance`
 * (a fraction) it is an alert.
 */
export function reconcileUsage(day: string, ledgerListUsd: number, anthropicCostUsd: number, tolerance = 0.02) {
  const diff = anthropicCostUsd - ledgerListUsd;
  const base = Math.max(anthropicCostUsd, ledgerListUsd, 0.01);
  const fraction = Math.abs(diff) / base;
  return {
    ev: "ai_reconcile_usage" as const,
    day,
    ledger_usd: ledgerListUsd,
    anthropic_usd: anthropicCostUsd,
    diff_usd: diff,
    mismatch_fraction: fraction,
    ...(fraction > tolerance ? { alert: true } : {}),
  };
}

/**
 * Daily: the store's transactions vs the ledger's credited purchases (both as
 * `<channel>:<txid>`). `missing` = paid but never credited (users short);
 * `unknown` = credited but the store doesn't know it (fraud or a bug).
 */
export function reconcileStore(day: string, credited: string[], storeReported: string[]) {
  const c = new Set(credited);
  const st = new Set(storeReported);
  const missing = [...st].filter((t) => !c.has(t)).sort();
  const unknown = [...c].filter((t) => !st.has(t)).sort();
  return {
    ev: "ai_reconcile_store" as const,
    day,
    credited: c.size,
    store: st.size,
    missing,
    unknown,
    ...(missing.length || unknown.length ? { alert: true } : {}),
  };
}
