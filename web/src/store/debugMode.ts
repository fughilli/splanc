/**
 * Debug mode — Settings ▸ Behavior ▸ Developer ▸ "Enable Debug Settings".
 *
 * One switch for the developer affordances: it shows the Debugging settings
 * tab, and while it is on, mapping runs that fail or end degenerate write a
 * capture reproduction bundle (solver/captureBundle.ts). Persisted per device
 * in localStorage; every accessor tolerates storage being unavailable.
 */

const DEBUG_SETTINGS_KEY = "ledmapper.debugSettings";

export function debugModeEnabled(): boolean {
  try {
    return localStorage.getItem(DEBUG_SETTINGS_KEY) === "1";
  } catch {
    return false;
  }
}

export function setDebugModeEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(DEBUG_SETTINGS_KEY, "1");
    else localStorage.removeItem(DEBUG_SETTINGS_KEY);
  } catch {
    /* non-fatal */
  }
}
