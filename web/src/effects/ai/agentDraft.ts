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
 * Only a TRUSTED reading counts as "over budget": an on-device measurement, or
 * an estimate from a CALIBRATED cost model — a stored cost table whose origin
 * is an on-device benchmark of the user's board (StoredCostTable.origin ===
 * "calibrated", the notion effects/fleet.ts uses). The shipped default
 * model is uncalibrated: its over-budget estimate does not hold the draft back
 * or mark it "not ready". The effect is pushed normally, and the agent and the
 * operator are told to read the measured number instead (owner decision on
 * PR #462).
 *
 * Pure (no DOM); the editor feeds it the budget-bar estimate (or a measurement).
 */

/** The budget reading for a compiled draft. */
export interface DraftBudget {
  /** Consumed / available FX budget (>1 = over budget). */
  fraction: number;
  /** "estimate" = the offline cost model (the budget bar); "measured" = device. */
  source: "estimate" | "measured";
  /** For an estimate: the cost table was calibrated on the user's board. */
  calibrated?: boolean;
}

/** A reading the over-budget decisions may act on: a measurement, or an
 * estimate from a calibrated cost model. */
export function trustedBudget(b: DraftBudget | null | undefined): boolean {
  return !!b && (b.source === "measured" || b.calibrated === true);
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
  return s.agentTurn && trustedBudget(s.budget) && draftVerdict(s.budget) === "over";
}

/**
 * For the agent (set_script result): an over-budget estimate from the
 * UNCALIBRATED default model is not a verdict. Say so, and point at the
 * measurement. Empty string when there is nothing to add.
 */
export function uncalibratedEstimateNote(b: DraftBudget | null | undefined, connected: boolean): string {
  if (!b || trustedBudget(b) || draftVerdict(b) !== "over") return "";
  return (
    `Budget estimate: ${pct(b.fraction)} of the frame budget, from the UNCALIBRATED default cost model ` +
    "(this board has no calibration), so it is not a verdict and the effect was not held back. " +
    (connected
      ? "Call measure_on_device and treat the measured number as what counts."
      : "No fixture is connected to measure it; say the estimate is uncalibrated rather than calling the effect too slow.")
  );
}

/** How the agent turn ended, from the editor's point of view. */
export type AgentTurnEnd = "complete" | "finished-after-script" | "exhausted" | "error" | "cancelled";

export type DraftAction = "optimize" | "continue" | "push";

export interface DraftNotice {
  tone: "info" | "warn" | "error";
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
  if (verdict === "over" && !trustedBudget(s.budget)) {
    // Uncalibrated estimate: inform, never "not ready" (the measurement decides).
    return {
      tone: "info",
      text:
        `The offline estimate is ${pct(s.budget!.fraction)} of the frame budget, but this board's cost model is ` +
        "uncalibrated, so it is only a rough guide" +
        (s.onDevice ? "; the effect is playing on the fixture. " : ". ") +
        (s.connected
          ? "The measured number (measure_on_device) is what counts."
          : "Connect a fixture to measure it."),
      actions: [],
    };
  }
  if (verdict !== "over") {
    // A stalled turn with an in-budget (or unknown) draft is already covered by
    // the error / exhausted message itself; nothing budget-specific to add.
    return null;
  }
  const b = s.budget!;
  const what = `${pct(b.fraction)} of the frame budget (${b.source === "measured" ? "measured" : "calibrated estimate"})`;
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
      b.source === "measured" ? "measured" : b.calibrated ? "calibrated offline estimate" : "uncalibrated offline estimate"
    }). Optimize it to fit within the budget while keeping the look. Check with estimate_performance ` +
    "(and measure_on_device when a fixture is connected) and report the final number honestly, including " +
    "if it is still over budget."
  );
}
