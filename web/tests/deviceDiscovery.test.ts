/**
 * Discovering remembered players on the LAN (FUG-66 / #114 / #125): the device
 * list shows which known devices answer on this network right now — probed over
 * the same wss the app uses, by reading each device's `welcome` — and offers the
 * matching next step per row: Connect (open the LAN connection) for a device that
 * answers; for one that does not, what to do about it (D-219: a network move
 * needs its Wi-Fi set up again over Bluetooth, never a reflash). A
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
import { discovery, type FoundFixture } from "../src/net/discovery";
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
  discovery.reset();
});

/** A fixture as the native mDNS browse reports it. */
function heard(name: string, host: string, mac: string): FoundFixture {
  return { key: mac, id: mac, name, host, url: `wss://${host}/ws`, source: "mdns", seenAt: Date.now() };
}

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
  const polled = deviceProber.probeAllNow(); // a one-shot poll of every device
  await advance(10_500);
  await polled;

  assert.deepEqual(rowState("Kitchen"), { dot: "reachable", meta: "on this network" });
  assert.equal(row("Kitchen").querySelector(".device-url")!.getAttribute("title"), "10.0.0.41", "the address is a tooltip");
  assert.deepEqual(rowState("Porch"), { dot: "offline", meta: "Can't reach it" });
  buttonTitled("Connect", row("Kitchen")); // a reachable device offers a LAN connect…
  // …an unreachable one says what to do, and offers Wi-Fi set-up over Bluetooth.
  assert.match(row("Porch").querySelector(".device-stale-text")!.textContent, /No need to flash it again/);
  buttonTitled("Set up Porch's Wi-Fi again over Bluetooth", row("Porch"));
  assert.equal(row("Kitchen").querySelector(".device-stale"), null, "a reachable one has no note");
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

test("the connected fixture's row leads on to the effects: one primary Choose an effect (D-219)", async () => {
  lan.add("10.0.0.47", { mac: "58:E6:C5:00:00:47", deviceName: "Den" });
  appState.connect("wss://10.0.0.47/ws");
  await settle();
  location.hash = "";
  openDeviceSheet();

  const next = all(".device-next");
  assert.equal(next.length, 1, "under the connected row only");
  assert.equal(next[0]!.textContent.trim(), "Choose an effect");
  assert.ok(next[0]!.closest(".device-row") === row("Den"));
  assert.ok(
    all(".connect-actions .k-btn").every((b) => b.classList.contains("k-btn--quiet")),
    "Connect / Flash step down: one primary action in the sheet",
  );
  next[0]!.click();
  assert.equal(location.hash, "#/effects");
  await advance(400); // the sheet's close transition
  assert.equal(all(".k-sheet").length, 0, "the sheet closed");
});

test("before a known device was looked for, its row says so instead of Can't reach it (D-219)", () => {
  known("10.0.0.48", "58:E6:C5:00:00:48", "Loft");
  openDeviceSheet(); // the look starts now; nothing has answered or timed out yet
  assert.deepEqual(rowState("Loft"), { dot: "offline", meta: "Looking for it…" });
  assert.equal(row("Loft").querySelector(".device-stale"), null);
});

test("Set up Wi-Fi again on an unreachable device opens the Bluetooth set-up sheet (D-219) [rr:PR-13]", async () => {
  known("10.0.0.49", "58:E6:C5:00:00:49", "Cellar"); // moved to another Wi-Fi
  openDeviceSheet();
  await advance(10_500);
  await settle();

  buttonTitled("Set up Cellar's Wi-Fi again over Bluetooth", row("Cellar")).click();
  await settle();
  assert.ok(
    all(".k-sheet-head h2").some((h) => h.textContent === "Set up a new fixture"),
    "straight into Bluetooth → Wi-Fi set-up, where the new network is chosen",
  );
});

test("a known device that comes online later is discovered in the background [rr:PR-13]", async () => {
  dom.document.hidden = false;
  known("10.0.0.43", "58:E6:C5:00:00:43", "Shed");

  openDeviceSheet(); // asks the background prober for a prompt look
  await advance(11_000, 500);
  assert.equal(rowState("Shed").dot, "offline", "not on the LAN yet");

  lan.add("10.0.0.43", { mac: "58:E6:C5:00:00:43", deviceName: "Shed" }); // powered on
  await advance(130_000, 500);

  assert.deepEqual(rowState("Shed"), { dot: "reachable", meta: "on this network" });
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
  assert.deepEqual(rowState("Hall"), { dot: "reachable", meta: "on this network" });
  buttonTitled("Connect", row("Hall"));
  assert.equal(lan.liveTo("10.0.0.44"), 0, "the probe closed its socket");
});

test("Find over Bluetooth on a Bluetooth-only device opens the Improv chooser [rr:PR-13]", async () => {
  deviceStore.upsert("ble:attic-1", "Attic"); // only ever reached over Bluetooth
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

test("fixtures heard on the network appear by themselves, and Connect opens them (D-72) [rr:PR-13]", async () => {
  lan.add("10.0.0.60", { mac: "58:E6:C5:00:00:60", deviceName: "Porch Arch" });
  openDeviceSheet();
  assert.equal(all(".device-row").length, 0, "nothing known, nothing heard yet");

  discovery.report(heard("Porch Arch", "10.0.0.60", "58:E6:C5:00:00:60")); // an mDNS advert arrives
  assert.deepEqual(rowState("Porch Arch"), { dot: "reachable", meta: "on this network · 10.0.0.60" });
  assert.ok(all(".device-add-label").some((l) => l.textContent === "On this network"), "under its own heading");

  buttonTitled("Connect to Porch Arch").click();
  await settle();
  assert.equal(appState.status.state, "connected");
  assert.equal(appState.client?.url, "wss://10.0.0.60/ws");
  assert.equal(deviceStore.list().length, 1, "now a known device");
  assert.equal(all(".device-row").length, 1, "listed once: the heard fixture folded into the known one");
  buttonTitled("Disconnect", row("Porch Arch"));
});

test("a known device heard at a new address is shown there and connects there (D-72) [rr:PR-13]", async () => {
  known("10.0.0.41", "58:E6:C5:00:00:41", "Kitchen");
  lan.add("10.0.0.99", { mac: "58:E6:C5:00:00:41", deviceName: "Kitchen" }); // DHCP moved it
  openDeviceSheet();
  discovery.report(heard("Kitchen", "10.0.0.99", "58:E6:C5:00:00:41"));

  assert.deepEqual(rowState("Kitchen"), { dot: "reachable", meta: "on this network" });
  assert.equal(all(".device-row").length, 1, "matched by MAC, not listed as new");
  buttonTitled("Connect", row("Kitchen")).click();
  await settle();
  assert.equal(appState.client?.url, "wss://10.0.0.99/ws");
});

test("the device sheet has one labelled Connect and a separate Flash button, no icon row (D-72)", () => {
  openDeviceSheet();
  const actions = all(".connect-actions .k-btn").map((b) => b.textContent.trim());
  assert.deepEqual(actions, ["Connect a fixture", "Flash a new device"]);
  assert.equal(all(".device-add .k-iconbtn").length, 0, "no unlabeled icon buttons");
});
