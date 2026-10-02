/**
 * Shared fakes for the device-connection suites (deviceIdentity, addDeviceFlow,
 * deviceRename, deviceDiscovery, bleDirectConnect, improvProvisionHardening,
 * connectionHardening): simulated splanc players plus the browser transports the
 * app reaches them through. They speak the REAL wire, so the production client,
 * stores and screens run unmodified on top:
 *
 *  - FakeLan: players keyed by host, reachable through a stand-in global
 *    `WebSocket` (Node 22 ships a real one — a test must never dial the network).
 *    A FakePlayer decodes the client's protobuf frames (decodeClient) and answers
 *    hello / time_sync_ping / set_device_name / uploads with encodeServer'd frames,
 *    like the firmware's ws handler. A player answers ("answer"), fails the TLS
 *    handshake ("refuse" — e.g. its self-signed cert is not trusted yet), or never
 *    answers at all ("silent" — still booting, or off the LAN).
 *  - FakeImprovDevice: a Web Bluetooth Improv peripheral (the ImprovDevice seam)
 *    that parses the wifi-settings RPC like improv_codec.h and answers on
 *    RPC_RESULT / ERROR_STATE with the framing improv_build_result() emits, with
 *    per-operation GATT flake injection and an operation log on the mocked clock.
 *  - FakePlayerGatt: the player-transport GATT service (the BleDevice seam): RX
 *    writes are reassembled from the length-prefixed stream and served by a
 *    FakePlayer; replies are framed and notified on TX in MTU-sized chunks.
 *  - installBluetooth(): a stand-in `navigator.bluetooth` chooser.
 *
 * Time: every modeled delay is a setTimeout, so suites run under node:test's
 * mock.timers and move time with `advance()`; deliveries that a real browser
 * makes asynchronously (socket open, frames, close) are queued as microtasks and
 * drained by `settle()`. Nothing here sleeps for real.
 */

import Module from "node:module";
import { mock } from "node:test";
import type { ServerMessage } from "@ledmapper/protocol";
import { FrameReassembler, chunkBytes, frameWithLength } from "../src/net/bleFrame";
import type { BleDevice } from "../src/net/bleTransport";
import type { ImprovDevice } from "../src/net/improv";
import { decodeClient, encodeServer } from "../src/net/proto";
import { asFake, type FakeElement } from "./fakeDom";

// -- time ----------------------------------------------------------------------

/** Virtual milliseconds advanced by `advance()` (op-log timestamps). */
export const clock = { now: 0 };

/** Drain queued microtasks / promise chains (each setImmediate turn runs the
 * whole microtask queue first). setImmediate is never mocked by these suites. */
export async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

export type Outcome<T> =
  | { state: "fulfilled"; value: T }
  | { state: "rejected"; reason: unknown }
  | { state: "pending" };

/** How `p` has settled so far (after draining pending microtasks) — lets a test
 * assert on a result that might never settle without hanging the suite. */
export async function outcome<T>(p: Promise<T>): Promise<Outcome<T>> {
  let o: Outcome<T> = { state: "pending" };
  p.then(
    (value) => {
      o = { state: "fulfilled", value };
    },
    (reason: unknown) => {
      o = { state: "rejected", reason };
    },
  );
  await settle();
  return o;
}

/** Advance the mocked clock by `ms` in `step`-sized ticks, draining promise
 * chains between ticks so code that awaits one timer and then arms the next keeps
 * pace with virtual time. Requires mock.timers to be enabled for setTimeout. */
export async function advance(ms: number, step = 50): Promise<void> {
  await settle();
  let left = ms;
  while (left > 0) {
    const s = Math.min(step, left);
    mock.timers.tick(s);
    clock.now += s;
    left -= s;
    await settle(2);
  }
}

// -- the player (device side of the protocol) ----------------------------------

export const CODE_PARAMS = {
  ledCount: 64,
  bits: 6,
  encoding: "hue",
  symbols: 2,
  bitPeriodMs: 100,
  syncPattern: "on_off",
  cycleFrames: 8,
};

export interface PlayerIdentity {
  mac: string;
  deviceName: string;
  fwVersion?: string;
  fwGitCommit?: string;
  fwGitDirty?: boolean;
}

export type PlayerMode = "answer" | "refuse" | "silent";

type ClientMsg = { type: string } & Record<string, unknown>;

/** One simulated player: the protocol side of the firmware's ws/BLE handler. */
export class FakePlayer {
  mode: PlayerMode = "answer";
  /** Fail the next N TLS handshakes even while answering — a TLS slot still
   * lingering from a just-closed socket, or a reboot in progress. */
  refuseNext = 0;
  /** hello → welcome latency (ms, mocked clock): a cold TLS session + welcome on
   * a heap-tight player takes seconds (HITL measured ~2.5–8.3 s). */
  welcomeDelayMs = 0;
  /** Every client message received, decoded, in arrival order. */
  readonly received: ClientMsg[] = [];

  constructor(public identity: PlayerIdentity) {}

  welcome(): ServerMessage {
    return {
      type: "welcome",
      sessionId: "s-fake",
      codeParams: CODE_PARAMS,
      solverBenchMs: null,
      mac: this.identity.mac,
      deviceName: this.identity.deviceName,
      fwGitCommit: this.identity.fwGitCommit ?? "",
      fwGitDirty: this.identity.fwGitDirty ?? false,
      fwVersion: this.identity.fwVersion ?? "",
    } as unknown as ServerMessage;
  }

  /** Serve one decoded client message; `reply` sends a server message back. */
  handle(msg: ClientMsg, reply: (m: ServerMessage) => void): void {
    this.received.push(msg);
    switch (msg.type) {
      case "hello":
        if (this.welcomeDelayMs > 0) setTimeout(() => reply(this.welcome()), this.welcomeDelayMs);
        else reply(this.welcome());
        return;
      case "time_sync_ping":
        reply({ type: "time_sync_pong", t0: msg["t0"] as number, t1: 5000, t2: 5000 } as ServerMessage);
        return;
      case "set_device_name":
        // The firmware persists the name, re-advertises it over BLE and echoes a
        // fresh welcome as the reply.
        this.identity.deviceName = String(msg["name"]);
        reply(this.welcome());
        return;
      case "get_status":
        reply({ type: "status", identified: 3, total: 64, lowParallax: 0 } as ServerMessage);
        return;
      case "upload_chunk":
        if (msg["last"] === true) reply({ type: "result_ready", mapId: "uploaded" } as ServerMessage);
        else {
          reply({
            type: "chunk_ack",
            uploadId: msg["uploadId"],
            seq: msg["seq"] ?? 0,
          } as unknown as ServerMessage);
        }
        return;
      case "submit_map":
      case "submit_effect":
        reply({ type: "result_ready", mapId: "uploaded" } as ServerMessage);
        return;
      default:
        return;
    }
  }

  /** Names this player was asked to adopt (set_device_name), in order. */
  renames(): string[] {
    return this.received.filter((m) => m.type === "set_device_name").map((m) => String(m["name"]));
  }

  count(type: string): number {
    return this.received.filter((m) => m.type === type).length;
  }
}

// -- the LAN (wss) -------------------------------------------------------------

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A WebSocket stand-in bound to a FakeLan (installed as globalThis.WebSocket). */
export class FakeWebSocket {
  readyState = 0; // CONNECTING
  binaryType = "blob";
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  readonly host: string;
  /** Opened (reached OPEN) at least once. */
  opened = false;

  constructor(
    readonly url: string,
    private readonly lan: FakeLan,
  ) {
    this.host = hostOf(url);
    lan.track(this);
    queueMicrotask(() => {
      if (this.readyState !== 0) return; // closed before it connected
      const p = this.lan.players.get(this.host);
      if (!p || p.mode === "silent") return; // no answer: only a client timeout ends it
      const refuse = p.mode === "refuse" || p.refuseNext > 0;
      if (p.mode !== "refuse" && p.refuseNext > 0) p.refuseNext--;
      if (refuse) {
        // TLS handshake rejected (untrusted cert): the browser fires error, close.
        this.onerror?.();
        this.finishClose();
        return;
      }
      this.readyState = 1;
      this.opened = true;
      this.onopen?.();
    });
  }

  send(data: string | Uint8Array): void {
    if (this.readyState !== 1) throw new Error("InvalidStateError: socket not open");
    if (!(data instanceof Uint8Array)) throw new Error("expected a binary protobuf frame");
    const p = this.lan.players.get(this.host);
    if (!p) return;
    const msg = decodeClient(data) as unknown as ClientMsg;
    p.handle(msg, (reply) => {
      // Delivered asynchronously, like a real socket (the client registers its
      // reply waiter right AFTER send()).
      queueMicrotask(() => {
        if (this.readyState === 1) this.onmessage?.({ data: encodeServer(reply) });
      });
    });
  }

  close(): void {
    if (this.readyState >= 2) return;
    this.readyState = 2; // CLOSING; onclose follows asynchronously
    queueMicrotask(() => this.finishClose());
  }

  /** The device closes the connection (e.g. it rebooted). */
  serverClose(): void {
    if (this.readyState >= 2) return;
    this.finishClose();
  }

  private finishClose(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.lan.untrack(this);
    this.onclose?.();
  }
}

/** A set of players reachable over wss, plus socket accounting. */
export class FakeLan {
  readonly players = new Map<string, FakePlayer>();
  /** Every socket ever constructed, in order. */
  readonly sockets: FakeWebSocket[] = [];
  private readonly live = new Set<FakeWebSocket>();
  private readonly peak = new Map<string, number>();

  add(host: string, identity: PlayerIdentity): FakePlayer {
    const p = new FakePlayer(identity);
    this.players.set(host, p);
    return p;
  }

  /** @internal */
  track(s: FakeWebSocket): void {
    this.sockets.push(s);
    this.live.add(s);
    const n = this.liveTo(s.host);
    this.peak.set(s.host, Math.max(this.peak.get(s.host) ?? 0, n));
  }

  /** @internal */
  untrack(s: FakeWebSocket): void {
    this.live.delete(s);
  }

  /** Sockets ever opened toward `host`. */
  socketsTo(host: string): FakeWebSocket[] {
    return this.sockets.filter((s) => s.host === host);
  }

  /** Sockets to `host` not yet closed. */
  liveTo(host: string): number {
    let n = 0;
    for (const s of this.live) if (s.host === host) n++;
    return n;
  }

  /** The most sockets ever simultaneously alive toward `host`. */
  peakLiveTo(host: string): number {
    return this.peak.get(host) ?? 0;
  }

  /** The device at `host` drops every connection (reboot / link loss). */
  dropAll(host: string): void {
    for (const s of [...this.live]) if (s.host === host) s.serverClose();
  }

  /** Install as globalThis.WebSocket; returns the restore function. */
  install(): () => void {
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
    const lan = this;
    class LanWebSocket extends FakeWebSocket {
      constructor(url: string) {
        super(url, lan);
      }
    }
    Object.defineProperty(globalThis, "WebSocket", {
      value: LanWebSocket,
      configurable: true,
      writable: true,
    });
    return () => {
      if (saved) Object.defineProperty(globalThis, "WebSocket", saved);
      else delete g["WebSocket"];
    };
  }
}

// -- Improv over Bluetooth (provisioning) --------------------------------------

const IMPROV_SERVICE = "00467768-6228-2272-4663-277478268000";
const CHAR_ERROR_STATE = "00467768-6228-2272-4663-277478268002";
const CHAR_RPC_COMMAND = "00467768-6228-2272-4663-277478268003";
const CHAR_RPC_RESULT = "00467768-6228-2272-4663-277478268004";

/** An RPC_RESULT packet `[cmd, total_len, (len, str)…, checksum]` — the framing
 * improv_build_result() emits on the firmware. */
export function improvResultPacket(strings: string[]): Uint8Array {
  const enc = new TextEncoder();
  const body: number[] = [0x01, 0];
  for (const s of strings) {
    const b = enc.encode(s);
    body.push(b.length, ...b);
  }
  body[1] = body.length - 2;
  const sum = body.reduce((a, b) => (a + b) & 0xff, 0);
  return new Uint8Array([...body, sum]);
}

/** Parse a wifi-settings RPC the way the firmware does (improv_codec.h); null
 * when the packet is malformed or its checksum is wrong. */
export function parseWifiSettings(pkt: Uint8Array): { ssid: string; password: string } | null {
  if (pkt.length < 5 || pkt[0] !== 0x01) return null;
  const len = pkt[1]!;
  if (pkt.length !== 2 + len + 1) return null;
  let sum = 0;
  for (let i = 0; i < 2 + len; i++) sum = (sum + pkt[i]!) & 0xff;
  if (pkt[2 + len] !== sum) return null;
  const sl = pkt[2]!;
  const pl = pkt[3 + sl]!;
  if (2 + sl + pl !== len) return null;
  const dec = new TextDecoder();
  return {
    ssid: dec.decode(pkt.subarray(3, 3 + sl)),
    password: dec.decode(pkt.subarray(4 + sl, 4 + sl + pl)),
  };
}

type CharListener = (ev: { target: unknown }) => void;

/** The write-only RPC_COMMAND characteristic. */
interface CommandChar {
  value?: DataView;
  startNotifications(): Promise<unknown>;
  addEventListener(type: string, cb: CharListener): void;
  writeValue(data: Uint8Array): Promise<void>;
}

/** A notifying characteristic: listeners read `ev.target.value` (a DataView). */
class NotifyChar {
  value?: DataView;
  subscribed = false;
  private readonly listeners: CharListener[] = [];
  constructor(private readonly onSubscribe: () => Promise<void>) {}
  async startNotifications(): Promise<unknown> {
    await this.onSubscribe();
    this.subscribed = true;
    return this;
  }
  addEventListener(_type: string, cb: CharListener): void {
    this.listeners.push(cb);
  }
  async writeValue(_data: Uint8Array | BufferSource): Promise<void> {
    throw new Error("not writable");
  }
  /** Device → app notification (only reaches a subscribed central). */
  emit(bytes: Uint8Array): void {
    if (!this.subscribed) return;
    this.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const cb of [...this.listeners]) cb({ target: this });
  }
}

/** First-N failure counters for each GATT operation (Android's "GATT operation
 * failed for unknown reason" flake). `writeAfterDelivery` models a write that
 * REACHED the device although the phone's stack reported it failed. */
export interface GattFlakes {
  connect?: number;
  discover?: number;
  subscribe?: number;
  write?: number;
  writeAfterDelivery?: number;
}

export interface FakeImprovOpts {
  id?: string;
  name?: string;
  /** Redirect strings the device reports after joining (default its LAN URL). */
  redirect?: string[];
  /** Answer with this Improv error code instead of a redirect. */
  errorCode?: number;
  /** Modeled WiFi-join time between receiving credentials and answering. */
  joinDelayMs?: number;
  /** Result notifications per join (the firmware's redirect resend window). */
  answers?: number;
  /** Never answer (the join never completes). */
  silent?: boolean;
  flakes?: GattFlakes;
}

const GATT_FLAKE = "GATT operation failed for unknown reason";

/** A Web Bluetooth Improv peripheral implementing the `ImprovDevice` seam. */
export class FakeImprovDevice implements ImprovDevice {
  readonly id: string;
  readonly name: string;
  /** GATT operations in order, stamped with the virtual clock. */
  readonly log: Array<{ op: string; at: number }> = [];
  /** Credential packets that reached the device. */
  readonly delivered: Uint8Array[] = [];
  connects = 0;
  disconnects = 0;
  private readonly left: Required<GattFlakes>;
  private readonly rpcResult: NotifyChar;
  private readonly errorState: NotifyChar;
  private readonly rpcCommand: CommandChar;
  readonly gatt: NonNullable<ImprovDevice["gatt"]>;

  constructor(private readonly opts: FakeImprovOpts = {}) {
    this.id = opts.id ?? "improv-dev-1";
    this.name = opts.name ?? "Led Widget A1B2C3";
    const f = opts.flakes ?? {};
    this.left = {
      connect: f.connect ?? 0,
      discover: f.discover ?? 0,
      subscribe: f.subscribe ?? 0,
      write: f.write ?? 0,
      writeAfterDelivery: f.writeAfterDelivery ?? 0,
    };
    const subscribe = async (): Promise<void> => {
      this.note("subscribe?");
      if (this.left.subscribe > 0) {
        this.left.subscribe--;
        throw new Error(GATT_FLAKE);
      }
      this.note("subscribe");
    };
    this.rpcResult = new NotifyChar(subscribe);
    this.errorState = new NotifyChar(subscribe);
    this.rpcCommand = {
      startNotifications: async () => undefined,
      addEventListener: () => undefined,
      writeValue: async (data: Uint8Array) => {
        this.note("write?");
        if (this.left.write > 0) {
          this.left.write--;
          throw new Error(GATT_FLAKE);
        }
        this.deliver(data.slice());
        if (this.left.writeAfterDelivery > 0) {
          this.left.writeAfterDelivery--;
          throw new Error(GATT_FLAKE);
        }
      },
    };
    const chars: Record<string, NotifyChar | CommandChar> = {
      [CHAR_RPC_COMMAND]: this.rpcCommand,
      [CHAR_RPC_RESULT]: this.rpcResult,
      [CHAR_ERROR_STATE]: this.errorState,
    };
    this.gatt = {
      connect: async () => {
        this.connects++;
        this.note("connect?");
        if (this.left.connect > 0) {
          this.left.connect--;
          throw new Error(GATT_FLAKE);
        }
        this.note("connect");
        return {
          getPrimaryService: async (uuid: string) => {
            this.note("discover");
            if (this.left.discover > 0) {
              this.left.discover--;
              throw new Error(GATT_FLAKE);
            }
            if (uuid !== IMPROV_SERVICE) throw new Error(`no service ${uuid}`);
            return {
              getCharacteristic: async (u: string) => {
                const c = chars[u];
                if (!c) throw new Error(`no characteristic ${u}`);
                return c;
              },
            };
          },
        };
      },
      disconnect: () => {
        this.disconnects++;
        this.note("disconnect");
        // A dropped link loses the central's notification subscriptions.
        this.rpcResult.subscribed = false;
        this.errorState.subscribed = false;
      },
    };
  }

  /** Op names only, in order. */
  ops(): string[] {
    return this.log.map((e) => e.op);
  }

  /** Virtual time of the first logged `op` (undefined if never logged). */
  at(op: string): number | undefined {
    return this.log.find((e) => e.op === op)?.at;
  }

  private note(op: string): void {
    this.log.push({ op, at: clock.now });
  }

  /** Device side: credentials arrived — "join" and report back on the
   * subscribed characteristics. */
  private deliver(pkt: Uint8Array): void {
    this.delivered.push(pkt);
    if (!parseWifiSettings(pkt) || this.opts.silent) return;
    const answers = this.opts.answers ?? 1;
    for (let i = 0; i < answers; i++) {
      setTimeout(
        () => {
          if (this.opts.errorCode) this.errorState.emit(new Uint8Array([this.opts.errorCode]));
          else this.rpcResult.emit(improvResultPacket(this.opts.redirect ?? ["http://192.168.1.50/"]));
        },
        (this.opts.joinDelayMs ?? 20) + i * 1000,
      );
    }
  }

}

// -- the player GATT transport (direct BLE connection) --------------------------

const PLAYER_SERVICE_UUID = "9f5b0000-8a2e-4c1d-9b3a-1f0e2d3c4b5a";
const PLAYER_RX_UUID = "9f5b0001-8a2e-4c1d-9b3a-1f0e2d3c4b5a";
const PLAYER_TX_UUID = "9f5b0002-8a2e-4c1d-9b3a-1f0e2d3c4b5a";
const NOTIFY_CHUNK = 180; // the firmware's player_ble_notify chunk

/** The player-protocol GATT service of one device (the `BleDevice` seam). */
export class FakePlayerGatt implements BleDevice {
  readonly id: string;
  /** Advertised Bluetooth name (follows a rename). */
  name: string;
  readonly player: FakePlayer;
  /** Every GATT write the app made to RX (one per write unit). */
  readonly rxWrites: Uint8Array[] = [];
  /** Byte length of every reassembled protocol frame the app sent. */
  readonly rxFrames: number[] = [];
  connects = 0;
  disconnects = 0;
  /** Fail the next N connect()s (radio flake / out of range). */
  failConnects = 0;
  private linkUp = false;
  private reasm = new FrameReassembler();
  private readonly tx: NotifyChar;
  private readonly rx: {
    startNotifications(): Promise<unknown>;
    addEventListener(type: string, cb: CharListener): void;
    writeValueWithResponse(data: BufferSource): Promise<void>;
    writeValue(data: BufferSource): Promise<void>;
  };
  private readonly linkListeners: Array<() => void> = [];
  readonly gatt: NonNullable<BleDevice["gatt"]>;

  constructor(identity: PlayerIdentity, opts: { id?: string; name?: string } = {}) {
    this.player = new FakePlayer(identity);
    this.id = opts.id ?? "ble-dev-1";
    this.name = opts.name ?? identity.deviceName;
    this.tx = new NotifyChar(async () => undefined);
    const write = async (data: BufferSource): Promise<void> => {
      if (!this.linkUp) throw new Error("GATT Server is disconnected");
      const u = data instanceof Uint8Array ? data.slice() : new Uint8Array(data as ArrayBuffer).slice();
      this.rxWrites.push(u);
      for (const frame of this.reasm.push(u)) this.serve(frame);
    };
    this.rx = {
      startNotifications: async () => undefined,
      addEventListener: () => undefined,
      writeValueWithResponse: write,
      writeValue: write,
    };
    this.gatt = {
      connect: async () => {
        this.connects++;
        if (this.failConnects > 0) {
          this.failConnects--;
          throw new Error("Bluetooth connection failed");
        }
        this.linkUp = true;
        this.reasm = new FrameReassembler(); // a fresh link is a fresh byte stream
        return {
          getPrimaryService: async (uuid: string) => {
            if (uuid !== PLAYER_SERVICE_UUID) throw new Error(`no service ${uuid}`);
            return {
              getCharacteristic: async (u: string) => {
                if (u === PLAYER_RX_UUID) return this.rx;
                if (u === PLAYER_TX_UUID) return this.tx;
                throw new Error(`no characteristic ${u}`);
              },
            };
          },
        };
      },
      disconnect: () => {
        this.disconnects++;
        this.linkUp = false;
        this.tx.subscribed = false;
      },
    };
  }

  addEventListener(type: string, cb: () => void): void {
    if (type === "gattserverdisconnected") this.linkListeners.push(cb);
  }

  /** The device drops the BLE link (out of range / reboot). */
  dropLink(): void {
    this.linkUp = false;
    this.tx.subscribed = false;
    for (const cb of [...this.linkListeners]) cb();
  }

  private serve(frame: Uint8Array): void {
    this.rxFrames.push(frame.length);
    const msg = decodeClient(frame) as unknown as ClientMsg;
    this.player.handle(msg, (reply) => {
      queueMicrotask(() => {
        if (!this.linkUp) return;
        const wire = frameWithLength(encodeServer(reply));
        for (const c of chunkBytes(wire, NOTIFY_CHUNK)) this.tx.emit(c.slice());
      });
    });
  }
}

// -- the Capacitor BLE plugin (native iOS/Android wrapper) ----------------------

/** One scan result as @capacitor-community/bluetooth-le reports it. */
export interface ScanResultLike {
  device: { deviceId: string; name?: string };
  localName?: string;
  rssi?: number;
}

/**
 * A stand-in for `@capacitor-community/bluetooth-le`'s BleClient, simulating one
 * Improv peripheral per deviceId behind it. The real plugin needs the native
 * runtime, so `install()` intercepts the module load (the code under test reaches
 * it through a lazy `import()`, i.e. a CommonJS require in the test build) and
 * hands back this fake instead.
 */
export class FakeCapacitorBle {
  /** Plugin calls in order: "initialize", "requestLEScan", "stopLEScan",
   * "connect:<id>", "disconnect:<id>", "notify:<char suffix>", "write:<char suffix>". */
  readonly calls: string[] = [];
  /** Bytes the app wrote, per write call (copied out of the DataView window). */
  readonly writes: Array<{ deviceId: string; char: string; bytes: Uint8Array }> = [];
  /** Redirect the simulated device reports after joining. */
  redirect = "http://192.168.1.50/";
  /** Fail the next N connect() calls. */
  failConnects = 0;
  private scanCb: ((r: ScanResultLike) => void) | null = null;
  private readonly notify = new Map<string, (v: DataView) => void>();

  readonly BleClient = {
    initialize: async (): Promise<void> => {
      this.calls.push("initialize");
    },
    requestLEScan: async (_opts: unknown, cb: (r: ScanResultLike) => void): Promise<void> => {
      this.calls.push("requestLEScan");
      this.scanCb = cb;
    },
    stopLEScan: async (): Promise<void> => {
      this.calls.push("stopLEScan");
      this.scanCb = null;
    },
    connect: async (deviceId: string): Promise<void> => {
      this.calls.push(`connect:${deviceId}`);
      if (this.failConnects > 0) {
        this.failConnects--;
        throw new Error(GATT_FLAKE);
      }
    },
    disconnect: async (deviceId: string): Promise<void> => {
      this.calls.push(`disconnect:${deviceId}`);
    },
    startNotifications: async (
      deviceId: string,
      _service: string,
      char: string,
      cb: (v: DataView) => void,
    ): Promise<void> => {
      this.calls.push(`notify:${char.slice(-4)}`);
      this.notify.set(`${deviceId}|${char}`, cb);
    },
    write: async (deviceId: string, _service: string, char: string, view: DataView): Promise<void> => {
      this.calls.push(`write:${char.slice(-4)}`);
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
      this.writes.push({ deviceId, char, bytes });
      if (char === CHAR_RPC_COMMAND && parseWifiSettings(bytes)) {
        setTimeout(() => {
          const pkt = improvResultPacket([this.redirect]);
          this.notify.get(`${deviceId}|${CHAR_RPC_RESULT}`)?.(new DataView(pkt.buffer));
        }, 20);
      }
    },
  };

  /** Deliver one advertisement sighting to the running scan. */
  advertise(hit: ScanResultLike): void {
    this.scanCb?.(hit);
  }

  get scanning(): boolean {
    return this.scanCb !== null;
  }

  /** Serve this fake for `@capacitor-community/bluetooth-le`; returns the undo. */
  install(): () => void {
    const M = Module as unknown as {
      _load: (request: string, parent: unknown, isMain: boolean) => unknown;
    };
    const orig = M._load;
    const fake = { BleClient: this.BleClient };
    M._load = function (this: unknown, request: string, parent: unknown, isMain: boolean): unknown {
      if (request === "@capacitor-community/bluetooth-le") return fake;
      return orig.call(this, request, parent, isMain);
    };
    return () => {
      M._load = orig;
    };
  }
}

// -- navigator.bluetooth --------------------------------------------------------

export interface BluetoothStub {
  /** Every requestDevice() options object, in order. */
  requests: unknown[];
  restore(): void;
}

/** Install a stand-in `navigator.bluetooth` whose chooser resolves with
 * `pick(options)` (throw a DOMException NotFoundError to model a dismiss). */
export function installBluetooth(pick: (options: unknown) => unknown): BluetoothStub {
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  const requests: unknown[] = [];
  Object.defineProperty(nav, "bluetooth", {
    configurable: true,
    value: {
      requestDevice: async (options: unknown) => {
        requests.push(options);
        return pick(options);
      },
    },
  });
  return {
    requests,
    restore: () => {
      delete nav["bluetooth"];
    },
  };
}

// -- fake-DOM conveniences -------------------------------------------------------

/** All elements matching `selector` under the document body. */
export function all(selector: string): FakeElement[] {
  return asFake(document.body).querySelectorAll(selector);
}

/** The first button whose visible text or title/aria-label contains `label`. */
export function button(label: string, root: unknown = document.body): FakeElement {
  const hit = asFake(root)
    .querySelectorAll("button")
    .find((b) => b.textContent.includes(label) || (b.getAttribute("title") ?? "").includes(label));
  if (!hit) throw new Error(`no button "${label}"`);
  return hit;
}

/** The first button whose title is exactly `title` (icon buttons). */
export function buttonTitled(title: string, root: unknown = document.body): FakeElement {
  const hit = asFake(root)
    .querySelectorAll("button")
    .find((b) => b.getAttribute("title") === title);
  if (!hit) throw new Error(`no button titled "${title}"`);
  return hit;
}

/** Visible toast messages, oldest first. */
export function toasts(): string[] {
  return all(".k-toast").map((t) => t.textContent);
}

/** Close every open sheet / dialog and drop their nodes and toasts (between tests). */
export function clearOverlays(): void {
  for (const s of all(".k-sheet-scrim")) s.click(); // Sheet.close → onClose
  for (const sel of [".k-sheet-scrim", ".k-sheet", ".k-confirm-scrim", ".k-confirm", ".k-toast"]) {
    for (const el of all(sel)) el.remove();
  }
}
