/**
 * Multi-device cost estimation (FUG-11 review: "Cost estimation should also be
 * supported for multiple devices … the AI agent in the AI code generator will
 * need to be able to performance-estimate each of them to guide
 * implementation").
 *
 * A heterogeneous fleet runs the same program at once (different SoCs, clocks,
 * LED counts). This estimates one compiled effect across a SET of device
 * targets — each with its own profile-derived {@link CostTable} and LED count —
 * and returns a per-device frame estimate + available-budget status, plus a
 * fleet summary (the binding target, whether all fit). The AI generator renders
 * {@link describeFleet} into its perf context so it can optimize for every
 * target, not just one.
 *
 * Pure + CJS-safe (no DOM/store); callers pass resolved tables.
 */

import { budgetFromEstimate, type BudgetStatus } from "./budget";
import {
  estimateFrameTime,
  DEFAULT_BUDGET_MODEL,
  type CostTable,
  type FrameEstimate,
} from "./costModel";

/** One device to estimate against. `key` is a stable identity (device MAC/id or
 * a SoC label); `table` is its resolved cost table (per-device if calibrated). */
export interface DeviceTarget {
  key: string;
  label: string;
  table: CostTable;
  ledCount: number;
  /** True if `table` came from a hardware calibration (vs a default/host seed). */
  calibrated?: boolean;
}

/** Per-device estimate result. */
export interface DeviceEstimate {
  target: DeviceTarget;
  estimate: FrameEstimate;
  budget: BudgetStatus;
}

/** Fleet-wide summary of estimating one program across all targets. */
export interface FleetEstimate {
  devices: DeviceEstimate[];
  /** The device that consumes the largest fraction of its FX budget — the one
   * that binds the design (optimize for this first). Null if no devices. */
  binding: DeviceEstimate | null;
  /** True if every device fits its available budget (fraction ≤ 1). */
  allFit: boolean;
}

/** Estimate one compiled effect across a set of device targets. */
export function estimateAcrossDevices(
  bytecode: Uint8Array,
  targets: DeviceTarget[],
): FleetEstimate {
  const devices: DeviceEstimate[] = targets.map((target) => {
    const estimate = estimateFrameTime({ bytecode, ledCount: target.ledCount, table: target.table });
    const budget = budgetFromEstimate(estimate, target.table.budget ?? DEFAULT_BUDGET_MODEL);
    return { target, estimate, budget };
  });

  let binding: DeviceEstimate | null = null;
  for (const d of devices) {
    if (binding === null || d.budget.fraction > binding.budget.fraction) binding = d;
  }
  const allFit = devices.every((d) => Number.isFinite(d.budget.fraction) && d.budget.fraction <= 1);
  return { devices, binding, allFit };
}

/** Render a compact fleet summary for the AI generator's perf context. Lists
 * each device's budget consumption + color, flags the binding device, and warns
 * on any that overrun — so the model optimizes for the whole fleet. */
export function describeFleet(fleet: FleetEstimate): string {
  if (fleet.devices.length === 0) return "No device targets to estimate against.";
  const lines: string[] = [];
  lines.push(
    `Estimating across ${fleet.devices.length} device target${fleet.devices.length > 1 ? "s" : ""} — ${
      fleet.allFit ? "all fit" : "SOME OVERRUN"
    }:`,
  );
  for (const d of fleet.devices) {
    const pct = Number.isFinite(d.budget.fraction)
      ? `${Math.round(d.budget.fraction * 100)}%`
      : ">budget";
    const soc = d.target.table.soc;
    const mhz = (d.target.table.cpuHz / 1e6).toFixed(0);
    const cal = d.target.calibrated ? "calibrated" : "uncalibrated (default model — wide error)";
    const bind = fleet.binding === d ? " ← binding" : "";
    lines.push(
      `- ${d.target.label} (${soc} @ ${mhz} MHz, ${d.target.ledCount} LEDs, ${cal}): ` +
        `${d.estimate.totalMs.toFixed(1)} ms, ${pct} of FX budget [${d.budget.color}]${bind}`,
    );
  }

  // The binding device's hottest opcodes are the most actionable lever — what
  // the AI should cut to bring the fleet inside budget.
  const bind = fleet.binding;
  if (bind && bind.estimate.hotOpcodes.length > 0) {
    const top = bind.estimate.hotOpcodes
      .slice(0, 6)
      .map((h) => `${h.op} (${Math.round(h.fraction * 100)}%)`)
      .join(", ");
    lines.push(`Hottest opcodes on the binding device (${bind.target.label}): ${top}.`);
  }
  if (!fleet.allFit) {
    lines.push("Optimize for the binding device first; it must fit before the others matter.");
  }
  lines.push(
    "To cut per-LED cost: hoist loop-invariant work into update(), prefer step/mix/polynomial " +
      "over sin/pow/exp, and avoid length/normalize/distance (hidden sqrt).",
  );
  return lines.join("\n");
}
