/**
 * Available-execution-budget simulation (FUG-11: "measuring available execution
 * budget" + "simulating FX engine execution cost w.r.t. execution budget").
 *
 * The offline cost model (costModel.ts) predicts how long an effect's
 * `update()`+`shade()` take per frame. This module turns that into a *budget
 * consumption*: what fraction of the CPU time actually available to the FX
 * engine (after transmit + other system tasks) the effect uses, and the
 * FUG-11 progress-bar color band for it (<=70% green, >70% yellow, >90% red).
 *
 * The budget is derived from a {@link BudgetModel} (see costModel.ts): the frame
 * period minus a reserved system-task fraction minus the LED transmit time.
 * Both offline estimates and on-device PerfReports flow through the same
 * {@link budgetConsumption} so the bar reads identically online and offline.
 */

import {
  DEFAULT_BUDGET_MODEL,
  type BudgetModel,
  type FrameEstimate,
  type PhaseSplit,
} from "./costModel";

/** FUG-11 color thresholds for the budget progress bar. */
export type BudgetColor = "green" | "yellow" | "red";

/** The <=70% / >70% / >90% bands from the FUG-11 spec. */
export const BUDGET_YELLOW_AT = 0.7;
export const BUDGET_RED_AT = 0.9;

/** How the frame period splits between the FX engine and everything else. */
export interface BudgetBreakdown {
  /** Frame period, ms (1000 / fps). */
  frameMs: number;
  /** Reserved for other system tasks (wss, scheduler…), ms. */
  systemReservedMs: number;
  /** LED transmit (`show`) time, ms — not FX-engine work but eats the frame. */
  showMs: number;
  /** CPU time left for the FX engine's update()+shade(), ms. Clamped >= 0. */
  availableFxMs: number;
}

/** The consumption of the available FX budget by an effect, for the bar. */
export interface BudgetStatus {
  breakdown: BudgetBreakdown;
  /** FX-engine wall time this frame (update + shade), ms. */
  consumedFxMs: number;
  /** consumedFxMs / availableFxMs (0..∞; >1 means it overruns the budget). */
  fraction: number;
  /** Progress-bar color per the FUG-11 bands. */
  color: BudgetColor;
  /** True if there is effectively no budget left (available <= 0). */
  starved: boolean;
}

/** Map a consumed fraction to the FUG-11 progress-bar color band. */
export function budgetColor(fraction: number): BudgetColor {
  if (fraction > BUDGET_RED_AT) return "red";
  if (fraction > BUDGET_YELLOW_AT) return "yellow";
  return "green";
}

/**
 * Split the frame period into system-reserved / transmit / FX-available, given
 * the budget model and the measured-or-estimated transmit time. `showMs` is the
 * LED transmit time for the frame (from the estimate's phase split or a
 * PerfReport's show cycles).
 */
export function computeBudget(model: BudgetModel, showMs: number): BudgetBreakdown {
  const fps = model.fps > 0 ? model.fps : DEFAULT_BUDGET_MODEL.fps;
  const frameMs = 1000 / fps;
  const avail = Math.min(1, Math.max(0, model.cpuAvailableFraction));
  const systemReservedMs = frameMs * (1 - avail);
  const show = Math.max(0, showMs);
  const availableFxMs = Math.max(0, frameMs - systemReservedMs - show);
  return { frameMs, systemReservedMs, showMs: show, availableFxMs };
}

/**
 * Compute how much of the available FX budget `consumedFxMs` uses, plus the
 * bar color. When the budget is starved (transmit + system already fill the
 * frame) any nonzero consumption is a red overrun.
 */
export function budgetConsumption(
  model: BudgetModel,
  consumedFxMs: number,
  showMs: number,
): BudgetStatus {
  const breakdown = computeBudget(model, showMs);
  const consumed = Math.max(0, consumedFxMs);
  const starved = breakdown.availableFxMs <= 0;
  const fraction = starved
    ? consumed > 0
      ? Number.POSITIVE_INFINITY
      : 0
    : consumed / breakdown.availableFxMs;
  return {
    breakdown,
    consumedFxMs: consumed,
    fraction,
    color: budgetColor(fraction),
    starved,
  };
}

/** Display-ready props for the FUG-11 budget progress bar (pure, so the exact
 * fill width / label / color are unit-testable without the DOM). */
export interface BudgetBarView {
  /** Bar fill width, 0..100 (clamped; an overrun pins at 100). */
  fillPct: number;
  /** Color band per the FUG-11 spec (<=70 green, >70 yellow, >90 red). */
  color: BudgetColor;
  /** Percent-of-available label ("72%", ">budget" when starved). */
  percentLabel: string;
  /** Detail line ("8.1 / 11.2 ms of FX budget"). */
  detail: string;
  /** Threshold marker positions along the bar (70, 90) for the tick guides. */
  thresholds: number[];
  /** True when the effect uses more than the available FX budget. */
  overrun: boolean;
}

/** Turn a {@link BudgetStatus} into display props for the progress bar. */
export function budgetBarView(status: BudgetStatus): BudgetBarView {
  const { fraction, breakdown, consumedFxMs, starved } = status;
  const finite = Number.isFinite(fraction);
  const overrun = !finite || fraction > 1;
  const fillPct = Math.max(0, Math.min(100, (finite ? fraction : 1) * 100));
  const percentLabel = finite ? `${Math.round(fraction * 100)}%` : ">budget";
  const detail = starved
    ? `no FX budget — transmit + system fill the ${breakdown.frameMs.toFixed(1)} ms frame`
    : `${consumedFxMs.toFixed(1)} / ${breakdown.availableFxMs.toFixed(1)} ms of FX budget`;
  return {
    fillPct,
    color: status.color,
    percentLabel,
    detail,
    thresholds: [BUDGET_YELLOW_AT * 100, BUDGET_RED_AT * 100],
    overrun,
  };
}

/** Budget status from an offline {@link FrameEstimate} (uses its phase split and
 * the table's budget model, defaulting when the table predates the model). */
export function budgetFromEstimate(
  est: FrameEstimate,
  model: BudgetModel = DEFAULT_BUDGET_MODEL,
): BudgetStatus {
  const consumedFxMs = est.phaseSplit.updateMs + est.phaseSplit.shadeMs;
  return budgetConsumption(model, consumedFxMs, est.phaseSplit.showMs);
}

/** Budget status from a measured phase split (device PerfReport → ms). */
export function budgetFromPhases(
  phases: PhaseSplit,
  model: BudgetModel = DEFAULT_BUDGET_MODEL,
): BudgetStatus {
  return budgetConsumption(model, phases.updateMs + phases.shadeMs, phases.showMs);
}

/**
 * Measure `cpuAvailableFraction` from a device. `otherTasksMs` is the mean CPU
 * time per frame the system spends *outside* the effect and its transmit (wss,
 * scheduler, telemetry) — everything that competes with the FX engine for the
 * frame period. The available fraction is what's left of the frame after that:
 *
 *   cpuAvailableFraction = 1 - otherTasksMs / frameMs
 *
 * Returns a fraction in (0, 1]; falls back to the model default when the inputs
 * are degenerate. This keeps the offline bar honest once a device is seen.
 */
export function measureAvailableFraction(frameMs: number, otherTasksMs: number): number {
  if (frameMs <= 0) return DEFAULT_BUDGET_MODEL.cpuAvailableFraction;
  const reserved = Math.max(0, otherTasksMs);
  const frac = 1 - reserved / frameMs;
  if (!Number.isFinite(frac) || frac <= 0) return 0.01;
  return Math.min(1, frac);
}
