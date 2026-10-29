/**
 * Halloween play mode, connect + kiosk (net/halloweenConnect.ts,
 * halloween/kioskStore.ts, ui/screens/kioskSection.ts): the onboarding pumpkin
 * opens the Web Bluetooth chooser filtered to SpookySplanc*, connects over the
 * GATT player socket and lands on #/play; the kiosk countdown follows the
 * device's KioskStatus (get on connect, pushes, local activity); the owner's
 * section configures + unlocks with a secret kept on this phone.
 *
 * Runs the REAL client/appState against a simulated board (tests/deviceFakes.ts)
 * that also answers the kiosk arms, under the fake DOM and mocked timers.
 */

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import type { ServerMessage } from "@ledmapper/protocol";
import { installFakeDom, asFake } from "./fakeDom";

const dom = installFakeDom();
mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
after(() => mock.timers.reset());

import { PLAYER_SERVICE_UUID } from "../src/net/bleTransport";
import { IMPROV_SERVICE } from "../src/net/improv";
import { connectHalloweenFixture } from "../src/net/halloweenConnect";
import { kioskStore } from "../src/halloween/kioskStore";
import { kioskSecretFor } from "../src/halloween/kioskSecrets";
import { connectAttempt } from "../src/halloween/playSession";
import { appState } from "../src/ui/app/state";
import { OnboardingScreen } from "../src/ui/screens/onboarding";
import { KioskSection } from "../src/ui/screens/kioskSection";
import type { Router } from "../src/ui/app/router";
import {
  FakeLan,
  FakePlayerGatt,
  advance,
  button,
  clearOverlays,
  installBluetooth,
  settle,
  type BluetoothStub,
} from "./deviceFakes";

let lan: FakeLan;
let restoreWs: () => void = () => undefined;
let bt: BluetoothStub | null = null;

beforeEach(() => {
  dom.document.hidden = true; // park the background liveness prober
  localStorage.clear();
  location.hash = "";
  lan = new FakeLan();
  restoreWs = lan.install();
});

afterEach(async () => {
  clearOverlays();
  appState.disconnect();
  await settle();
  bt?.restore();
  bt = null;
  restoreWs();
  localStorage.clear();
});

interface KioskBoard {
  dev: FakePlayerGatt;
  /** Device-side kiosk state (proto3 JSON). */
  state: Record<string, unknown>;
  secret: string;
  /** Push an unsolicited kiosk_status. */
  push(extra: Record<string, unknown>): void;
}

/** A SpookySplanc board whose player also serves the kiosk arms like the firmware. */
function spookyBoard(name = "SpookySplanc1", kiosk: Record<string, unknown> = {}): KioskBoard {
  const dev = new FakePlayerGatt({ mac: "58:E6:C5:00:0B:01", deviceName: name }, { id: `bt-${name}` });
  dev.player.features = ["effects", "kiosk"];
  const k: KioskBoard = {
    dev,
    secret: "",
    state: { enabled: false, idleTimeoutS: 120, idleRemainingS: 0, ownerUnlocked: false, ...kiosk },
    push: () => undefined,
  };
  let replyFn: ((m: ServerMessage) => void) | null = null;
  const status = (event = "KIOSK_EVENT_NONE"): ServerMessage =>
    ({ type: "kiosk_status", ...k.state, event }) as unknown as ServerMessage;
  const base = dev.player.handle.bind(dev.player);
  dev.player.handle = (msg, reply) => {
    replyFn = reply;
    switch (msg.type) {
      case "get_kiosk_status":
        dev.player.received.push(msg);
        reply(status());
        return;
      case "kiosk_unlock":
        dev.player.received.push(msg);
        if (msg["secret"] !== k.secret) {
          reply({ type: "error", code: "kiosk_bad_secret", message: "bad secret" } as ServerMessage);
          return;
        }
        k.state["ownerUnlocked"] = true;
        reply(status());
        return;
      case "set_kiosk_config":
        dev.player.received.push(msg);
        if (k.state["enabled"] && !k.state["ownerUnlocked"]) {
          reply({ type: "error", code: "kiosk_locked", message: "locked" } as ServerMessage);
          return;
        }
        if (typeof msg["ownerSecret"] === "string" && msg["ownerSecret"]) k.secret = msg["ownerSecret"];
        if (msg["enabled"] !== undefined) k.state["enabled"] = msg["enabled"];
        if (msg["idleTimeoutS"]) k.state["idleTimeoutS"] = msg["idleTimeoutS"];
        if (msg["captureAttractFromCurrent"]) {
          k.state["hasAttract"] = true;
          k.state["attractName"] = "boo-pumpkin-glow";
        }
        k.state["idleRemainingS"] = k.state["enabled"] ? k.state["idleTimeoutS"] : 0;
        reply(status("KIOSK_EVENT_CONFIG"));
        return;
      default:
        base(msg, reply);
    }
  };
  k.push = (extra) => {
    Object.assign(k.state, extra);
    replyFn?.(status(String(extra["event"] ?? "KIOSK_EVENT_NONE")));
  };
  return k;
}

const fakeRouter = { navigate: (p: string) => (location.hash = `#${p}`) } as unknown as Router;

test("the onboarding pumpkin opens a SpookySplanc chooser, connects over GATT and enters play mode", async () => {
  const k = spookyBoard("SpookySplanc1", { enabled: true, idleRemainingS: 102 });
  bt = installBluetooth(() => k.dev);
  kioskStore.start();
  const screen = OnboardingScreen(fakeRouter);
  document.body.appendChild(screen.el);

  button("Play with the Halloween lights", screen.el).click();
  assert.equal(bt.requests.length, 1, "the chooser opened inside the click (user gesture)");
  assert.deepEqual(bt.requests[0], {
    filters: [{ namePrefix: "SpookySplanc" }],
    optionalServices: [PLAYER_SERVICE_UUID, IMPROV_SERVICE],
  });
  assert.equal(location.hash, "#/play");
  await advance(1000);

  assert.equal(appState.status.state, "connected");
  assert.equal(appState.client?.url, "ble:bt-SpookySplanc1");
  assert.equal(connectAttempt().state, "started");
  assert.equal(k.dev.player.count("get_kiosk_status"), 1, "kiosk status read right after connect");
  assert.equal(kioskStore.active, true);
  assert.ok(Math.abs(kioskStore.remaining() - 102) < 1.5, `remaining ${kioskStore.remaining()}`);
  screen.onUnmount?.();
});

test("exact fixture name from the QR link filters the chooser to that board", async () => {
  const k = spookyBoard("SpookySplanc2");
  bt = installBluetooth(() => k.dev);
  const conn = await connectHalloweenFixture({ name: "SpookySplanc2" });
  assert.deepEqual((bt.requests[0] as { filters: unknown }).filters, [{ name: "SpookySplanc2" }]);
  assert.equal(conn.label, "SpookySplanc2");
  await advance(1000);
  assert.equal(appState.status.state, "connected");
});

test("the countdown restarts on visitor activity and a REVERTED push fires the revert notice", async () => {
  const k = spookyBoard("SpookySplanc1", { enabled: true, idleRemainingS: 30 });
  bt = installBluetooth(() => k.dev);
  kioskStore.start();
  await connectHalloweenFixture({});
  await advance(1000);
  assert.ok(kioskStore.remaining() <= 30);

  await advance(10_000);
  assert.ok(kioskStore.remaining() < 21);
  appState.client!.setUniforms([{ slot: 0, value: [0.5] }], false);
  assert.ok(kioskStore.remaining() > 119, "local activity restarts the full timer");

  const reverts: string[] = [];
  const off = kioskStore.onRevert((s) => reverts.push(s.attractName));
  k.push({ idleRemainingS: 0, attractActive: true, attractName: "boo-pumpkin-glow", event: "KIOSK_EVENT_REVERTED" });
  await settle();
  assert.deepEqual(reverts, ["boo-pumpkin-glow"]);
  assert.equal(kioskStore.remaining(), 0, "the show is on: no countdown");
  off();
});

test("owner section: enable kiosk with a secret generated on this phone, then unlock on a later connection", async () => {
  const k = spookyBoard("SpookySplanc1");
  bt = installBluetooth(() => k.dev);
  kioskStore.start();
  await connectHalloweenFixture({});
  await advance(1000);
  const client = appState.client!;

  const section = KioskSection(client);
  document.body.appendChild(section);
  await settle();
  // Turn it on: the switch, then Apply (capture is pre-checked when enabling).
  asFake(section).querySelector(".k-switch")!.click();
  button("Apply", section).click();
  await settle(8);
  const set = k.dev.player.received.filter((m) => m.type === "set_kiosk_config");
  assert.equal(set.length, 1);
  assert.equal(set[0]!["enabled"], true);
  assert.equal(set[0]!["idleTimeoutS"], 120);
  assert.equal(set[0]!["captureAttractFromCurrent"], true);
  const secret = kioskSecretFor("58:E6:C5:00:0B:01");
  assert.match(secret ?? "", /^[0-9a-f]{32}$/);
  assert.equal(set[0]!["ownerSecret"], secret, "the device got the secret this phone keeps");
  assert.equal(kioskStore.active, true);

  // A later (locked) connection: Apply unlocks with the stored secret first.
  k.state["ownerUnlocked"] = false;
  const again = KioskSection(client);
  document.body.appendChild(again);
  await settle(8);
  button("Apply", again).click();
  await settle(12);
  const unlocks = k.dev.player.received.filter((m) => m.type === "kiosk_unlock");
  assert.equal(unlocks.length, 1);
  assert.equal(unlocks[0]!["secret"], secret);
  assert.equal(k.dev.player.received.filter((m) => m.type === "set_kiosk_config").length, 2);
});
