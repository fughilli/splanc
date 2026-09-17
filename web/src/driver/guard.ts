/**
 * App-driver guard flag (phone-in-the-loop HITL).
 *
 * A single module-level boolean the transport/capture swap points read to decide
 * whether to substitute a virtual device / synthetic camera for real hardware.
 * Set to true ONLY by the app-driver harness (`driver/harness.ts`), which is
 * itself only reachable behind the `?driver=<ws-url>` flag in `ui/app/main.ts`.
 *
 * This is the mirror of the `?demo=` seam's intent: a guarded, zero-production-cost
 * hook. In a normal load `driverActive()` is `false` and every swap point takes its
 * real-hardware branch, so this adds one boolean check to a couple of user-gesture
 * handlers and nothing else.
 */

let active = false;

/** True when the app is being driven by the HITL harness (virtual BLE + synthetic
 * camera should be substituted for real hardware). */
export function driverActive(): boolean {
  return active;
}

/** Called once by the driver harness during bootstrap, before any screen mounts. */
export function setDriverActive(value: boolean): void {
  active = value;
}

/** Live decode health from the running capture (what the on-screen HUD shows):
 * how many distinct LED ids the real detector+decoder has recovered so far. This
 * is the part the synthetic camera uniquely exercises through the real app. */
export interface DriverDecodeStats {
  ids: number;
  total: number;
  tracks: number;
  observations: number;
}

/** A solved-map summary the HITL capture journey asserts on (target LED count vs
 * how many the solve actually recovered from the synthetic scene). */
export interface DriverCaptureResult {
  mapId: string;
  ledCount: number;
  solved: number;
}

/** The capture screen registers this under `?driver=` so the harness can drive a
 * real capture → detect → decode (→ solve) headlessly: `stats()` reads live decode
 * progress; `finish()` ends the capture and runs the solve. Null when no capture
 * screen is mounted. */
export interface DriverCaptureController {
  stats(): DriverDecodeStats;
  finish(): Promise<DriverCaptureResult>;
}

let captureController: DriverCaptureController | null = null;

/** Set by the capture screen on mount (under the driver), cleared on unmount. */
export function registerDriverCapture(c: DriverCaptureController | null): void {
  captureController = c;
}

export function driverCapture(): DriverCaptureController | null {
  return captureController;
}
