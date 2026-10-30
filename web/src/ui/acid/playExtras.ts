/**
 * Hook for play mode's extra chrome in Acid Mode (`#/acid?play=1`). The play-mode
 * screen owns the kiosk idle countdown ("returns to the show in 1:42 if idle");
 * it registers a factory here and Acid Mode mounts it in its top bar, so the two
 * screens don't import each other. With nothing registered, Acid shows no countdown.
 */

export interface AcidPlayExtra {
  el: HTMLElement;
  dispose?: () => void;
}

let kioskCountdown: (() => AcidPlayExtra | null) | null = null;

/** Play mode calls this once (e.g. at module load) with its countdown component.
 * The factory may return null when the connected device has no kiosk capability. */
export function registerAcidKioskCountdown(factory: (() => AcidPlayExtra | null) | null): void {
  kioskCountdown = factory;
}

/** Acid Mode: a fresh countdown element for this mount, or null. */
export function createAcidKioskCountdown(): AcidPlayExtra | null {
  try {
    return kioskCountdown?.() ?? null;
  } catch {
    return null;
  }
}
