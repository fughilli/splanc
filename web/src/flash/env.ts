/**
 * Flash environment capability summary (FUG-60 follow-up; FUG-85 WebUSB path).
 *
 * The flasher rides on the Web Serial API. Desktop Chromium exposes it natively;
 * Android Chrome does not — but it does expose WebUSB, so webserial.ts installs
 * Google's web-serial-polyfill there and the same flow works over WebUSB. Only a
 * browser with neither (e.g. iOS Safari) truly can't flash. This module turns the
 * raw capability flags into a human diagnosis + a checklist the UI shows, so a
 * failed attempt is self-explaining instead of a dead end.
 *
 * Pure and DOM-free (the flags are read in webserial.ts) so it unit-tests.
 */

/** Raw capability flags, read from the browser in webserial.ts. `serial`/`usb`
 * are the browser's NATIVE capabilities (snapshotted before any polyfill is
 * installed), so the summary below can tell a native path from the WebUSB one. */
export interface FlashEnv {
  /** navigator.serial present natively (Web Serial API). */
  serial: boolean;
  /** navigator.usb present (WebUSB — on Android it backs the Serial polyfill). */
  usb: boolean;
  /** Secure context (https/localhost); Web Serial + WebUSB both require it. */
  secureContext: boolean;
  /** navigator.userAgent, for the mobile heuristic + the diagnostics dump. */
  userAgent: string;
}

export interface EnvSummary {
  /** True when flashing can actually be attempted here (native or via WebUSB). */
  ok: boolean;
  /** Why it can't be used (user-facing), or null when ok. */
  reason: string | null;
  /** A non-blocking caveat to show when ok (e.g. the WebUSB polyfill path). */
  note: string | null;
  /** Capability checklist lines for the diagnostics panel. */
  lines: string[];
}

/** Rough "is this a phone/tablet" test — enough to tailor the Web Serial hint. */
export function isMobileUserAgent(ua: string): boolean {
  return /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua);
}

/** Diagnose the environment: is flashing possible, and if not, precisely why. */
export function summarizeEnv(env: FlashEnv): EnvSummary {
  // With no native Web Serial but WebUSB present (Android Chrome), webserial.ts
  // installs the WebUSB-backed polyfill and the same flash path runs over it.
  const viaPolyfill = !env.serial && env.usb;
  const transport = env.serial
    ? "native Web Serial"
    : viaPolyfill
      ? "WebUSB (Web Serial polyfill)"
      : "none";
  const lines = [
    `Web Serial API: ${env.serial ? "available" : "not available"}`,
    `WebUSB API: ${env.usb ? "available" : "not available"}`,
    `Flash transport: ${transport}`,
    `Secure context (https): ${env.secureContext ? "yes" : "no"}`,
  ];

  let reason: string | null = null;
  let note: string | null = null;
  if (!env.serial && !env.usb) {
    // Neither transport — e.g. iOS Safari/Chrome (no WebUSB, no Web Serial).
    reason = isMobileUserAgent(env.userAgent)
      ? "This device can't flash over USB: its browser has neither Web Serial nor WebUSB. On Android use Chrome; on iPhone/iPad no browser can flash — use desktop Chrome or Edge."
      : "This browser can't flash over USB. Use desktop Chrome, Edge, or another Chromium browser (neither Web Serial nor WebUSB is available here).";
  } else if (!env.secureContext) {
    reason = "Flashing needs a secure (https) page — open the app over https and retry.";
  } else if (viaPolyfill) {
    note =
      "This browser has no native Web Serial, so flashing runs over WebUSB. Pick the board from the WebUSB prompt (not the OS chooser). If it doesn't appear, another app may have it open, or the OS has already claimed it.";
  }
  return { ok: reason === null, reason, note, lines };
}
