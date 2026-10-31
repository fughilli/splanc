/**
 * Native (Capacitor) BLE player socket + connect-by-name (src/net/nativeBlePlayer.ts)
 * — the iOS path to a fixture over Bluetooth, where WebKit has no Web Bluetooth.
 *
 * A stand-in for `@capacitor-community/bluetooth-le` bridges plugin calls (scan,
 * connect + disconnect callback, startNotifications, write) onto simulated player
 * boards (tests/deviceFakes.ts FakePlayerGatt), so the real LedMapperClient runs
 * its handshake, uploads and reconnects through the shared BleSocket over the
 * native adapter, under the fake DOM and node:test's mocked timers.
 */

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { installFakeDom } from "./fakeDom";

const dom = installFakeDom();
mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
after(() => mock.timers.reset());

import { BLE_UPLOAD_CHUNK_BYTES, BleSocket, PLAYER_SERVICE_UUID } from "../src/net/bleTransport";
import { FrameReassembler, frameWithLength } from "../src/net/bleFrame";
import { IMPROV_SERVICE } from "../src/net/improv";
import {
  connectNativePlayer,
  nativeBleDevice,
  pickPlayer,
  type NativeBlePlugin,
} from "../src/net/nativeBlePlayer";
import { appState } from "../src/ui/app/state";
import { openDeviceSheet } from "../src/ui/screens/deviceSheet";
import { FakeLan, FakePlayerGatt, advance, button, buttonTitled, clearOverlays, outcome, settle } from "./deviceFakes";

const PLAYER_RX = "9f5b0001-8a2e-4c1d-9b3a-1f0e2d3c4b5a";
const PLAYER_TX = "9f5b0002-8a2e-4c1d-9b3a-1f0e2d3c4b5a";

type ScanCb = Parameters<NativeBlePlugin["requestLEScan"]>[1];
type GattChar = {
  value?: DataView;
  startNotifications(): Promise<unknown>;
  addEventListener(t: string, cb: (ev: { target: unknown }) => void): void;
  writeValue(d: BufferSource): Promise<void>;
};

/** `BleClient` stand-in: CoreBluetooth in front of simulated player boards. */
class FakeNativePlayerBle implements NativeBlePlugin {
  readonly calls: string[] = [];
  readonly scanOpts: unknown[] = [];
  /** deviceIds this phone already holds a link to (getConnectedDevices). */
  readonly systemConnected = new Set<string>();
  private scanCb: ScanCb | null = null;
  private readonly boards = new Map<string, FakePlayerGatt>();
  private readonly links = new Map<string, { chars: Map<string, GattChar>; onDisc?: () => void }>();

  add(board: FakePlayerGatt): FakePlayerGatt {
    this.boards.set(board.id, board);
    // The board dropping the link reaches the app as the plugin's disconnect callback.
    board.addEventListener("gattserverdisconnected", () => this.links.get(board.id)?.onDisc?.());
    return board;
  }

  get scanning(): boolean {
    return this.scanCb !== null;
  }

  advertise(deviceId: string, localName: string, rssi?: number): void {
    this.scanCb?.({ device: { deviceId }, localName, ...(rssi !== undefined ? { rssi } : {}) });
  }

  async initialize(): Promise<void> {
    this.calls.push("initialize");
  }
  async requestLEScan(opts: unknown, cb: ScanCb): Promise<void> {
    this.calls.push("requestLEScan");
    this.scanOpts.push(opts);
    this.scanCb = cb;
  }
  async stopLEScan(): Promise<void> {
    this.calls.push("stopLEScan");
    this.scanCb = null;
  }
  async getConnectedDevices(_services: string[]): Promise<{ deviceId: string; name?: string }[]> {
    return [...this.systemConnected].map((id) => ({ deviceId: id, name: this.boards.get(id)!.name }));
  }
  async connect(deviceId: string, onDisconnect?: (id: string) => void): Promise<void> {
    this.calls.push(`connect:${deviceId}`);
    const board = this.boards.get(deviceId);
    if (!board) throw new Error("Device not found.");
    const server = await board.gatt.connect();
    const svc = await server.getPrimaryService(PLAYER_SERVICE_UUID);
    const chars = new Map<string, GattChar>();
    for (const u of [PLAYER_RX, PLAYER_TX]) chars.set(u, (await svc.getCharacteristic(u)) as unknown as GattChar);
    this.links.set(deviceId, { chars, ...(onDisconnect ? { onDisc: () => onDisconnect(deviceId) } : {}) });
  }
  async disconnect(deviceId: string): Promise<void> {
    this.calls.push(`disconnect:${deviceId}`);
    this.boards.get(deviceId)?.gatt.disconnect();
    const l = this.links.get(deviceId);
    this.links.delete(deviceId);
    l?.onDisc?.();
  }
  async write(deviceId: string, service: string, char: string, value: DataView): Promise<void> {
    assert.equal(service, PLAYER_SERVICE_UUID);
    const c = this.links.get(deviceId)?.chars.get(char);
    if (!c) throw new Error("Not connected.");
    await c.writeValue(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice());
  }
  async startNotifications(deviceId: string, _s: string, char: string, cb: (v: DataView) => void): Promise<void> {
    this.calls.push(`notify:${char.slice(4, 8)}`);
    const c = this.links.get(deviceId)?.chars.get(char);
    if (!c) throw new Error("Not connected.");
    c.addEventListener("characteristicvaluechanged", (ev) => cb((ev.target as GattChar).value!));
    await c.startNotifications();
  }
}

function spooky(n: number, mac: string): FakePlayerGatt {
  return new FakePlayerGatt(
    { mac, deviceName: `SpookySplanc${n}`, fwVersion: "1.6.0" },
    { id: `ios-peripheral-${n}` },
  );
}

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
  restoreWs();
  localStorage.clear();
});

/** connectNativePlayer, then the same appState.connect halloweenConnect makes. */
async function connectLikeHalloween(
  ble: FakeNativePlayerBle,
  opts: { name?: string },
  during: () => void,
): Promise<string> {
  const p = connectNativePlayer({ ...opts, namePrefix: "SpookySplanc", scanMs: 2500 }, ble);
  await settle();
  during();
  await advance(2600);
  const o = await outcome(p);
  assert.equal(o.state, "fulfilled", o.state === "rejected" ? String(o.reason) : "");
  const link = o.state === "fulfilled" ? o.value : null!;
  appState.connect(`ble:${link.id}`, link.name, {
    socketFactory: link.socketFactory,
    coldRetryLimit: 6,
    uploadChunkBytes: BLE_UPLOAD_CHUNK_BYTES,
  });
  await advance(1000);
  return link.name;
}

test("no name: picks the strongest SpookySplanc* by mean RSSI and runs the protocol over the native link", async () => {
  const ble = new FakeNativePlayerBle();
  const near = ble.add(spooky(1, "58:E6:C5:00:00:01"));
  ble.add(spooky(2, "58:E6:C5:00:00:02"));
  const name = await connectLikeHalloween(ble, {}, () => {
    // iOS: first sighting carries no name (scan response not merged yet).
    ble.advertise("ios-peripheral-1", "", -60);
    ble.advertise("ios-peripheral-2", "SpookySplanc2", -55); // one lucky strong sample
    ble.advertise("ios-peripheral-2", "SpookySplanc2", -80);
    ble.advertise("ios-peripheral-1", "SpookySplanc1", -62);
    ble.advertise("ios-peripheral-9", "Some Speaker", -30); // not ours
  });

  assert.equal(name, "SpookySplanc1");
  assert.deepEqual(ble.scanOpts, [{ services: [IMPROV_SERVICE], allowDuplicates: true }]);
  assert.equal(ble.scanning, false, "scan stopped before connecting");
  assert.equal(appState.status.state, "connected");
  assert.equal(appState.client?.url, "ble:ios-peripheral-1");
  assert.equal(lan.sockets.length, 0, "no WebSocket was opened");
  assert.equal(near.player.count("hello"), 1);
  assert.ok(near.player.count("time_sync_ping") >= 1, "clock synced over GATT");
});

test("exact name wins over a stronger neighbour and resolves without waiting out the window", async () => {
  const ble = new FakeNativePlayerBle();
  ble.add(spooky(1, "58:E6:C5:00:00:01"));
  ble.add(spooky(2, "58:E6:C5:00:00:02"));
  const p = connectNativePlayer({ name: "SpookySplanc2", namePrefix: "SpookySplanc" }, ble);
  await settle();
  ble.advertise("ios-peripheral-1", "SpookySplanc1", -40);
  ble.advertise("ios-peripheral-2", "SpookySplanc2", -85);
  await settle();
  const o = await outcome(p);
  assert.equal(o.state, "fulfilled");
  assert.equal(o.state === "fulfilled" ? o.value.id : "", "ios-peripheral-2");
  assert.equal(ble.scanning, false);
});

test("nothing nearby: rejects with a human message after the max scan, and stops scanning", async () => {
  const ble = new FakeNativePlayerBle();
  const p = connectNativePlayer({ namePrefix: "SpookySplanc", scanMs: 2500, maxScanMs: 6000 }, ble);
  p.catch(() => undefined);
  await settle();
  ble.advertise("x", "Led Widget 123456", -40);
  await advance(5000);
  assert.equal((await outcome(p)).state, "pending", "keeps looking past the short window");
  await advance(1500);
  const o = await outcome(p);
  assert.equal(o.state, "rejected");
  assert.match(String(o.state === "rejected" ? o.reason : ""), /Couldn't find a SpookySplanc fixture nearby/);
  assert.equal(ble.scanning, false);
});

test("a fixture this phone is already connected to (invisible to the scan) is picked", async () => {
  const ble = new FakeNativePlayerBle();
  ble.add(spooky(1, "58:E6:C5:00:00:01"));
  ble.add(spooky(2, "58:E6:C5:00:00:02"));
  ble.systemConnected.add("ios-peripheral-2");
  const name = await connectLikeHalloween(ble, {}, () => ble.advertise("ios-peripheral-1", "SpookySplanc1", -40));
  assert.equal(name, "SpookySplanc2");
  // Exact name already connected: no scan at all.
  const o = await outcome(connectNativePlayer({ name: "SpookySplanc2", namePrefix: "SpookySplanc" }, ble));
  assert.equal(o.state === "fulfilled" ? o.value.id : "", "ios-peripheral-2");
});

test("uploads are framed + chunked for the board: ≤180 B writes, ≤1 KB windows", async () => {
  const ble = new FakeNativePlayerBle();
  const dev = ble.add(spooky(1, "58:E6:C5:00:00:01"));
  await connectLikeHalloween(ble, { name: "SpookySplanc1" }, () => ble.advertise(dev.id, "SpookySplanc1", -50));
  const client = appState.client!;
  const fxb = Uint8Array.from({ length: 3000 }, (_, i) => (i * 7) & 0xff);
  const upload = client.submitEffect("fx-ble", fxb, true);
  await advance(500);
  const done = await outcome(upload);
  assert.equal(done.state, "fulfilled");
  assert.ok(dev.player.count("upload_chunk") >= 3, "a 3 KB effect is sharded into several windows");
  assert.ok(Math.max(...dev.rxFrames) <= BLE_UPLOAD_CHUNK_BYTES + 32, `frames ${dev.rxFrames.join(",")}`);
  assert.ok(Math.max(...dev.rxWrites.map((w) => w.length)) <= 180, "every GATT write fits the write unit");
});

test("a dropped native link closes the socket and the client reconnects over a fresh GATT session", async () => {
  const ble = new FakeNativePlayerBle();
  const dev = ble.add(spooky(1, "58:E6:C5:00:00:01"));
  await connectLikeHalloween(ble, { name: "SpookySplanc1" }, () => ble.advertise(dev.id, "SpookySplanc1", -50));
  assert.equal(dev.connects, 1);
  dev.dropLink(); // visitor walks out of range for a moment
  await settle();
  // The plugin's disconnect callback closes the socket at once (not a later
  // failed write), so the pill shows it immediately.
  assert.equal(appState.status.text, "reconnecting…");
  await advance(3000);
  assert.equal(dev.connects, 2, "a fresh GATT connection");
  assert.equal(dev.player.count("hello"), 2, "the handshake ran again");
  assert.ok(appState.client?.isConnected);
});

test("BleSocket over the native adapter: notify reassembly, write chunking, close", async () => {
  const sent: Uint8Array[] = [];
  let notify: ((v: DataView) => void) | null = null;
  let onDisc: (() => void) | undefined;
  const calls: string[] = [];
  const ble: NativeBlePlugin = {
    initialize: async () => undefined,
    requestLEScan: async () => undefined,
    stopLEScan: async () => undefined,
    getConnectedDevices: async () => [],
    connect: async (_id, cb) => {
      calls.push("connect");
      onDisc = cb ? () => cb("d") : undefined;
    },
    disconnect: async () => {
      calls.push("disconnect");
      onDisc?.();
    },
    write: async (_id, svc, ch, v) => {
      assert.equal(svc, PLAYER_SERVICE_UUID);
      assert.equal(ch, PLAYER_RX);
      sent.push(new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice());
    },
    startNotifications: async (_id, svc, ch, cb) => {
      assert.equal(svc, PLAYER_SERVICE_UUID);
      assert.equal(ch, PLAYER_TX);
      notify = cb;
    },
  };
  const sock = new BleSocket(nativeBleDevice(ble, "d", "SpookySplanc1"));
  let opened = 0;
  let closed = 0;
  const got: number[][] = [];
  sock.onopen = () => opened++;
  sock.onclose = () => closed++;
  sock.onmessage = (ev) => got.push(Array.from(ev.data as Uint8Array));
  await advance(300);
  assert.equal(opened, 1);

  // Two frames split awkwardly across three notifications (one carries a frame end
  // AND the next frame's start).
  const stream = new Uint8Array([...frameWithLength(new Uint8Array([1, 2, 3])), ...frameWithLength(new Uint8Array(300).fill(9))]);
  for (const [a, b] of [
    [0, 5],
    [5, 200],
    [200, stream.length],
  ] as const) {
    const c = stream.slice(a, b);
    notify!(new DataView(c.buffer));
  }
  assert.deepEqual(got[0], [1, 2, 3]);
  assert.equal(got[1]?.length, 300);
  assert.equal(got.length, 2);

  // 500 B payload → 504 framed bytes → 180+180+144, reassembling to the payload.
  const payload = Uint8Array.from({ length: 500 }, (_, i) => i & 0xff);
  sock.send(payload);
  await settle();
  assert.deepEqual(
    sent.map((s) => s.length),
    [180, 180, 144],
  );
  const re = new FrameReassembler();
  const frames = sent.flatMap((s) => re.push(s));
  assert.deepEqual(Array.from(frames[0]!), Array.from(payload));

  sock.close();
  await settle();
  assert.equal(closed, 1, "onclose fires once (the disconnect callback is a no-op after close)");
  assert.deepEqual(calls, ["connect", "disconnect"]);
});

test("pickPlayer ignores nameless and foreign sightings", () => {
  const opts = { namePrefix: "SpookySplanc" };
  assert.equal(pickPlayer([{ deviceId: "a", name: "", rssi: -20 }], opts), null);
  assert.equal(pickPlayer([{ deviceId: "a", name: "Splanc", rssi: -20 }], opts), null);
  assert.equal(
    pickPlayer(
      [
        { deviceId: "a", name: "SpookySplanc1", rssi: -70 },
        { deviceId: "b", name: "SpookySplanc2" }, // no RSSI reported → weakest
      ],
      opts,
    )?.deviceId,
    "a",
  );
});

test("in the native app, the device sheet's 'Connect over Bluetooth (offline)' scans, lists and connects natively", async () => {
  const ble = new FakeNativePlayerBle();
  const dev = ble.add(spooky(1, "58:E6:C5:00:00:01"));
  const g = globalThis as { Capacitor?: unknown };
  g.Capacitor = { isNativePlatform: () => true, getPlatform: () => "ios" };
  const Module = (await import("node:module")).default as unknown as {
    _load: (r: string, p: unknown, m: boolean) => unknown;
  };
  const orig = Module._load;
  Module._load = function (this: unknown, r: string, p: unknown, m: boolean): unknown {
    if (r === "@capacitor-community/bluetooth-le") return { BleClient: ble };
    return orig.call(this, r, p, m);
  };
  try {
    openDeviceSheet();
    buttonTitled("Connect over Bluetooth (offline)").click();
    await advance(200);
    assert.ok(ble.scanning, "native scan running (no Web Bluetooth on iOS)");
    ble.advertise(dev.id, "SpookySplanc1", -50);
    await settle();
    button("SpookySplanc1").click();
    await advance(1500);
    assert.equal(appState.status.state, "connected");
    assert.equal(appState.client?.url, "ble:ios-peripheral-1");
    assert.equal(dev.player.count("hello"), 1);
    assert.equal(lan.sockets.length, 0);
  } finally {
    Module._load = orig;
    delete g.Capacitor;
  }
});

test("relaunching the iOS app after a Bluetooth session never hands the ble: key to the native WssBridge", async () => {
  // TestFlight 1.13.0 (1252): after a Halloween BLE session, every relaunch
  // aborted in WssBridge.connect -> URLSession.webSocketTask(with: "ble:…"),
  // because boot restored the active device and the prober probed it through the
  // native socket bridge. Model the bridge the way iOS behaves: a non-ws(s) URL
  // is fatal, so any call with one fails the test.
  const bridgeUrls: string[] = [];
  const g = globalThis as { Capacitor?: unknown };
  g.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
    registerPlugin: () => ({
      addListener: async () => ({ remove: async () => {} }),
      connect: async ({ url }: { url: string }) => {
        bridgeUrls.push(url);
        if (!/^wss?:\/\//.test(url)) throw new Error(`iOS would abort: webSocketTask(${url})`);
        return { id: "sock-1" };
      },
      send: async () => {},
      close: async () => {},
    }),
  };
  const { deviceStore } = await import("../src/store/deviceStore");
  const { deviceProber } = await import("../src/net/deviceProber");
  const { nativeSocketFactory } = await import("../src/net/nativeSocket");
  try {
    const dev = deviceStore.upsert("ble:ios-peripheral-1", "SpookySplanc1");
    deviceStore.setActive(dev.id);

    appState.restoreActive(); // app launch
    await advance(100);
    assert.equal(appState.client, null, "a Bluetooth device is not auto-restored over a socket");

    await deviceProber.probeNow(dev.id); // what a disconnect triggers
    appState.connect("ble:ios-peripheral-1"); // device-sheet Connect with no BLE link
    await advance(100);
    assert.equal(appState.status.state, "offline");

    const s = nativeSocketFactory()!("ble:ios-peripheral-1"); // and the socket itself refuses
    let closed = false;
    s.onclose = () => {
      closed = true;
    };
    await settle();
    assert.ok(closed, "the native socket fails as a JS error");
    assert.deepEqual(bridgeUrls, [], "nothing reached the native bridge");
  } finally {
    deviceStore.setActive(null);
    delete g.Capacitor;
  }
});
