/**
 * Fleet resolution (FUG-11 review: multi-device estimation for the AI code
 * generator). Bridges the persisted {@link fleetStore} selection and the stored
 * device profiles ({@link costTableStore}) into the {@link DeviceTarget}s the
 * multi-device estimator consumes, so the AI can performance-estimate one
 * program across a heterogeneous fleet.
 *
 * The mapping ({@link fleetTargetsFrom}) is a pure function (testable, CJS-safe);
 * {@link resolveFleetTargets} is the thin async wrapper that reads the stores.
 * If the fleet is unset, it falls back to a single target from the active
 * device / SoC default so the AI always gets at least one estimate.
 */

import type { DeviceTarget } from "./multiDevice";
import type { CostTable } from "./costModel";
import {
  costTableStore,
  defaultCostTable,
  toCostTable,
  DEFAULT_SOC,
  DEFAULT_CPU_HZ,
  type StoredCostTable,
} from "../store/costTableStore";
import { fleetStore, type FleetEntry } from "../store/fleetStore";

/** Turn a fleet selection + the available profile records into device targets.
 * Entries whose profile no longer exists are skipped (a stale selection is
 * self-healing). Pure so it can be unit-tested without IndexedDB. */
export function fleetTargetsFrom(
  entries: FleetEntry[],
  records: StoredCostTable[],
): DeviceTarget[] {
  const byId = new Map(records.map((r) => [r.id, r]));
  const targets: DeviceTarget[] = [];
  for (const e of entries) {
    const rec = byId.get(e.tableId);
    if (!rec) continue;
    targets.push({
      key: rec.deviceKey ?? rec.id,
      label: rec.deviceLabel || rec.soc,
      table: toCostTable(rec),
      ledCount: Math.max(1, Math.round(e.ledCount)),
      calibrated: rec.origin === "calibrated",
    });
  }
  return targets;
}

/** A single fallback target for when no fleet is configured: the active device's
 * resolved table (per-device calibration → SoC calibration → default). */
export function fallbackTarget(table: CostTable, ledCount: number, calibrated: boolean): DeviceTarget {
  return {
    key: `${table.soc}@${table.cpuHz}`,
    label: table.soc,
    table,
    ledCount: Math.max(1, Math.round(ledCount)),
    calibrated,
  };
}

/**
 * Resolve the AI estimation fleet into device targets. Uses the persisted fleet
 * when set; otherwise a single fallback target for `fallbackLedCount` (the
 * connected device's table, or the shipped default). Never returns empty when a
 * fallback LED count is given, so the AI always has a target to reason about.
 */
export async function resolveFleetTargets(fallbackLedCount: number): Promise<DeviceTarget[]> {
  const entries = fleetStore.get();
  if (entries.length > 0) {
    const records = await costTableStore.list().catch(() => [] as StoredCostTable[]);
    const targets = fleetTargetsFrom(entries, records);
    if (targets.length > 0) return targets;
  }
  // No (usable) fleet — fall back to the best table for the default SoC.
  const { table, stored } = await costTableStore
    .resolveTable(DEFAULT_SOC, DEFAULT_CPU_HZ)
    .catch(() => ({ table: defaultCostTable(), stored: null as StoredCostTable | null }));
  return [fallbackTarget(table, fallbackLedCount, stored?.origin === "calibrated")];
}
