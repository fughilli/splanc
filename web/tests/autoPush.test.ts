// Auto-push policy (src/effects/editor/autoPush.ts): on by default, and a program
// compiled while offline reaches the device once it connects.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTOPUSH_KEY,
  needsPush,
  pushOutcomeNote,
  readAutoPush,
  shouldPushOnConnect,
  uncalibratedEstimateToolResult,
  writeAutoPush,
} from "../src/effects/editor/autoPush";
import { CHAT_SYSTEM, DEVICE_PERF_GUIDE } from "../src/effects/ai/chatPrompt";
import { ACID_SYSTEM } from "../src/effects/ai/acidPersona";

function memStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    m,
  };
}

test("auto-push defaults ON for a new install and for users who never touched it", () => {
  assert.equal(AUTOPUSH_KEY, "fxedit.autopush.v1"); // the existing key: old choices carry over
  assert.equal(readAutoPush(memStorage()), true);
  assert.equal(readAutoPush(null), true);
  assert.equal(readAutoPush(memStorage({ [AUTOPUSH_KEY]: "1" })), true);
  assert.equal(readAutoPush(memStorage({ [AUTOPUSH_KEY]: "0" })), false, "an explicit off is kept");
  const throwing = {
    getItem: (): string | null => {
      throw new Error("SecurityError");
    },
  };
  assert.equal(readAutoPush(throwing), true);
});

test("writeAutoPush round-trips and tolerates blocked storage", () => {
  const s = memStorage();
  writeAutoPush(s, false);
  assert.equal(readAutoPush(s), false);
  writeAutoPush(s, true);
  assert.equal(s.m.get(AUTOPUSH_KEY), "1");
  writeAutoPush(
    {
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
    },
    true,
  );
});

const A = new Uint8Array([1, 2, 3]);
const A2 = new Uint8Array([1, 2, 3]);
const B = new Uint8Array([1, 2, 4]);

test("needsPush dedupes per device, byte-for-byte", () => {
  assert.equal(needsPush(null, { fxb: null, device: null }, "d1"), false);
  assert.equal(needsPush(A, { fxb: null, device: null }, "d1"), true);
  assert.equal(needsPush(A, { fxb: A2, device: "d1" }, "d1"), false, "identical bytes on the same device");
  assert.equal(needsPush(B, { fxb: A, device: "d1" }, "d1"), true);
  assert.equal(needsPush(A, { fxb: A, device: "d1" }, "d2"), true, "another device doesn't have it");
});

test("a compile written while offline is pushed when the device connects (the 'not connected' set_script)", () => {
  const base = {
    autoPush: true,
    connected: true,
    wasConnected: false,
    compiled: A,
    pushed: { fxb: null, device: null },
    device: "player-1",
  };
  assert.equal(shouldPushOnConnect(base), true);
  // Only on the transition to connected — not on every state emit.
  assert.equal(shouldPushOnConnect({ ...base, wasConnected: true }), false);
  assert.equal(shouldPushOnConnect({ ...base, connected: false }), false);
  // Nothing compiled yet / auto-push explicitly off.
  assert.equal(shouldPushOnConnect({ ...base, compiled: null }), false);
  assert.equal(shouldPushOnConnect({ ...base, autoPush: false }), false);
  // A reconnect of the device that already has it doesn't re-flash.
  assert.equal(shouldPushOnConnect({ ...base, pushed: { fxb: A2, device: "player-1" } }), false);
  // …but a different device does get it.
  assert.equal(shouldPushOnConnect({ ...base, pushed: { fxb: A, device: "player-0" } }), true);
  // A held over-budget AI draft waits for the user's "push anyway" (#443).
  assert.equal(shouldPushOnConnect({ ...base, held: true }), false);
});

test("set_script's device line: SENT only when it was sent; NOT SENT says so and forbids 'live'", () => {
  assert.match(pushOutcomeNote({ kind: "sent", device: "Dodeca" }), /^SENT: uploaded and now playing on Dodeca/);
  assert.match(pushOutcomeNote({ kind: "already" }), /^SENT/);
  for (const o of [
    { kind: "not_connected", autoPush: true },
    { kind: "not_connected", autoPush: false },
    { kind: "autopush_off" },
    { kind: "held", detail: "held back — 140% (measured)" },
    { kind: "failed", error: "timeout" },
  ] as const) {
    const t = pushOutcomeNote(o);
    assert.match(t, /^NOT SENT: /, o.kind);
    assert.match(t, /do NOT say it is live/, o.kind);
  }
  assert.match(pushOutcomeNote({ kind: "not_connected", autoPush: true }), /sent automatically as soon as a fixture connects/);
  assert.match(pushOutcomeNote({ kind: "autopush_off" }), /tap Push/);
});

test("an uncalibrated estimate gives the AI no numbers and points at the fixture", () => {
  const withFixture = uncalibratedEstimateToolResult(true);
  assert.doesNotMatch(withFixture, /\d+%/);
  assert.match(withFixture, /UNCALIBRATED/);
  assert.match(withFixture, /never hold back, delay, or refuse to send/);
  assert.match(withFixture, /measure_on_device.*gold standard/);
  assert.match(uncalibratedEstimateToolResult(false), /can't be judged until a fixture is connected/);
});

test("the editor prompt forbids claiming a push without SENT and gating on uncalibrated estimates", () => {
  assert.match(CHAT_SYSTEM, /ONLY when it says SENT/);
  assert.match(CHAT_SYSTEM, /Never hold back, delay, or refuse to send an effect.*uncalibrated estimate/);
  assert.match(DEVICE_PERF_GUIDE, /gold standard/);
  assert.match(ACID_SYSTEM, /Only say it's on their lights when the set_script result says SENT/);
});
