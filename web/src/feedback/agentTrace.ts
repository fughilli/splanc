/**
 * Agent feedback: the "agent trace" a user sends when the in-app AI (the effect
 * editor's chat, Acid Mode) or the MCP agent did something wrong
 * (docs/design/agent-feedback.md). Pure: no DOM, no storage, no network — the
 * app, the agent and the relay all import it.
 *
 * - {@link TurnRecorder} watches one chat turn through the existing ChatHooks
 *   seams (onPrompt / onTrace) and records every round, tool call + result,
 *   timings, and what the turn claimed vs what the tools reported.
 * - {@link buildFeedbackReport} turns the recorded turns plus the user's reason
 *   and note into a report: redacted (the app log's masks, then the bug
 *   reporter's scrubber), bounded ({@link FEEDBACK_LIMITS}), split into
 *   sections the user can leave out, and signed with a grouping
 *   {@link feedbackSignature}.
 * - {@link validateFeedbackReport} is what the relay runs on intake.
 */

import { scrubText, scrubValue } from "../bugs/bugReport";
import { fnv1a, maskText, type AppLogEntry } from "../store/appLog";

export const TRACE_SCHEMA = "splanc-agent-feedback/1";

/** The reason chips. */
export const FEEDBACK_REASONS = [
  { id: "false_claim", label: "Claimed it did something it didn't" },
  { id: "wrong_effect", label: "Wrong effect" },
  { id: "not_sent", label: "Didn't send to my fixture" },
  { id: "stuck", label: "Stuck / error" },
  { id: "other", label: "Other" },
] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number]["id"];
const REASON_IDS = new Set<string>(FEEDBACK_REASONS.map((r) => r.id));

/** Where the report came from. */
export type FeedbackSurface = "web-editor" | "web-acid" | "mcp" | "bridge";
const SURFACES = new Set<string>(["web-editor", "web-acid", "mcp", "bridge"]);

/** The sections a user can leave out (everything else is always sent). */
export const FEEDBACK_SECTIONS = [
  { id: "conversation", label: "Your messages and the AI's replies" },
  { id: "trace", label: "What the AI did (tool calls, results, timings)" },
  { id: "source", label: "Effect code before and after" },
  { id: "device", label: "Fixture board, firmware and features" },
  { id: "applog", label: "Recent app events (errors, connection changes)" },
] as const;
export type FeedbackSectionId = (typeof FEEDBACK_SECTIONS)[number]["id"];

/** Sections the report sheet starts with switched OFF (owner decision, #539):
 * they hold the user's own words and code, so the user opts in to each. */
export const DEFAULT_OMITTED: readonly FeedbackSectionId[] = ["conversation", "source"];

/** The note shown next to the default-off sections' switches. */
export const OPT_IN_HINT = "Including your conversation and the effect code helps us reproduce the problem.";

/** Size caps (characters of JSON unless noted). */
export const FEEDBACK_LIMITS = {
  /** The whole report as JSON: what the relay accepts. */
  report: 96 * 1024,
  note: 2000,
  /** One message / reply / tool result. */
  message: 4000,
  toolInput: 4000,
  /** Messages of conversation context kept (newest first). */
  conversationMessages: 24,
  /** Turns whose traces are kept (newest first). */
  turns: 5,
  /** Tool calls per turn. */
  toolCalls: 40,
  source: 12000,
  applogEntries: 80,
} as const;

// -- the recorded turn -------------------------------------------------------------

/** What reached the fixture according to a tool's own result. */
export type Delivery = "sent" | "not_sent" | null;

export interface TraceToolCall {
  round: number;
  name: string;
  input: unknown;
  result: string;
  isError: boolean;
  /** ms since the turn started. */
  atMs: number;
  durationMs: number;
  /** SENT / NOT SENT, read from the result (set_script, deploy). */
  delivery: Delivery;
  /** Compile outcome read from the result (set_script / compile), or null. */
  compile: "ok" | "error" | null;
  /** For an estimate: whether the cost model was calibrated (null = not an estimate). */
  estimateCalibrated: boolean | null;
}

export interface TurnTrace {
  /** 1-based index of this turn in the conversation. */
  turn: number;
  startedAt: string;
  durationMs: number;
  /** The user's ask as typed (not the grounding context). */
  ask: string;
  /** The final reply shown to the user. */
  reply: string;
  outcome: string;
  error?: string;
  rounds: { round: number; atMs: number; out: string }[];
  tools: TraceToolCall[];
  system: { hash: string; chars: number; tools: string[] } | null;
  sourceBefore: string;
  sourceAfter: string;
  /** Automatic findings (see {@link turnFlags}). */
  flags: TurnFlag[];
}

/** Things the recorder can tell on its own. */
export type TurnFlag =
  | "claimed_sent_not_sent" // the reply says pushed/sent/live, no tool reported SENT
  | "held_on_uncalibrated_estimate" // nothing sent, the only estimate was uncalibrated, the reply blames the budget
  | "compile_failed" // the last compile of the turn failed
  | "tool_error"
  | "exhausted" // ran out of tool rounds
  | "turn_error"; // the turn threw

/** Read SENT / NOT SENT out of a tool result. */
export function deliveryOf(text: string): Delivery {
  if (/\bNOT SENT\b/.test(text)) return "not_sent";
  if (/\bSENT\b/.test(text)) return "sent";
  return null;
}

function compileOf(name: string, text: string): "ok" | "error" | null {
  if (name !== "set_script" && name !== "compile_effect" && name !== "deploy_effect") return null;
  if (/Compile result:\s*OK\b|"ok":\s*true/.test(text)) return "ok";
  if (/Compile result:|"ok":\s*false|doesn't compile|error/i.test(text)) return "error";
  return null;
}

function calibratedOf(name: string, text: string): boolean | null {
  if (name !== "estimate_performance" && name !== "estimate_effect") return null;
  if (/UNCALIBRATED|uncalibrated|default table/.test(text)) return false;
  return true;
}

/** A reply that tells the user the effect is on the lights. */
const CLAIM_SENT = /\b(pushed|sent|deployed|uploaded|is (now )?(live|playing|running)|now (live|playing|running))\b/i;
const CLAIM_SENT_NEGATED = /\b(not|n't|never|couldn't|didn't|wasn't|isn't|nothing)\b[^.!?\n]{0,40}\b(pushed|sent|deployed|uploaded|live|playing)\b/i;
const BUDGET_BLAME = /\b(budget|too slow|too heavy|over budget|frame cost|overrun|performance)\b/i;

/** Automatic findings for a finished turn. */
export function turnFlags(t: Pick<TurnTrace, "reply" | "outcome" | "error" | "tools">): TurnFlag[] {
  const flags: TurnFlag[] = [];
  const sent = t.tools.some((c) => c.delivery === "sent");
  if (!sent && CLAIM_SENT.test(t.reply) && !CLAIM_SENT_NEGATED.test(t.reply)) flags.push("claimed_sent_not_sent");
  const estimates = t.tools.filter((c) => c.estimateCalibrated !== null);
  if (!sent && estimates.length > 0 && estimates.every((c) => c.estimateCalibrated === false) && BUDGET_BLAME.test(t.reply)) {
    flags.push("held_on_uncalibrated_estimate");
  }
  const compiles = t.tools.filter((c) => c.compile !== null);
  if (compiles.length > 0 && compiles[compiles.length - 1]!.compile === "error") flags.push("compile_failed");
  if (t.tools.some((c) => c.isError)) flags.push("tool_error");
  if (t.outcome === "exhausted") flags.push("exhausted");
  if (t.error !== undefined || t.outcome === "error") flags.push("turn_error");
  return flags;
}

/** A trace event as ChatHooks.onTrace emits it (generate.ts ChatTraceEvent). */
export type RecorderTraceEvent =
  | { kind: "round"; round: number }
  | { kind: "in"; text: string }
  | { kind: "delta"; text: string }
  | { kind: "out"; text: string }
  | { kind: "tool_call"; name: string; input: unknown }
  | { kind: "tool_result"; name: string; text: string; isError: boolean };

/** Records one chat turn. Feed it the ChatHooks events; never throws. */
export class TurnRecorder {
  private readonly t0: number;
  private readonly startedAt: string;
  private round = 0;
  private readonly rounds: TurnTrace["rounds"] = [];
  private readonly tools: TraceToolCall[] = [];
  private pending: { name: string; input: unknown; atMs: number } | null = null;
  private system: TurnTrace["system"] = null;

  constructor(
    private readonly opts: { turn: number; ask: string; sourceBefore: string; now?: () => number; date?: () => Date },
  ) {
    this.t0 = this.now();
    this.startedAt = (opts.date?.() ?? new Date()).toISOString();
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  private at(): number {
    return Math.round(this.now() - this.t0);
  }

  /** ChatHooks.onPrompt: the assembled system prompt (only its hash is kept). */
  onPrompt(info: { system: string; tools: string[] }): void {
    this.system = { hash: fnv1a(info.system), chars: info.system.length, tools: [...info.tools] };
  }

  /** ChatHooks.onTrace. */
  onTrace(ev: RecorderTraceEvent): void {
    try {
      if (ev.kind === "round") {
        this.round = ev.round;
        this.rounds.push({ round: ev.round, atMs: this.at(), out: "" });
      } else if (ev.kind === "out") {
        const r = this.rounds[this.rounds.length - 1];
        if (r) r.out = ev.text;
      } else if (ev.kind === "tool_call") {
        this.pending = { name: ev.name, input: ev.input, atMs: this.at() };
      } else if (ev.kind === "tool_result") {
        const p = this.pending && this.pending.name === ev.name ? this.pending : { name: ev.name, input: null, atMs: this.at() };
        this.pending = null;
        this.tools.push({
          round: this.round,
          name: ev.name,
          input: p.input,
          result: ev.text,
          isError: ev.isError,
          atMs: p.atMs,
          durationMs: Math.max(0, this.at() - p.atMs),
          delivery: deliveryOf(ev.text),
          compile: compileOf(ev.name, ev.text),
          estimateCalibrated: calibratedOf(ev.name, ev.text),
        });
      }
    } catch {
      /* recording never breaks a turn */
    }
  }

  /** The finished turn. */
  finish(end: { reply: string; outcome: string; error?: string | undefined; sourceAfter: string }): TurnTrace {
    const base = {
      turn: this.opts.turn,
      startedAt: this.startedAt,
      durationMs: this.at(),
      ask: this.opts.ask,
      reply: end.reply,
      outcome: end.outcome,
      ...(end.error !== undefined ? { error: end.error } : {}),
      rounds: this.rounds.slice(),
      tools: this.tools.slice(),
      system: this.system,
      sourceBefore: this.opts.sourceBefore,
      sourceAfter: end.sourceAfter,
    };
    return { ...base, flags: turnFlags(base) };
  }
}

/** The last few turns of a chat screen, for "report the answer above". */
export class TurnHistory {
  private readonly turns: TurnTrace[] = [];
  constructor(private readonly max: number = FEEDBACK_LIMITS.turns) {}
  push(t: TurnTrace): void {
    this.turns.push(t);
    while (this.turns.length > this.max) this.turns.shift();
  }
  /** Oldest first, up to and including turn `upTo` (default: all). */
  upTo(turn?: number): TurnTrace[] {
    return this.turns.filter((t) => turn === undefined || t.turn <= turn);
  }
  get(turn: number): TurnTrace | undefined {
    return this.turns.find((t) => t.turn === turn);
  }
  clear(): void {
    this.turns.length = 0;
  }
}

// -- the report ----------------------------------------------------------------------

export interface FeedbackDevice {
  board: string | null;
  firmware: string | null;
  features: string[];
  channels: number | null;
  led_count: number | null;
}

export interface FeedbackReport {
  schema: typeof TRACE_SCHEMA;
  /** Random, client-made: dedups retries of the same report. */
  id: string;
  createdAt: string;
  surface: FeedbackSurface;
  reasons: FeedbackReason[];
  note: string;
  /** The turn the user reported (1-based). */
  turn: number;
  app: { version: string; commit: string | null; browser: string };
  ai: Record<string, string | null>;
  /** Grouping key (see {@link feedbackSignature}). */
  signature: string;
  /** What the signature is made of (always sent). */
  signal: FeedbackSignal;
  /** Flags of the reported turn (always sent: no user content). */
  flags: TurnFlag[];
  sections: {
    conversation?: { role: "user" | "assistant"; text: string }[];
    trace?: Omit<TurnTrace, "sourceBefore" | "sourceAfter" | "ask" | "reply">[];
    source?: { before: string; after: string };
    device?: FeedbackDevice[];
    applog?: AppLogEntry[];
  };
  /** Sections the user left out. */
  omitted: FeedbackSectionId[];
  /** What was cut to fit the limits. */
  truncated: string[];
  /** Secrets / identifiers removed. */
  redactions: number;
}

export interface FeedbackInput {
  id: string;
  createdAt?: string;
  surface: FeedbackSurface;
  reasons: FeedbackReason[];
  note?: string;
  /** The reported turn. */
  turn: number;
  turns: TurnTrace[];
  /** The visible conversation (user asks + AI replies), oldest first. */
  conversation: { role: "user" | "assistant" | "tool"; text: string }[];
  app: { version: string; commit: string | null; browser: string };
  ai: Record<string, unknown>;
  devices: FeedbackDevice[];
  applog: AppLogEntry[];
  /** Strings to mask (device names / hosts → opaque ids). */
  known?: Readonly<Record<string, string>>;
  /** Sections to leave out. */
  omit?: readonly FeedbackSectionId[];
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** Normalize an error into a class for grouping: no numbers, ids or quotes. */
export function errorClass(msg: string): string {
  return msg
    .toLowerCase()
    .replace(/"[^"]*"|'[^']*'/g, "_")
    .replace(/\b[0-9a-f]{6,}\b/g, "#")
    .replace(/\d+(\.\d+)*/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

/** What grouping is computed from: no user content beyond an error class. */
export interface FeedbackSignal {
  /** The last failing tool of the reported turn ("none"). */
  tool: string;
  /** The error class (see {@link errorClass}) or the turn's outcome. */
  error: string;
  flags: string;
  firmware: string;
}

/** The signal of a reported turn. */
export function feedbackSignal(
  turn: Pick<TurnTrace, "tools" | "error" | "outcome" | "flags"> | null,
  firmware: string | null,
): FeedbackSignal {
  const tools = turn?.tools ?? [];
  const failing = [...tools].reverse().find((c) => c.isError || c.delivery === "not_sent" || c.compile === "error") ?? null;
  const error = turn?.error
    ? errorClass(turn.error)
    : failing
      ? errorClass(failing.result.split("\n").find((l) => l.trim()) ?? "")
      : (turn?.outcome ?? "none");
  return { tool: failing?.name ?? "none", error, flags: [...(turn?.flags ?? [])].sort().join(","), firmware: firmware ?? "none" };
}

/**
 * The grouping key: the failing tool, the error class, the flags, the reasons,
 * and the app + firmware versions. Two reports with the same signature are very
 * likely the same bug; triage groups by it.
 */
export function feedbackSignature(signal: FeedbackSignal, reasons: readonly string[], appVersion: string): string {
  return fnv1a([signal.tool, signal.error, signal.flags, [...reasons].sort().join(","), appVersion, signal.firmware].join("|"));
}

/** Redact one string: the app log's masks (known names, ws URLs, IPs, MACs, key
 * runs), then the bug reporter's scrubber (passwords, SSIDs, tokens, e-mail…). */
function redactor(known: Readonly<Record<string, string>>): { text: (s: string) => string; value: (v: unknown) => unknown; count: () => number } {
  let n = 0;
  const text = (s: string): string => {
    const masked = maskText(s, known);
    if (masked !== s) n++;
    const r = scrubText(masked);
    n += r.redactions;
    return r.text;
  };
  const value = (v: unknown): unknown => {
    const r = scrubValue(v);
    n += r.redactions;
    const walk = (x: unknown): unknown => {
      if (typeof x === "string") {
        const m = maskText(x, known);
        if (m !== x) n++;
        return m;
      }
      if (Array.isArray(x)) return x.map(walk);
      if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, val]) => [k, walk(val)]));
      return x;
    };
    return walk(r.value);
  };
  return { text, value, count: () => n };
}

/** Drop inline images (capture_preview results, data: URLs) from a string. */
function dropImages(s: string): string {
  return s.replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/g, "[image omitted]");
}

const jsonSize = (v: unknown): number => JSON.stringify(v).length;

/** Build the report the preview shows and the app sends. */
export function buildFeedbackReport(input: FeedbackInput): FeedbackReport {
  const red = redactor(input.known ?? {});
  const omit = new Set(input.omit ?? []);
  const truncated: string[] = [];
  const reasons = input.reasons.filter((r) => REASON_IDS.has(r));
  const reported = input.turns.find((t) => t.turn === input.turn) ?? input.turns[input.turns.length - 1] ?? null;
  const firmware = input.devices[0]?.firmware ?? null;
  const signal = feedbackSignal(reported, firmware);

  const textOf = (s: string, n: number = FEEDBACK_LIMITS.message) => clip(red.text(dropImages(s)), n);
  const sections: FeedbackReport["sections"] = {};

  if (!omit.has("conversation")) {
    const conv = input.conversation.filter((m): m is { role: "user" | "assistant"; text: string } => m.role !== "tool");
    if (conv.length > FEEDBACK_LIMITS.conversationMessages) truncated.push(`conversation: kept the last ${FEEDBACK_LIMITS.conversationMessages} of ${conv.length} messages`);
    sections.conversation = conv.slice(-FEEDBACK_LIMITS.conversationMessages).map((m) => ({ role: m.role, text: textOf(m.text) }));
  }
  if (!omit.has("trace")) {
    const turns = input.turns.filter((t) => t.turn <= (reported?.turn ?? Infinity)).slice(-FEEDBACK_LIMITS.turns);
    sections.trace = turns.map((t) => {
      if (t.tools.length > FEEDBACK_LIMITS.toolCalls) truncated.push(`turn ${t.turn}: kept the last ${FEEDBACK_LIMITS.toolCalls} of ${t.tools.length} tool calls`);
      return {
        turn: t.turn,
        startedAt: t.startedAt,
        durationMs: t.durationMs,
        outcome: t.outcome,
        ...(t.error !== undefined ? { error: textOf(t.error) } : {}),
        // The model's text is the AI's reply: it rides with the conversation.
        rounds: t.rounds.map((r) => ({
          round: r.round,
          atMs: r.atMs,
          out: omit.has("conversation") ? (r.out ? "[left out with the conversation]" : "") : textOf(r.out),
        })),
        tools: t.tools.slice(-FEEDBACK_LIMITS.toolCalls).map((c) => ({
          ...c,
          // Effect source inside tool inputs belongs to the "source" section.
          input: omit.has("source") ? stripSource(red.value(c.input)) : clipValue(red.value(c.input), FEEDBACK_LIMITS.toolInput),
          result: textOf(c.result),
        })),
        system: t.system,
        flags: t.flags,
      };
    });
  }
  if (!omit.has("source") && reported) {
    const cut = (s: string, what: string) => {
      if (s.length > FEEDBACK_LIMITS.source) truncated.push(`source ${what}: cut to ${FEEDBACK_LIMITS.source} characters`);
      return clip(red.text(s), FEEDBACK_LIMITS.source);
    };
    sections.source = { before: cut(reported.sourceBefore, "before"), after: cut(reported.sourceAfter, "after") };
  }
  if (!omit.has("device")) {
    sections.device = input.devices.map((d) => ({
      board: d.board,
      firmware: d.firmware,
      features: [...d.features].sort(),
      channels: d.channels,
      led_count: d.led_count,
    }));
  }
  if (!omit.has("applog")) {
    const log = input.applog.slice(-FEEDBACK_LIMITS.applogEntries);
    if (input.applog.length > log.length) truncated.push(`applog: kept the last ${log.length} of ${input.applog.length} events`);
    sections.applog = log.map((e) => ({ ...e, msg: red.text(e.msg) }));
  }

  const ai: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(input.ai)) {
    if (/key|token|secret/i.test(k)) continue;
    ai[k] = v === null || v === undefined ? null : red.text(String(v)).slice(0, 120);
  }

  const report: FeedbackReport = {
    schema: TRACE_SCHEMA,
    id: input.id,
    createdAt: input.createdAt ?? new Date().toISOString(),
    surface: input.surface,
    reasons,
    note: textOf(input.note ?? "", FEEDBACK_LIMITS.note),
    turn: reported?.turn ?? input.turn,
    app: { version: input.app.version, commit: input.app.commit, browser: input.app.browser },
    ai,
    signature: feedbackSignature(signal, reasons, input.app.version),
    signal,
    flags: reported?.flags ?? [],
    sections,
    omitted: FEEDBACK_SECTIONS.map((s) => s.id).filter((id) => omit.has(id)),
    truncated,
    redactions: 0,
  };
  fitReport(report);
  report.redactions = red.count();
  return report;
}

function clipValue(v: unknown, n: number): unknown {
  const s = JSON.stringify(v);
  if (s === undefined || s.length <= n) return v;
  return `${s.slice(0, n - 1)}…`;
}

/** Replace effect source in a tool input with its size (the user left source out). */
function stripSource(v: unknown): unknown {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  const o = { ...(v as Record<string, unknown>) };
  for (const k of ["source", "script"]) {
    if (typeof o[k] === "string") o[k] = `[effect source omitted: ${(o[k] as string).length} characters]`;
  }
  return o;
}

/**
 * Shrink a report until it fits {@link FEEDBACK_LIMITS.report}: the app log
 * first, then older conversation, then tool results, then older turns, then the
 * source. Each step is noted in `truncated`.
 */
export function fitReport(r: FeedbackReport, limit: number = FEEDBACK_LIMITS.report): void {
  const over = () => jsonSize(r) > limit;
  const s = r.sections;
  while (over() && s.applog && s.applog.length > 0) {
    s.applog.splice(0, Math.max(1, Math.ceil(s.applog.length / 4)));
    if (s.applog.length === 0) delete s.applog;
    note(r, "applog: dropped older events to fit");
  }
  while (over() && s.conversation && s.conversation.length > 2) {
    s.conversation.shift();
    note(r, "conversation: dropped older messages to fit");
  }
  for (const n of [1500, 600, 200]) {
    if (!over() || !s.trace) break;
    for (const t of s.trace) for (const c of t.tools) c.result = clip(c.result, n);
    for (const t of s.trace) for (const c of t.tools) c.input = clipValue(c.input, n);
    note(r, `trace: tool results cut to ${n} characters to fit`);
  }
  while (over() && s.trace && s.trace.length > 1) {
    s.trace.shift();
    note(r, "trace: dropped older turns to fit");
  }
  for (const n of [4000, 1000]) {
    if (!over() || !s.source) break;
    s.source = { before: clip(s.source.before, n), after: clip(s.source.after, n) };
    note(r, `source: cut to ${n} characters to fit`);
  }
  if (over() && s.conversation) {
    for (const m of s.conversation) m.text = clip(m.text, 500);
    note(r, "conversation: messages cut to 500 characters to fit");
  }
}

function note(r: FeedbackReport, msg: string): void {
  if (!r.truncated.includes(msg)) r.truncated.push(msg);
}

/** A short, human summary of each section for the preview sheet. */
export function sectionSummary(r: FeedbackReport, id: FeedbackSectionId): string {
  const s = r.sections;
  switch (id) {
    case "conversation":
      return s.conversation ? `${s.conversation.length} messages` : "left out";
    case "trace": {
      if (!s.trace) return "left out";
      const calls = s.trace.reduce((n, t) => n + t.tools.length, 0);
      return `${s.trace.length} turn${s.trace.length === 1 ? "" : "s"}, ${calls} tool call${calls === 1 ? "" : "s"}`;
    }
    case "source":
      return s.source ? `${s.source.before.split("\n").length} → ${s.source.after.split("\n").length} lines` : "left out";
    case "device":
      return s.device ? (s.device.length ? s.device.map((d) => `${d.board ?? "board?"} fw ${d.firmware ?? "?"}`).join(", ") : "no fixture connected") : "left out";
    case "applog":
      return s.applog ? `${s.applog.length} events` : "left out";
  }
}

// -- intake validation (the relay) ------------------------------------------------------

export type ValidationResult = { ok: true; report: FeedbackReport } | { ok: false; status: number; message: string };

/**
 * Validate a report on intake (the relay): shape, size, known values. Every
 * string is scrubbed again — the relay never stores what a client forgot to
 * scrub. The signature is recomputed so a client can't pick its group.
 */
export function validateFeedbackReport(text: string): ValidationResult {
  if (text.length > FEEDBACK_LIMITS.report + 4096) return { ok: false, status: 413, message: `the report is larger than ${FEEDBACK_LIMITS.report} characters` };
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ok: false, status: 400, message: "the body must be a JSON feedback report" };
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { ok: false, status: 400, message: "the body must be a JSON object" };
  if (j["schema"] !== TRACE_SCHEMA) return { ok: false, status: 400, message: `schema must be ${TRACE_SCHEMA}` };
  const id = typeof j["id"] === "string" && /^[A-Za-z0-9_-]{8,40}$/.test(j["id"]) ? j["id"] : null;
  if (!id) return { ok: false, status: 400, message: "id must be 8-40 characters of [A-Za-z0-9_-]" };
  if (!SURFACES.has(String(j["surface"]))) return { ok: false, status: 400, message: "unknown surface" };
  const reasons = Array.isArray(j["reasons"]) ? (j["reasons"] as unknown[]).filter((r): r is FeedbackReason => REASON_IDS.has(String(r))) : [];
  if (reasons.length === 0) return { ok: false, status: 400, message: "pick at least one reason" };
  const sections = j["sections"] && typeof j["sections"] === "object" ? (j["sections"] as Record<string, unknown>) : {};
  for (const k of Object.keys(sections)) {
    if (!FEEDBACK_SECTIONS.some((s) => s.id === k)) return { ok: false, status: 400, message: `unknown section ${k}` };
  }
  const scrubbed = scrubValue(j).value as FeedbackReport;
  const app = (scrubbed.app && typeof scrubbed.app === "object" ? scrubbed.app : {}) as Partial<FeedbackReport["app"]>;
  const sg = (scrubbed.signal && typeof scrubbed.signal === "object" ? scrubbed.signal : {}) as Partial<FeedbackSignal>;
  const signal: FeedbackSignal = {
    tool: clip(String(sg.tool ?? "none"), 60),
    error: clip(String(sg.error ?? "none"), 60),
    flags: clip(String(sg.flags ?? ""), 200),
    firmware: clip(String(sg.firmware ?? "none"), 40),
  };
  const report: FeedbackReport = {
    ...scrubbed,
    id,
    reasons,
    note: clip(String(scrubbed.note ?? ""), FEEDBACK_LIMITS.note),
    app: { version: clip(String(app.version ?? "unknown"), 40), commit: app.commit ? clip(String(app.commit), 40) : null, browser: clip(String(app.browser ?? ""), 60) },
    signal,
    signature: feedbackSignature(signal, reasons, clip(String(app.version ?? "unknown"), 40)),
  };
  return { ok: true, report };
}

/** A random report id (URL-safe). */
export function newFeedbackId(): string {
  const b = new Uint8Array(12);
  globalThis.crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(36).padStart(2, "0")).join("").slice(0, 20);
}
