/**
 * Browser onboarding of a player (FUG-66 / FUG-92 / #177): the add-device sheet
 * provisions a new board end to end — pick the Wi-Fi network, pick the board in
 * the Bluetooth chooser (filtered to the Improv service), send the credentials
 * over Improv, then open the LAN (wss) connection to the address the board
 * reports — or connects straight to a typed wss address. The native (Capacitor)
 * wrapper provisions through its Bluetooth plugin with the same Improv state
 * machine, and the HITL app-driver substitutes the virtual Improv board at the
 * same seam (an untraced test-plumbing case: the provisioning path itself is
 * PR-13's first case).
 *
 * Simulated boards answer over the real wire (tests/deviceFakes.ts) behind a
 * stand-in Web Bluetooth / WebSocket / Capacitor plugin, under the fake DOM and
 * node:test's mocked timers — no radio, no network, no real sleeps.
 */

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { installFakeDom, typeInto, type FakeElement } from "./fakeDom";

const dom = installFakeDom();
// One mocked-timer session for the whole file: the app singletons (connection
// manager, liveness prober) keep timer handles across tests, and clearing a handle
// from an earlier MockTimers session corrupts the next session's queue.
mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
after(() => mock.timers.reset());

import { setDriverActive } from "../src/driver/guard";
import { improvDeviceById } from "../src/net/capacitorImprov";
import {
  IMPROV_SERVICE,
  ImprovError,
  buildWifiSettings,
  provisionViaBle,
  requestImprovDevice,
} from "../src/net/improv";
import { deviceStore } from "../src/store/deviceStore";
import { prefs } from "../src/store/prefs";
import { appState } from "../src/ui/app/state";
import { bleRediscover, openAddDevice } from "../src/ui/screens/addDevice";
import { wifiDraft } from "../src/store/wifiDraft";
import {
  FakeCapacitorBle,
  FakeImprovDevice,
  FakeLan,
  advance,
  all,
  button,
  clearOverlays,
  installBluetooth,
  outcome,
  parseWifiSettings,
  settle,
  toasts,
} from "./deviceFakes";

let lan: FakeLan;
let restoreWs: () => void = () => undefined;

beforeEach(() => {
  // Park the background liveness prober (it only probes a visible tab); tests
  // that exercise it call it directly.
  dom.document.hidden = true;
  localStorage.clear();
  wifiDraft.clear();
  lan = new FakeLan();
  restoreWs = lan.install();
});

afterEach(async () => {
  clearOverlays();
  appState.disconnect();
  await settle();
  appState.disconnect(); // clears a reconnect watch armed by a failure that landed during the settle
  await settle();
  restoreWs();
  localStorage.clear();
  delete (globalThis as { prompt?: unknown }).prompt;
});

/** Fill the add-device sheet's Wi-Fi fields. */
function enterWifi(ssid: string, password: string): void {
  const [ssidInput, passInput] = all(".wifi-sheet .sheet-input");
  typeInto(ssidInput!, ssid);
  typeInto(passInput!, password);
}

test("adding a device over Bluetooth provisions it and connects to the address it reports [rr:PR-13]", async () => {
  const board = new FakeImprovDevice({
    id: "bt-new",
    name: "Led Widget 5EED01",
    redirect: ["http://192.168.1.50/"],
  });
  const bt = installBluetooth(() => board);
  lan.add("192.168.1.50", { mac: "58:E6:C5:5E:ED:01", deviceName: "Led Widget 5EED01" });
  try {
    openAddDevice("ble");
    enterWifi("HomeNet", "hunter22");
    button("Scan for device").click();
    await advance(1500);

    assert.deepEqual(bt.requests, [{ filters: [{ services: [IMPROV_SERVICE] }] }], "chooser lists Improv boards only");
    assert.equal(board.delivered.length, 1, "credentials sent once");
    assert.deepEqual(parseWifiSettings(board.delivered[0]!), { ssid: "HomeNet", password: "hunter22" });

    assert.equal(appState.status.state, "connected");
    assert.equal(appState.client?.url, "wss://192.168.1.50/ws", "connected over wss to the reported address");
    const rec = deviceStore.active()!;
    assert.equal(rec.wssUrl, "wss://192.168.1.50/ws");
    assert.equal(rec.label, "Led Widget 5EED01");
    assert.equal(rec.bleMac, "58:E6:C5:5E:ED:01");
    assert.equal(rec.bleId, "bt-new", "the record remembers which Bluetooth device it is");
    assert.deepEqual(prefs.getWifiList()[0], { ssid: "HomeNet", password: "hunter22" }, "network remembered");
    assert.ok(toasts().includes("Device provisioned"));
    assert.equal(all(".k-sheet").length, 0, "the add-device sheet closed");
  } finally {
    bt.restore();
  }
});

test("a board that cannot join the network says why, and nothing is saved or connected [rr:PR-13]", async () => {
  const board = new FakeImprovDevice({ errorCode: 0x03 });
  const bt = installBluetooth(() => board);
  try {
    openAddDevice("ble");
    enterWifi("HomeNet", "wrong-password");
    button("Scan for device").click();
    await advance(1500);

    assert.equal(
      all(".wifi-status")[0]?.textContent,
      "Setup failed: unable to connect to the network (check SSID/password)",
    );
    assert.deepEqual(prefs.getWifiList(), [], "a network the board could not join is not remembered");
    assert.deepEqual(deviceStore.list(), [], "no device record");
    assert.equal(lan.sockets.length, 0, "no connection attempted");
    assert.equal(button("Try again").disabled, false, "the user can retry from the same sheet");
    assert.equal(all(".k-sheet").length, 1, "the sheet stays open");
  } finally {
    bt.restore();
  }
});

/** The add-device sheet's SSID + password inputs. */
function wifiFields(): { ssid: FakeElement; pass: FakeElement } {
  const [ssid, pass] = all(".wifi-sheet .sheet-input");
  return { ssid: ssid!, pass: pass! };
}

/** Visible (not [hidden]) buttons in the add-device sheet, by label text. */
function visibleButtons(): string[] {
  return all(".wifi-sheet .k-btn")
    .filter((b) => !b.hidden)
    .map((b) => b.textContent.trim());
}

test("a mistyped password returns to the password field, and the corrected one joins without re-picking the device", async () => {
  const board = new FakeImprovDevice({ id: "bt-pw", password: "hunter22", redirect: ["http://192.168.1.51/"] });
  const bt = installBluetooth(() => board);
  lan.add("192.168.1.51", { mac: "58:E6:C5:5E:ED:51", deviceName: "Porch" });
  try {
    openAddDevice("ble");
    enterWifi("HomeNet", "hunter2");
    button("Scan for device").click();
    await advance(1500);

    const status = all(".wifi-status")[0]!;
    assert.equal(status.textContent, 'Wrong Wi-Fi password: "HomeNet" rejected it. Check the password and try again.');
    assert.ok(status.classList.contains("wifi-status--error"), "shown as an error");
    const { ssid, pass } = wifiFields();
    assert.equal(document.activeElement, pass as unknown as Element, "the password field has focus");
    assert.equal(pass.disabled, false);
    assert.equal(ssid.value, "HomeNet", "what was typed is still there");
    assert.equal(pass.value, "hunter2");
    assert.deepEqual(visibleButtons(), ["Try again", "Choose a different device"], "one primary, one secondary");
    assert.deepEqual(prefs.getWifiList(), [], "a refused password is not saved");
    assert.equal(board.disconnects, 0, "the link stays up for the retry");

    typeInto(pass, "hunter22");
    button("Try again").click();
    await advance(1500);

    assert.equal(bt.requests.length, 1, "no second Bluetooth chooser");
    assert.equal(board.delivered.length, 2);
    assert.deepEqual(parseWifiSettings(board.delivered[1]!), { ssid: "HomeNet", password: "hunter22" });
    assert.equal(appState.client?.url, "wss://192.168.1.51/ws");
    assert.deepEqual(prefs.getWifiList()[0], { ssid: "HomeNet", password: "hunter22" });
    assert.equal(all(".k-sheet").length, 0, "the sheet closed on success");
  } finally {
    bt.restore();
  }
});

test("a network the device can't hear returns to the SSID field and says so", async () => {
  const board = new FakeImprovDevice({ errorCode: 0x03, errorReason: 0x01 });
  const bt = installBluetooth(() => board);
  try {
    openAddDevice("ble");
    enterWifi("HomeNet-5G", "hunter22");
    button("Scan for device").click();
    await advance(1500);

    assert.equal(
      all(".wifi-status")[0]?.textContent,
      'The device can\'t find "HomeNet-5G". Check the network name, and that it\'s a 2.4 GHz network in range.',
    );
    assert.equal(document.activeElement, wifiFields().ssid as unknown as Element, "the SSID field has focus");
  } finally {
    bt.restore();
  }
});

test("backing out keeps what was typed: reopening the sheet shows it again", async () => {
  prefs.addWifi({ ssid: "SavedNet", password: "saved-pass" });
  openAddDevice("ble");
  assert.equal(wifiFields().ssid.value, "SavedNet", "first open: the most recent saved network");
  enterWifi("CafeNet", "typo-pass");
  clearOverlays(); // the user closes the sheet

  openAddDevice("ble");
  assert.equal(wifiFields().ssid.value, "CafeNet", "reopened with the typed SSID");
  assert.equal(wifiFields().pass.value, "typo-pass", "and the typed password");
  clearOverlays();

  // The same draft serves the by-address flow.
  openAddDevice("manual");
  assert.equal(wifiFields().ssid.value, "CafeNet");
});

test("while waiting for the join, 'Edit Wi-Fi details' stops waiting and unlocks the fields", async () => {
  const board = new FakeImprovDevice({ silent: true });
  const bt = installBluetooth(() => board);
  try {
    openAddDevice("ble");
    enterWifi("HomeNet", "hunter2");
    button("Scan for device").click();
    await advance(1500);

    assert.equal(all(".wifi-status")[0]?.textContent, "Waiting for the device to join the network…");
    assert.deepEqual(visibleButtons(), ["Edit Wi-Fi details"], "the only action while waiting");
    assert.equal(wifiFields().pass.disabled, true, "fields locked while the device joins");

    button("Edit Wi-Fi details").click();
    await settle();

    assert.equal(all(".wifi-status")[0]?.textContent, "Stopped waiting. Edit the Wi-Fi details, then try again.");
    assert.ok(!all(".wifi-status")[0]!.classList.contains("wifi-status--error"), "not an error");
    assert.equal(wifiFields().pass.disabled, false);
    assert.equal(document.activeElement, wifiFields().pass as unknown as Element);
    assert.deepEqual(visibleButtons(), ["Try again", "Choose a different device"]);
    assert.equal(board.disconnects, 1, "the BLE link was dropped");

    // The 45 s join timeout of the abandoned wait never fires into the edited form.
    await advance(50_000, 1000);
    assert.equal(all(".wifi-status")[0]?.textContent, "Stopped waiting. Edit the Wi-Fi details, then try again.");
    assert.equal(all(".k-sheet").length, 1);
  } finally {
    bt.restore();
  }
});

test("closing the sheet mid-join stops waiting, drops the link, and keeps the draft", async () => {
  const board = new FakeImprovDevice({ silent: true });
  const bt = installBluetooth(() => board);
  try {
    openAddDevice("ble");
    enterWifi("HomeNet", "hunter2");
    button("Scan for device").click();
    await advance(1500);
    clearOverlays();
    await settle();
    assert.equal(board.disconnects, 1);
    await advance(50_000, 1000);
    assert.ok(!toasts().some((t) => t.includes("timed out")), "no late timeout toast");

    openAddDevice("ble");
    assert.equal(wifiFields().pass.value, "hunter2");
  } finally {
    bt.restore();
  }
});

test("re-discover with a saved password the network now refuses opens the Wi-Fi dialog on the password", async () => {
  prefs.addWifi({ ssid: "HomeNet", password: "old-pass" });
  const board = new FakeImprovDevice({ id: "bt-re", password: "new-pass", redirect: ["http://192.168.1.52/"] });
  const bt = installBluetooth(() => board);
  lan.add("192.168.1.52", { mac: "58:E6:C5:5E:ED:52", deviceName: "Den" });
  try {
    bleRediscover();
    await advance(1500);

    assert.equal(all(".k-sheet").length, 1, "the Wi-Fi dialog opened");
    assert.match(all(".wifi-status")[0]!.textContent, /^Wrong Wi-Fi password/);
    assert.equal(wifiFields().pass.value, "old-pass");
    assert.equal(document.activeElement, wifiFields().pass as unknown as Element);

    typeInto(wifiFields().pass, "new-pass");
    button("Try again").click();
    await advance(1500);
    assert.equal(bt.requests.length, 1, "the picked device is re-used");
    assert.equal(appState.client?.url, "wss://192.168.1.52/ws");
    assert.deepEqual(prefs.getWifiList()[0], { ssid: "HomeNet", password: "new-pass" });
  } finally {
    bt.restore();
  }
});

test("adding a device by address connects to the typed wss URL [rr:PR-13]", async () => {
  lan.add("192.168.1.77", { mac: "58:E6:C5:00:01:77", deviceName: "Hall" });
  const asked: string[] = [];
  (globalThis as { prompt?: unknown }).prompt = (message: string): string => {
    asked.push(message);
    return "wss://192.168.1.77/ws";
  };

  openAddDevice("manual");
  enterWifi("HomeNet", "hunter22");
  button("Enter address").click();
  await settle();

  assert.equal(asked.length, 1, "asked for the address once");
  assert.equal(appState.status.state, "connected");
  assert.equal(appState.client?.url, "wss://192.168.1.77/ws");
  const rec = deviceStore.active()!;
  assert.equal(rec.wssUrl, "wss://192.168.1.77/ws");
  assert.equal(rec.label, "Hall", "the device's own name replaces the host label");
  assert.deepEqual(prefs.getWifiList()[0], { ssid: "HomeNet", password: "hunter22" });
});

test("an address without a ws:// or wss:// scheme is rejected without connecting [rr:PR-13]", async () => {
  (globalThis as { prompt?: unknown }).prompt = (): string => "192.168.1.77";

  openAddDevice("manual");
  enterWifi("HomeNet", "hunter22");
  button("Enter address").click();
  await settle();

  assert.ok(toasts().includes("Address must start with ws:// or wss://"));
  assert.equal(lan.sockets.length, 0);
  assert.deepEqual(deviceStore.list(), []);
  assert.equal(appState.client, null);
});

test("the native app provisions through the Capacitor Bluetooth plugin with the same Improv exchange [rr:PR-13]", async () => {
  const plugin = new FakeCapacitorBle();
  plugin.redirect = "http://192.168.1.88/";
  const undo = plugin.install();
  try {
    const device = await improvDeviceById("ios-peripheral-7", "splanc-kitchen");
    assert.equal(device.id, "ios-peripheral-7");
    assert.equal(device.name, "splanc-kitchen");

    const result = provisionViaBle(device, "HomeNet", "hunter22");
    await advance(1000);

    assert.deepEqual(await outcome(result), { state: "fulfilled", value: ["http://192.168.1.88/"] });
    // Subscribe to RPC_RESULT + ERROR_STATE before writing the RPC command, and drop
    // the BLE link once the redirect arrives (frees the player's shared radio for the
    // wss TLS handshake that follows — net/improv.ts provisionViaBle).
    assert.deepEqual(plugin.calls, [
      "connect:ios-peripheral-7",
      "notify:8004",
      "notify:8002",
      "write:8003",
      "disconnect:ios-peripheral-7",
    ]);
    assert.equal(plugin.writes.length, 1);
    assert.deepEqual(Array.from(plugin.writes[0]!.bytes), Array.from(buildWifiSettings("HomeNet", "hunter22")));
  } finally {
    undo();
  }
});

test("the native app hears a rejected password too, and the corrected re-send joins on the same link", async () => {
  const plugin = new FakeCapacitorBle();
  plugin.redirect = "http://192.168.1.89/";
  plugin.password = "hunter22";
  const undo = plugin.install();
  try {
    const device = await improvDeviceById("ios-peripheral-8", "splanc-hall");
    const first = provisionViaBle(device, "HomeNet", "hunter2");
    first.catch(() => undefined); // graded below; no unhandled-rejection noise meanwhile
    await advance(1000);
    const r = await outcome(first);
    assert.equal(r.state, "rejected");
    assert.ok((r as { reason: unknown }).reason instanceof ImprovError);
    assert.equal(((r as { reason: unknown }).reason as ImprovError).kind, "wrong-password");
    assert.ok(!plugin.calls.includes("disconnect:ios-peripheral-8"), "the link stays up for the retry");

    const second = provisionViaBle(device, "HomeNet", "hunter22");
    await advance(1000);
    assert.deepEqual(await outcome(second), { state: "fulfilled", value: ["http://192.168.1.89/"] });
  } finally {
    undo();
  }
});

test("the HITL app driver provisions its virtual Improv board through the production path", async () => {
  setDriverActive(true);
  try {
    const device = await requestImprovDevice();
    assert.equal(device.id, "virtual-improv-device");
    const result = provisionViaBle(device, "FugLink", "bigblinkycube");
    await advance(1000);
    assert.deepEqual(await outcome(result), { state: "fulfilled", value: ["http://192.168.1.50/"] });
  } finally {
    setDriverActive(false);
  }
});
