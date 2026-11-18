/**
 * Agent feedback in the app (docs/design/agent-feedback.md): what the chat
 * screens (effect editor, Acid Mode) call to record turns and to turn a
 * thumbs-down into a report — the app's context (versions, the connected
 * fixture, the app log), the outbox on this phone (localStorage), and sending
 * through the relay the app already uses for bug reports.
 */

import { aiSummary, appDiagnostics, APP_RELAY, coarseUserAgent, storedCreds } from "../bugs/appBugReport";
import { appBuildInfo } from "../buildInfo";
import type { LedMapperClient } from "../net/client";
import type { AppLogEntry } from "../store/appLog";
import { appLogMasks, appLogRecords } from "../store/appLogStore";
import {
  buildFeedbackReport,
  newFeedbackId,
  type FeedbackDevice,
  type FeedbackReason,
  type FeedbackReport,
  type FeedbackSectionId,
  type FeedbackSurface,
  type TurnHistory,
} from "./agentTrace";
import { fetchFeedbackStatus, submitFeedback } from "./feedbackClient";
import { FeedbackQueue, type KeyValue } from "./feedbackQueue";

/** What a chat screen hands the report sheet. */
export interface FeedbackScreenContext {
  surface: Extract<FeedbackSurface, "web-editor" | "web-acid">;
  history: TurnHistory;
  /** The visible conversation, oldest first. */
  conversation: () => { role: "user" | "assistant" | "tool"; text: string }[];
  client: () => LedMapperClient | null;
}

const memoryKv = (): KeyValue => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};

function storage(): KeyValue {
  try {
    if (globalThis.localStorage) return globalThis.localStorage;
  } catch {
    /* private mode */
  }
  return memoryKv();
}

let queue: FeedbackQueue | null = null;
export function feedbackQueue(): FeedbackQueue {
  return (queue ??= new FeedbackQueue(storage()));
}

/** The relay to send through, and the app's credential if it's paired. */
export function feedbackRelay(): { relay: string; headers: Record<string, string> } {
  const c = storedCreds();
  return { relay: c?.relay ?? APP_RELAY, headers: c ? { authorization: `Bearer ${c.token}` } : {} };
}

/** The fixture as a report may describe it (no name, MAC or address). */
export async function feedbackDevices(client: LedMapperClient | null): Promise<FeedbackDevice[]> {
  const d = await appDiagnostics({ source: () => "", client: () => client });
  const p = d["player"];
  if (!p || typeof p !== "object") return [];
  const o = p as { firmware?: { version?: string | null }; features?: string[]; board?: string | null; channels?: number | null; led_count?: number | null };
  return [
    {
      board: o.board ?? null,
      firmware: o.firmware?.version ?? null,
      features: o.features ?? [],
      channels: o.channels ?? null,
      led_count: o.led_count ?? null,
    },
  ];
}

async function recentAppLog(): Promise<AppLogEntry[]> {
  try {
    return (await appLogRecords()).flatMap((r) => r.entries);
  } catch {
    return [];
  }
}

/** Build the report for turn `turn` of a chat screen (what the preview shows). */
export async function buildAppFeedback(
  ctx: FeedbackScreenContext,
  opts: { turn: number; reasons: FeedbackReason[]; note: string; omit: readonly FeedbackSectionId[]; id?: string },
): Promise<FeedbackReport> {
  return buildFeedbackReport({
    id: opts.id ?? newFeedbackId(),
    surface: ctx.surface,
    reasons: opts.reasons,
    note: opts.note,
    turn: opts.turn,
    turns: ctx.history.upTo(opts.turn),
    conversation: ctx.conversation(),
    app: {
      version: appBuildInfo.version ?? "dev",
      commit: appBuildInfo.gitCommitShort || null,
      browser: coarseUserAgent(globalThis.navigator?.userAgent ?? ""),
    },
    ai: aiSummary(),
    devices: await feedbackDevices(ctx.client()),
    applog: await recentAppLog(),
    known: appLogMasks(),
    omit: opts.omit,
  });
}

export type SendOutcome =
  | { state: "sent"; id: string }
  | { state: "queued"; message: string }
  | { state: "rejected"; message: string }
  | { state: "no_room"; message: string };

/** Queue a consented report and try to send it now. */
export async function sendOrQueue(report: FeedbackReport): Promise<SendOutcome> {
  const q = feedbackQueue();
  if (!q.enqueue(report)) return { state: "no_room", message: "There's no room to keep this report on this device. Export it instead." };
  const { relay, headers } = feedbackRelay();
  await q.flush((r) => submitFeedback(relay, r, { headers }), relay);
  if (q.receipts().some((r) => r.id === report.id)) return { state: "sent", id: report.id };
  const left = q.outbox().find((x) => x.report.id === report.id);
  if (left?.rejected) return { state: "rejected", message: left.lastError ?? "the relay refused the report" };
  return {
    state: "queued",
    message:
      `Saved on this device; it will be sent when the connection is back${left?.lastError ? ` (${left.lastError})` : ""}. ` +
      "You can also export it from Settings ▸ Debugging.",
  };
}

let flusherInstalled = false;
/** Retry the outbox when the app starts and whenever the browser comes back online. */
export function installFeedbackFlusher(): void {
  if (flusherInstalled || typeof window === "undefined") return;
  flusherInstalled = true;
  const run = () => {
    const q = feedbackQueue();
    if (q.due().length === 0) return;
    const { relay, headers } = feedbackRelay();
    void q.flush((r) => submitFeedback(relay, r, { headers }), relay).catch(() => undefined);
  };
  window.addEventListener("online", run);
  setTimeout(run, 5000);
}

/** Refresh the status of reports this phone sent ("received" → "fixed in X"). */
export async function refreshFeedbackStatuses(): Promise<void> {
  await feedbackQueue().refresh((r) => fetchFeedbackStatus(r));
}
