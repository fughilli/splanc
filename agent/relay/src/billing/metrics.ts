/**
 * Billing observability (docs/design/ai-billing.md §Observability and alerts,
 * docs/design/ops-grafana.md).
 *
 * Every billing event is one JSON log line. The relay writes it to the Worker
 * log AND, when configured, pushes it to Grafana Cloud Logs through ops.ts,
 * which keeps ONLY the allowlisted, type-checked fields of each event (no
 * account / request / session ids, no error text, never prompt or reply text).
 * Grafana Cloud alerting evaluates the rules in ops/grafana/business/alerts.json
 * (owner decision: billing alerts go to Grafana Cloud alerting, like the HITL
 * rigs); the dashboards are in ops/grafana/business/dashboards/.
 */

import { redact } from "./proxy";
import { OPS_SCHEMA, opsEnvName, opsPush, type OpsEnv } from "../ops";
import type { Channel, PricingConfig } from "./pricing";
import { MICRO, findPack } from "./pricing";

export { grafanaConfigured, lokiPayload } from "../ops";

/** Every billing event the relay emits. The alert rules may only name these. */
export const BILLING_EVENTS = Object.keys(OPS_SCHEMA).filter((k) => OPS_SCHEMA[k]!.component === "ai-billing") as readonly string[];
export type BillingEvent = string;

export type GrafanaEnv = OpsEnv;

/**
 * The event sink the billing routes log through: the Worker log, plus a
 * fire-and-forget Loki push of the allowlisted line (kept alive with
 * waitUntil). Every line is redacted against every secret first; a push
 * failure never affects a request.
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
  const out = opts.console ?? ((l: string) => console.log(l));
  const scrub = (line: string) => opts.secrets.reduce((l, s) => redact(l, s), line);
  return (ev) => {
    const line = scrub(JSON.stringify(ev));
    out(line);
    void opsPush(env, [JSON.parse(line) as Record<string, unknown>], {
      envName: opsEnvName(env, env.AI_BILLING ?? "unknown"),
      fetchImpl: opts.fetchImpl,
      waitUntil: opts.waitUntil,
      now: opts.now,
      onFail: (status) => out(JSON.stringify({ ev: "ai_metrics_push_failed", status })),
    });
  };
}

// -- money ------------------------------------------------------------------------------

const cents = (x: number) => Math.round(x * 100) / 100;

/**
 * What a credited purchase is worth, from the pricing config: the gross price,
 * the store's / Stripe's fee (estimated: fee_percent x gross + the fixed fee)
 * and the net. Zeros for an unknown pack (the event still counts).
 */
export function purchaseMoney(cfg: PricingConfig, channel: Channel, sku: string, creditedMicro: number) {
  const p = findPack(cfg, channel, sku);
  const ch = cfg.channels[channel];
  const gross = p?.price_usd ?? 0;
  const fee = p && ch ? cents(gross * ch.fee_percent + ch.fee_fixed_usd) : 0;
  return { credits: creditedMicro / MICRO, usd_gross: gross, usd_fee: fee, usd_net: cents(gross - fee) };
}

/** The USD a refund of `creditsMicro` gives back, estimated from the channel
 * markup (credits = price / (1 + markup) x credits_per_usd, inverted). */
export function refundUsdEstimate(cfg: PricingConfig, channel: string, creditsMicro: number): number {
  const ch = cfg.channels[channel as Channel];
  if (!ch) return 0;
  return cents((Math.abs(creditsMicro) / MICRO / cfg.credits_per_usd) * (1 + ch.markup));
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
    // Counts for the push (the transaction ids above stay in the Worker log).
    missing_count: missing.length,
    unknown_count: unknown.length,
    ...(missing.length || unknown.length ? { alert: true } : {}),
  };
}
