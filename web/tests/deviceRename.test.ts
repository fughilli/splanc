/**
 * Renaming a player from the browser (FUG-85 / #60, FUG-83): the device card's
 * display name is edited in place — Enter or the save button commits, Escape or
 * tapping away cancels, a blank name is refused — and the new name is pushed to
 * the player (which persists it and re-advertises it over Bluetooth) right away
 * when connected, or saved and queued for the next connection when not.
 *
 * Drives the real device sheet + card against simulated players speaking the
 * protobuf wire (tests/deviceFakes.ts), under the fake DOM and node:test's
 * mocked timers.
 */

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { fire, installFakeDom, textOf, typeInto, type FakeElement } from "./fakeDom";

const dom = installFakeDom();
// One mocked-timer session for the whole file (see deviceIdentity.test.ts).
mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
after(() => mock.timers.reset());

import { deviceStore } from "../src/store/deviceStore";
import { appState } from "../src/ui/app/state";
import { openDeviceSheet } from "../src/ui/screens/deviceSheet";
import { FakeLan, all, buttonTitled, clearOverlays, settle, toasts, type FakePlayer } from "./deviceFakes";

let lan: FakeLan;
let restoreWs: () => void = () => undefined;

beforeEach(() => {
  dom.document.hidden = true; // park the background liveness prober
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
  restoreWs();
  localStorage.clear();
});

/** Connect to a simulated player and return it. */
async function connected(host: string, mac: string, name: string): Promise<FakePlayer> {
  const player = lan.add(host, { mac, deviceName: name });
  appState.connect(`wss://${host}/ws`);
  await settle();
  assert.equal(appState.status.state, "connected");
  return player;
}

/** Open the device list, then the (only) device's card, and start editing its
 * name; returns the name input. */
function startRename(): FakeElement {
  if (all(".device-detail").length === 0) {
    openDeviceSheet();
    buttonTitled("Options").click();
  }
  buttonTitled("Rename", all(".device-detail")[0]).click();
  const input = all(".device-name-input")[0];
  assert.ok(input, "the name became editable");
  return input;
}

test("renaming a connected device from its card renames the device live [rr:PR-13]", async () => {
  const player = await connected("10.0.0.70", "AA:BB:CC:00:00:70", "Led Widget 000070");
  const id = deviceStore.activeId()!;

  const input = startRename();
  typeInto(input, "Porch Light");
  fire(input, "keydown", { key: "Enter" });
  await settle();

  assert.deepEqual(player.renames(), ["Porch Light"], "set_device_name reached the device");
  assert.equal(player.identity.deviceName, "Porch Light");
  const rec = deviceStore.get(id)!;
  assert.equal(rec.label, "Porch Light");
  assert.equal(rec.pendingName, undefined, "nothing left queued once the device confirmed");
  assert.ok(toasts().includes("Device renamed"));
  assert.equal(textOf(all(".device-name-val")[0]), "Porch Light", "the card shows the new name");
  assert.ok(
    all(".device-row .device-name").some((n) => n.textContent === "Porch Light"),
    "so does the device list",
  );
});

test("renaming a device that is not connected saves the name now and queues it for the device [rr:PR-13]", async () => {
  const rec = deviceStore.upsert("wss://10.0.0.71/ws");
  deviceStore.applyWelcome(rec.id, { mac: "AA:BB:CC:00:00:71", deviceName: "Led Widget 000071" });

  const input = startRename();
  typeInto(input, "Garage");
  fire(input, "keydown", { key: "Enter" });
  await settle();

  const saved = deviceStore.get(rec.id)!;
  assert.equal(saved.label, "Garage", "shown immediately");
  assert.equal(saved.pendingName, "Garage", "queued for the next connection");
  assert.ok(toasts().includes("Name saved — applies on next connection"));
  assert.equal(lan.sockets.length, 0, "no connection is opened just to rename");
});

test("Escape or tapping away cancels a rename and nothing reaches the device [rr:PR-13]", async () => {
  const player = await connected("10.0.0.72", "AA:BB:CC:00:00:72", "Led Widget 000072");
  const id = deviceStore.activeId()!;

  let input = startRename();
  typeInto(input, "Nope");
  fire(input, "keydown", { key: "Escape" });
  input = startRename();
  typeInto(input, "Nope either");
  fire(input, "blur");
  await settle();

  assert.deepEqual(player.renames(), []);
  const rec = deviceStore.get(id)!;
  assert.equal(rec.label, "Led Widget 000072");
  assert.equal(rec.pendingName, undefined);
  assert.equal(textOf(all(".device-name-val")[0]), "Led Widget 000072");
});

test("the save button commits even though tapping it blurs the field first (iOS) [rr:PR-13]", async () => {
  const player = await connected("10.0.0.73", "AA:BB:CC:00:00:73", "Led Widget 000073");

  const input = startRename();
  typeInto(input, "Desk Lamp");
  const save = buttonTitled("Save");
  // WKWebView order: pointerdown on the button, then the input's blur, then click.
  fire(save, "pointerdown");
  fire(input, "blur");
  save.click();
  await settle();

  assert.deepEqual(player.renames(), ["Desk Lamp"], "saved exactly once, not cancelled by the blur");
  assert.equal(deviceStore.active()!.label, "Desk Lamp");
});

test("a blank name is refused and never sent to the device [rr:PR-13]", async () => {
  const player = await connected("10.0.0.74", "AA:BB:CC:00:00:74", "Led Widget 000074");

  const input = startRename();
  typeInto(input, "   ");
  fire(input, "keydown", { key: "Enter" });
  await settle();

  assert.deepEqual(player.renames(), []);
  assert.equal(deviceStore.active()!.label, "Led Widget 000074");
});
