/**
 * Direct connection over Bluetooth (#154 / #155): where the LAN path can't be
 * used — no Wi-Fi, or a network that won't load the board's https cert page —
 * the app connects straight to the board and runs the whole player protocol over
 * its GATT player service (length-prefixed frames written to RX, notified on
 * TX), through the same client the wss path uses: no certificate, no address.
 * Uploads are sharded into windows small enough for the board's BLE reassembly
 * buffer, and a dropped link comes back over a fresh GATT session.
 *
 * Drives the device sheet's "Connect over Bluetooth" against a simulated board
 * behind a stand-in Web Bluetooth (tests/deviceFakes.ts), under the fake DOM and
 * node:test's mocked timers.
 */

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { installFakeDom } from "./fakeDom";

const dom = installFakeDom();
// One mocked-timer session for the whole file (see deviceIdentity.test.ts).
mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
after(() => mock.timers.reset());

import { BLE_UPLOAD_CHUNK_BYTES, PLAYER_SERVICE_UUID } from "../src/net/bleTransport";
import { IMPROV_SERVICE } from "../src/net/improv";
import { deviceStore } from "../src/store/deviceStore";
import { appState } from "../src/ui/app/state";
import { openDeviceSheet } from "../src/ui/screens/deviceSheet";
import {
  FakeLan,
  FakePlayerGatt,
  advance,
  buttonTitled,
  clearOverlays,
  installBluetooth,
  outcome,
  settle,
  type BluetoothStub,
} from "./deviceFakes";

let lan: FakeLan;
let restoreWs: () => void = () => undefined;
let bt: BluetoothStub | null = null;

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
  bt?.restore();
  bt = null;
  restoreWs();
  localStorage.clear();
});

/** Pick `board` in the chooser via the device sheet's Bluetooth connect. */
async function connectOverBluetooth(board: FakePlayerGatt): Promise<void> {
  bt = installBluetooth(() => board);
  openDeviceSheet();
  buttonTitled("Connect over Bluetooth (offline)").click();
  await advance(1000);
}

function board(): FakePlayerGatt {
  return new FakePlayerGatt(
    { mac: "58:E6:C5:B1:E0:01", deviceName: "Led Widget B1E001", fwVersion: "1.4.0" },
    { id: "bt-player-1" },
  );
}

test("Connect over Bluetooth runs the player protocol over GATT with no Wi-Fi or certificate [rr:PR-13]", async () => {
  const dev = board();
  await connectOverBluetooth(dev);

  assert.deepEqual(bt!.requests, [
    { filters: [{ services: [IMPROV_SERVICE] }], optionalServices: [PLAYER_SERVICE_UUID] },
  ]);
  assert.equal(appState.status.state, "connected");
  assert.equal(appState.status.certUrl, null, "nothing to trust over Bluetooth");
  assert.equal(appState.client?.url, "ble:bt-player-1");
  assert.equal(lan.sockets.length, 0, "no WebSocket was opened");
  assert.equal(dev.player.count("hello"), 1);
  assert.ok(dev.player.count("time_sync_ping") >= 1, "the clock was synced over GATT");

  const rec = deviceStore.active()!;
  assert.equal(rec.wssUrl, "ble:bt-player-1");
  assert.equal(rec.label, "Led Widget B1E001");
  assert.equal(rec.bleMac, "58:E6:C5:B1:E0:01");
  assert.equal(rec.bleId, "bt-player-1");
  assert.equal(rec.fwVersion, "1.4.0");
});

test("requests and uploads over Bluetooth travel in frames sized for the board [rr:PR-13]", async () => {
  const dev = board();
  await connectOverBluetooth(dev);
  const client = appState.client!;

  const status = client.getStatus();
  await settle();
  const st = await outcome(status);
  assert.equal(st.state, "fulfilled");
  assert.equal(st.state === "fulfilled" ? st.value.identified : -1, 3);

  const fxb = Uint8Array.from({ length: 3000 }, (_, i) => (i * 7) & 0xff);
  const upload = client.submitEffect("fx-ble", fxb, true);
  await advance(500);
  const done = await outcome(upload);
  assert.equal(done.state, "fulfilled");
  assert.equal(done.state === "fulfilled" ? done.value.mapId : "", "uploaded");

  assert.ok(dev.player.count("upload_chunk") >= 3, "a 3 KB effect is sharded into several windows");
  assert.ok(Math.max(...dev.rxFrames) <= BLE_UPLOAD_CHUNK_BYTES + 32, `frames ${dev.rxFrames.join(",")}`);
  assert.ok(Math.max(...dev.rxWrites.map((w) => w.length)) <= 180, "every GATT write fits the write unit");
});

test("a dropped Bluetooth link reconnects over a fresh GATT session [rr:PR-13]", async () => {
  const dev = board();
  await connectOverBluetooth(dev);
  assert.equal(dev.connects, 1);

  dev.dropLink(); // out of range for a moment
  await advance(3000);

  assert.equal(dev.connects, 2, "a fresh GATT connection");
  assert.equal(dev.player.count("hello"), 2, "the protocol handshake ran again on it");
  assert.equal(appState.client?.url, "ble:bt-player-1");
  assert.ok(appState.client?.isConnected);
});
