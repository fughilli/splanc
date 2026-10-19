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

type Msg = Record<string, unknown> & { type: string };

export interface FakeEffect {
  id: string;
  manifest: string;
  current: { slot: number; value: number[] }[];
  textures?: { index: number; width: number; height: number; elem: number }[];
}

export class FakePlayer {
  readonly received: Msg[] = [];
  effect: FakeEffect | null = null;
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
  perf = { budgetCycles: 5_333_333, frameCyclesMean: 1_000_000, frameCyclesMax: 1_200_000, overruns: 0 };
  private server!: https.Server;
  private wss!: WebSocketServer;
  private uploads = new Map<number, string[]>();
  port = 0;

  async start(): Promise<void> {
    this.server = https.createServer(
      { cert: readFileSync(join(FIXTURES, "cert.pem")), key: readFileSync(join(FIXTURES, "key.pem")) },
      (req, res) => {
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
      ws.on("message", (data: Buffer) => this.onMessage(ws, decodeClient(new Uint8Array(data)) as unknown as Msg));
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
  }

  get host(): string {
    return `127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
    await new Promise<void>((r) => this.server.close(() => r()));
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
    };
  }

  private applyEffect(effectId: string, fxbB64: string | Uint8Array, activate: boolean): Msg {
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
    if (activate) this.effect = { id: effectId, manifest, current: [] };
    return { type: "result_ready", mapId: effectId };
  }

  private onMessage(ws: WebSocket, m: Msg): void {
    this.received.push(m);
    const refusal = this.refuse.get(m.type);
    if (refusal) {
      this.reply(ws, { type: "error", ...refusal });
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
          channels: [{ channel: 0, gpio: 20, ledType: "ws281x", colorOrder: "GRB", ledCount: 64 }],
          board: { board: "ESP32-C6 SuperMini", gpioPins: [], ledModes: [], ledChannels: 2, maxLeds: 512 },
        });
      case "get_effect_uniforms": {
        const e = this.effect;
        return this.reply(ws, {
          type: "effect_uniforms",
          effectId: e?.id ?? "",
          manifest: new TextEncoder().encode(e?.manifest ?? ""),
          current: e?.current ?? [],
          textures: e?.textures ?? [],
        });
      }
      case "set_uniforms":
        if (this.effect) {
          for (const v of m["values"] as { slot: number; value: number[] }[]) {
            this.effect.current = this.effect.current.filter((c) => c.slot !== v.slot).concat([v]);
          }
        }
        return;
      case "set_effect":
        if (!m["effectId"]) this.effect = null;
        return this.reply(ws, { type: "playback_state", active: false, effect: "off" });
      case "submit_effect":
        return this.reply(ws, this.applyEffect(m["effectId"] as string, m["fxb"] as Uint8Array, m["activate"] as boolean));
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
        return this.reply(ws, this.applyEffect(inner["effectId"] as string, inner["fxb"] as Uint8Array, inner["activate"] as boolean));
      }
      case "set_perf":
      case "get_perf_report":
        return this.reply(ws, {
          type: "perf_report",
          effectId: this.effect?.id ?? "",
          cpuHz: 160_000_000,
          budgetCycles: this.perf.budgetCycles,
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
      default:
        return this.reply(ws, { type: "error", code: "unsupported", message: `fake player: ${m.type}` });
    }
  }
}

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
