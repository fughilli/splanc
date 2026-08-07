/** Flash environment capability summary (FUG-60 follow-up; FUG-85 WebUSB). */

import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeEnv, isMobileUserAgent, isAndroidUserAgent, type FlashEnv } from "../src/flash/env";

const DESKTOP_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36";
const IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const desktopOk: FlashEnv = { serial: true, usb: true, secureContext: true, userAgent: DESKTOP_UA };

test("isMobileUserAgent flags phones/tablets, not desktop", () => {
  assert.equal(isMobileUserAgent(ANDROID_UA), true);
  assert.equal(isMobileUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)"), true);
  assert.equal(isMobileUserAgent(DESKTOP_UA), false);
});

test("a capable desktop is ok with no reason (native Web Serial)", () => {
  const s = summarizeEnv(desktopOk);
  assert.equal(s.ok, true);
  assert.equal(s.reason, null);
  assert.equal(s.note, null);
  assert.ok(s.lines.some((l) => l.includes("Web Serial API: available")));
  assert.ok(s.lines.some((l) => l.includes("Flash transport: native Web Serial")));
});

test("isAndroidUserAgent flags Android only, not other mobiles/desktop", () => {
  assert.equal(isAndroidUserAgent(ANDROID_UA), true);
  assert.equal(isAndroidUserAgent(IOS_UA), false);
  assert.equal(isAndroidUserAgent(DESKTOP_UA), false);
});

test("Android (WebUSB, no Web Serial) is ok via the polyfill, with a note", () => {
  const s = summarizeEnv({ serial: false, usb: true, secureContext: true, userAgent: ANDROID_UA });
  assert.equal(s.ok, true);
  assert.equal(s.reason, null);
  assert.ok(s.note, "expected a WebUSB-path note");
  assert.match(s.note, /WebUSB/i);
  assert.ok(s.lines.some((l) => l.includes("Flash transport: WebUSB")));
  assert.ok(s.lines.some((l) => l.includes("WebUSB API: available")));
  assert.ok(s.lines.some((l) => l.includes("Web Serial API: not available")));
});

// Regression (FUG-85 follow-up): Chrome for Android 138+ ships Web Serial, but
// only over Bluetooth — it can't see a USB board. So even with navigator.serial
// present we must route over the WebUSB polyfill, not report the native path.
test("Android with native Web Serial still flashes via the WebUSB polyfill", () => {
  const s = summarizeEnv({ serial: true, usb: true, secureContext: true, userAgent: ANDROID_UA });
  assert.equal(s.ok, true);
  assert.equal(s.reason, null);
  assert.ok(s.note, "expected a WebUSB-path note on Android");
  assert.match(s.note, /WebUSB/i);
  assert.ok(s.lines.some((l) => l.includes("Flash transport: WebUSB")));
});

test("iOS (neither Web Serial nor WebUSB) reports a mobile-specific reason", () => {
  const s = summarizeEnv({ serial: false, usb: false, secureContext: true, userAgent: IOS_UA });
  assert.equal(s.ok, false);
  assert.ok(s.reason);
  assert.match(s.reason, /iPhone|iPad|Android|desktop/i);
  assert.ok(s.lines.some((l) => l.includes("Flash transport: none")));
});

test("desktop without either API gets the generic Chromium hint", () => {
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
