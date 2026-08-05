/**
 * Flash environment capability summary (FUG-60 follow-up).
 *
 * The flasher rides on the Web Serial API, which is desktop-Chromium only —
 * Android/iOS browsers don't expose it, so the port chooser either never opens
 * or opens empty ("no matching devices"). This module turns the raw capability
 * flags into a human diagnosis + a checklist the UI shows, so a failed attempt
 * is self-explaining instead of a dead end.
 *
 * Pure and DOM-free (the flags are read in webserial.ts) so it unit-tests.
 */

/** Raw capability flags, read from the browser in webserial.ts. */
export interface FlashEnv {
  /** navigator.serial present (Web Serial API — what the flasher uses). */
  serial: boolean;
  /** navigator.usb present (WebUSB — present on Android, but not used here). */
  usb: boolean;
  /** Secure context (https/localhost); Web Serial silently requires it. */
  secureContext: boolean;
  /** navigator.userAgent, for the mobile heuristic + the diagnostics dump. */
  userAgent: string;
}

export interface EnvSummary {
  /** True when Web Serial can actually be used here. */
  ok: boolean;
  /** Why it can't be used (user-facing), or null when ok. */
  reason: string | null;
  /** Capability checklist lines for the diagnostics panel. */
  lines: string[];
}

/** Rough "is this a phone/tablet" test — enough to tailor the Web Serial hint. */
export function isMobileUserAgent(ua: string): boolean {
  return /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua);
}

/** Diagnose the environment: is flashing possible, and if not, precisely why. */
export function summarizeEnv(env: FlashEnv): EnvSummary {
  const lines = [
    `Web Serial API: ${env.serial ? "available" : "not available"}`,
    `WebUSB API: ${env.usb ? "available" : "not available"}`,
    `Secure context (https): ${env.secureContext ? "yes" : "no"}`,
  ];

  let reason: string | null = null;
  if (!env.serial) {
    reason = isMobileUserAgent(env.userAgent)
      ? "This device doesn't support Web Serial. Phone and tablet browsers can't open a USB serial port — flash from desktop Chrome or Edge instead."
      : "This browser can't flash over USB. Use desktop Chrome, Edge, or another Chromium browser (Web Serial isn't available here).";
  } else if (!env.secureContext) {
    reason = "Flashing needs a secure (https) page — open the app over https and retry.";
  }
  return { ok: reason === null, reason, lines };
}
