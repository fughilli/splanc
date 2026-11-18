/**
 * The relay's agent-feedback intake, client side (docs/design/agent-feedback.md):
 *
 *   POST   <relay>/feedback                 a report → 201 {id, receipt, status}
 *   GET    <relay>/feedback/status?id=…     x-splanc-receipt → {status, fixed_in?, message?}
 *   DELETE <relay>/feedback?id=…            x-splanc-receipt → the report is erased
 *
 * Pure (fetch injected). Never throws: every failure is a SubmitResult reason.
 */

import type { FeedbackReport } from "./agentTrace";
import type { FeedbackReceipt, FeedbackStatus, SubmitResult } from "./feedbackQueue";

export const RECEIPT_HEADER = "x-splanc-receipt";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const base = (relay: string) => relay.replace(/\/+$/, "");
const STATUSES = new Set<string>(["received", "reproduced", "not_reproduced", "fixed", "wontfix", "deleted"]);

export async function submitFeedback(
  relay: string,
  report: FeedbackReport,
  opts: { fetch?: FetchFn; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<SubmitResult> {
  const f = opts.fetch ?? ((i: string, init?: RequestInit) => fetch(i, init));
  let res: Response;
  try {
    res = await f(`${base(relay)}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
  } catch (e) {
    return { ok: false, reason: "unavailable", message: `couldn't reach the relay: ${e instanceof Error ? e.message : String(e)}` };
  }
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const message = typeof j["message"] === "string" ? (j["message"] as string) : `relay answered ${res.status}`;
  if ((res.status === 201 || res.status === 200) && typeof j["id"] === "string" && typeof j["receipt"] === "string") {
    const status = STATUSES.has(String(j["status"])) ? (j["status"] as FeedbackStatus) : "received";
    return { ok: true, id: j["id"] as string, receipt: j["receipt"] as string, status };
  }
  if (j["error"] === "not_configured" || res.status === 503) return { ok: false, reason: "not_configured", message };
  if (res.status === 429) {
    const ra = Number(res.headers.get("retry-after") ?? "");
    return { ok: false, reason: "rate_limited", message, ...(Number.isFinite(ra) && ra > 0 ? { retryAfterS: ra } : {}) };
  }
  if (res.status === 400 || res.status === 401 || res.status === 413) return { ok: false, reason: "rejected", message };
  return { ok: false, reason: "unavailable", message };
}

export async function fetchFeedbackStatus(
  r: Pick<FeedbackReceipt, "relay" | "id" | "receipt">,
  opts: { fetch?: FetchFn } = {},
): Promise<{ status: FeedbackStatus; fixedIn?: string; message?: string } | null> {
  const f = opts.fetch ?? ((i: string, init?: RequestInit) => fetch(i, init));
  try {
    const res = await f(`${base(r.relay)}/feedback/status?id=${encodeURIComponent(r.id)}`, {
      headers: { [RECEIPT_HEADER]: r.receipt },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return { status: "deleted" };
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, unknown>;
    if (!STATUSES.has(String(j["status"]))) return null;
    return {
      status: j["status"] as FeedbackStatus,
      ...(typeof j["fixed_in"] === "string" ? { fixedIn: j["fixed_in"] as string } : {}),
      ...(typeof j["message"] === "string" ? { message: j["message"] as string } : {}),
    };
  } catch {
    return null;
  }
}

/** Erase a sent report on the relay (the reporter's right to delete). */
export async function deleteFeedback(r: Pick<FeedbackReceipt, "relay" | "id" | "receipt">, opts: { fetch?: FetchFn } = {}): Promise<boolean> {
  const f = opts.fetch ?? ((i: string, init?: RequestInit) => fetch(i, init));
  try {
    const res = await f(`${base(r.relay)}/feedback?id=${encodeURIComponent(r.id)}`, {
      method: "DELETE",
      headers: { [RECEIPT_HEADER]: r.receipt },
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

/** The report as a file to share or save (when it can't be sent). */
export function feedbackFile(report: FeedbackReport): { name: string; mime: string; text: string } {
  return { name: `splanc-agent-feedback-${report.id}.json.txt`, mime: "text/plain", text: JSON.stringify(report, null, 2) };
}
