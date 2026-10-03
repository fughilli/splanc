/**
 * Discovering remembered players on the LAN (FUG-66 / #114 / #125): the device
 * list shows which known devices answer on this network right now — probed over
 * the same wss the app uses, by reading each device's `welcome` — and offers the
 * matching next step per row: Connect (open the LAN connection) for a device that
 * answers, Find over Bluetooth (Improv re-discovery) for one that does not. A
 * device that comes online later is picked up by the background prober, and a
 * device the app just disconnected from is re-probed at once.
 *
 * Drives the real prober + device sheet against simulated players reachable
 * through a stand-in WebSocket (tests/deviceFakes.ts), under the fake DOM and
 * node:test's mocked timers.
 */

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { installFakeDom, type FakeElement } from "./fakeDom";

const dom = installFakeDom();
// One mocked-timer session for the whole file (see deviceIdentity.test.ts).
mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
after(() => mock.timers.reset());

import { deviceProber } from "../src/net/deviceProber";
import { IMPROV_SERVICE } from "../src/net/improv";
import { deviceStore } from "../src/store/deviceStore";
import { appState } from "../src/ui/app/state";
import { openDeviceSheet } from "../src/ui/screens/deviceSheet";
import {
  FakeLan,
  advance,
  all,
  buttonTitled,
  clearOverlays,
  installBluetooth,
  settle,
  toasts,
} from "./deviceFakes";

let lan: FakeLan;
let restoreWs: () => void = () => undefined;

beforeEach(() => {
  dom.document.hidden = true; // background prober parked unless a test wakes it
  localStorage.clear();
  lan = new FakeLan();
  restoreWs = lan.install();
});

afterEach(async () => {
  clearOverlays();
  appState.disconnect();
  await settle();
  appState.disconnect();
  await settle();
  dom.document.hidden = true;
  restoreWs();
  localStorage.clear();
});

/** Remember a device the way a past connection left it. */
function known(host: string, mac: string, name: string): string {
  const rec = deviceStore.upsert(`wss://${host}/ws`);
  deviceStore.applyWelcome(rec.id, { mac, deviceName: name });
  return rec.id;
}

/** The device-list row showing `name`. */
function row(name: string): FakeElement {
  const r = all(".device-row").find((el) => el.querySelector(".device-name")?.textContent === name);
  assert.ok(r, `a row for ${name}`);
  return r;
}

function rowState(name: string): { dot: string | undefined; meta: string } {
  const r = row(name);
  return {
    dot: r.querySelector(".device-dot")!.dataset["state"],
    meta: r.querySelector(".device-url")!.textContent,
  };
}

test("the device list marks which known devices answer on this network [rr:PR-13]", async () => {
  known("10.0.0.41", "58:E6:C5:00:00:41", "Kitchen");
  known("10.0.0.42", "58:E6:C5:00:00:42", "Porch");
  lan.add("10.0.0.41", { mac: "58:E6:C5:00:00:41", deviceName: "Kitchen" }); // Porch is off the LAN

  openDeviceSheet();
  const polled = deviceProber.probeAllNow(); // the sheet's pull-to-refresh poll
  await advance(10_500);
  await polled;

  assert.deepEqual(rowState("Kitchen"), { dot: "reachable", meta: "on this network · 10.0.0.41" });
  assert.deepEqual(rowState("Porch"), { dot: "offline", meta: "10.0.0.42" });
  buttonTitled("Connect", row("Kitchen")); // a reachable device offers a LAN connect…
  buttonTitled("Find over Bluetooth", row("Porch")); // …an unreachable one Bluetooth re-discovery
  assert.equal(lan.liveTo("10.0.0.41") + lan.liveTo("10.0.0.42"), 0, "probe sockets are closed again");
});

test("Connect on a discovered device opens the LAN connection to its address [rr:PR-13]", async () => {
  const id = known("10.0.0.45", "58:E6:C5:00:00:45", "Studio");
  lan.add("10.0.0.45", { mac: "58:E6:C5:00:00:45", deviceName: "Studio" });
  openDeviceSheet();
  await deviceProber.probeAllNow();

  buttonTitled("Connect", row("Studio")).click();
  await settle();

  assert.equal(appState.status.state, "connected");
  assert.equal(appState.client?.url, "wss://10.0.0.45/ws");
  assert.equal(deviceStore.activeId(), id);
  buttonTitled("Disconnect", row("Studio")); // the row now offers to disconnect
});

test("a known device that comes online later is discovered in the background [rr:PR-13]", async () => {
  dom.document.hidden = false;
  known("10.0.0.43", "58:E6:C5:00:00:43", "Shed");

  openDeviceSheet(); // asks the background prober for a prompt look
  await advance(11_000, 500);
  assert.equal(rowState("Shed").dot, "offline", "not on the LAN yet");

  lan.add("10.0.0.43", { mac: "58:E6:C5:00:00:43", deviceName: "Shed" }); // powered on
  await advance(130_000, 500);

  assert.deepEqual(rowState("Shed"), { dot: "reachable", meta: "on this network · 10.0.0.43" });
});

test("a device the app disconnects from is re-probed at once and shown still on the network [rr:PR-13]", async () => {
  lan.add("10.0.0.44", { mac: "58:E6:C5:00:00:44", deviceName: "Hall" });
  appState.connect("wss://10.0.0.44/ws");
  await settle();
  const id = deviceStore.activeId()!;
  openDeviceSheet();

  buttonTitled("Disconnect", row("Hall")).click();
  await settle();

  assert.equal(deviceProber.isReachable(id), true);
  assert.deepEqual(rowState("Hall"), { dot: "reachable", meta: "on this network · 10.0.0.44" });
  buttonTitled("Connect", row("Hall"));
  assert.equal(lan.liveTo("10.0.0.44"), 0, "the probe closed its socket");
});

test("Find over Bluetooth on an unreachable device opens the Improv chooser [rr:PR-13]", async () => {
  known("10.0.0.46", "58:E6:C5:00:00:46", "Attic"); // not answering on the LAN
  const bt = installBluetooth(() => {
    throw new DOMException("User cancelled the requestDevice() chooser.", "NotFoundError");
  });
  try {
    openDeviceSheet();
    buttonTitled("Find over Bluetooth", row("Attic")).click();
    await settle();

    assert.deepEqual(bt.requests, [{ filters: [{ services: [IMPROV_SERVICE] }] }]);
    assert.deepEqual(toasts(), [], "dismissing the chooser is not reported as an error");
  } finally {
    bt.restore();
  }
});
