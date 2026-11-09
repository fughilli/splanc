/**
 * Readiness of an AI-written effect against the fixture's frame budget (#443).
 *
 * In the demo, an agent edit produced an effect at ~4× its frame budget; the
 * optimization pass then ended on a network error with the last estimate still
 * at 314% — and nothing on screen said the effect was not ready. The rule this
 * module encodes for the editor:
 *  - while an agent turn is running, an over-budget compile is an OPTIMIZING
 *    DRAFT: it plays in the preview, but auto-push holds it back so the fixture
 *    keeps playing the last pushed effect (nothing is parked or stopped — the
 *    device just isn't switched to a draft that would stutter);
 *  - when the turn ends (finished, out of steps, or failed), an over-budget
 *    draft is reported as NOT ready, with explicit recovery actions (keep
 *    optimizing / continue / push anyway).
 * A manual compile with auto-push on is the user's own call and is not held.
 *
 * Pure (no DOM); the editor feeds it the budget-bar estimate (or a measurement).
 */

/** The budget reading for a compiled draft. */
export interface DraftBudget {
  /** Consumed / available FX budget (>1 = over budget). */
  fraction: number;
  /** "estimate" = the offline cost model (the budget bar); "measured" = device. */
  source: "estimate" | "measured";
}

export type DraftVerdict = "within" | "over" | "unknown";

/** Over budget means strictly above the available FX budget. */
export function draftVerdict(b: DraftBudget | null | undefined): DraftVerdict {
  if (!b || !Number.isFinite(b.fraction) || b.fraction < 0) return "unknown";
  return b.fraction > 1 ? "over" : "within";
}

/** Whether auto-push should hold this compile back from the fixture. Only an
 * agent-driven, known-over-budget draft is held; unknown budgets are not (an
 * estimator failure must not silently stop pushes). */
export function holdAgentAutoPush(s: { agentTurn: boolean; budget: DraftBudget | null | undefined }): boolean {
  return s.agentTurn && draftVerdict(s.budget) === "over";
}

/** How the agent turn ended, from the editor's point of view. */
export type AgentTurnEnd = "complete" | "finished-after-script" | "exhausted" | "error" | "cancelled";

export type DraftAction = "optimize" | "continue" | "push";

export interface DraftNotice {
  tone: "warn" | "error";
  text: string;
  actions: DraftAction[];
}

const pct = (f: number): string => `${Math.round(f * 100)}%`;

/**
 * The operator-facing notice after an agent turn, or null when the result is
 * fine to present as ready (within budget, or nothing compiled / no budget).
 * `canResume`: the conversation ends in unassessed tool results (Continue works).
 */
export function draftNotice(s: {
  end: AgentTurnEnd;
  /** The latest compile's budget (null when nothing compiled / unknown). */
  budget: DraftBudget | null | undefined;
  /** The fixture currently plays this draft (pushed or measured). */
  onDevice: boolean;
  /** Auto-push held this draft back during the turn. */
  held: boolean;
  connected: boolean;
  /** Error text for end === "error". */
  error?: string | undefined;
  canResume: boolean;
}): DraftNotice | null {
  const verdict = draftVerdict(s.budget);
  const stalled = s.end === "error" || s.end === "exhausted" || s.end === "cancelled";
  if (verdict !== "over") {
    // A stalled turn with an in-budget (or unknown) draft is already covered by
    // the error / exhausted message itself; nothing budget-specific to add.
    return null;
  }
  const b = s.budget!;
  const what = `${pct(b.fraction)} of the frame budget (${b.source === "measured" ? "measured" : "estimate"})`;
  const device = !s.connected
    ? "No fixture is connected."
    : s.onDevice
      ? "The fixture is playing it now, so expect stutter."
      : s.held
        ? "Auto-push held it back: the fixture keeps playing the previous effect."
        : "It has not been pushed: the fixture keeps playing whatever it had.";
  let head: string;
  if (s.end === "error") {
    head = `**Optimization stopped${s.error ? ` (${s.error})` : ""}** — the current draft is still over budget at ${what}.`;
  } else if (s.end === "exhausted") {
    head = `**Still optimizing** — the agent ran out of steps with the draft at ${what}.`;
  } else if (s.end === "cancelled") {
    head = `**Optimization cancelled** — the draft is at ${what}.`;
  } else {
    head = `**Not ready: over budget** — the draft is at ${what}.`;
  }
  const actions: DraftAction[] = [];
  if (stalled && s.canResume) actions.push("continue");
  actions.push("optimize");
  if (s.connected && !s.onDevice) actions.push("push");
  const hints: string[] = [];
  if (actions.includes("continue")) hints.push("Continue resumes the agent where it stopped");
  hints.push("Keep optimizing asks it to bring the draft under budget");
  if (actions.includes("push")) hints.push("Push anyway sends it to the fixture as is");
  return {
    tone: s.end === "error" ? "error" : "warn",
    text: `${head} ${device} ${hints.join("; ")}.`,
    actions,
  };
}

/** The ask behind "Keep optimizing". */
export function optimizeAsk(b: DraftBudget): string {
  return (
    `The current effect is at ${pct(b.fraction)} of the fixture's frame budget (${
      b.source === "measured" ? "measured" : "offline estimate"
    }). Optimize it to fit within the budget while keeping the look. Check with estimate_performance ` +
    "(and measure_on_device when a fixture is connected) and report the final number honestly, including " +
    "if it is still over budget."
  );
}
