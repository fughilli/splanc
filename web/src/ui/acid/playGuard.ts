/**
 * Play-mode upload guard (Halloween kiosk): an AI-written effect only reaches the
 * fixture if it compiled, is not dark, and is not hopelessly slow. Otherwise the
 * fixture keeps the last good effect and the model is told why, so it can retry.
 * Pure (no DOM/engine) so it is unit-tested.
 */

/** A frame is "dark" when no LED channel byte reaches this (of 255). */
export const DARK_BYTE = 8;

/** True when every sampled frame is dark (all LEDs at or near black). */
export function allDark(frames: readonly Uint8Array[], threshold = DARK_BYTE): boolean {
  if (frames.length === 0) return false;
  return frames.every((f) => {
    for (let i = 0; i < f.length; i++) if (f[i]! >= threshold) return false;
    return true;
  });
}

export interface GuardInput {
  /** Sampled preview frames (RGB bytes), or [] if no preview could run. */
  frames: readonly Uint8Array[];
  /** Estimated fraction of the C6 frame budget (1 = exactly fits), or NaN. */
  budgetFraction: number;
  /** Reject at or above this budget fraction. */
  maxBudgetFraction: number;
}

/** Why an upload is refused, or null when it may go to the fixture. Phrased for
 * the model (it becomes the set_script tool result). */
export function guardVerdict(g: GuardInput): string | null {
  if (allDark(g.frames)) {
    return "NOT SENT: it renders completely dark. The fixture keeps the previous effect. Keep a visible glow and send it again with set_script.";
  }
  if (!Number.isFinite(g.budgetFraction) || g.budgetFraction >= g.maxBudgetFraction) {
    const pct = Number.isFinite(g.budgetFraction) ? `${Math.round(g.budgetFraction * 100)}%` : "far over";
    return `NOT SENT: too slow for the ESP32-C6 (${pct} of the frame budget). The fixture keeps the previous effect. Send a simpler, cheaper version with set_script: fixed maths with fixed() literals, fewer ops per LED, no loops in shade().`;
  }
  return null;
}
