/**
 * Agent-feedback intake (docs/design/agent-feedback.md): a PRIVATE store for the
 * reports users send when the AI agent misbehaves. Unlike POST /bugs nothing
 * here becomes a public GitHub issue — a report carries the user's own words and
 * effect code. Reports live in the Directory Durable Object (`fb:<id>` = the
 * record, `fbi:<id>` = its summary for listing), expire after
 * FEEDBACK_RETENTION_DAYS (90), and are read only with the owner's
 * FEEDBACK_ADMIN_TOKEN (the triage CLI, `splanc-agent feedback`).
 *
 *   POST   /feedback                 a report (any caller; per-bridge / per-IP / global limits)
 *                                     → 201 {id, receipt, status}; the same report again → 200, same receipt
 *   GET    /feedback/status?id=      x-splanc-receipt: the reporter's status {status, fixed_in, message}
 *   DELETE /feedback?id=             x-splanc-receipt (the reporter) or the admin token: erase it
 *   GET    /feedback                 admin: summaries (?signature= ?status= filter)
 *   GET    /feedback?id=             admin: the whole record
 *   POST   /feedback/status          admin: {id, status, fixed_in?, message?}
 *
 * Without FEEDBACK_ADMIN_TOKEN the intake answers 503 not_configured (nobody
 * could read what it stored), and the app keeps reports queued / exportable.
 */

import { validateFeedbackReport, type FeedbackReport } from "../../../web/src/feedback/agentTrace";
import { caller, type BugsContext } from "./bugs";
import { safeEqual, sha256b64url } from "./crypto";
import { dir } from "./oauth";
import { now, type Env } from "./platform";
import { opsPush } from "./ops";

export const RECEIPT_HEADER = "x-splanc-receipt";
export const FEEDBACK_STATUSES = ["received", "reproduced", "not_reproduced", "fixed", "wontfix"] as const;
export type StoredStatus = (typeof FEEDBACK_STATUSES)[number];
/** The request cap (bytes): the report cap + JSON slack. */
export const FEEDBACK_REQUEST_BYTES = 112 * 1024;
const DEFAULT_RETENTION_DAYS = 90;

export const NOT_CONFIGURED_MESSAGE =
  "Agent feedback isn't configured on this relay (no FEEDBACK_ADMIN_TOKEN secret). The report stays on the device; export it instead.";

/** What the listing shows (no user content beyond the reasons + signal). */
export interface FeedbackSummary {
  id: string;
  createdAt: string;
  surface: string;
  reasons: string[];
  signature: string;
  signal: FeedbackReport["signal"];
  flags: string[];
  app: string;
  ai: string;
  status: StoredStatus;
  fixedIn?: string;
  sections: string[];
  bytes: number;
  /** Who sent it: "bridge" (a paired app / bridge) or "anonymous". */
  via: string;
  /** A hash of the bridge id / client IP, for abuse handling (never the IP). */
  from: string;
  exp: number;
}

export interface FeedbackRecord {
  report: FeedbackReport;
  bodyHash: string;
  status: StoredStatus;
  fixedIn?: string;
  message?: string;
  updatedAt: string;
  exp: number;
}

type Ctx = BugsContext & {
  /** Keeps the ops push alive after the response (ctx.waitUntil in the Worker). */
  waitUntil?: ((p: Promise<unknown>) => void) | undefined;
  /** Tests: a fake fetch for the Grafana Cloud Logs push. */
  opsFetch?: typeof fetch | undefined;
};

/**
 * Ops metrics (docs/design/ops-grafana.md): counts and labels only. ops.ts
 * keeps just the allowlisted fields: never the note, conversation, trace,
 * source, device list, error text, report id, receipt, or who sent it.
 */
function ops(env: Env, ctx: Ctx, events: Record<string, unknown>[]): void {
  void opsPush(env, events, { waitUntil: ctx.waitUntil, fetchImpl: ctx.opsFetch, now: () => now(env) });
}

/** The ops fields that describe a report (all from its no-content summary). */
function reportLabels(s: Pick<FeedbackSummary, "signature" | "signal" | "app">) {
  return { signature: s.signature, tool: s.signal?.tool, app: s.app, firmware: s.signal?.firmware };
}

function isAdmin(req: Request, env: Env): boolean {
  const h = req.headers.get("authorization") ?? "";
  return !!env.FEEDBACK_ADMIN_TOKEN && h.startsWith("Bearer ") && safeEqual(h.slice(7), env.FEEDBACK_ADMIN_TOKEN);
}

const receiptMsg = (id: string) => `splanc-feedback-receipt\n${id}`;

async function receiptFor(env: Env, id: string): Promise<string> {
  const r = await dir<{ sig: string }>(env, "/hmac/sign", { msg: receiptMsg(id) });
  return r.body.sig;
}

async function receiptOk(env: Env, id: string, receipt: string | null): Promise<boolean> {
  if (!receipt) return false;
  const r = await dir<{ ok: boolean }>(env, "/hmac/verify", { msg: receiptMsg(id), sig: receipt });
  return r.body.ok === true;
}

const ID_RE = /^[A-Za-z0-9_-]{8,40}$/;

/** /feedback and /feedback/status. */
export async function feedbackEndpoint(req: Request, env: Env, ctx: Ctx, path: string): Promise<Response> {
  if (!env.FEEDBACK_ADMIN_TOKEN) return ctx.json({ error: "not_configured", message: NOT_CONFIGURED_MESSAGE }, 503);
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (id !== null && !ID_RE.test(id)) return ctx.json({ error: "invalid_request", message: "bad id" }, 400);
  if (path === "/feedback/status") {
    if (req.method === "GET") return reporterStatus(req, env, ctx, id);
    if (req.method === "POST") return setStatus(req, env, ctx);
    return ctx.json({ error: "method_not_allowed" }, 405, { allow: "GET, POST" });
  }
  switch (req.method) {
    case "POST":
      return submit(req, env, ctx);
    case "GET":
      if (!isAdmin(req, env)) return ctx.json({ error: "unauthorized", message: "the admin token is required" }, 401);
      return id ? getOne(env, ctx, id) : list(env, ctx, url);
    case "DELETE":
      return erase(req, env, ctx, id);
    default:
      return ctx.json({ error: "method_not_allowed" }, 405, { allow: "GET, POST, DELETE" });
  }
}

async function submit(req: Request, env: Env, ctx: Ctx): Promise<Response> {
  if (Number(req.headers.get("content-length") ?? 0) > FEEDBACK_REQUEST_BYTES) {
    return ctx.json({ error: "too_large", message: `the request is larger than ${FEEDBACK_REQUEST_BYTES} bytes` }, 413);
  }
  const text = await req.text();
  if (new TextEncoder().encode(text).length > FEEDBACK_REQUEST_BYTES) {
    return ctx.json({ error: "too_large", message: `the request is larger than ${FEEDBACK_REQUEST_BYTES} bytes` }, 413);
  }
  const bodyHash = await sha256b64url(text);
  const who = await caller(req, ctx, bodyHash);
  if (who instanceof Response) return who;
  const v = validateFeedbackReport(text);
  if (!v.ok) {
    ops(env, ctx, [{ ev: "fb_rejected", status: v.status }]);
    return ctx.json({ error: "invalid_request", message: v.message }, v.status);
  }
  const report = v.report;
  // A retry of the same report: same receipt, nothing counted twice.
  const existing = (await dir<{ rec: FeedbackRecord | null }>(env, "/fb/get", { id: report.id })).body.rec;
  if (existing) {
    if (existing.bodyHash !== bodyHash) return ctx.json({ error: "conflict", message: "a different report already has this id" }, 409);
    ops(env, ctx, [{ ev: "fb_duplicate" }]);
    return ctx.json({ id: report.id, receipt: await receiptFor(env, report.id), status: existing.status }, 200);
  }
  const lim =
    who.kind === "bridge"
      ? await dir(env, "/limit", { name: "feedbackBridge", key: who.bridge, global: "feedbackGlobal" })
      : await dir(env, "/limit", { name: "feedbackIp", key: who.ip, global: "feedbackGlobal" });
  if (lim.status === 429) {
    ops(env, ctx, [{ ev: "fb_rate_limited", via: who.kind }]);
    return ctx.json({ error: "rate_limited", message: "Too many reports from here for now; it stays queued on the device." }, 429, { "retry-after": "3600" });
  }
  const days = Number(env.FEEDBACK_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS) || DEFAULT_RETENTION_DAYS;
  const exp = Math.floor(now(env) / 1000) + days * 86400;
  const nowIso = new Date(now(env)).toISOString();
  const rec: FeedbackRecord = { report, bodyHash, status: "received", updatedAt: nowIso, exp };
  const summary: FeedbackSummary = {
    id: report.id,
    createdAt: nowIso,
    surface: report.surface,
    reasons: report.reasons,
    signature: report.signature,
    signal: report.signal,
    flags: Array.isArray(report.flags) ? report.flags.map(String) : [],
    app: report.app.version,
    ai: [report.ai?.["kind"], report.ai?.["vendor"], report.ai?.["model"]].filter(Boolean).join("/"),
    status: "received",
    sections: Object.keys(report.sections ?? {}),
    bytes: text.length,
    via: who.kind,
    from: (await sha256b64url(`feedback-from\n${who.kind === "bridge" ? who.bridge : who.ip}`)).slice(0, 12),
    exp,
  };
  await dir(env, "/fb/put", { id: report.id, rec, summary });
  ops(env, ctx, [
    {
      ev: "fb_received",
      ...reportLabels(summary),
      surface: summary.surface,
      reasons: [...summary.reasons].sort().join(","),
      reason_count: summary.reasons.length,
      ai: summary.ai,
      via: summary.via,
      sections: summary.sections.length,
      bytes: summary.bytes,
    },
    ...summary.reasons.map((reason) => ({ ev: "fb_reason", reason, surface: summary.surface, app: summary.app })),
  ]);
  return ctx.json({ id: report.id, receipt: await receiptFor(env, report.id), status: "received" }, 201);
}

async function reporterStatus(req: Request, env: Env, ctx: Ctx, id: string | null): Promise<Response> {
  if (!id) return ctx.json({ error: "invalid_request", message: "id is required" }, 400);
  const admin = isAdmin(req, env);
  if (!admin && !(await receiptOk(env, id, req.headers.get(RECEIPT_HEADER)))) return ctx.json({ error: "unauthorized" }, 401);
  const rec = (await dir<{ rec: FeedbackRecord | null }>(env, "/fb/get", { id })).body.rec;
  if (!rec) return ctx.json({ error: "not_found" }, 404);
  return ctx.json({ id, status: rec.status, ...(rec.fixedIn ? { fixed_in: rec.fixedIn } : {}), ...(rec.message ? { message: rec.message } : {}), updated: rec.updatedAt });
}

async function setStatus(req: Request, env: Env, ctx: Ctx): Promise<Response> {
  if (!isAdmin(req, env)) return ctx.json({ error: "unauthorized", message: "the admin token is required" }, 401);
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const id = typeof b["id"] === "string" && ID_RE.test(b["id"]) ? b["id"] : null;
  const status = FEEDBACK_STATUSES.includes(b["status"] as StoredStatus) ? (b["status"] as StoredStatus) : null;
  if (!id || !status) return ctx.json({ error: "invalid_request", message: `{id, status: ${FEEDBACK_STATUSES.join("|")}}` }, 400);
  const patch: Partial<FeedbackRecord> = {
    status,
    updatedAt: new Date(now(env)).toISOString(),
    ...(typeof b["fixed_in"] === "string" ? { fixedIn: String(b["fixed_in"]).slice(0, 40) } : {}),
    ...(typeof b["message"] === "string" ? { message: String(b["message"]).slice(0, 500) } : {}),
  };
  const r = await dir<{ ok: boolean; before?: FeedbackSummary }>(env, "/fb/patch", { id, patch });
  if (r.status === 404) return ctx.json({ error: "not_found" }, 404);
  // The summary as it was (no content) gives the ops event its age and labels.
  const before = r.body.before;
  if (before && before.status !== status) {
    const ageH = (now(env) - Date.parse(before.createdAt)) / 3_600_000;
    ops(env, ctx, [{ ev: "fb_status", status, prev: before.status, age_h: Math.round(ageH * 100) / 100, ...reportLabels(before) }]);
  }
  return ctx.json({ ok: true, id, status });
}

async function getOne(env: Env, ctx: Ctx, id: string): Promise<Response> {
  const rec = (await dir<{ rec: FeedbackRecord | null }>(env, "/fb/get", { id })).body.rec;
  return rec ? ctx.json(rec) : ctx.json({ error: "not_found" }, 404);
}

async function list(env: Env, ctx: Ctx, url: URL): Promise<Response> {
  const all = (await dir<{ items: FeedbackSummary[] }>(env, "/fb/list", {})).body.items;
  const sig = url.searchParams.get("signature");
  const st = url.searchParams.get("status");
  const items = all.filter((s) => (!sig || s.signature === sig) && (!st || s.status === st));
  return ctx.json({ items, total: all.length });
}

async function erase(req: Request, env: Env, ctx: Ctx, id: string | null): Promise<Response> {
  if (!id) return ctx.json({ error: "invalid_request", message: "id is required" }, 400);
  const admin = isAdmin(req, env);
  if (!admin && !(await receiptOk(env, id, req.headers.get(RECEIPT_HEADER)))) return ctx.json({ error: "unauthorized" }, 401);
  const r = await dir<{ ok: boolean }>(env, "/fb/delete", { id });
  if (r.status === 404) return ctx.json({ error: "not_found" }, 404);
  ops(env, ctx, [{ ev: "fb_deleted", by: admin ? "admin" : "reporter" }]);
  return ctx.json({ ok: true, deleted: id });
}
