/**
 * Agent-feedback triage (docs/design/agent-feedback.md): for the Splanc team,
 * not users. Reads reports from the relay's private store (the owner's
 * FEEDBACK_ADMIN_TOKEN) or from exported files, groups them by signature, shows
 * one, and REPLAYS one: the recorded tool calls are re-run against the agent's
 * own tools (a player — in the tests, the FakePlayer) N times, and each run's
 * outcome per step is compared with what was recorded and with the other runs.
 *
 * Replay re-executes the TOOLS, not the model: it answers "does the tool still
 * do what the trace says" (a NOT SENT that a fresh fixture accepts points at the
 * app's push path; a deploy refused on an uncalibrated estimate reproduces every
 * time) and separates tool bugs from model behaviour (the tool said NOT SENT,
 * the reply said "pushed": a model-honesty bug). Repeated runs side by side is
 * the one idea kept from orban/moirai (considered, not a dependency).
 */

import { readFileSync } from "node:fs";

import type { FeedbackReport, TraceToolCall } from "../../web/src/feedback/agentTrace";
import { deliveryOf, validateFeedbackReport } from "../../web/src/feedback/agentTrace";

// -- reading reports ---------------------------------------------------------------------

export interface TriageSource {
  relay: string;
  token: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

async function adminGet(src: TriageSource, path: string): Promise<unknown> {
  const f = src.fetch ?? ((i: string, init?: RequestInit) => fetch(i, init));
  const r = await f(`${src.relay.replace(/\/+$/, "")}${path}`, { headers: { authorization: `Bearer ${src.token}` } });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new Error(`relay answered ${r.status}: ${String(j["message"] ?? j["error"] ?? "")}`);
  return j;
}

/** One summary row (the relay's FeedbackSummary, or one made from a file). */
export interface SummaryRow {
  id: string;
  createdAt: string;
  surface: string;
  reasons: string[];
  signature: string;
  signal: { tool: string; error: string; flags: string; firmware: string };
  flags: string[];
  app: string;
  status: string;
  fixedIn?: string;
}

export async function listReports(src: TriageSource, filter: { signature?: string; status?: string } = {}): Promise<SummaryRow[]> {
  const q = new URLSearchParams();
  if (filter.signature) q.set("signature", filter.signature);
  if (filter.status) q.set("status", filter.status);
  const j = (await adminGet(src, `/feedback${q.size ? `?${q}` : ""}`)) as { items: SummaryRow[] };
  return j.items;
}

export async function getReport(src: TriageSource, id: string): Promise<{ report: FeedbackReport; status: string; fixedIn?: string }> {
  return (await adminGet(src, `/feedback?id=${encodeURIComponent(id)}`)) as { report: FeedbackReport; status: string };
}

export async function setReportStatus(src: TriageSource, id: string, status: string, extra: { fixed_in?: string; message?: string } = {}): Promise<void> {
  const f = src.fetch ?? ((i: string, init?: RequestInit) => fetch(i, init));
  const r = await f(`${src.relay.replace(/\/+$/, "")}/feedback/status`, {
    method: "POST",
    headers: { authorization: `Bearer ${src.token}`, "content-type": "application/json" },
    body: JSON.stringify({ id, status, ...extra }),
  });
  if (!r.ok) throw new Error(`relay answered ${r.status}`);
}

/** A report from a file: the app's export (one report or an array), or a
 * relay record ({report, status}). Validated + scrubbed like intake does. */
export function readReportFile(path: string): FeedbackReport[] {
  const j = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const items = Array.isArray(j) ? j : [j];
  return items.map((x) => {
    const rep = x && typeof x === "object" && "report" in x ? (x as { report: unknown }).report : x;
    const v = validateFeedbackReport(JSON.stringify(rep));
    if (!v.ok) throw new Error(`${path}: ${v.message}`);
    return v.report;
  });
}

export function summaryOf(r: FeedbackReport, status = "local"): SummaryRow {
  return {
    id: r.id,
    createdAt: r.createdAt,
    surface: r.surface,
    reasons: r.reasons,
    signature: r.signature,
    signal: r.signal,
    flags: r.flags,
    app: r.app.version,
    status,
  };
}

// -- grouping ---------------------------------------------------------------------------

export interface ReportGroup {
  signature: string;
  count: number;
  tool: string;
  error: string;
  flags: string;
  reasons: string[];
  apps: string[];
  firmware: string;
  statuses: Record<string, number>;
  latest: string;
  ids: string[];
}

/** Group by signature, biggest group first. */
export function groupReports(rows: SummaryRow[]): ReportGroup[] {
  const by = new Map<string, ReportGroup>();
  for (const r of rows) {
    let g = by.get(r.signature);
    if (!g) {
      g = { signature: r.signature, count: 0, tool: r.signal.tool, error: r.signal.error, flags: r.signal.flags, reasons: [], apps: [], firmware: r.signal.firmware, statuses: {}, latest: r.createdAt, ids: [] };
      by.set(r.signature, g);
    }
    g.count++;
    for (const x of r.reasons) if (!g.reasons.includes(x)) g.reasons.push(x);
    if (!g.apps.includes(r.app)) g.apps.push(r.app);
    g.statuses[r.status] = (g.statuses[r.status] ?? 0) + 1;
    if (r.createdAt > g.latest) g.latest = r.createdAt;
    g.ids.push(r.id);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || b.latest.localeCompare(a.latest));
}

export function renderGroups(groups: ReportGroup[]): string {
  if (!groups.length) return "no reports";
  return groups
    .map(
      (g) =>
        `${g.signature}  ×${g.count}  ${g.tool} — ${g.error || "-"}${g.flags ? `  [${g.flags}]` : ""}\n` +
        `    reasons ${g.reasons.join(", ")} · app ${g.apps.join(", ")} · fw ${g.firmware} · ` +
        `${Object.entries(g.statuses).map(([k, v]) => `${k} ${v}`).join(", ")} · latest ${g.latest}\n` +
        `    ${g.ids.slice(0, 5).join(" ")}${g.ids.length > 5 ? " …" : ""}`,
    )
    .join("\n");
}

// -- showing one --------------------------------------------------------------------------

const first = (s: string, n = 140) => {
  const l = s.split("\n").find((x) => x.trim()) ?? "";
  return l.length > n ? `${l.slice(0, n - 1)}…` : l;
};

export function renderReport(r: FeedbackReport): string {
  const out: string[] = [];
  out.push(`report ${r.id}  (${r.surface}, ${r.createdAt})`);
  out.push(`signature ${r.signature}: tool ${r.signal.tool} · ${r.signal.error} · fw ${r.signal.firmware}`);
  out.push(`reasons: ${r.reasons.join(", ")}${r.flags.length ? `   findings: ${r.flags.join(", ")}` : ""}`);
  if (r.note) out.push(`note: ${r.note}`);
  out.push(`app ${r.app.version} (${r.app.commit ?? "?"}) · ${r.app.browser} · AI ${Object.values(r.ai).filter(Boolean).join("/")}`);
  if (r.omitted.length) out.push(`left out by the user: ${r.omitted.join(", ")}`);
  if (r.truncated.length) out.push(`shortened: ${r.truncated.join("; ")}`);
  const s = r.sections;
  if (s.device) out.push(`devices: ${s.device.map((d) => `${d.board ?? "?"} fw ${d.firmware ?? "?"} ${d.led_count ?? "?"} LEDs [${d.features.join(",")}]`).join("; ") || "none connected"}`);
  if (s.conversation) {
    out.push("", "conversation:");
    for (const m of s.conversation) out.push(`  ${m.role === "user" ? "user" : "AI  "}: ${first(m.text, 200)}`);
  }
  if (s.trace) {
    for (const t of s.trace) {
      out.push("", `turn ${t.turn}: ${t.outcome}${t.error ? ` (${first(t.error)})` : ""}, ${t.durationMs} ms, ${t.rounds.length} rounds` + (t.system ? `, prompt ${t.system.hash}/${t.system.chars}ch` : "") + (t.flags.length ? `  [${t.flags.join(", ")}]` : ""));
      for (const c of t.tools) {
        const tags = [c.isError ? "ERROR" : "", c.compile ? `compile ${c.compile}` : "", c.delivery ? c.delivery.toUpperCase().replace("_", " ") : "", c.estimateCalibrated === false ? "UNCALIBRATED estimate" : ""].filter(Boolean);
        out.push(`  r${c.round} +${c.atMs}ms ${c.name} (${c.durationMs} ms)${tags.length ? ` [${tags.join(", ")}]` : ""}: ${first(c.result)}`);
      }
      const last = t.rounds[t.rounds.length - 1];
      if (last?.out) out.push(`  reply: ${first(last.out, 200)}`);
    }
  }
  if (s.applog?.length) {
    out.push("", `app log (last ${Math.min(10, s.applog.length)} of ${s.applog.length}):`);
    for (const e of s.applog.slice(-10)) out.push(`  ${e.t} ${e.kind}: ${e.msg}`);
  }
  return out.join("\n");
}

// -- replay ------------------------------------------------------------------------------

/** One recorded tool call, mapped onto the agent's MCP tools. */
export interface ReplayStep {
  turn: number;
  index: number;
  recorded: { name: string; outcome: string; firstLine: string };
  /** The MCP call to make, or null (not replayable: e.g. MIDI, file_bug). */
  call: { name: string; args: Record<string, unknown> } | null;
}

export interface ToolAnswer {
  isError: boolean;
  text: string;
}

/** ok|error / compile ok|error|- / sent|not_sent|- for one tool answer. */
export function outcomeClass(name: string, a: ToolAnswer): string {
  let compile = "-";
  let delivery = "-";
  if (/doesn't compile|"ok":\s*false|Compile result: (?!OK)/.test(a.text)) compile = "error";
  else if (/^(set_script|compile_effect|deploy_effect)$/.test(name) && !a.isError) compile = "ok";
  if (name === "deploy_effect" || name === "set_script") {
    const d = deliveryOf(a.text);
    if (d) delivery = d;
    else if (name === "deploy_effect") delivery = a.isError ? "not_sent" : "sent";
  }
  return `${a.isError ? "error" : "ok"}/${compile}/${delivery}`;
}

function recordedClass(c: TraceToolCall): string {
  return `${c.isError ? "error" : "ok"}/${c.compile ?? "-"}/${c.delivery ?? "-"}`;
}

/** Map an in-app tool call onto the agent's tools (MCP traces map to themselves). */
function mapCall(c: TraceToolCall, lastSource: string | null): ReplayStep["call"] {
  const input = (c.input && typeof c.input === "object" ? c.input : {}) as Record<string, unknown>;
  const src = typeof input["source"] === "string" && !String(input["source"]).startsWith("[effect source omitted") ? (input["source"] as string) : null;
  switch (c.name) {
    case "set_script":
      return src ? { name: "deploy_effect", args: { effect_id: "replay", source: src, activate: true } } : null;
    case "estimate_performance":
      return lastSource ? { name: "estimate_effect", args: { source: lastSource } } : null;
    case "capture_preview":
      return lastSource ? { name: "preview_effect", args: { source: lastSource, times: [0] } } : null;
    case "measure_on_device":
      return { name: "measure_effect", args: typeof input["seconds"] === "number" ? { seconds: input["seconds"] } : {} };
    case "set_live_uniforms": {
      const set = Array.isArray(input["set"]) ? (input["set"] as { name?: unknown; value?: unknown }[]) : [];
      const values = Object.fromEntries(set.filter((e) => typeof e.name === "string").map((e) => [e.name as string, e.value]));
      return Object.keys(values).length ? { name: "set_uniforms", args: { values } } : null;
    }
    case "compile_effect":
    case "deploy_effect":
    case "estimate_effect":
    case "preview_effect":
    case "set_uniforms":
    case "measure_effect":
    case "list_players":
    case "list_uniforms":
      return { name: c.name, args: input };
    default:
      return null;
  }
}

/** The steps to replay for a report (every turn in its trace, in order). */
export function planReplay(r: FeedbackReport): ReplayStep[] {
  const steps: ReplayStep[] = [];
  let lastSource: string | null = null;
  for (const t of r.sections.trace ?? []) {
    t.tools.forEach((c, index) => {
      const call = mapCall(c, lastSource);
      const input = (c.input && typeof c.input === "object" ? c.input : {}) as Record<string, unknown>;
      if (typeof input["source"] === "string" && !String(input["source"]).startsWith("[effect source omitted")) lastSource = input["source"] as string;
      steps.push({ turn: t.turn, index, recorded: { name: c.name, outcome: recordedClass(c), firstLine: first(c.result) }, call });
    });
  }
  return steps;
}

export interface ReplayRun {
  /** One outcome class per step ("skip" when not replayable). */
  outcomes: string[];
  firstLines: string[];
  /** Effect uploads the player saw this run (when `uploads` is given). */
  uploads?: number;
}

export interface ReplayResult {
  steps: ReplayStep[];
  runs: ReplayRun[];
  /** Runs in which the reported failure came back (the signal's failing step). */
  reproduced: number;
  /** The step the signature points at (-1: none replayable). */
  failingStep: number;
  /** First step where the runs disagree with each other (flaky), or -1. */
  divergesAt: number;
  /** First step where a run disagrees with the recording, or -1. */
  differsFromRecordingAt: number;
  findings: string[];
}

export interface ReplayDeps {
  call: (name: string, args: Record<string, unknown>) => Promise<ToolAnswer>;
  /** Put the player back to its start state before each run. */
  reset?: () => Promise<void>;
  /** How many effect uploads the player has received so far (ground truth). */
  uploads?: () => number;
}

/** Replay a report's tool calls `runs` times and compare. */
export async function replayReport(r: FeedbackReport, runs: number, deps: ReplayDeps): Promise<ReplayResult> {
  const steps = planReplay(r);
  const results: ReplayRun[] = [];
  for (let n = 0; n < Math.max(1, runs); n++) {
    await deps.reset?.();
    const before = deps.uploads?.() ?? 0;
    const run: ReplayRun = { outcomes: [], firstLines: [] };
    for (const s of steps) {
      if (!s.call) {
        run.outcomes.push("skip");
        run.firstLines.push("");
        continue;
      }
      let a: ToolAnswer;
      try {
        a = await deps.call(s.call.name, s.call.args);
      } catch (e) {
        a = { isError: true, text: e instanceof Error ? e.message : String(e) };
      }
      run.outcomes.push(outcomeClass(s.call.name, a));
      run.firstLines.push(first(a.text));
    }
    if (deps.uploads) run.uploads = deps.uploads() - before;
    results.push(run);
  }

  // The failing step: the last recorded step matching the signal's tool that failed.
  const sigTool = r.signal.tool;
  let failingStep = -1;
  steps.forEach((s, i) => {
    if (s.recorded.name === sigTool && /^error|\/error\/|not_sent$/.test(s.recorded.outcome)) failingStep = i;
  });
  const failed = (o: string | undefined) => o !== undefined && o !== "skip" && (/^error/.test(o) || o.includes("/error/") || o.endsWith("/not_sent"));
  const reproduced = failingStep >= 0 ? results.filter((run) => failed(run.outcomes[failingStep])).length : 0;
  let divergesAt = -1;
  let differsFromRecordingAt = -1;
  for (let i = 0; i < steps.length; i++) {
    const os = results.map((run) => run.outcomes[i]!);
    if (divergesAt < 0 && new Set(os).size > 1) divergesAt = i;
    const rec = steps[i]!.recorded.outcome;
    const replayed = os.find((o) => o !== "skip");
    if (differsFromRecordingAt < 0 && replayed !== undefined && comparable(steps[i]!, replayed) !== comparable(steps[i]!, rec)) differsFromRecordingAt = i;
  }

  const findings: string[] = [];
  const nRuns = results.length;
  if (failingStep < 0) findings.push(`no replayable failing step for signal tool "${sigTool}"`);
  else findings.push(`the reported failure (${steps[failingStep]!.recorded.name}: ${steps[failingStep]!.recorded.outcome}) came back in ${reproduced}/${nRuns} runs`);
  if (divergesAt >= 0) findings.push(`runs diverge at step ${divergesAt + 1} (${steps[divergesAt]!.recorded.name}): ${[...new Set(results.map((x) => x.outcomes[divergesAt]))].join(" vs ")} — flaky`);
  if (differsFromRecordingAt >= 0) {
    const s = steps[differsFromRecordingAt]!;
    const replayed = results[0]!.outcomes[differsFromRecordingAt];
    findings.push(`step ${differsFromRecordingAt + 1} (${s.recorded.name}) differs from the recording: recorded ${s.recorded.outcome}, replayed ${replayed}`);
    if (s.recorded.name === "set_script" && s.recorded.outcome.endsWith("not_sent") && replayed?.endsWith("/sent")) {
      findings.push("a fresh fixture accepted the effect the app reported NOT SENT: suspect the app's push path (connection, auto-push, a hold), not the effect");
    }
  }
  if (r.flags.includes("claimed_sent_not_sent")) {
    const toolSaid = steps.filter((s) => s.recorded.outcome.endsWith("not_sent")).length;
    findings.push(
      toolSaid
        ? "the tools reported NOT SENT and the reply claimed it was sent: the false claim is the model's (prompt/tool-result honesty), not a tool bug"
        : "the reply claimed a send with no send tool in the trace",
    );
  }
  for (const [i, s] of steps.entries()) {
    const line = results[0]?.firstLines[i] ?? "";
    if (s.call?.name === "deploy_effect" && /overrun the frame budget/.test(line)) {
      findings.push(`step ${i + 1}: deploy_effect refused on an estimate (${first(line, 100)}) — estimates must never gate a send`);
      break;
    }
  }
  if (results.some((x) => x.uploads !== undefined)) findings.push(`uploads seen by the player per run: ${results.map((x) => x.uploads ?? "?").join(", ")}`);
  return { steps, runs: results, reproduced, failingStep, divergesAt, differsFromRecordingAt, findings };
}

/** Compare only what both sides know (an in-app set_script records SENT/NOT
 * SENT; a replayed deploy knows the same). */
function comparable(s: ReplayStep, outcome: string): string {
  return s.call?.name === "deploy_effect" && s.recorded.name === "set_script" ? outcome.replace(/^(ok|error)\//, "") : outcome;
}

export function renderReplay(res: ReplayResult): string {
  const out: string[] = [];
  const w = Math.max(...res.steps.map((s) => s.recorded.name.length), 4);
  out.push(`step  ${"tool".padEnd(w)}  recorded            ${res.runs.map((_, i) => `run ${i + 1}`.padEnd(18)).join(" ")}`);
  res.steps.forEach((s, i) => {
    const mark = i === res.failingStep ? "*" : i === res.divergesAt ? "~" : " ";
    out.push(
      `${String(i + 1).padStart(3)}${mark}  ${s.recorded.name.padEnd(w)}  ${s.recorded.outcome.padEnd(18)}  ` +
        res.runs.map((r) => (r.outcomes[i] ?? "").padEnd(18)).join(" ") +
        (s.call && s.call.name !== s.recorded.name ? `  (as ${s.call.name})` : s.call ? "" : "  (not replayable)"),
    );
  });
  out.push("", ...res.findings.map((f) => `- ${f}`));
  return out.join("\n");
}

/**
 * A confirmed report as a regression fixture: the report (already scrubbed)
 * plus what a fixed build must show when it is replayed.
 */
export function regressionFixture(r: FeedbackReport, res: ReplayResult, expect: { failingStepOutcome: string; note: string }): Record<string, unknown> {
  return {
    schema: "splanc-agent-feedback-fixture/1",
    note: expect.note,
    report: r,
    expect: {
      failing_step: res.failingStep,
      // What the failing step must replay as once fixed (e.g. "ok/ok/sent").
      failing_step_outcome: expect.failingStepOutcome,
    },
  };
}
