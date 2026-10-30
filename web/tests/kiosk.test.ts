/**
 * Kiosk mode, app side (src/net/kiosk.ts): status normalization (tolerant of
 * the wire's shapes), the visitor countdown wording, the local countdown clock
 * re-synced from device pushes, and revert detection.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  KIOSK_DEFAULT_IDLE_S,
  KioskClock,
  countdownLine,
  deviceHasKiosk,
  formatCountdown,
  isRevert,
  countdownTicking,
  kioskConfigFields,
  kioskEventFromWire,
  kioskFromWelcome,
  normalizeKioskStatus,
  type KioskStatus,
} from "../src/net/kiosk";
import { generateKioskSecret } from "../src/halloween/kioskSecrets";

const base = (over: Partial<KioskStatus> = {}): KioskStatus => ({
  enabled: true,
  idleTimeoutS: 120,
  idleRemainingS: 120,
  attractName: "Pumpkin glow",
  attractBrightness: 0.6,
  ownerUnlocked: false,
  attractActive: false,
  hasAttract: true,
  hasSecret: true,
  event: "none",
  ...over,
});

test("normalizeKioskStatus: camel, nested attract", () => {
  const s = normalizeKioskStatus({
    type: "kiosk_status",
    enabled: true,
    idleTimeoutS: 90,
    idleRemainingS: 42.5,
    attractName: "boo-ghost-drift",
    attractBrightness: 0.4,
    hasAttract: true,
    ownerUnlocked: true,
    hasSecret: true,
    event: "KIOSK_EVENT_ACTIVITY",
  });
  assert.deepEqual(s, {
    enabled: true,
    idleTimeoutS: 90,
    idleRemainingS: 42.5,
    attractName: "boo-ghost-drift",
    attractBrightness: 0.4,
    ownerUnlocked: true,
    attractActive: false,
    hasAttract: true,
    hasSecret: true,
    event: "activity",
  });
  // Nested attract info (older draft shape) still reads.
  assert.equal(normalizeKioskStatus({ attract: { name: "Ghosts", brightness: 0.5 } })!.attractName, "Ghosts");
});

test("kioskEventFromWire: enum names and numbers", () => {
  assert.equal(kioskEventFromWire("KIOSK_EVENT_REVERTED"), "reverted");
  assert.equal(kioskEventFromWire("KIOSK_EVENT_CONFIG"), "config");
  assert.equal(kioskEventFromWire(2), "activity");
  assert.equal(kioskEventFromWire("KIOSK_EVENT_NONE"), "none");
  assert.equal(kioskEventFromWire(undefined), "none");
});

test("normalizeKioskStatus: snake/flat fields, proto3 dropped zeros, defaults", () => {
  const s = normalizeKioskStatus({ enabled: true, idle_remaining_s: "7", attract_name: "Boo", attract_brightness: 3 })!;
  assert.equal(s.idleTimeoutS, KIOSK_DEFAULT_IDLE_S); // dropped zero -> default 120
  assert.equal(s.idleRemainingS, 7);
  assert.equal(s.attractName, "Boo");
  assert.equal(s.attractBrightness, 1); // clamped
  assert.equal(s.ownerUnlocked, false);
  assert.equal(s.event, "none");
  const off = normalizeKioskStatus({})!;
  assert.equal(off.enabled, false);
  assert.equal(off.idleRemainingS, 0);
  assert.equal(normalizeKioskStatus(null), null);
  assert.equal(normalizeKioskStatus("x"), null);
});

test("kioskFromWelcome + deviceHasKiosk", () => {
  assert.equal(kioskFromWelcome({ deviceName: "x" }), null);
  assert.equal(kioskFromWelcome({ kiosk: { enabled: true, idleRemainingS: 5 } })?.idleRemainingS, 5);
  assert.equal(kioskFromWelcome({ kioskStatus: { enabled: true } })?.enabled, true);
  assert.equal(deviceHasKiosk({ features: ["effects", "kiosk"] }), true);
  assert.equal(deviceHasKiosk({ features: ["effects"] }), false);
  assert.equal(deviceHasKiosk(null), false);
});

test("formatCountdown / countdownLine", () => {
  assert.equal(formatCountdown(102), "1:42");
  assert.equal(formatCountdown(6.2), "0:07"); // ceil: never shows 0:00 while time is left
  assert.equal(formatCountdown(720), "12:00");
  assert.equal(formatCountdown(-3), "0:00");
  assert.equal(countdownLine(102), "Back to the show in 1:42 if you stop playing");
  assert.equal(countdownLine(0), "Back to the show any second now");
  assert.equal(countdownLine(0, { attractActive: true, ownerUnlocked: false }), "The show is on — tap an effect to play");
  assert.equal(countdownLine(50, { attractActive: false, ownerUnlocked: true }), "Owner unlocked — the idle timer is paused");
  assert.equal(countdownTicking(base()), true);
  assert.equal(countdownTicking(base({ attractActive: true })), false);
  assert.equal(countdownTicking(base({ ownerUnlocked: true })), false);
  assert.equal(countdownTicking(null), false);
});

test("KioskClock counts down locally and re-syncs on each push", () => {
  let now = 1_000_000;
  const clock = new KioskClock(() => now);
  assert.equal(clock.remaining(), 0); // unknown
  clock.sync(base({ idleRemainingS: 102 }));
  assert.equal(clock.remaining(), 102);
  now += 30_000;
  assert.equal(clock.remaining(), 72);
  // A push re-syncs (device clock is authoritative).
  clock.sync(base({ idleRemainingS: 80 }));
  assert.equal(clock.remaining(), 80);
  now += 200_000;
  assert.equal(clock.remaining(), 0); // never negative
  // Local activity restarts the full timer.
  clock.noteActivity();
  assert.equal(clock.remaining(), 120);
  // Disabled: no countdown, activity is a no-op.
  clock.sync(base({ enabled: false, idleRemainingS: 50 }));
  assert.equal(clock.remaining(), 0);
  clock.noteActivity();
  assert.equal(clock.remaining(), 0);
});

test("revert detection: the device's REVERTED event, or the show newly on in a plain reply", () => {
  assert.equal(isRevert(base(), base({ event: "reverted", attractActive: true, idleRemainingS: 0 })), true);
  assert.equal(isRevert(null, base({ event: "reverted" })), true); // first status after connect can be the push
  assert.equal(isRevert(base(), base({ event: "activity" })), false);
  assert.equal(isRevert(base(), base({ event: "config", attractActive: true })), false);
  assert.equal(isRevert(base(), base({ attractActive: true })), true); // missed push, reply shows it
  assert.equal(isRevert(base({ attractActive: true }), base({ attractActive: true })), false);
  assert.equal(isRevert(null, base({ attractActive: true })), false);
  assert.equal(isRevert(base(), base({ enabled: false, event: "reverted" })), false);

  let now = 0;
  const clock = new KioskClock(() => now);
  assert.equal(clock.sync(base({ idleRemainingS: 5 })), false);
  now += 6_000;
  assert.equal(clock.sync(base({ idleRemainingS: 0, attractActive: true, event: "reverted" })), true);
  assert.equal(clock.remaining(), 0); // the show is on: no countdown
  clock.noteActivity(); // a visitor taps a tile
  assert.equal(clock.remaining(), 120);
  assert.equal(clock.status?.attractActive, false);
  // Owner unlocked: the device pauses the idle timer; so do we.
  clock.sync(base({ ownerUnlocked: true, idleRemainingS: 60 }));
  assert.equal(clock.remaining(), 0);
  clock.noteActivity();
  assert.equal(clock.remaining(), 0);
});

test("kioskConfigFields: wire shape, timeout rounded and floored", () => {
  assert.deepEqual(
    kioskConfigFields({ enabled: true, idleTimeoutS: 119.6, captureAttractFromCurrent: true, ownerSecret: "ab" }),
    { enabled: true, idleTimeoutS: 120, captureAttractFromCurrent: true, ownerSecret: "ab" },
  );
  assert.equal(
    kioskConfigFields({ enabled: true, idleTimeoutS: 2, captureAttractFromCurrent: false, ownerSecret: "" })
      .idleTimeoutS,
    10,
  );
});

test("owner secret: 128-bit hex", () => {
  const s = generateKioskSecret((n) => new Uint8Array(n).fill(0xab));
  assert.equal(s, "ab".repeat(16));
  assert.match(generateKioskSecret(), /^[0-9a-f]{32}$/);
});
