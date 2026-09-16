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
