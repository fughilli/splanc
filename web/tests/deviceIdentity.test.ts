/**
 * Device identity reconciliation (FUG-66, #180, FUG-83): the app must recognise
 * the SAME physical player across every way it reaches it — BLE onboarding's
 * mDNS URL, a manual IP, a re-provisioned new IP, a Bluetooth link — by the
 * stable hardware MAC the device reports in `welcome`, never by a URL spelling
 * or an editable name; keep the display name and the device's own (Bluetooth)
 * name in step; and refresh the record when the device's network-facing
 * identity changes (new IP, renamed elsewhere, a cert rotated by a rename).
 *
 * These drive the production stores, the app connection manager and the device
 * screens against simulated players (tests/deviceFakes.ts) that answer over the
 * real protobuf wire through a stand-in WebSocket / Web Bluetooth, under a fake
 * DOM and node:test's mocked timers — no network, no real sleeps.
 */

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { installFakeDom } from "./fakeDom";

const dom = installFakeDom();
// One mocked-timer session for the whole file: the app singletons (connection
// manager, liveness prober) keep timer handles across tests, and clearing a handle
// from an earlier MockTimers session corrupts the next session's queue.
mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
after(() => mock.timers.reset());

import { bleSocketFactory } from "../src/net/bleTransport";
import { deviceProber } from "../src/net/deviceProber";
import { deviceIdForUrl, deviceStore } from "../src/store/deviceStore";
import { prefs } from "../src/store/prefs";
import { appState } from "../src/ui/app/state";
import { bleRediscover } from "../src/ui/screens/addDevice";
import { openDeviceSheet } from "../src/ui/screens/deviceSheet";
import {
  FakeImprovDevice,
  FakeLan,
  FakePlayerGatt,
  advance,
  all,
  button,
  buttonTitled,
  clearOverlays,
  installBluetooth,
  settle,
} from "./deviceFakes";

let lan: FakeLan;
let restoreWs: () => void = () => undefined;

beforeEach(() => {
  // Park the background liveness prober (it only probes a visible tab); tests
  // that exercise it call it directly.
  dom.document.hidden = true;
  localStorage.clear();
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
});

/** Seed the persisted known-devices list the way an older app build left it. */
function seedDevices(records: Array<Record<string, unknown>>): void {
  localStorage.setItem("ledmapper.devices", JSON.stringify(records));
}

/** One persisted known-device record (storage format), keyed like the store keys it. */
function stored(wssUrl: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { id: deviceIdForUrl(wssUrl), wssUrl, named: false, ...fields };
}

test("a player onboarded via mDNS then connected by IP stays one record, keyed by its MAC [rr:PR-35]", async () => {
  // BLE onboarding recorded the board under its mDNS URL; the user filed it.
  const mdns = deviceStore.upsert("wss://ledmapper.local/ws");
  deviceStore.applyWelcome(mdns.id, { mac: "58:E6:C5:11:FC:DA", deviceName: "Kitchen" });
  deviceStore.setFolder(mdns.id, "Downstairs");
  deviceStore.setBleId("wss://ledmapper.local/ws", "bt-kitchen");
  // The same board answers on its LAN IP.
  lan.add("192.168.1.50", { mac: "58:E6:C5:11:FC:DA", deviceName: "Kitchen" });

  appState.connect("wss://192.168.1.50/ws"); // "add device by address"
  await settle();

  assert.equal(appState.status.state, "connected");
  const list = deviceStore.list();
  assert.equal(list.length, 1, "one physical device -> one record");
  const rec = list[0]!;
  assert.equal(rec.wssUrl, "wss://192.168.1.50/ws", "the survivor is the address that just answered");
  assert.equal(rec.bleMac, "58:E6:C5:11:FC:DA");
  assert.equal(rec.label, "Kitchen");
  assert.equal(rec.folder, "Downstairs", "the absorbed record's folder carries over");
  assert.equal(rec.bleId, "bt-kitchen", "the absorbed record's Bluetooth id carries over");
  assert.equal(deviceStore.activeId(), rec.id, "the active selection is the survivor");
});

test("every duplicate sharing the welcome MAC collapses at once, across BLE and URL spellings [rr:PR-35]", async () => {
  const mac = "AA:BB:CC:00:11:22";
  // Three records an older build left for ONE board: a Bluetooth link, its mDNS
  // name and an IP spelled with an explicit port — plus a different board.
  seedDevices([
    stored("ble:bt-porch", { label: "Porch", bleMac: mac, named: true, bleId: "bt-porch" }),
    stored("wss://porch.local/ws", { label: "porch.local", bleMac: mac, folder: "Outside" }),
    stored("wss://10.0.0.7:443/ws", { label: "10.0.0.7:443", bleMac: mac }),
    stored("wss://10.0.0.8/ws", { label: "Garage", bleMac: "DE:AD:BE:EF:00:01", named: true }),
  ]);
  // Older firmware: it reports its MAC but no name.
  lan.add("10.0.0.7", { mac, deviceName: "" });

  appState.connect("wss://10.0.0.7/ws");
  await settle();

  const list = deviceStore.list();
  assert.deepEqual(
    list.map((d) => d.label).sort(),
    ["Garage", "Porch"],
    "the three spellings of the porch board are one record; the garage board is untouched",
  );
  const porch = list.find((d) => d.bleMac === mac)!;
  assert.equal(porch.wssUrl, "wss://10.0.0.7/ws");
  assert.equal(porch.folder, "Outside", "folded from the mDNS record");
  assert.equal(porch.bleId, "bt-porch", "folded from the Bluetooth record");
  assert.equal(porch.named, true, "the user-given name (from the Bluetooth record) survives");
});

test("a user-given name survives when its record is absorbed by an unnamed survivor [rr:PR-35]", () => {
  const mac = "0C:8B:95:12:34:56";
  const mdns = deviceStore.upsert("wss://lamp.local/ws");
  deviceStore.applyWelcome(mdns.id, { mac });
  deviceStore.rename(mdns.id, "Reading Lamp");
  deviceStore.takePending(mdns.id); // pushed to the device already

  // The board, on firmware that reports no name, is now reached by IP.
  const ip = deviceStore.upsert("wss://10.0.0.9/ws");
  assert.equal(ip.label, "10.0.0.9", "a fresh by-address record starts with a host label");
  deviceStore.applyWelcome(ip.id, { mac, deviceName: "" });

  const list = deviceStore.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, ip.id);
  assert.equal(list[0]!.label, "Reading Lamp", "the host fallback must not replace the user's name");
  assert.equal(list[0]!.named, true);
});

test("the device list tells same-named devices apart by MAC suffix, never by name [rr:PR-35]", async () => {
  seedDevices([
    stored("wss://10.0.0.11/ws", { label: "Kitchen", bleMac: "58:E6:C5:11:FC:DA", named: true }),
    stored("wss://10.0.0.12/ws", { label: "Kitchen", bleMac: "58:E6:C5:AB:12:CD", named: true }),
    stored("wss://10.0.0.13/ws", { label: "Garage", bleMac: "58:E6:C5:00:00:13", named: true }),
  ]);
  openDeviceSheet();
  // meta line (host · tag) -> display name, for every row in the list
  const rowMeta = (): Record<string, string> =>
    Object.fromEntries(
      all(".device-row").map((r) => [
        r.querySelector(".device-url")!.textContent,
        r.querySelector(".device-name")!.textContent,
      ]),
    );

  assert.deepEqual(rowMeta(), {
    "10.0.0.11 · 11FCDA": "Kitchen",
    "10.0.0.12 · AB12CD": "Kitchen",
    "10.0.0.13": "Garage",
  });

  // Renaming one of the twins makes every name unique again: the tags go away
  // (they mark a collision; they are derived from the MAC, not the label).
  deviceStore.rename(deviceIdForUrl("wss://10.0.0.12/ws"), "Pantry");
  assert.deepEqual(rowMeta(), { "10.0.0.11": "Kitchen", "10.0.0.12": "Pantry", "10.0.0.13": "Garage" });
});

test("a rename queued offline converges the device's name and its record on reconnect [rr:PR-35]", async () => {
  const mac = "11:22:33:44:55:66";
  const player = lan.add("192.168.1.60", { mac, deviceName: "Led Widget 445566" });
  const rec = deviceStore.upsert("wss://192.168.1.60/ws");
  deviceStore.applyWelcome(rec.id, { mac, deviceName: "Led Widget 445566" });
  deviceStore.rename(rec.id, "Porch"); // offline: shown at once, queued for the device

  const labels: string[] = [];
  const unsub = deviceStore.subscribe(() => labels.push(deviceStore.get(rec.id)?.label ?? "<gone>"));
  appState.connect("wss://192.168.1.60/ws");
  await settle();
  unsub();

  assert.deepEqual(player.renames(), ["Porch"], "the queued name was pushed to the device once");
  assert.equal(player.identity.deviceName, "Porch", "the device (and its Bluetooth name) adopted it");
  const after = deviceStore.get(rec.id)!;
  assert.equal(after.label, "Porch");
  assert.equal(after.pendingName, undefined, "nothing stays queued once the device echoed the name");
  assert.ok(
    !labels.includes("Led Widget 445566"),
    `the display name never flipped back to the device's stale name (saw ${JSON.stringify(labels)})`,
  );
});

test("the liveness probe folds a device's changed name and firmware into its record [rr:PR-35]", async () => {
  const mac = "C0:FF:EE:00:00:21";
  lan.add("10.0.0.21", { mac, deviceName: "Den Lights", fwVersion: "1.3.0", fwGitCommit: "f".repeat(40) });
  const rec = deviceStore.upsert("wss://10.0.0.21/ws");
  deviceStore.applyWelcome(rec.id, { mac, deviceName: "Den", fwVersion: "1.2.0", fwGitCommit: "e".repeat(40) });

  await deviceProber.probeNow(rec.id); // renamed + updated from another phone meanwhile

  const got = deviceStore.get(rec.id)!;
  assert.equal(deviceProber.isReachable(rec.id), true);
  assert.equal(got.label, "Den Lights", "the record follows the device's new name");
  assert.equal(got.fwVersion, "1.3.0");
  assert.equal(got.fwGitCommit, "f".repeat(40));
  assert.equal(got.bleMac, mac, "identity (MAC) unchanged");
  assert.equal(deviceStore.list().length, 1);
});

test("re-discovering a known device warns before provisioning a different physical device [rr:PR-35]", async () => {
  prefs.addWifi({ ssid: "HomeNet", password: "hunter22" });
  const rec = deviceStore.upsert("wss://192.168.1.50/ws");
  deviceStore.applyWelcome(rec.id, { mac: "58:E6:C5:11:FC:DA", deviceName: "Kitchen" });
  deviceStore.setBleId("wss://192.168.1.50/ws", "bt-kitchen");
  const stranger = new FakeImprovDevice({ id: "bt-stranger", name: "Led Widget 0F0F0F" });
  const bt = installBluetooth(() => stranger);
  try {
    bleRediscover(deviceStore.get(rec.id));
    await settle();

    const dialog = all(".k-confirm")[0];
    assert.ok(dialog, "a confirmation is shown before touching the other device");
    assert.match(dialog.textContent, /Different device\?/);
    assert.match(dialog.textContent, /"Kitchen"/);
    button("Cancel", dialog).click();
    await advance(1000);

    assert.equal(stranger.connects, 0, "declining sends nothing to the other device");
    assert.equal(stranger.delivered.length, 0);
    const kept = deviceStore.get(rec.id)!;
    assert.equal(kept.label, "Kitchen");
    assert.equal(kept.bleId, "bt-kitchen");
    assert.equal(deviceStore.list().length, 1);
  } finally {
    bt.restore();
  }
});

test("re-provisioning the same board onto a new IP refreshes its one record to that address [rr:PR-35]", async () => {
  const mac = "58:E6:C5:11:FC:DA";
  prefs.addWifi({ ssid: "HomeNet", password: "hunter22" });
  const rec = deviceStore.upsert("wss://192.168.1.50/ws");
  deviceStore.applyWelcome(rec.id, { mac, deviceName: "Kitchen" });
  deviceStore.setFolder(rec.id, "Downstairs");
  deviceStore.setBleId("wss://192.168.1.50/ws", "bt-kitchen");
  // Same physical board (same Bluetooth id); after joining it got a new lease.
  const board = new FakeImprovDevice({ id: "bt-kitchen", redirect: ["http://192.168.1.77/"] });
  lan.add("192.168.1.77", { mac, deviceName: "Kitchen" });
  const bt = installBluetooth(() => board);
  try {
    bleRediscover(deviceStore.get(rec.id));
    await advance(2000);

    assert.equal(all(".k-confirm").length, 0, "the same board needs no confirmation");
    assert.equal(board.delivered.length, 1, "credentials were sent once");
    assert.equal(appState.status.state, "connected");
    const list = deviceStore.list();
    assert.equal(list.length, 1, "no stale-IP duplicate is left behind");
    assert.equal(list[0]!.wssUrl, "wss://192.168.1.77/ws", "the record now points at the new lease");
    assert.equal(list[0]!.label, "Kitchen");
    assert.equal(list[0]!.folder, "Downstairs");
    assert.equal(list[0]!.bleId, "bt-kitchen");
  } finally {
    bt.restore();
  }
});

test("a Bluetooth entry that never learned its MAC is dropped when its connection fails [rr:PR-35]", async () => {
  const dev = new FakePlayerGatt({ mac: "", deviceName: "Led Widget 9A9A9A" }, { id: "bt-temp" });
  dev.failConnects = 1;
  appState.connect("ble:bt-temp", "Led Widget 9A9A9A", {
    socketFactory: bleSocketFactory(dev),
    coldRetryLimit: 6,
  });
  await settle();

  assert.equal(deviceStore.get(deviceIdForUrl("ble:bt-temp")), undefined, "no orphan provisional record");
  assert.equal(deviceStore.list().length, 0);
  assert.equal(appState.status.error, "Bluetooth connection failed — re-scan to try again");
});

test("a Bluetooth entry already identified by its MAC survives a failed reconnect [rr:PR-35]", async () => {
  const known = deviceStore.upsert("ble:bt-known", "Porch");
  deviceStore.applyWelcome(known.id, { mac: "AA:AA:AA:00:00:01", deviceName: "Porch" });
  const dev = new FakePlayerGatt({ mac: "AA:AA:AA:00:00:01", deviceName: "Porch" }, { id: "bt-known" });
  dev.failConnects = 1;
  appState.connect("ble:bt-known", "Porch", { socketFactory: bleSocketFactory(dev), coldRetryLimit: 6 });
  await settle();

  const kept = deviceStore.get(known.id);
  assert.ok(kept, "an identified device is never forgotten by a transient failure");
  assert.equal(kept.bleMac, "AA:AA:AA:00:00:01");
  assert.equal(kept.label, "Porch");
});

test("a stale advertised Bluetooth name never overwrites the name the device reported [rr:PR-35]", () => {
  const first = deviceStore.upsert("ble:bt-1", "Led Widget E2F5EF"); // advertised name at scan
  deviceStore.applyWelcome(first.id, { mac: "58:E6:C5:E2:F5:EF", deviceName: "Kitchen" });
  // A later re-scan hands over the OS-cached (pre-rename) advertisement name.
  deviceStore.upsert("ble:bt-1", "Led Widget E2F5EF");
  assert.equal(deviceStore.get(first.id)!.label, "Kitchen");
});

test("after a rename rotates the device's cert, reconnects stop and ask to re-trust that device [rr:PR-35]", async () => {
  const player = lan.add("10.0.0.30", { mac: "B4:B4:B4:00:00:30", deviceName: "Hall" });
  appState.connect("wss://10.0.0.30/ws");
  await settle();
  assert.equal(appState.status.state, "connected");

  // The rename regenerates the board's self-signed cert and it reboots: every
  // reconnect now fails the TLS handshake until the user trusts the new cert.
  player.mode = "refuse";
  lan.dropAll("10.0.0.30");
  await advance(20_000);

  assert.equal(appState.status.text, "trust needed");
  assert.equal(appState.status.certUrl, "https://10.0.0.30/", "the trust prompt targets the renamed board's origin");
  const attempts = lan.socketsTo("10.0.0.30").length;
  await advance(60_000);
  assert.equal(lan.socketsTo("10.0.0.30").length, attempts, "no further handshakes until the user acts");
});

test("a Bluetooth device's record is keyed on its Bluetooth id, never its editable name [rr:PR-35]", async () => {
  const boardA = new FakePlayerGatt({ mac: "58:E6:C5:AA:00:01", deviceName: "Kitchen" }, { id: "bt-a" });
  const boardB = new FakePlayerGatt({ mac: "58:E6:C5:BB:00:02", deviceName: "Pantry" }, { id: "bt-b" });
  let picked: FakePlayerGatt = boardA;
  const bt = installBluetooth(() => picked);
  const connectVia = async (board: FakePlayerGatt): Promise<void> => {
    picked = board;
    openDeviceSheet();
    buttonTitled("Connect over Bluetooth (offline)").click();
    await advance(1000);
    assert.equal(appState.status.state, "connected");
    clearOverlays();
  };
  try {
    await connectVia(boardA);
    // Board A is renamed: it now advertises — and reports — "Pantry".
    appState.disconnect();
    boardA.player.identity.deviceName = "Pantry";
    boardA.name = "Pantry";
    await connectVia(boardA);
    assert.equal(deviceStore.list().length, 1, "the rename did not orphan or duplicate board A");

    await connectVia(boardB); // a different board that happens to share the name
    const list = deviceStore.list();
    assert.equal(list.length, 2, "two physical boards, two records");
    assert.deepEqual(list.map((d) => d.label), ["Pantry", "Pantry"]);
    assert.deepEqual(list.map((d) => d.bleMac).sort(), ["58:E6:C5:AA:00:01", "58:E6:C5:BB:00:02"]);
  } finally {
    bt.restore();
  }
});
