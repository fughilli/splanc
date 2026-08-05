/** Flash environment capability summary (FUG-60 follow-up). */

import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeEnv, isMobileUserAgent, type FlashEnv } from "../src/flash/env";

const DESKTOP_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36";

const desktopOk: FlashEnv = { serial: true, usb: true, secureContext: true, userAgent: DESKTOP_UA };

test("isMobileUserAgent flags phones/tablets, not desktop", () => {
  assert.equal(isMobileUserAgent(ANDROID_UA), true);
  assert.equal(isMobileUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)"), true);
  assert.equal(isMobileUserAgent(DESKTOP_UA), false);
});

test("a capable desktop is ok with no reason", () => {
  const s = summarizeEnv(desktopOk);
  assert.equal(s.ok, true);
  assert.equal(s.reason, null);
  assert.ok(s.lines.some((l) => l.includes("Web Serial API: available")));
});

test("Android (no Web Serial) reports a mobile-specific reason", () => {
  const s = summarizeEnv({ serial: false, usb: true, secureContext: true, userAgent: ANDROID_UA });
  assert.equal(s.ok, false);
  assert.ok(s.reason);
  assert.match(s.reason, /phone|tablet|desktop/i);
  // The checklist still shows WebUSB is present even though we can't use it.
  assert.ok(s.lines.some((l) => l.includes("WebUSB API: available")));
  assert.ok(s.lines.some((l) => l.includes("Web Serial API: not available")));
});

test("desktop without Web Serial gets the generic Chromium hint", () => {
  const s = summarizeEnv({ serial: false, usb: false, secureContext: true, userAgent: DESKTOP_UA });
  assert.equal(s.ok, false);
  assert.ok(s.reason);
  assert.match(s.reason, /Chrome|Edge|Chromium/);
});

test("insecure context is flagged even when Web Serial exists", () => {
  const s = summarizeEnv({ serial: true, usb: true, secureContext: false, userAgent: DESKTOP_UA });
  assert.equal(s.ok, false);
  assert.ok(s.reason);
  assert.match(s.reason, /https|secure/i);
});
