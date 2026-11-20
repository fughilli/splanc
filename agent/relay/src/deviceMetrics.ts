/**
 * Device metrics intake (docs/design/device-metrics.md): what the app sends when
 * its user switched on "Send feedback to Fug Studio". Opt-in only; the app sends
 * nothing until then.
 *
 *   POST /metrics            an upload (web/src/metrics/metricsSchema.ts MetricsUpload)
 *                            → 202 {accepted, dropped}; 410 when this install asked for
 *                            deletion (the app rotates its pseudonym); 429 rate-limited
 *   POST /metrics/delete     {secret}: delete everything stored for this install
 *                            → 202 {status: "deleted" | "queued"}
 *   GET  /metrics/deletions  admin (FEEDBACK_ADMIN_TOKEN): deletion requests not yet
 *                            carried out in Grafana (no delete token configured)
 *   POST /metrics/deletions  admin {install}: mark one carried out
 *
 * Nothing is stored here: an upload becomes allowlisted lines in Grafana Cloud
 * Logs through ops.ts (component device-metrics), the same no-PII path as the
 * business events. The install is a random pseudonym (sha256 of a secret only
 * the app holds), rotated by the app every 30 days and after a deletion; it is
 * never linked to a credits account, a bridge or an IP. The IP is used only to
 * rate-limit (a counter for the current hour, then gone) and is never pushed.
 *
 * Deletion: with GRAFANA_LOKI_DELETE_TOKEN (an access-policy token with
 * logs:delete) the relay files a Loki delete request for the install's lines
 * right away; without it the request is queued for the owner (sync CLI). Either
 * way a tombstone refuses later uploads from that pseudonym for the retention
 * period, so a stale app can't refill what was deleted.
 *
 * Off (503 not_configured) unless the Grafana push is configured, or when
 * DEVICE_METRICS is "off" (the kill switch).
 */

import { installFromSecret, SECRET_RE, PSEUDONYM_RE, validateMetricsUpload, type MetricsUpload } from "../../../web/src/metrics/metricsSchema";
import { safeEqual } from "./crypto";
import { dir } from "./oauth";
import { grafanaConfigured, opsPush } from "./ops";
import { now, type Env } from "./platform";

/** Grafana Cloud Logs keeps device metrics at most this long (and the tombstones live as long). */
export const METRICS_RETENTION_DAYS = 90;

export interface MetricsEnv {
  DEVICE_METRICS?: string | undefined;
  /** Worker SECRET (optional): access-policy token with logs:delete on the stack. */
  GRAFANA_LOKI_DELETE_TOKEN?: string | undefined;
}

type Json = (obj: unknown, status?: number, headers?: Record<string, string>) => Response;
export interface MetricsCtx {
  json: Json;
  clientIp: string;
  waitUntil?: ((p: Promise<unknown>) => void) | undefined;
  /** Tests: a fake fetch for the Grafana push and delete calls. */
  opsFetch?: typeof fetch | undefined;
}

const enabled = (env: Env & MetricsEnv) => grafanaConfigured(env) && env.DEVICE_METRICS !== "off";

function ops(env: Env, ctx: MetricsCtx, events: Record<string, unknown>[]): void {
  void opsPush(env, events, { waitUntil: ctx.waitUntil, fetchImpl: ctx.opsFetch, now: () => now(env) });
}

/** The Loki lines for one accepted upload: one per player sample, one usage line, one summary. */
export function metricsEvents(u: MetricsUpload): Record<string, unknown>[] {
  const base = { install: u.install, app: u.app, platform: u.platform };
  const out: Record<string, unknown>[] = [
    { ev: "dm_upload", ...base, devices: u.devices.length, categories: [...u.categories].sort().join(",") },
  ];
  for (const d of u.devices) out.push({ ev: "dm_device", ...base, ...d });
  if (u.usage && Object.keys(u.usage).length) out.push({ ev: "dm_usage", ...base, ...u.usage });
  return out;
}

function isAdmin(req: Request, env: Env): boolean {
  const h = req.headers.get("authorization") ?? "";
  return !!env.FEEDBACK_ADMIN_TOKEN && h.startsWith("Bearer ") && safeEqual(h.slice(7), env.FEEDBACK_ADMIN_TOKEN);
}

export async function metricsEndpoint(req: Request, env: Env & MetricsEnv, ctx: MetricsCtx, path: string): Promise<Response> {
  if (!enabled(env)) return ctx.json({ error: "not_configured", message: "Device metrics aren't being collected right now. Nothing was sent." }, 503);
  if (path === "/metrics") {
    if (req.method !== "POST") return ctx.json({ error: "method_not_allowed" }, 405, { allow: "POST" });
    return ingest(req, env, ctx);
  }
  if (path === "/metrics/delete") {
    if (req.method !== "POST") return ctx.json({ error: "method_not_allowed" }, 405, { allow: "POST" });
    return requestDeletion(req, env, ctx);
  }
  // /metrics/deletions (admin)
  if (!isAdmin(req, env)) return ctx.json({ error: "unauthorized", message: "the admin token is required" }, 401);
  if (req.method === "GET") return ctx.json({ items: (await dir<{ items: unknown[] }>(env, "/dm/queue", {})).body.items });
  if (req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const install = typeof b["install"] === "string" && PSEUDONYM_RE.test(b["install"]) ? b["install"] : null;
    if (!install) return ctx.json({ error: "invalid_request", message: "{install}" }, 400);
    const r = await dir(env, "/dm/done", { install });
    return r.status === 404 ? ctx.json({ error: "not_found" }, 404) : ctx.json({ ok: true, install });
  }
  return ctx.json({ error: "method_not_allowed" }, 405, { allow: "GET, POST" });
}

async function readCapped(req: Request, cap: number): Promise<string | null> {
  if (Number(req.headers.get("content-length") ?? 0) > cap) return null;
  const t = await req.text();
  return new TextEncoder().encode(t).length > cap ? null : t;
}

async function ingest(req: Request, env: Env & MetricsEnv, ctx: MetricsCtx): Promise<Response> {
  const text = await readCapped(req, 24 * 1024 + 1024);
  if (text === null) {
    ops(env, ctx, [{ ev: "dm_rejected", status: 413 }]);
    return ctx.json({ error: "too_large" }, 413);
  }
  const v = validateMetricsUpload(text);
  if (!v.ok) {
    ops(env, ctx, [{ ev: "dm_rejected", status: v.status }]);
    return ctx.json({ error: "invalid_request", message: v.message }, v.status);
  }
  const u = v.upload;
  if ((await dir<{ dead: boolean }>(env, "/dm/tomb", { install: u.install })).body.dead) {
    ops(env, ctx, [{ ev: "dm_rejected", status: 410 }]);
    return ctx.json({ error: "deleted", message: "This install asked for its data to be deleted; start a new pseudonym." }, 410);
  }
  // Per install (a few uploads a day are plenty), per IP (many installs behind one
  // NAT), and everyone together. The IP key lives only for its one-hour window.
  for (const [name, key, global] of [
    ["metricsInstall", u.install, undefined],
    ["metricsIp", ctx.clientIp, "metricsGlobal"],
  ] as const) {
    const lim = await dir(env, "/limit", { name, key, ...(global ? { global } : {}) });
    if (lim.status === 429) {
      ops(env, ctx, [{ ev: "dm_rate_limited", by: name === "metricsInstall" ? "install" : "ip" }]);
      return ctx.json({ error: "rate_limited", message: "Too many uploads for now; the app tries again later." }, 429, { "retry-after": "3600" });
    }
  }
  ops(env, ctx, metricsEvents(u));
  return ctx.json({ accepted: u.devices.length, dropped: v.dropped }, 202);
}

/** The Loki delete API for the install's lines (Grafana Cloud: logs:delete). */
export function lokiDeleteUrl(pushUrl: string, install: string, nowMs: number): string {
  const base = pushUrl.replace(/\/loki\/api\/v1\/push\/?$/, "");
  const query = `{service="splanc-relay", component="device-metrics"} |= "\\"install\\":\\"${install}\\""`;
  const start = Math.floor(nowMs / 1000) - (METRICS_RETENTION_DAYS + 10) * 86400;
  return `${base}/loki/api/v1/delete?query=${encodeURIComponent(query)}&start=${start}&end=${Math.floor(nowMs / 1000) + 3600}`;
}

async function requestDeletion(req: Request, env: Env & MetricsEnv, ctx: MetricsCtx): Promise<Response> {
  const text = await readCapped(req, 1024);
  const b = text ? ((() => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; } })()) : {};
  const secret = typeof b["secret"] === "string" && SECRET_RE.test(b["secret"]) ? b["secret"] : null;
  if (!secret) return ctx.json({ error: "invalid_request", message: "{secret}" }, 400);
  const lim = await dir(env, "/limit", { name: "metricsDeleteIp", key: ctx.clientIp });
  if (lim.status === 429) return ctx.json({ error: "rate_limited", message: "Too many requests; try again in an hour." }, 429, { "retry-after": "3600" });
  const install = await installFromSecret(secret);
  let status: "deleted" | "queued" = "queued";
  if (env.GRAFANA_LOKI_DELETE_TOKEN && env.GRAFANA_LOKI_PUSH_URL && env.GRAFANA_LOKI_USER) {
    try {
      const r = await (ctx.opsFetch ?? fetch)(lokiDeleteUrl(env.GRAFANA_LOKI_PUSH_URL, install, now(env)), {
        method: "POST",
        headers: { authorization: `Basic ${btoa(`${env.GRAFANA_LOKI_USER}:${env.GRAFANA_LOKI_DELETE_TOKEN}`)}` },
      });
      if (r.ok) status = "deleted";
    } catch {
      /* queued below */
    }
  }
  const exp = Math.floor(now(env) / 1000) + METRICS_RETENTION_DAYS * 86400;
  await dir(env, "/dm/delete", { install, exp, queued: status === "queued", at: new Date(now(env)).toISOString() });
  ops(env, ctx, [{ ev: "dm_delete_requested", outcome: status }]);
  return ctx.json(
    {
      status,
      message:
        status === "deleted"
          ? "Deletion requested. Grafana removes the data within a few days; nothing more is accepted from this install."
          : "Deletion requested. It's carried out within 7 days; nothing more is accepted from this install.",
    },
    202,
  );
}
