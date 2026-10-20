/**
 * One player, one /ws session. Everything the MCP tools and resources need from
 * the device goes through here, SERIALIZED (LedMapperClient's requests are
 * single-flight per reply type, and the device serves one session's requests in
 * order anyway), with three bridge-side policies the spec asks for:
 *
 * - error mapping: `unsupported` / `unsupported_effect` name the firmware
 *   version; `effect_too_large` / `bad_fxb` become plain tool errors;
 * - safety: no path here sends SetHardwareConfig, SetLedCount,
 *   SetColorCorrection, the mapping arms or SetJit (see FORBIDDEN_TYPES — a test
 *   pins it), and SetDeviceName needs an explicit confirmation;
 * - rollback: the device holds ONE loaded effect, so "the previous effect" is
 *   kept here as the bytecode last deployed, and restored by re-deploying it.
 */

import { ClientMessageSchema, SetUniformsSchema } from "../../web/src/gen/ledmapper_pb";
import { LedMapperClient, ServerErrorReply, type SocketFactory } from "../../web/src/net/client";
import type { ClientMessage } from "@ledmapper/protocol";
import {
  encodeClient,
  type EffectUniformsMessage,
  type HardwareConfigStateMessage,
  type MappingBundle,
  type PerfReportMessage,
  type UniformValueFlat,
} from "../../web/src/net/proto";
import { TextureStreamer, type TextureFormat } from "../../web/src/net/textureCodec";
import type { Pose } from "./config";
import { compile, type CompileOutcome, type Toolchain } from "./fxhost";
import type { ClockSync } from "./timesync";
import {
  describe,
  lerpValues,
  parseManifest,
  resolve,
  type ManifestUniform,
  type UniformInput,
} from "./uniforms";

/** Message types the bridge must never send (spec "Safety and exclusions"). */
export const FORBIDDEN_TYPES = new Set([
  "set_hardware_config",
  "set_led_count",
  "set_color_correction",
  "start_mapping",
  "configure",
  "stop_mapping",
  "submit_map",
  "submit_topology",
  "set_counting_pattern",
  "set_jit",
]);

/** Device features the bridge can use when the firmware advertises them
 * (Welcome.features or the discovery manifest's protocol.features). */
export type Feature =
  | "effects"
  | "perf"
  | "textures"
  | "stored_map"
  | "uniform_commit"
  | "list_effects"
  | "uniform_docs"
  | (string & {});

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export interface SessionOptions {
  url: string;
  socketFactory: SocketFactory;
  /** Features from the discovery manifest (merged with Welcome.features). */
  features?: string[];
  /** Max uniform stream rate for ramps, Hz (spec: configurable; default 20). */
  streamHz?: number;
  connectTimeoutMs?: number;
  /** The host compiler/VM matching this player's firmware (default: the bundle's). */
  toolchain?: Toolchain;
}

interface Deployed {
  effectId: string;
  fxb: Uint8Array;
  source?: string;
}

interface TextureStream {
  texIndex: number;
  timer: ReturnType<typeof setInterval>;
  frames: number;
}

export class DeviceSession {
  readonly client: LedMapperClient;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly extraFeatures: string[];
  readonly streamHz: number;
  private fixture: { mapId: string; bundle: MappingBundle } | null = null;
  private current: Deployed | null = null;
  private previous: Deployed | null = null;
  private readonly streams = new Map<number, TextureStream>();
  /** Every message type sent, for the safety test and diagnostics. */
  readonly sentTypes: string[] = [];
  /** Forbidden message types something tried to send (and the guard refused). */
  readonly blockedTypes: string[] = [];
  /** The host compiler/VM for this player's firmware (the hub sets it). */
  toolchain: Toolchain | undefined;
  /** The last clock sync against this player. */
  clock: ClockSync | null = null;

  constructor(private readonly opts: SessionOptions) {
    this.extraFeatures = opts.features ?? [];
    this.streamHz = opts.streamHz ?? 20;
    this.toolchain = opts.toolchain;
    const factory: SocketFactory = (url) => {
      const s = opts.socketFactory(url);
      const send = s.send.bind(s);
      s.send = (data) => {
        // Guard at the wire: decode just the envelope arm and refuse forbidden
        // ones (belt and braces under the tool layer, which never builds them).
        const t = sniffType(data);
        if (t !== null) {
          if (FORBIDDEN_TYPES.has(t)) {
            this.blockedTypes.push(t);
            throw new ToolError(`the bridge never sends ${t}`);
          }
          this.sentTypes.push(t);
        }
        send(data);
      };
      return s;
    };
    this.client = new LedMapperClient(opts.url, {
      socketFactory: factory,
      clientName: "splanc-agent",
      connectTimeoutMs: opts.connectTimeoutMs ?? 15000,
      requestTimeoutMs: 10000,
      // Unref'd: the client's connect/backoff timers must not keep Node alive
      // after close() (the stdio transport is what holds the CLI open).
      schedule: (fn, ms) => void setTimeout(fn, ms).unref(),
    });
  }

  /** Run `fn` after every earlier request on this session has settled. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next.then(undefined, (e) => {
      throw this.mapError(e);
    });
  }

  async connect() {
    return this.client.connect();
  }

  close(): void {
    for (const s of this.streams.values()) clearInterval(s.timer);
    this.streams.clear();
    this.client.close();
  }

  get welcome() {
    const w = this.client.welcome;
    if (!w) throw new ToolError("not connected to the player");
    return w;
  }

  get fwVersion(): string {
    return this.client.welcome?.fwVersion || "unknown";
  }

  features(): Set<string> {
    const w = this.client.welcome as unknown as { features?: string[] } | null;
    return new Set([...(w?.features ?? []), ...this.extraFeatures]);
  }

  has(f: Feature): boolean {
    return this.features().has(f);
  }

  private mapError(e: unknown): Error {
    if (e instanceof ServerErrorReply) {
      const code = e.code;
      if (code === "unsupported" || code === "unsupported_effect") {
        return new ToolError(
          `the player's firmware (${this.fwVersion}) doesn't support this (${code}: ${e.message})`,
        );
      }
      if (code === "effect_too_large") {
        return new ToolError(`the effect is too large for the player (${e.message}); simplify it`);
      }
      if (code === "bad_fxb") {
        return new ToolError(`the player rejected the effect bytecode (${e.message})`);
      }
      return new ToolError(`player error ${code}: ${e.message}`);
    }
    return e instanceof Error ? e : new Error(String(e));
  }

  // -- resources ---------------------------------------------------------------

  async device(): Promise<Record<string, unknown>> {
    const w = this.welcome;
    let hw: HardwareConfigStateMessage | null = null;
    try {
      hw = await this.run(() => this.client.getHardwareConfig());
    } catch {
      hw = null; // older firmware: no hardware-config arm
    }
    return {
      name: w.deviceName,
      id: w.mac,
      firmware: { version: w.fwVersion, commit: w.fwGitCommit, dirty: w.fwGitDirty },
      board: hw?.board?.board ?? null,
      channels: hw?.channels ?? [],
      max_leds: hw?.board?.maxLeds ?? null,
      brightness: (w as unknown as { brightness?: number }).brightness ?? 1,
      features: [...this.features()].sort(),
    };
  }

  /** The stored map + topology, pulled once in chunks and cached by map id. */
  async mappingBundle(refresh = false): Promise<MappingBundle> {
    if (this.fixture && !refresh) return this.fixture.bundle;
    const bundle = await this.run(() => this.client.pullStoredMap());
    this.fixture = { mapId: bundle.map?.mapId ?? "", bundle };
    return bundle;
  }

  async fixtureSummary(): Promise<Record<string, unknown>> {
    return summarize(await this.mappingBundle());
  }

  async activeEffect(): Promise<{
    effectId: string;
    uniforms: ManifestUniform[];
    current: Map<string, number[]>;
    textures: { index: number; width: number; height: number; elem: number }[];
    raw: EffectUniformsMessage;
  }> {
    const raw = await this.run(() => this.client.getEffectUniforms());
    const uniforms = parseManifest(raw.manifest ?? new Uint8Array(0));
    const bySlot = new Map((raw.current ?? []).map((c) => [c.slot, c.value]));
    const current = new Map<string, number[]>();
    for (const u of uniforms) {
      const v = bySlot.get(u.slot);
      if (v) current.set(u.name, v);
    }
    const textures = (raw as unknown as { textures?: { index: number; width: number; height: number; elem: number }[] })
      .textures ?? [];
    return { effectId: raw.effectId ?? "", uniforms, current, textures, raw };
  }

  async effectResource(): Promise<Record<string, unknown>> {
    const a = await this.activeEffect();
    const stored = this.has("list_effects")
      ? "TODO(list_effects): wire ListEffects once the device PR lands"
      : "the firmware can't list stored effects; only the active one is known";
    return {
      effect_id: a.effectId || null,
      uniforms: a.uniforms.map((u) => describe(u, a.current.get(u.name))),
      textures: a.textures,
      stored_effects: stored,
    };
  }

  // -- control -----------------------------------------------------------------

  async setBrightness(level: number): Promise<number> {
    if (!(level >= 0 && level <= 1)) throw new ToolError("level must be within 0..1");
    const w = await this.run(() => this.client.setBrightness(level));
    this.lastBrightness = (w as unknown as { brightness?: number }).brightness ?? level;
    return this.lastBrightness;
  }

  /** The brightness last set through this session (Welcome's is from connect time). */
  private lastBrightness: number | undefined;

  async setDeviceName(name: string, confirm: boolean): Promise<string> {
    if (!confirm) {
      throw new ToolError(
        "renaming persists and changes the Bluetooth name; ask the user, then call again with confirm: true",
      );
    }
    const w = await this.run(() => this.client.setDeviceName(name));
    return w.deviceName;
  }

  async listUniforms(): Promise<Record<string, unknown>> {
    const a = await this.activeEffect();
    if (!a.effectId) return { effect_id: null, uniforms: [], note: "no effect is loaded" };
    return { effect_id: a.effectId, uniforms: a.uniforms.map((u) => describe(u, a.current.get(u.name))) };
  }

  /** Resolve + send uniform values. `commit` persists them (when supported). */
  async setUniforms(values: Record<string, UniformInput>, commit = false): Promise<UniformValueFlat[]> {
    const a = await this.activeEffect();
    if (!a.effectId) throw new ToolError("no effect is loaded; deploy one first");
    const wire = resolve(a.uniforms, values);
    await this.run(async () => this.sendUniforms(wire, commit));
    return wire;
  }

  private sendUniforms(values: UniformValueFlat[], commit: boolean): void {
    // `commit` is a newer SetUniforms field (device-side spec work). Only send it
    // when the firmware says it understands it; older firmware commits on its
    // own coalesced schedule, so a ramp's final set still persists there.
    // Both halves must agree: the firmware advertises it AND this bundle's proto
    // has the field (fromJson would reject an unknown one). TODO(uniform_commit):
    // true once the device PR's proto change is regenerated into web/src/gen.
    const msg: Record<string, unknown> = { type: "set_uniforms", values };
    if (this.has("uniform_commit") && COMMIT_IN_PROTO) msg["commit"] = commit;
    const ok = (this.client as unknown as { send(m: unknown): boolean }).send(msg);
    if (!ok) throw new ToolError("the player connection is down");
  }

  /** Interpolate uniforms to `targets` over `seconds`, uncommitted, at the
   * stream rate; then one committed set of the targets. */
  async rampUniforms(
    targets: Record<string, UniformInput>,
    seconds: number,
    opts: { hz?: number; sleep?: (ms: number) => Promise<void> } = {},
  ): Promise<{ steps: number; final: UniformValueFlat[] }> {
    if (!(seconds >= 0 && seconds <= 600)) throw new ToolError("seconds must be within 0..600");
    const a = await this.activeEffect();
    if (!a.effectId) throw new ToolError("no effect is loaded; deploy one first");
    const final = resolve(a.uniforms, targets);
    const byName = new Map(a.uniforms.map((u) => [u.name, u]));
    const hz = Math.max(1, Math.min(opts.hz ?? this.streamHz, 60));
    const steps = Math.max(1, Math.round(seconds * hz));
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const names = Object.keys(targets);
    const from = names.map((n) => a.current.get(n) ?? byName.get(n)!.default);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const vals = names.map((n, k) => ({
        slot: byName.get(n)!.slot,
        value: lerpValues(byName.get(n)!, from[k]!, final[k]!.value, t),
      }));
      await this.run(async () => this.sendUniforms(vals, false));
      await sleep(1000 / hz);
    }
    await this.run(async () => this.sendUniforms(final, true));
    return { steps, final };
  }

  /** Resolves this player's toolchain on first compile (the hub sets it: picking
   * one may fetch the player's bundle, which only compile/preview need). */
  toolchainLoader: (() => Promise<Toolchain>) | undefined;

  /** This player's host compiler/VM (undefined: the bundle's own). */
  async getToolchain(): Promise<Toolchain | undefined> {
    if (this.toolchain === undefined && this.toolchainLoader) this.toolchain = await this.toolchainLoader();
    return this.toolchain;
  }

  /** Compile with this player's toolchain (no device traffic). */
  async compile(source: string): Promise<CompileOutcome> {
    return compile(source, await this.getToolchain());
  }

  /** Compile, then upload + (optionally) activate. Remembers what it replaced.
   * `compiled` skips the compile when the caller already has this player's build. */
  async deployEffect(effectId: string, source: string, activate: boolean, compiled?: CompileOutcome) {
    const c = compiled ?? (await this.compile(source));
    if (!c.ok) {
      const d = c.diagnostics.map((x) => `${x.line}:${x.col}: ${x.msg}`).join("\n");
      throw new ToolError(`the effect doesn't compile:\n${d}`);
    }
    await this.run(() => this.client.submitEffect(effectId, c.fxb, activate));
    if (activate) {
      this.previous = this.current;
      this.current = { effectId, fxb: c.fxb, source };
    }
    return { effect_id: effectId, bytecode_bytes: c.bytecodeBytes, uniforms: c.uniforms.map((u) => u.name) };
  }

  /** Select the active effect ("off" clears it). The device holds one effect:
   * any other id keeps the loaded one active. */
  async setEffect(effectId: string): Promise<Record<string, unknown>> {
    const id = effectId === "off" ? "" : effectId;
    if (id === "" && this.current) {
      this.previous = this.current;
      this.current = null;
    }
    await this.run(() => this.client.setEffect(id));
    const a = await this.activeEffect();
    return { active_effect: a.effectId || null };
  }

  /** Restore the effect active before the last deploy (re-uploads its bytecode). */
  async rollback(): Promise<Record<string, unknown>> {
    const prev = this.previous;
    if (prev) {
      await this.run(() => this.client.submitEffect(prev.effectId, prev.fxb, true));
      this.current = prev;
      this.previous = null;
      return { restored: prev.effectId };
    }
    await this.run(() => this.client.setEffect(""));
    this.current = null;
    return { restored: null, note: "no earlier effect was deployed by this bridge; the effect was turned off" };
  }

  /** BASIC perf for `seconds`: frame cost vs budget, overruns, heap. */
  async measureEffect(
    seconds: number,
    opts: { sleep?: (ms: number) => Promise<void> } = {},
  ): Promise<Record<string, unknown>> {
    if (!(seconds > 0 && seconds <= 60)) throw new ToolError("seconds must be within (0, 60]");
    const reports: PerfReportMessage[] = [];
    const unsub = this.client.onPerfReport((r) => reports.push(r));
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    try {
      await this.run(() => this.client.setPerf("BASIC", 1000));
      await sleep(seconds * 1000);
      await this.run(() => this.client.getPerfReport());
    } finally {
      unsub();
      await this.run(() => this.client.setPerf("OFF", 0)).catch(() => undefined);
    }
    const live = reports.filter((r) => r.frameCyclesMax > 0 || r.frameCyclesMean > 0);
    if (live.length === 0) return { reports: 0, note: "no frames were measured (is an effect active?)" };
    const last = live[live.length - 1]!;
    const meanCycles = live.reduce((s, r) => s + r.frameCyclesMean, 0) / live.length;
    const maxCycles = Math.max(...live.map((r) => r.frameCyclesMax));
    const overruns = live.reduce((s, r) => s + r.overruns, 0);
    const budget = last.budgetCycles;
    const toMs = (c: number) => (last.cpuHz > 0 ? +((c / last.cpuHz) * 1000).toFixed(2) : null);
    return {
      effect_id: last.effectId,
      reports: live.length,
      budget_cycles: budget,
      frame_cycles_mean: Math.round(meanCycles),
      frame_cycles_max: maxCycles,
      // The same numbers in ms, and per window (one per ~1 s report), so stability
      // and drift are visible — compare with estimate_effect's estimate_ms.
      frame_ms_mean: toMs(meanCycles),
      frame_ms_max: toMs(maxCycles),
      window_means_ms: live.map((r) => toMs(r.frameCyclesMean)),
      budget_used: budget > 0 ? +(meanCycles / budget).toFixed(3) : null,
      overruns,
      heap_free: last.heapFree,
      heap_min_free: Math.min(...live.map((r) => r.heapMinFree)),
      verdict:
        overruns > 0 || (budget > 0 && maxCycles > budget)
          ? "over budget: roll back (set_effect / rollback) and simplify"
          : "within budget",
    };
  }

  // -- room ------------------------------------------------------------------------

  /** Estimate this player's clock offset (TimeSyncPing/Pong, min-RTT of `rounds`). */
  async syncClock(rounds = 6): Promise<ClockSync> {
    const s = await this.run(() => this.client.syncClock(rounds));
    this.clock = { offsetMs: s.offsetMs, rttMs: s.rttMs, at: performance.now() };
    return this.clock;
  }

  /** Whether this build's protocol can encode a message (newer device-side arms
   * are feature-detected on BOTH ends: the firmware advertises the feature, and
   * this bundle's regenerated proto + CLIENT_ARMS carry the arm and its fields). */
  static encodable(msg: Record<string, unknown> & { type: string }): boolean {
    try {
      encodeClient(msg as unknown as ClientMessage);
      return true;
    } catch {
      return false;
    }
  }

  /** Fire-and-forget a feature-gated message; false when either end can't. */
  private async sendGated(feature: string, msg: Record<string, unknown> & { type: string }): Promise<boolean> {
    if (!this.has(feature) || !DeviceSession.encodable(msg)) return false;
    await this.run(async () => {
      const ok = (this.client as unknown as { send(m: unknown): boolean }).send(msg);
      if (!ok) throw new ToolError("the player connection is down");
    });
    return true;
  }

  /** Set the effect clock's epoch, in this player's clock (the shared time base).
   * Returns false when the firmware or this bundle's protocol can't. */
  setTimeBase(epochDeviceMs: number): Promise<boolean> {
    return this.sendGated("time_base", { type: "set_time_base", epochMs: Math.round(epochDeviceMs) });
  }

  /** Store the fixture's room pose ON the device (feature `fixture_pose`). Returns
   * false when it can't — the hub then keeps the pose itself. */
  setFixturePose(pose: Pose): Promise<boolean> {
    return this.sendGated("fixture_pose", {
      type: "set_fixture_pose",
      // SetFixturePose { FixturePose pose = 1; ...; optional bool commit = 3 }.
      pose: { room: pose.room, translation: pose.translation, rotation: pose.rotation, scale: pose.scale },
      commit: true,
    });
  }

  /** Blink this fixture so a person can say which one it is: brightness dips to
   * 5% and back `times` times, then the previous brightness is restored. Works over
   * any running effect (SetBrightness is runtime-only). */
  async identify(times = 3, opts: { sleep?: (ms: number) => Promise<void> } = {}): Promise<Record<string, unknown>> {
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const before = this.lastBrightness ?? (this.welcome as unknown as { brightness?: number }).brightness ?? 1;
    const high = Math.max(before, 0.6);
    try {
      for (let i = 0; i < times; i++) {
        await this.run(() => this.client.setBrightness(0.05));
        await sleep(350);
        await this.run(() => this.client.setBrightness(high));
        await sleep(350);
      }
    } finally {
      await this.run(() => this.client.setBrightness(before)).catch(() => undefined);
    }
    return { blinked: times, brightness_restored: before };
  }

  /** LEDs this player drives: the stored map's count, else the board's max. */
  async ledCount(): Promise<number> {
    try {
      const b = await this.mappingBundle();
      const n = b.map?.ledCount ?? b.map?.leds?.length ?? 0;
      if (n > 0) return n;
    } catch {
      // no stored map
    }
    try {
      const hw = await this.run(() => this.client.getHardwareConfig());
      return hw.board?.maxLeds || 256;
    } catch {
      return 256;
    }
  }

  // -- textures ------------------------------------------------------------------

  async listTextures() {
    const a = await this.activeEffect();
    return a.textures;
  }

  /** Start a bridge-side generator streaming into texture `texIndex`. */
  async streamTexture(
    texIndex: number,
    source: TextureSource,
    fps: number,
    opts: { format?: TextureFormat; maxFrames?: number } = {},
  ): Promise<Record<string, unknown>> {
    const tex = (await this.listTextures()).find((t) => t.index === texIndex);
    if (!tex) throw new ToolError(`the active effect has no texture ${texIndex}`);
    this.stopTexture(texIndex);
    const rate = Math.max(1, Math.min(fps, 30));
    const streamer = new TextureStreamer(texIndex, opts.format ?? "rgb565", true);
    const gen = makeGenerator(source, tex.width, tex.height);
    const start = Date.now();
    const s = { texIndex, frames: 0 } as TextureStream;
    s.timer = setInterval(() => {
      const rgba = gen((Date.now() - start) / 1000, s.frames);
      const msg = streamer.frame(tex.width, tex.height, rgba);
      // Fire-and-forget like the editor's video panel (a frame has no reply).
      this.client.setTexture(msg);
      s.frames++;
      if (opts.maxFrames !== undefined && s.frames >= opts.maxFrames) this.stopTexture(texIndex);
    }, 1000 / rate);
    this.streams.set(texIndex, s);
    return { streaming: texIndex, width: tex.width, height: tex.height, fps: rate };
  }

  stopTexture(texIndex: number): { stopped: boolean; frames: number } {
    const s = this.streams.get(texIndex);
    if (!s) return { stopped: false, frames: 0 };
    clearInterval(s.timer);
    this.streams.delete(texIndex);
    return { stopped: true, frames: s.frames };
  }
}

/** A bridge-side texture source: a solid colour, a scrolling gradient, animated
 * value noise, or raw RGBA frames (base64, texture-sized) played in a loop. */
export type TextureSource =
  | { kind: "solid"; color: [number, number, number] }
  | { kind: "gradient"; from: [number, number, number]; to: [number, number, number]; speed?: number }
  | { kind: "noise"; scale?: number; speed?: number }
  | { kind: "frames"; rgba_base64: string[] };

function makeGenerator(src: TextureSource, w: number, h: number): (t: number, i: number) => Uint8Array {
  const px = (c: [number, number, number]) => c.map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255));
  switch (src.kind) {
    case "solid": {
      const [r, g, b] = px(src.color);
      return () => {
        const out = new Uint8Array(w * h * 4);
        for (let i = 0; i < w * h; i++) out.set([r!, g!, b!, 255], i * 4);
        return out;
      };
    }
    case "gradient": {
      const a = px(src.from);
      const b = px(src.to);
      const speed = src.speed ?? 0.2;
      return (t) => {
        const out = new Uint8Array(w * h * 4);
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const f = (x / Math.max(1, w - 1) + t * speed) % 1;
            const k = f < 0.5 ? f * 2 : 2 - f * 2;
            out.set([0, 1, 2].map((c) => Math.round(a[c]! + (b[c]! - a[c]!) * k)).concat(255), (y * w + x) * 4);
          }
        return out;
      };
    }
    case "noise": {
      const scale = src.scale ?? 4;
      const speed = src.speed ?? 0.5;
      const hash = (x: number, y: number, z: number) => {
        const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
        return s - Math.floor(s);
      };
      return (t) => {
        const out = new Uint8Array(w * h * 4);
        const z = Math.floor(t * speed * 4);
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const v = Math.round(hash(Math.floor((x / w) * scale), Math.floor((y / h) * scale), z) * 255);
            out.set([v, v, v, 255], (y * w + x) * 4);
          }
        return out;
      };
    }
    case "frames": {
      const frames = src.rgba_base64.map((b) => Uint8Array.from(Buffer.from(b, "base64")));
      for (const f of frames) {
        if (f.length !== w * h * 4) throw new ToolError(`each frame must be ${w}x${h} RGBA (${w * h * 4} bytes)`);
      }
      if (frames.length === 0) throw new ToolError("frames needs at least one frame");
      return (_t, i) => frames[i % frames.length]!;
    }
  }
}

/** The fixture at a glance (spec splanc://fixture/summary). */
export function summarize(b: MappingBundle): Record<string, unknown> {
  const leds = b.map?.leds ?? [];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const l of leds) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, l.xyz[k]!);
      max[k] = Math.max(max[k]!, l.xyz[k]!);
    }
  }
  const segs = b.topology?.segments ?? [];
  const r3 = (v: number) => +v.toFixed(3);
  return {
    map_id: b.map?.mapId ?? null,
    led_count: b.map?.ledCount ?? leds.length,
    mapped_leds: leds.length,
    unmapped_leds: b.map?.unmapped?.length ?? 0,
    units: "meters",
    frame: b.map?.frame ?? null,
    up_axis: "+y",
    bounding_box_m: leds.length ? { min: min.map(r3), max: max.map(r3), size: max.map((m, k) => r3(m - min[k]!)) } : null,
    topology: b.topology
      ? {
          segments: segs.length,
          total_length_m: r3(segs.reduce((s, g) => s + g.length, 0)),
          branch_points: b.topology.branchPoints?.length ?? 0,
          associated_leds: b.topology.associations?.length ?? 0,
        }
      : null,
  };
}

/** Whether this build's SetUniforms carries the (device-PR) `commit` field. */
export const COMMIT_IN_PROTO = SetUniformsSchema.fields.some((f) => f.name === "commit");

/** ClientMessage oneof arm names by field number, from the generated schema. */
const ARM_BY_FIELD: Record<number, string> = Object.fromEntries(
  ClientMessageSchema.fields.map((f) => [f.number, f.name]),
);

/** The envelope arm of an encoded ClientMessage (its one top-level field). */
export function sniffType(data: string | Uint8Array): string | null {
  if (typeof data === "string" || data.length === 0) return null;
  let key = 0;
  let shift = 0;
  for (let i = 0; i < Math.min(data.length, 5); i++) {
    const b = data[i]!;
    key |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return ARM_BY_FIELD[key >>> 3] ?? `field_${key >>> 3}`;
}
