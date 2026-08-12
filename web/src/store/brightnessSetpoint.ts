/**
 * Per-device global-brightness setpoint (0..1), persisted in localStorage.
 *
 * The device holds its output brightness only at RUNTIME (a reboot returns it to
 * full, so it can never get stuck dark), which makes the app the source of truth
 * for the user's "master dimmer" level. Two readers share this store:
 *   - the device settings screen edits it (and pushes set_brightness live), and
 *   - the calibration/performance-measurement driver reads it to restore the
 *     user's level after blanking the strip (set_brightness 0) for a run.
 * Mirrors colorCorrection.ts's `cc:profile:<id>` per-device persistence.
 */

export const DEFAULT_BRIGHTNESS = 1;

function storeKey(deviceId: string): string {
  return `brightness:${deviceId}`;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** The saved setpoint for a device (0..1), or the default (1.0) when unset. */
export function loadBrightness(deviceId: string | null): number {
  if (deviceId) {
    try {
      const raw = localStorage.getItem(storeKey(deviceId));
      if (raw !== null) {
        const v = Number(raw);
        if (Number.isFinite(v)) return clamp01(v);
      }
    } catch {
      /* fall through to default */
    }
  }
  return DEFAULT_BRIGHTNESS;
}

export function saveBrightness(deviceId: string | null, v: number): void {
  if (!deviceId) return;
  try {
    localStorage.setItem(storeKey(deviceId), String(clamp01(v)));
  } catch {
    /* storage full / disabled — non-fatal */
  }
}
