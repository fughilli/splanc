/**
 * An in-process fake Splanc player for the bridge tests: TLS (self-signed test
 * cert) + WebSocket on /ws speaking the real protobuf wire (web/src/net/proto's
 * decodeClient/encodeServer), the discovery manifest route, and scripted replies.
 * It records every request it receives.
 */

import { readFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { WebSocketServer, type WebSocket } from "ws";

import { decodeClient, encodeMappingBundle, encodeServer, type MappingBundle } from "../../web/src/net/proto";
import type { ServerMessage } from "@ledmapper/protocol";

export const FIXTURES = process.env["AGENT_TEST_FIXTURES"] ?? join(process.cwd(), "tests/fixtures");
export const TEST_CERT_SHA256 =
  "2B:2F:BA:31:32:EF:D5:58:E4:33:4D:DC:23:7B:88:D6:0F:B4:3F:9C:EC:56:CD:D5:F5:53:14:7E:9F:69:8D:E2";
/** A second identity (cert2.pem/key2.pem): the same player after a factory reset, or
 * an impostor answering as it. */
export const TEST_CERT2_SHA256 =
  "BA:5B:E9:6F:A9:C8:7C:CA:6C:45:06:E2:1D:49:1E:78:EA:E8:75:7F:BA:E7:2A:5A:82:F6:FD:16:54:AC:6B:40";

type Msg = Record<string, unknown> & { type: string };

export interface FakeEffect {
  id: string;
  manifest: string;
  /** The uploaded .fxb. */
  fxb?: Uint8Array;
  current: { slot: number; value: number[] }[];
  textures?: { index: number; width: number; height: number; elem: number }[];
}

export class FakePlayer {
  readonly received: Msg[] = [];
  /** Deck A's effect (the only deck before FUG-110). */
  effect: FakeEffect | null = null;
  /** Deck B's effect (firmware with "decks"). */
  deckB: FakeEffect | null = null;
  /** Running flags per deck (an upload with activate=false parks it). */
  deckActive: [boolean, boolean] = [false, false];
  /** The global crossfade (0 = all A .. 1 = all B) and mode, and every set. */
  crossfade = 0;
  crossfadeMode = 0;
  readonly crossfades: { position: number; mode: number; at: number }[] = [];
  /** A slow player: delay each set_crossfade's apply + ack (ms). */
  crossfadeDelayMs = 0;
  /** The last set_time_base epoch (device ms). */
  timeBase: number | null = null;
  /** The running mapping pattern (start_mapping options + the epoch it used), or null. */
  mapping: { options: Record<string, unknown>; epochMs: number } | null = null;
  /** The last set_fixture_pose pose (null = none / cleared). */
  pose: Record<string, unknown> | null = null;
  bundle: MappingBundle | null = null;
  manifest: unknown | null = null;
  fwVersion = "1.6.0";
  brightness = 1;
  name = "Led Widget 31687A";
  mac = "CC:FD:49:00:3F:08";
  /** Error to answer the NEXT effect upload with (e.g. effect_too_large). */
  nextUploadError: { code: string; message: string } | null = null;
  /** Error codes to answer whole request types with. */
  refuse = new Map<string, { code: string; message: string }>();
  perf: { budgetCycles: number; frameCyclesMean: number; frameCyclesMax: number; overruns: number; currentFps?: number } =
    { budgetCycles: 5_333_333, frameCyclesMean: 1_000_000, frameCyclesMax: 1_200_000, overruns: 0 };
  /** FUG-82: push fps_state{lagging} (the effect can't hold the floor / pin and runs
   * at `achievedFps`, still playing) on the next set_perf. `oldAbort`: answer like
   * pre-lag firmware instead, which parked the effect (aborted, no lagging). */
  lagOnNextPerf: { auto: boolean; targetFps: number; achievedFps: number; oldAbort?: boolean } | null = null;
  /** The fake device clock = this process's performance.now() + this. */
  clockOffsetMs = 0;
  /** Delay before each time_sync_pong (simulated one-way latency). */
  pingDelayMs = 0;
  /** Manifest features (see agentManifest). */
  features: string[] = ["effects", "perf", "textures", "stored_map"];
  /** hardware_config_state per-channel LED counts (0 = not configured). */
  hwLedCounts: number[] = [64];
  /** hardware_config_state.led_capacity (0 = not reported). */
  ledCapacity = 0;
  /** Also send them in Welcome.features (current firmware does). */
  welcomeFeatures = true;
  /** Every HTTPS GET (the manifest route) and every /ws connection, in order. */
  readonly connections: ("manifest" | "ws")[] = [];
  /** Device-stored uniform keypoints: effect id -> name -> {index, values by uniform}. */
  keypoints = new Map<string, Map<string, { index: number; values: Record<string, number[]> }>>();
  /** The motion sensor's get_sensors reply (proto3-JSON field names); null =
   * the sensor core reports "absent". calibrate_sensors bumps calibrationSeq. */
  sensor: Record<string, unknown> | null = null;
  /** The loaded sensor driver's driver_state (null = none). */
  driver: Record<string, unknown> | null = null;
  /** The Wi-Fi rejoin policy (proto3-JSON names; the "wifi_policy" feature).
   * set_wifi_policy merges the set fields; manual/offline are refused while
   * `otaPending` unless forced, like the firmware. */
  wifi: Record<string, unknown> = {
    mode: "WIFI_MODE_AUTO",
    scanCapS: 60,
    intervalS: 300,
    decayAfterH: 0,
    sparseIntervalS: 900,
    state: "WIFI_LINK_JOINED",
    ssid: "Venue1",
    radioOn: true,
  };
  otaPending = false;
  /** Every blend_keypoints applied (for assertions). */
  blends: Msg[] = [];

  /** Extra request handlers by message type (checked before the built-in ones),
   * e.g. the FX debugger emulation in fxdebug.test.ts. Return null for no reply. */
  readonly handlers = new Map<string, (m: Msg) => Msg | null>();

  /** Which TLS identity this player serves (2 = cert2.pem: "after a factory reset"). */
  identity: 1 | 2 = 1;

  constructor(opts: { name?: string; mac?: string; fwVersion?: string; identity?: 1 | 2 } = {}) {
    if (opts.name) this.name = opts.name;
    if (opts.mac) this.mac = opts.mac;
    if (opts.fwVersion) this.fwVersion = opts.fwVersion;
    if (opts.identity) this.identity = opts.identity;
  }

  get certSha256(): string {
    return this.identity === 2 ? TEST_CERT2_SHA256 : TEST_CERT_SHA256;
  }

  /** Serve a splanc-agent/1 manifest describing this player. */
  serveManifest(extra: Record<string, unknown> = {}): void {
    this.manifest = {
      schema: "splanc-agent/1",
      device: { id: this.mac, name: this.name, board: "ESP32-C6 SuperMini" },
      firmware: { version: this.fwVersion },
      protocol: { ws_path: "/ws", features: this.features },
      tls: { cert_sha256: this.certSha256, state: "ready", persisted: true },
      ...extra,
    };
  }
  private server!: https.Server;
  private wss!: WebSocketServer;
  private uploads = new Map<number, string[]>();
  port = 0;

  /** Listen (on `port`, default any free one — pass the old port to "reboot"). */
  async start(port = 0): Promise<void> {
    const sfx = this.identity === 2 ? "2" : "";
    this.server = https.createServer(
      { cert: readFileSync(join(FIXTURES, `cert${sfx}.pem`)), key: readFileSync(join(FIXTURES, `key${sfx}.pem`)) },
      (req, res) => {
        this.connections.push("manifest");
        if (req.url === "/.well-known/splanc.json" && this.manifest !== null) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(this.manifest));
        } else {
          res.writeHead(404);
          res.end("not found");
        }
      },
    );
    this.wss = new WebSocketServer({ server: this.server, path: "/ws" });
    this.wss.on("connection", (ws) => {
      this.connections.push("ws");
      ws.on("message", (data: Buffer) => this.onMessage(ws, decodeClient(new Uint8Array(data)) as unknown as Msg));
    });
    await new Promise<void>((r) => this.server.listen(port, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
  }

  get host(): string {
    return `127.0.0.1:${this.port}`;
  }

  /** Ignore everything received (no replies): a player that rebooted onto another
   * IP, as the bridge sees it — its old socket stays "open" and nothing answers. */
  silent = false;

  /** "Reboot onto a new IP": go silent on every open socket WITHOUT closing them
   * (no FIN/RST, like a device that vanished), and stop listening at this address. */
  freeze(): void {
    this.silent = true;
    this.server.close();
  }

  async stop(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Push an fps_state (FUG-82) to every connected session, as the autoscaler does. */
  pushFpsState(st: { targetFps: number; currentFps: number; auto: boolean; lagging: boolean; achievedFps?: number }): void {
    for (const c of this.wss.clients) this.reply(c, { type: "fps_state", minFps: 25, maxFps: 80, ...st });
  }

  types(): string[] {
    return this.received.map((m) => m.type);
  }

  private reply(ws: WebSocket, msg: Msg): void {
    ws.send(encodeServer(msg as unknown as ServerMessage));
  }

  private welcome(): Msg {
    return {
      type: "welcome",
      sessionId: "fake",
      mac: this.mac,
      deviceName: this.name,
      fwVersion: this.fwVersion,
      fwGitCommit: "0".repeat(40),
      fwGitDirty: false,
      brightness: this.brightness,
      // Like the firmware since the manifest arrived (#276): Welcome carries the
      // features too, so the bridge needn't read the manifest to know them.
      ...(this.welcomeFeatures ? { features: this.features } : {}),
      ...(this.features.includes("crossfade") ? { crossfade: this.crossfade, crossfadeMode: this.crossfadeMode } : {}),
    };
  }

  deck(d: number): FakeEffect | null {
    return d === 1 ? this.deckB : this.effect;
  }

  /** What the LEDs show, per the firmware's two-deck shade: A, B or both. */
  visible(): ("A" | "B")[] {
    const a = !!this.effect && this.deckActive[0];
    const b = !!this.deckB && this.deckActive[1];
    const out: ("A" | "B")[] = [];
    if (a && !(b && this.crossfade >= 1)) out.push("A");
    if (b && !(a && this.crossfade <= 0)) out.push("B");
    return out;
  }

  private applyEffect(effectId: string, fxbB64: string | Uint8Array, activate: boolean, deck = 0): Msg {
    if (this.nextUploadError) {
      const e = this.nextUploadError;
      this.nextUploadError = null;
      return { type: "error", ...e };
    }
    const fxb = typeof fxbB64 === "string" ? Buffer.from(fxbB64, "base64") : Buffer.from(fxbB64);
    // The real device stores the manifest embedded in the .fxb; the fake reads
    // it back out of the header (manifest length @8, manifest after the 18-B header).
    const mlen = fxb.readUInt16LE(8);
    const manifest = fxb.subarray(18, 18 + mlen).toString("utf8");
    const e = { id: effectId, manifest, current: [], fxb: new Uint8Array(fxb) };
    if (deck === 1) {
      this.deckB = e;
      this.deckActive[1] = activate;
    } else if (activate || this.features.includes("decks")) {
      // Pre-deck firmware tests only ever activate; a parked deck-A load is kept.
      this.effect = e;
      this.deckActive[0] = activate;
    }
    return { type: "result_ready", mapId: effectId };
  }

  private onMessage(ws: WebSocket, m: Msg): void {
    if (this.silent) return;
    this.received.push(m);
    const refusal = this.refuse.get(m.type);
    if (refusal) {
      this.reply(ws, { type: "error", ...refusal });
      return;
    }
    const extra = this.handlers.get(m.type);
    if (extra) {
      const r = extra(m);
      if (r) this.reply(ws, r);
      return;
    }
    switch (m.type) {
      case "hello":
        return this.reply(ws, this.welcome());
      case "set_brightness":
        this.brightness = m["brightness"] as number;
        return this.reply(ws, this.welcome());
      case "set_device_name":
        this.name = m["name"] as string;
        return this.reply(ws, this.welcome());
      case "get_hardware_config":
        return this.reply(ws, {
          type: "hardware_config_state",
          channels: this.hwLedCounts.map((ledCount, channel) => ({
            channel,
            gpio: channel === 0 ? 20 : 14,
            ledType: "ws281x",
            colorOrder: "GRB",
            ledCount,
          })),
          ledCapacity: this.ledCapacity,
          board: { board: "ESP32-C6 SuperMini", gpioPins: [], ledModes: [], ledChannels: 2, maxLeds: 512 },
        });
      case "get_effect_uniforms": {
        const d = (m["deck"] as number) ?? 0;
        if (d === 1 && !(this.deckB && this.deckActive[1])) {
          return this.reply(ws, { type: "error", code: "no_effect", message: "no active effect to describe" });
        }
        const e = this.deck(d);
        return this.reply(ws, {
          type: "effect_uniforms",
          effectId: e?.id ?? "",
          manifest: new TextEncoder().encode(e?.manifest ?? ""),
          current: e?.current ?? [],
          textures: e?.textures ?? [],
        });
      }
      case "set_uniforms": {
        const e = this.deck((m["deck"] as number) ?? 0);
        if (e) {
          for (const v of m["values"] as { slot: number; value: number[] }[]) {
            e.current = e.current.filter((c) => c.slot !== v.slot).concat([v]);
          }
        }
        // Like the firmware: a seq'd (live-channel) update gets a ControlAck, a
        // legacy one its playback_state.
        if (m["seq"]) return this.reply(ws, { type: "control_ack", seq: m["seq"] });
        return this.reply(ws, { type: "playback_state", active: false, effect: "off" });
      }
      case "set_effect": {
        const d = (m["deck"] as number) ?? 0;
        const id = m["effectId"] as string;
        if (!id || id === "off") {
          if (d === 1 && this.deckB && this.deckActive[1]) this.deckActive[1] = false;
          else if (d === 1) this.deckB = null;
          else {
            this.effect = null;
            this.deckActive[0] = false;
          }
        } else if (this.deck(d)) {
          this.deckActive[d === 1 ? 1 : 0] = true;
        }
        return this.reply(ws, { type: "playback_state", active: false, effect: "off" });
      }
      case "list_effects":
        return this.reply(ws, {
          type: "effect_list",
          effects: ([0, 1] as const)
            .filter((d) => this.deck(d))
            .map((d) => ({ effectId: this.deck(d)!.id, fxbBytes: 100, active: this.deckActive[d], deck: d })),
        });
      case "set_crossfade": {
        const apply = () => {
          this.crossfade = Math.min(1, Math.max(0, m["position"] as number));
          this.crossfadeMode = (m["mode"] as number) ?? 0;
          this.crossfades.push({ position: this.crossfade, mode: this.crossfadeMode, at: performance.now() });
          this.reply(ws, m["seq"] ? { type: "control_ack", seq: m["seq"] } : this.welcome());
        };
        if (this.crossfadeDelayMs > 0) setTimeout(apply, this.crossfadeDelayMs);
        else apply();
        return;
      }
      case "set_time_base":
        this.timeBase = Number(m["epochMs"]);
        return this.reply(ws, this.welcome());
      case "start_mapping": {
        // Group capture (firmware group_capture): code book of codeSpace ids, LED
        // i transmits i + codeOffset, on the requested epoch (device clock).
        const o = (m["options"] ?? {}) as Record<string, number>;
        const space = o["codeSpace"] ?? (o["codeOffset"] ?? 0) + o["ledCount"]!;
        const epochMs = o["epochMs"] ?? performance.now() + this.clockOffsetMs;
        this.mapping = { options: o, epochMs };
        const bits = Math.ceil(Math.log2(space + 1)) + 5;
        return this.reply(ws, {
          type: "mapping_started",
          patternClockEpoch: epochMs,
          codeParams: {
            ledCount: space,
            bits,
            encoding: "hue",
            bitPeriodMs: o["bitPeriodMs"] ?? 100,
            syncPattern: "on_off",
            cycleFrames: 2 + Math.ceil(bits / ((o["symbols"] ?? 2) === 4 ? 2 : 1)),
            fec: "secded",
            symbols: o["symbols"] ?? 2,
            ...(o["codeOffset"] ? { codeOffset: o["codeOffset"] } : {}),
          },
        });
      }
      case "stop_mapping":
        this.mapping = null;
        return this.reply(ws, { type: "mapping_stopped", detections: 0, imuSamples: 0 });
      case "set_fixture_pose":
        this.pose = (m["pose"] as Record<string, unknown>) ?? null;
        return this.reply(ws, this.welcome());
      case "submit_effect":
        return this.reply(
          ws,
          this.applyEffect(m["effectId"] as string, m["fxb"] as Uint8Array, m["activate"] as boolean, (m["deck"] as number) ?? 0),
        );
      case "upload_chunk": {
        const id = m["uploadId"] as number;
        const parts = this.uploads.get(id) ?? [];
        parts.push(m["payload"] as string);
        this.uploads.set(id, parts);
        if (!m["last"]) return this.reply(ws, { type: "chunk_ack", uploadId: id, seq: m["seq"] as number });
        this.uploads.delete(id);
        const frame = Buffer.concat(parts.map((p) => Buffer.from(p, "base64")));
        const inner = decodeClient(new Uint8Array(frame)) as unknown as Msg;
        this.received.push(inner);
        return this.reply(
          ws,
          this.applyEffect(inner["effectId"] as string, inner["fxb"] as Uint8Array, inner["activate"] as boolean, (inner["deck"] as number) ?? 0),
        );
      }
      case "set_perf":
      case "get_perf_report":
        if (m.type === "set_perf" && this.lagOnNextPerf) {
          const a = this.lagOnNextPerf;
          this.lagOnNextPerf = null;
          this.reply(ws, {
            type: "fps_state",
            targetFps: a.targetFps,
            minFps: 25,
            maxFps: 80,
            auto: a.auto,
            ...(a.oldAbort
              ? { currentFps: a.auto ? 25 : a.targetFps, aborted: true }
              : { currentFps: a.achievedFps, lagging: true, achievedFps: a.achievedFps }),
          });
        }
        return this.reply(ws, {
          type: "perf_report",
          effectId: this.effect?.id ?? "",
          cpuHz: 160_000_000,
          budgetCycles: this.perf.budgetCycles,
          ...(this.perf.currentFps ? { currentFps: this.perf.currentFps } : {}),
          frameCyclesMin: this.perf.frameCyclesMean,
          frameCyclesMean: this.perf.frameCyclesMean,
          frameCyclesMax: this.perf.frameCyclesMax,
          overruns: this.perf.overruns,
          heapFree: 90000,
          heapMinFree: 80000,
          heapLargestFree: 60000,
        });
      case "get_stored_map": {
        if (!this.bundle) return this.reply(ws, { type: "error", code: "no_map", message: "no stored map to dump" });
        const all = encodeMappingBundle(this.bundle);
        const off = m["offset"] as number;
        const len = (m["maxLen"] as number) || 1024;
        return this.reply(ws, {
          type: "stored_map_chunk",
          totalLen: all.length,
          offset: off,
          data: all.subarray(off, off + len),
          hasTopology: true,
        });
      }
      case "set_texture":
        return;
      case "save_keypoint":
      case "list_keypoints":
      case "delete_keypoint":
      case "get_keypoint":
      case "blend_keypoints":
        return this.reply(ws, this.keypoint(m));
      case "get_sensors":
      case "calibrate_sensors": {
        const base = this.sensor ?? { status: "SENSOR_STATUS_ABSENT", sdaGpio: 6, sclGpio: 7, intGpio: 21 };
        const reply = { type: "sensor_state", ...base };
        if (m.type === "calibrate_sensors" && this.sensor) {
          // Applied "on the next poll": the reply is the state before it ran.
          const seq = (this.sensor["calibrationSeq"] as number | undefined) ?? 0;
          this.sensor = { ...this.sensor, calibrationSeq: seq + 1, calibrationResult: "ok", calibrated: true };
        }
        return this.reply(ws, reply);
      }
      case "get_wifi_policy":
        return this.reply(ws, { type: "wifi_policy_state", ...this.wifi, otaPending: this.otaPending });
      case "set_wifi_policy": {
        const mode = m["mode"] as string | undefined;
        const leaving = mode === "WIFI_MODE_MANUAL" || mode === "WIFI_MODE_OFFLINE";
        if (leaving && mode !== this.wifi["mode"] && this.otaPending && m["force"] !== true) {
          return this.reply(ws, {
            type: "wifi_policy_state",
            ...this.wifi,
            otaPending: true,
            refused: "ota_pending",
          });
        }
        for (const k of ["mode", "scanCapS", "intervalS", "decayAfterH", "sparseIntervalS"]) {
          if (m[k] !== undefined) this.wifi[k] = m[k];
        }
        if (this.wifi["mode"] === "WIFI_MODE_OFFLINE") {
          this.wifi = { ...this.wifi, state: "WIFI_LINK_OFFLINE", radioOn: false, nextScanS: 0 };
        } else if (m["rejoinNow"] === true && this.wifi["state"] !== "WIFI_LINK_JOINED") {
          this.wifi = { ...this.wifi, state: "WIFI_LINK_SEARCHING", radioOn: true, nextScanS: 0 };
        }
        return this.reply(ws, { type: "wifi_policy_state", ...this.wifi, otaPending: this.otaPending });
      }
      case "scan_i2c":
        return this.reply(ws, { type: "i2c_scan_result", addresses: [0x40, 0x68] });
      case "submit_driver":
        this.driver = { running: true, pollIntervalMs: m["pollIntervalMs"], feedImu: m["feedImu"], polls: 3, busOps: 6, exports: [{ name: "imu_ok", value: [1] }] };
        return this.reply(ws, { type: "driver_state", ...this.driver });
      case "get_driver_state":
        return this.reply(ws, { type: "driver_state", ...(this.driver ?? { running: false }) });
      case "remove_driver":
        this.driver = null;
        return this.reply(ws, { type: "driver_state", running: false });
      case "time_sync_ping": {
        // The device clock: this process's clock shifted by clockOffsetMs.
        const t1 = performance.now() + this.clockOffsetMs;
        const pong = { type: "time_sync_pong", t0: m["t0"] as number, t1, t2: t1 };
        if (this.pingDelayMs > 0) {
          setTimeout(() => this.reply(ws, pong), this.pingDelayMs);
          return;
        }
        return this.reply(ws, pong);
      }
      default:
        return this.reply(ws, { type: "error", code: "unsupported", message: `fake player: ${m.type}` });
    }
  }
}

/** The fake's manifest walk: uniform name -> {slot, width}. */
function ports(manifest: string): Map<string, { slot: number; width: number }> {
  const out = new Map<string, { slot: number; width: number }>();
  try {
    for (const u of JSON.parse(manifest) as { name: string; slot: number; width?: number }[]) {
      out.set(u.name, { slot: u.slot, width: u.width ?? 1 });
    }
  } catch {
    /* no manifest */
  }
  return out;
}

export interface FakePlayer {
  keypoint(m: Msg): Msg;
}

/** Keypoint arms, modelled closely enough for the bridge: store by uniform name,
 * blend floats linearly (the device's per-kind rules are its own tests'). */
FakePlayer.prototype.keypoint = function (this: FakePlayer, m: Msg): Msg {
  const e = this.deck((m["deck"] as number) ?? 0);
  if (!e) return { type: "error", code: "no_effect", message: "no effect loaded on that deck" };
  const store = this.keypoints.get(e.id) ?? new Map();
  this.keypoints.set(e.id, store);
  const list = (): Msg => ({
    type: "keypoint_list",
    effectId: e.id,
    keypoints: [...store.entries()].map(([name, k]) => ({ index: k.index, name, stale: false })),
    capacity: 16,
  });
  const p = ports(e.manifest);
  const bySlot = new Map(e.current.map((c) => [c.slot, c.value]));
  const name = (m["name"] as string) ?? "";
  switch (m.type) {
    case "list_keypoints":
      return list();
    case "save_keypoint": {
      const given = (m["values"] as { slot: number; value: number[] }[] | undefined) ?? [];
      const values: Record<string, number[]> = {};
      for (const [u, { slot }] of p) {
        const v = given.length ? given.find((g) => g.slot === slot)?.value : bySlot.get(slot);
        if (v) values[u] = v;
      }
      const index = store.get(name)?.index ?? [...Array(16).keys()].find((i) => ![...store.values()].some((k) => k.index === i));
      if (index === undefined) return { type: "error", code: "keypoint_full", message: "16 keypoints per effect" };
      store.set(name, { index, values });
      return list();
    }
    case "delete_keypoint":
      if (!store.delete(name)) return { type: "error", code: "no_keypoint", message: "no keypoint by that name" };
      return list();
    case "get_keypoint": {
      const k = store.get(name);
      if (!k) return { type: "error", code: "no_keypoint", message: "no keypoint by that name" };
      return {
        type: "keypoint",
        effectId: e.id,
        index: k.index,
        name,
        stale: false,
        values: Object.entries(k.values).map(([uniform, value]) => ({ uniform, value })),
        slots: [],
      };
    }
    default: {
      // blend_keypoints: weighted mean per uniform, applied at once (the fake has
      // no frames; `seconds` is just recorded).
      const ws = m["weights"] as { name: string; weight: number }[];
      const total = ws.reduce((s, w) => s + Math.max(0, w.weight), 0);
      for (const w of ws) {
        if (!store.has(w.name)) return { type: "error", code: "no_keypoint", message: "no keypoint by that name" };
      }
      for (const [u, { slot, width }] of p) {
        const mix = new Array(width).fill(0);
        for (const w of ws) {
          const v = store.get(w.name)!.values[u] ?? bySlot.get(slot) ?? new Array(width).fill(0);
          for (let i = 0; i < width; i++) mix[i] += (Math.max(0, w.weight) / total) * (v[i] ?? 0);
        }
        e.current = e.current.filter((c) => c.slot !== slot).concat([{ slot, value: mix }]);
      }
      this.blends.push(m);
      return { type: "playback_state", active: true, effect: e.id };
    }
  }
};

/** A small fixture: a 3-arm Y of 30 LEDs, 1 m arms, with topology. */
export function yFixture(): MappingBundle {
  const leds = [];
  const associations = [];
  const dirs: [number, number][] = [
    [0, 1],
    [0.87, -0.5],
    [-0.87, -0.5],
  ];
  for (let i = 0; i < 30; i++) {
    const arm = i % 3;
    const s = (Math.floor(i / 3) + 1) * 0.1;
    const [dx, dy] = dirs[arm]!;
    leds.push({ id: i, xyz: [dx * s, 1 + dy * s, 0] as [number, number, number], confidence: 1, nViews: 4, rmsReprojPx: 0.5, parallaxDeg: 10 });
    associations.push({ ledId: i, segmentId: 10 + arm, footArclength: s, dPerp: 0 });
  }
  return {
    map: {
      mapId: "m-fake",
      createdAt: "2026-10-19T00:00:00Z",
      units: "meters",
      frame: "gravity_leveled",
      ledCount: 30,
      leds,
      unmapped: [],
      stats: { rmsReprojPxGlobal: 0.5, medianParallaxDeg: 10 },
    },
    topology: {
      mapId: "m-fake",
      branchPoints: [{ id: 0, xyz: [0, 1, 0] }],
      segments: [10, 11, 12].map((id, k) => ({
        id,
        a: 0,
        b: -1,
        length: 1,
        polyline: [
          [0, 1, 0],
          [dirs[k]![0], 1 + dirs[k]![1], 0],
        ] as [number, number, number][],
      })),
      associations,
    },
  } as unknown as MappingBundle;
}
