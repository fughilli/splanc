/**
 * AI estimation-fleet store (FUG-11 review: "Cost estimation should also be
 * supported for multiple devices … the AI agent in the AI code generator will
 * need to be able to performance-estimate each of them to guide
 * implementation").
 *
 * Persists WHICH stored device profiles (by cost-table id) form the fleet the
 * AI estimates a program against, plus a per-target LED count (a heterogeneous
 * fleet runs different-sized maps). The profile manager edits this; the effect
 * editor's `estimate_performance` AI tool reads it. localStorage-backed, keyed
 * by cost-table id so a deleted/re-imported profile round-trips cleanly.
 *
 * localStorage is touched only inside methods, so this module stays CJS-safe for
 * the node:test unit build.
 */

const STORAGE_KEY = "ledmapper.perfFleet";

/** One device in the AI estimation fleet. `tableId` is a {@link
 * StoredCostTable} id; `ledCount` is the map size to estimate that device at. */
export interface FleetEntry {
  tableId: string;
  ledCount: number;
}

type Listener = () => void;

class FleetStore {
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** The current fleet (empty if unset or storage is unavailable). */
  get(): FleetEntry[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw) as unknown;
      if (!Array.isArray(arr)) return [];
      return arr
        .filter((e): e is FleetEntry => {
          const o = e as Record<string, unknown>;
          return typeof o["tableId"] === "string" && Number.isFinite(o["ledCount"]);
        })
        .map((e) => ({ tableId: e.tableId, ledCount: Math.max(1, Math.round(e.ledCount)) }));
    } catch {
      return [];
    }
  }

  private set(entries: FleetEntry[]): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // storage unavailable — the fleet just won't persist this session.
    }
    this.emit();
  }

  has(tableId: string): boolean {
    return this.get().some((e) => e.tableId === tableId);
  }

  /** Add `tableId` to the fleet (at `ledCount`) if absent, else remove it. */
  toggle(tableId: string, ledCount: number): void {
    const entries = this.get();
    const idx = entries.findIndex((e) => e.tableId === tableId);
    if (idx >= 0) entries.splice(idx, 1);
    else entries.push({ tableId, ledCount: Math.max(1, Math.round(ledCount)) });
    this.set(entries);
  }

  /** Update the LED count for a fleet member (no-op if it isn't in the fleet). */
  setLedCount(tableId: string, ledCount: number): void {
    const entries = this.get();
    const e = entries.find((x) => x.tableId === tableId);
    if (!e) return;
    e.ledCount = Math.max(1, Math.round(ledCount));
    this.set(entries);
  }

  /** Drop a profile from the fleet (e.g. when its cost table is deleted). */
  remove(tableId: string): void {
    const entries = this.get().filter((e) => e.tableId !== tableId);
    this.set(entries);
  }
}

export const fleetStore = new FleetStore();
