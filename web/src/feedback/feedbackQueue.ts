/**
 * Agent-feedback outbox + receipts (docs/design/agent-feedback.md). Pure: the
 * storage and the network are injected, so it runs the same in the app
 * (localStorage + fetch) and in the tests.
 *
 * A report the user consented to send goes into the outbox first, then
 * {@link FeedbackQueue.flush} sends whatever is due. Offline / relay down /
 * intake not configured: it stays queued and is retried with backoff, and the
 * user can export it instead. Once the relay accepts it, the report body is
 * DROPPED from the phone and only a small receipt is kept (id + the receipt
 * token that lets this phone ask for its status or delete it).
 */

import { FEEDBACK_LIMITS, type FeedbackReason, type FeedbackReport } from "./agentTrace";

/** What the relay says about a report (GET /feedback/status). */
export type FeedbackStatus = "received" | "reproduced" | "not_reproduced" | "fixed" | "wontfix" | "deleted";

export interface QueuedReport {
  report: FeedbackReport;
  queuedAt: string;
  attempts: number;
  /** Epoch ms of the next attempt. */
  nextAt: number;
  lastError?: string;
  /** Rejected by the relay (won't be retried; export or discard it). */
  rejected?: boolean;
}

export interface FeedbackReceipt {
  id: string;
  receipt: string;
  relay: string;
  sentAt: string;
  reasons: FeedbackReason[];
  surface: string;
  status: FeedbackStatus;
  fixedIn?: string;
  /** A note from triage, shown to the reporter. */
  message?: string;
  checkedAt?: string;
}

/** The outcome of one submit (feedbackClient.submitFeedback). */
export type SubmitResult =
  | { ok: true; id: string; receipt: string; status: FeedbackStatus }
  | { ok: false; reason: "not_configured" | "rate_limited" | "unavailable" | "rejected"; message: string; retryAfterS?: number };

export interface KeyValue {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

const OUTBOX_KEY = "splanc.feedback.outbox.v1";
const RECEIPTS_KEY = "splanc.feedback.receipts.v1";
/** At most this many waiting reports, and this much JSON, on the phone. */
export const QUEUE_LIMITS = { reports: 10, bytes: 1024 * 1024, receipts: 50 } as const;
/** Retry backoff: 1 min doubling to 6 h. */
const BACKOFF_MS = { first: 60_000, max: 6 * 3600_000 } as const;

export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_MS.max, BACKOFF_MS.first * 2 ** Math.max(0, attempts - 1));
}

export class FeedbackQueue {
  constructor(
    private readonly kv: KeyValue,
    private readonly now: () => number = Date.now,
  ) {}

  private read<T>(key: string): T[] {
    try {
      const raw = this.kv.getItem(key);
      const v = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(v) ? (v as T[]) : [];
    } catch {
      return [];
    }
  }

  private write(key: string, v: unknown[]): boolean {
    try {
      this.kv.setItem(key, JSON.stringify(v));
      return true;
    } catch {
      return false; // quota: the caller says so
    }
  }

  outbox(): QueuedReport[] {
    return this.read<QueuedReport>(OUTBOX_KEY);
  }

  receipts(): FeedbackReceipt[] {
    return this.read<FeedbackReceipt>(RECEIPTS_KEY);
  }

  /**
   * Queue a consented report. The oldest waiting reports go first when the
   * outbox is over its limits. Returns false when even this one doesn't fit
   * (too big, or storage refused it): export it instead.
   */
  enqueue(report: FeedbackReport): boolean {
    if (JSON.stringify(report).length > FEEDBACK_LIMITS.report + 4096) return false;
    const box = this.outbox().filter((q) => q.report.id !== report.id);
    box.push({ report, queuedAt: new Date(this.now()).toISOString(), attempts: 0, nextAt: this.now() });
    while (box.length > QUEUE_LIMITS.reports || (box.length > 1 && JSON.stringify(box).length > QUEUE_LIMITS.bytes)) box.shift();
    return this.write(OUTBOX_KEY, box);
  }

  /** Remove a waiting report (the user discarded it, or exported it). */
  discard(id: string): void {
    this.write(OUTBOX_KEY, this.outbox().filter((q) => q.report.id !== id));
  }

  /** Make every waiting (not rejected) report due now ("Send now"). */
  retryNow(): void {
    const box = this.outbox();
    for (const q of box) if (!q.rejected) q.nextAt = 0;
    this.write(OUTBOX_KEY, box);
  }

  /** Waiting reports whose next attempt is due. */
  due(): QueuedReport[] {
    const t = this.now();
    return this.outbox().filter((q) => !q.rejected && q.nextAt <= t);
  }

  /**
   * Send every due report with `submit`. Accepted: the body is dropped, a
   * receipt kept. Rejected: kept, marked, not retried. Anything else: retried
   * later with backoff (rate limits honour retry-after).
   */
  async flush(submit: (r: FeedbackReport) => Promise<SubmitResult>, relay: string): Promise<{ sent: string[]; waiting: number; rejected: number }> {
    const sent: string[] = [];
    for (const q of this.due()) {
      let r: SubmitResult;
      try {
        r = await submit(q.report);
      } catch (e) {
        r = { ok: false, reason: "unavailable", message: e instanceof Error ? e.message : String(e) };
      }
      const box = this.outbox();
      const i = box.findIndex((x) => x.report.id === q.report.id);
      if (r.ok) {
        if (i >= 0) box.splice(i, 1);
        this.write(OUTBOX_KEY, box);
        this.addReceipt({
          id: r.id,
          receipt: r.receipt,
          relay,
          sentAt: new Date(this.now()).toISOString(),
          reasons: q.report.reasons,
          surface: q.report.surface,
          status: r.status,
        });
        sent.push(r.id);
        continue;
      }
      if (i < 0) continue;
      const e = box[i]!;
      e.attempts += 1;
      e.lastError = r.message;
      if (r.reason === "rejected") e.rejected = true;
      else e.nextAt = this.now() + Math.max(backoffMs(e.attempts), (r.retryAfterS ?? 0) * 1000);
      this.write(OUTBOX_KEY, box);
      // One outage answers for all: stop and retry the rest later.
      if (r.reason === "unavailable" || r.reason === "not_configured") {
        for (const other of box) {
          if (other !== e && !other.rejected && other.nextAt <= this.now()) other.nextAt = e.nextAt;
        }
        this.write(OUTBOX_KEY, box);
        break;
      }
    }
    const box = this.outbox();
    return { sent, waiting: box.filter((q) => !q.rejected).length, rejected: box.filter((q) => q.rejected).length };
  }

  private addReceipt(r: FeedbackReceipt): void {
    const all = this.receipts().filter((x) => x.id !== r.id);
    all.push(r);
    while (all.length > QUEUE_LIMITS.receipts) all.shift();
    this.write(RECEIPTS_KEY, all);
  }

  /** Update receipts from the relay's status answers. */
  async refresh(
    fetchStatus: (r: FeedbackReceipt) => Promise<{ status: FeedbackStatus; fixedIn?: string; message?: string } | null>,
  ): Promise<FeedbackReceipt[]> {
    const all = this.receipts();
    for (const r of all) {
      if (r.status === "deleted") continue;
      try {
        const s = await fetchStatus(r);
        if (!s) continue;
        r.status = s.status;
        if (s.fixedIn) r.fixedIn = s.fixedIn;
        if (s.message) r.message = s.message;
        r.checkedAt = new Date(this.now()).toISOString();
      } catch {
        /* try again next time */
      }
    }
    this.write(RECEIPTS_KEY, all);
    return all;
  }

  /** Forget a receipt (after deleting the report on the relay). */
  forget(id: string): void {
    this.write(RECEIPTS_KEY, this.receipts().filter((r) => r.id !== id));
  }
}

/** What the reporter sees for a receipt. */
export function receiptStatusText(r: Pick<FeedbackReceipt, "status" | "fixedIn">): string {
  switch (r.status) {
    case "received":
      return "Received";
    case "reproduced":
      return "Reproduced: we can see the problem";
    case "not_reproduced":
      return "Looked at: we couldn't reproduce it yet";
    case "fixed":
      return r.fixedIn ? `Fixed in version ${r.fixedIn}` : "Fixed";
    case "wontfix":
      return "Closed";
    case "deleted":
      return "Deleted";
  }
}
