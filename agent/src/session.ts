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
 * - rollback: deck A holds ONE persisted effect, so "the previous effect" is
 *   kept here as the bytecode last deployed, and restored by re-deploying it —
 *   or, after a crossfade (firmware with two FX decks), it is still loaded on
 *   the other deck, and rollback just fades back to it.
 *
 * Decks (FUG-110): the firmware runs two effects (deck A = 0, the persisted one;
 * deck B = 1, runtime-only) and blends them by a global crossfade position. The
 * session tracks which deck is LIVE (the one the crossfade shows), and every
 * deck-addressed request (uniforms, keypoints) defaults to it.
 */

import { ClientMessageSchema, SetUniformsSchema } from "../../web/src/gen/ledmapper_pb";
import { LedMapperClient, ServerErrorReply, type SocketFactory } from "../../web/src/net/client";
import type { ClientMessage } from "@ledmapper/protocol";
import {
  encodeClient,
  type EffectUniformsMessage,
  type FpsStateMessage,
  type HardwareConfigStateMessage,
  type MappingBundle,
  type PerfReportMessage,
  type UniformValueFlat,
} from "../../web/src/net/proto";
import { TextureStreamer, type TextureFormat } from "../../web/src/net/textureCodec";
import type { Pose } from "./config";
import { compile, type CompileOutcome, type Toolchain } from "./fxhost";
import { progress } from "./progress";
import type { ClockSync } from "./timesync";
import {
  describe,
  lerpValues,
  parseManifest,
  resolve,
  type ManifestUniform,
  type UniformInput,
} from "./uniforms";

/** The framerate autoscaler's floor (FUG-82; firmware/fps MIN_FPS). */
const FPS_FLOOR = 25;

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
  | "decks"
  | "crossfade"
  | "keypoints"
  | "fps"
  | (string & {});

export type Deck = 0 | 1;

/** The shape of a crossfade over time: progress u (0..1) -> mix (0..1). */
export type Curve = "linear" | "ease" | "ease_in" | "ease_out";

export function curveAt(curve: Curve, u: number): number {
  const t = Math.min(1, Math.max(0, u));
  switch (curve) {
    case "linear":
      return t;
    case "ease_in":
      return t * t;
    case "ease_out":
      return 1 - (1 - t) * (1 - t);
    default:
      return t * t * (3 - 2 * t);
  }
}

/** One deck as list_decks reports it. */
export interface DeckView {
  deck: Deck;
  name: "A" | "B";
  effect_id: string | null;
  /** Running (its update() ticks; it shows when the crossfade is on its side). */
  active: boolean;
  /** The crossfade shows it (fully or partly). */
  visible: boolean;
}

export interface DeckStatus {
  /** The deck the crossfade shows (the one deck-addressed tools target); null when
   * nothing is running. */
  live: Deck | null;
  crossfade: number;
  mode: "rgb" | "hsv";
  decks: DeckView[];
  /** The device couldn't list its decks (no list_effects): what is known comes
   * from this session. */
  inferred?: boolean;
}

/** What crossfade_to's cue step did on one player (the fade comes after). */
export interface CueResult {
  from_deck: Deck;
  to_deck: Deck;
  outgoing: string | null;
  incoming: string;
  uploaded: boolean;
  bytecode_bytes?: number;
  /** The crossfade position the fade starts from / ends at. */
  from: number;
  to: number;
}

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
  /** Its bytecode; undefined for an effect this bridge didn't upload (one the app
   * or another client put on the device — it can only be restored while it is
   * still loaded on a deck). */
  fxb: Uint8Array | undefined;
  /** The deck it is (or was) loaded on. */
  deck: Deck;
  /** Still loaded on `deck` (parked behind the crossfade) — rollback can fade
   * straight back to it without re-uploading. */
  onDevice?: boolean;
  source?: string;
  /** The effect's declared uniforms (slot + default), from its compile. */
  uniforms: ManifestUniform[];
  /** Last-known value per slot: the defaults sent on activation, then every
   * set this session sent while it was active (restored by rollback). */
  values: Map<number, number[]>;
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
  /** The live deck as this session last set/learned it (null: not yet known —
   * derived from Welcome.crossfade). */
  private live: Deck | null = null;
  /** The crossfade position/mode this session last set (null: Welcome's). */
  private xf: number | null = null;
  private xfMode: number | null = null;
  private readonly streams = new Map<number, TextureStream>();
  /** Every message type sent, for the safety test and diagnostics. */
  readonly sentTypes: string[] = [];
  /** Forbidden message types something tried to send (and the guard refused). */
  readonly blockedTypes: string[] = [];
  /** The host compiler/VM for this player's firmware (the hub sets it). */
  toolchain: Toolchain | undefined;
  /** The last clock sync against this player. */
  clock: ClockSync | null = null;
  /** The framerate autoscaler's last abort (FUG-82): the player parked the
   * running effect because it couldn't hold even the floor / a pinned rate.
   * Cleared when this session activates an effect. */
  private parked: (FpsStateMessage & { at: number }) | null = null;
  /** The player's last-reported effect framerate (FUG-82 autoscaler; 0 = unknown).
   * Ramps never stream uniforms faster than the player renders. */
  private playerFps = 0;
  /** The player's last fps_state (FUG-82), and who wants each one (the live mux
   * forwards them to app sessions). */
  private lastFps: FpsStateMessage | null = null;
  private readonly fpsSubs = new Set<(st: FpsStateMessage) => void>();
  /**
   * A live performer's show lock (docs/design/live-vj-relay.md, "Arbitration"):
   * while set, every mutating method refuses with a ToolError naming the holder,
   * except calls made through {@link asLive} with the lock's key. Reads still work.
   */
  liveLock: { by: string; key: object } | null = null;
  private liveKey: object | null = null;
  /** Bumped whenever an effect is (de)activated through this session, so caches
   * of the active effect's uniform manifest (the live mux's) know to re-read it. */
  effectGen = 0;

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
    this.client.onFpsState((st) => {
      if (st.aborted) this.parked = { ...st, at: performance.now() };
      if (st.currentFps > 0) this.playerFps = st.currentFps;
      this.lastFps = st;
      for (const fn of this.fpsSubs) fn(st);
    });
    this.client.onPerfReport((r) => {
      if ((r.currentFps ?? 0) > 0) this.playerFps = r.currentFps!;
    });
  }

  /** The player's framerate as last reported (fps_state or a perf report; 0 = unknown),
   * and its last fps_state (null until one arrives). */
  get renderFps(): number {
    return this.playerFps;
  }

  get fpsState(): FpsStateMessage | null {
    return this.lastFps;
  }

  /** Every fps_state the player pushes (autoscaler steps, aborts); returns unsubscribe. */
  onFps(fn: (st: FpsStateMessage) => void): () => void {
    this.fpsSubs.add(fn);
    return () => this.fpsSubs.delete(fn);
  }

  /** Whether rollback() has an earlier effect to restore (else it turns the
   * effect off — which would also discard an effect this bridge didn't deploy). */
  get canRestorePrevious(): boolean {
    const p = this.previous;
    return p !== null && (Boolean(p.onDevice && this.decksUsable()) || Boolean(p.fxb));
  }

  /** Call a mutating method on behalf of the holder of `key` (the live mux). The
   * guard runs synchronously at each method's start, so `fn` must call the method
   * directly (not after an await). */
  asLive<T>(key: object, fn: () => T): T {
    const prev = this.liveKey;
    this.liveKey = key;
    try {
      return fn();
    } finally {
      this.liveKey = prev;
    }
  }

  /** Refuse a mutation while someone else holds the show lock. */
  private assertUnlocked(): void {
    const l = this.liveLock;
    if (l && l.key !== this.liveKey) {
      throw new ToolError(
        `${this.client.welcome?.deviceName || "this player"} is being performed live (Show Mode lock held by ` +
          `"${l.by}"); it can't be changed until they release it. Reads still work; ask the user.`,
      );
    }
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

  async activeEffect(deck?: Deck): Promise<{
    effectId: string;
    uniforms: ManifestUniform[];
    current: Map<string, number[]>;
    textures: { index: number; width: number; height: number; elem: number }[];
    raw: EffectUniformsMessage;
  }> {
    const d = deck ?? this.liveDeck();
    let raw: EffectUniformsMessage;
    try {
      raw = await this.run(() => this.client.getEffectUniforms(undefined, d));
    } catch (e) {
      // Welcome said the crossfade sits on deck B but nothing runs there (stale
      // hydration): describe deck A instead, and remember it.
      if (d !== 1 || deck !== undefined || !(e instanceof ToolError && /no_effect/.test(e.message))) throw e;
      raw = await this.run(() => this.client.getEffectUniforms(undefined, 0));
      this.live = 0;
    }
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
    let keypoints: unknown = "the firmware doesn't store uniform keypoints";
    if (a.effectId && this.keypointsUsable()) {
      try {
        keypoints = (await this.listKeypoints()).keypoints;
      } catch (e) {
        keypoints = `unavailable: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    return {
      effect_id: a.effectId || null,
      ...(this.decksUsable() ? { deck: this.liveDeck() === 1 ? "B" : "A", crossfade: this.crossfadePosition() } : {}),
      uniforms: a.uniforms.map((u) => describe(u, a.current.get(u.name))),
      textures: a.textures,
      keypoints,
      stored_effects: stored,
    };
  }

  // -- uniform keypoints (docs/design/uniform-keypoints.md) ----------------------
  // Named looks of the active effect, stored ON the device (so the app and every
  // agent share them); the device blends between them in parameter space.

  /** Both ends can do keypoints: the firmware advertises them AND this bundle's
   * protocol carries the arms. */
  keypointsUsable(): boolean {
    return this.has("keypoints") && KEYPOINTS_IN_PROTO;
  }

  private requireKeypoints(): void {
    if (!this.has("keypoints")) {
      throw new ToolError(`the player's firmware (${this.fwVersion}) doesn't store uniform keypoints`);
    }
    if (!KEYPOINTS_IN_PROTO) throw new ToolError("this agent bundle predates uniform keypoints; update it");
  }

  /** A request/reply on the device session (single-flight per reply type). */
  private rpc<T>(msg: Record<string, unknown> & { type: string }, reply: string): Promise<T> {
    const c = this.client as unknown as { request(m: unknown, t: string, ms?: number): Promise<unknown> };
    return this.run(() => c.request(msg, reply)) as Promise<T>;
  }

  private static keypointList(r: KeypointListReply): Record<string, unknown> {
    return {
      effect_id: r.effectId,
      keypoints: (r.keypoints ?? [])
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((k) => ({ name: k.name, ...(k.stale ? { stale: true } : {}) })),
      capacity: r.capacity,
    };
  }

  async listKeypoints(deck?: number): Promise<{ effect_id: string; keypoints: unknown[]; capacity: number }> {
    this.requireKeypoints();
    const r = await this.rpc<KeypointListReply>({ type: "list_keypoints", deck: deck ?? this.liveDeck() }, "keypoint_list");
    return DeviceSession.keypointList(r) as { effect_id: string; keypoints: unknown[]; capacity: number };
  }

  /** Save the active effect's live uniforms (or, with `values`, those uniforms
   * set by name — the rest stay unset in the keypoint) as keypoint `name`.
   * Overwrites an existing keypoint of that name. */
  async saveKeypoint(name: string, values?: Record<string, UniformInput>, deckArg?: number): Promise<Record<string, unknown>> {
    this.assertUnlocked();
    this.requireKeypoints();
    const deck = deckArg ?? this.liveDeck();
    if (!name.trim() || new TextEncoder().encode(name).length > 32) {
      throw new ToolError("keypoint names are 1..32 bytes");
    }
    const msg: Record<string, unknown> & { type: string } = { type: "save_keypoint", name, deck };
    if (values && Object.keys(values).length) {
      const a = await this.activeEffect(deck as Deck);
      if (!a.effectId) throw new ToolError("no effect is loaded; deploy one first");
      msg["values"] = resolve(a.uniforms, values);
    }
    return DeviceSession.keypointList(await this.rpc<KeypointListReply>(msg, "keypoint_list"));
  }

  async deleteKeypoint(name: string, deck?: number): Promise<Record<string, unknown>> {
    this.assertUnlocked();
    this.requireKeypoints();
    return DeviceSession.keypointList(
      await this.rpc<KeypointListReply>({ type: "delete_keypoint", name, deck: deck ?? this.liveDeck() }, "keypoint_list"),
    );
  }

  /** One keypoint's values, by uniform name. */
  async getKeypoint(name: string, deck?: number): Promise<Record<string, unknown>> {
    this.requireKeypoints();
    const r = await this.rpc<KeypointReply>({ type: "get_keypoint", name, deck: deck ?? this.liveDeck() }, "keypoint");
    const values: Record<string, number | number[]> = {};
    for (const v of r.values ?? []) values[v.uniform] = v.value.length === 1 ? v.value[0]! : v.value;
    return { name: r.name, effect_id: r.effectId, ...(r.stale ? { stale: true } : {}), values };
  }

  /** Move the active effect's uniforms to a weighted blend of keypoints, on the
   * device, over `seconds` (0 = at once). One weight = recall. */
  async blendKeypoints(
    weights: Record<string, number>,
    opts: { seconds?: number | undefined; colorMode?: "rgb" | "hsv" | undefined; commit?: boolean | undefined; deck?: number | undefined } = {},
  ): Promise<Record<string, unknown>> {
    this.assertUnlocked();
    this.requireKeypoints();
    const entries = Object.entries(weights).filter(([, w]) => w > 0);
    if (entries.length === 0) throw new ToolError("give at least one keypoint a positive weight");
    if (entries.length > 4) throw new ToolError("at most 4 keypoints per blend");
    const seconds = opts.seconds ?? 0;
    if (!(seconds >= 0 && seconds <= 600)) throw new ToolError("seconds must be within 0..600");
    const total = entries.reduce((s, [, w]) => s + w, 0);
    await this.rpc(
      {
        type: "blend_keypoints",
        deck: opts.deck ?? this.liveDeck(),
        weights: entries.map(([name, weight]) => ({ name, weight })),
        seconds,
        colorMode: opts.colorMode === "hsv" ? 1 : 0,
        ...(opts.commit ? { commit: true } : {}),
      },
      "playback_state",
    );
    return {
      weights: Object.fromEntries(entries.map(([n, w]) => [n, Math.round((w / total) * 1000) / 1000])),
      seconds,
      color_mode: opts.colorMode ?? "rgb",
      committed: opts.commit === true,
    };
  }

  // -- control -----------------------------------------------------------------

  async setBrightness(level: number): Promise<number> {
    this.assertUnlocked();
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
    this.assertUnlocked();
    const a = await this.activeEffect();
    if (!a.effectId) throw new ToolError("no effect is loaded; deploy one first");
    const wire = resolve(a.uniforms, values);
    await this.run(async () => this.sendUniforms(wire, commit));
    return wire;
  }

  /** Live uniform push (the live mux; slider drags): fire-and-forget, in order
   * with this session's other traffic, on `deck` (default: the live deck).
   * `commit` persists them where the firmware understands it (false while
   * dragging, true on release). */
  async sendLiveUniforms(values: UniformValueFlat[], commit: boolean, deck?: Deck): Promise<void> {
    this.assertUnlocked();
    await this.run(async () => this.sendUniforms(values, commit, deck ?? this.liveDeck()));
  }

  /** `deck` default: the live deck. Deck B is never persisted (commit ignored). */
  private sendUniforms(values: UniformValueFlat[], commit: boolean, deck: Deck = this.liveDeck()): void {
    // `commit` is a newer SetUniforms field (device-side spec work). Only send it
    // when the firmware says it understands it; older firmware commits on its
    // own coalesced schedule, so a ramp's final set still persists there.
    // Both halves must agree: the firmware advertises it AND this bundle's proto
    // has the field (fromJson would reject an unknown one). TODO(uniform_commit):
    // true once the device PR's proto change is regenerated into web/src/gen.
    const msg: Record<string, unknown> = { type: "set_uniforms", values };
    if (this.has("uniform_commit") && COMMIT_IN_PROTO) msg["commit"] = commit;
    if (deck !== 0) msg["deck"] = deck;
    const ok = (this.client as unknown as { send(m: unknown): boolean }).send(msg);
    if (!ok) throw new ToolError("the player connection is down");
    const target = this.current?.deck === deck ? this.current : this.previous?.deck === deck && this.previous.onDevice ? this.previous : null;
    if (target) for (const v of values) target.values.set(v.slot, v.value);
  }

  /** The firmware VM starts every uniform at 0 (it ignores the manifest's
   * defaults), so a freshly activated effect renders black until something sets
   * them. Send each declared uniform's value — its default, or `known` — right
   * after the submit, uncommitted (as the web app does after its own submit). */
  private async sendActivationValues(d: Pick<Deployed, "uniforms">, known?: Map<number, number[]>, deck = 0): Promise<void> {
    const values = d.uniforms.map((u) => ({ slot: u.slot, value: known?.get(u.slot) ?? u.default }));
    if (values.length === 0) return;
    await this.run(async () => this.sendUniforms(values, false, d.deck));
  }

  /** Interpolate uniforms to `targets` over `seconds`, uncommitted, at the
   * stream rate; then one committed set of the targets. */
  async rampUniforms(
    targets: Record<string, UniformInput>,
    seconds: number,
    opts: { hz?: number; sleep?: (ms: number) => Promise<void> } = {},
  ): Promise<{ steps: number; final: UniformValueFlat[] }> {
    this.assertUnlocked();
    if (!(seconds >= 0 && seconds <= 600)) throw new ToolError("seconds must be within 0..600");
    const a = await this.activeEffect();
    if (!a.effectId) throw new ToolError("no effect is loaded; deploy one first");
    const final = resolve(a.uniforms, targets);
    const byName = new Map(a.uniforms.map((u) => [u.name, u]));
    // Never faster than the player renders (its autoscaled rate, once a perf
    // report or fps_state has told us), nor 60 Hz.
    const hz = Math.max(1, Math.min(opts.hz ?? this.streamHz, 60, this.playerFps || 60));
    const steps = Math.max(1, Math.round(seconds * hz));
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const names = Object.keys(targets);
    const from = names.map((n) => a.current.get(n) ?? byName.get(n)!.default);
    if (seconds >= 2) progress(`ramping ${names.join(", ")} over ${seconds} s…`);
    for (let i = 1; i < steps; i++) {
      if (seconds >= 2 && i % Math.max(1, Math.round(hz * Math.max(1, seconds / 5))) === 0) {
        progress(`ramp ${Math.round((100 * i) / steps)}%`);
      }
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

  /** Compile, then upload + (optionally) activate on deck A (the persisted deck).
   * Remembers what it replaced. When the crossfade was showing deck B, it snaps
   * back to A (the new effect) and the effect on B stays parked there — the
   * rollback target. `compiled` skips the compile when the caller already has
   * this player's build. */
  async deployEffect(effectId: string, source: string, activate: boolean, compiled?: CompileOutcome) {
    this.assertUnlocked();
    const c = compiled ?? (await this.compile(source));
    if (!c.ok) {
      const d = c.diagnostics.map((x) => `${x.line}:${x.col}: ${x.msg}`).join("\n");
      throw new ToolError(`the effect doesn't compile:\n${d}`);
    }
    const wasLive = activate ? this.liveDeck() : 0;
    await this.run(() => this.client.submitEffect(effectId, c.fxb, activate));
    if (activate) {
      this.parked = null;
      this.effectGen++;
      const outgoing = this.current ?? (wasLive === 1 ? await this.deviceHeld(1) : null);
      // Deck A was just overwritten; an outgoing effect on deck B is still there.
      this.previous = outgoing ? { ...outgoing, onDevice: outgoing.deck === 1 } : null;
      this.current = { effectId, fxb: c.fxb, deck: 0, source, uniforms: c.uniforms, values: new Map() };
      if (wasLive === 1 || (this.xf ?? 0) > 0) await this.snapCrossfade(0);
      this.live = 0;
      await this.sendActivationValues(this.current);
    }
    return { effect_id: effectId, bytecode_bytes: c.bytecodeBytes, uniforms: c.uniforms.map((u) => u.name) };
  }

  /** Select the active effect ("off" clears it). An id activates the effect
   * loaded under it — on the live deck, or on the other deck when that is where
   * it is parked (then the crossfade snaps to it). */
  async setEffect(effectId: string): Promise<Record<string, unknown>> {
    this.assertUnlocked();
    this.effectGen++;
    const id = effectId === "off" ? "" : effectId;
    this.parked = null;
    if (id === "") {
      if (this.current) {
        this.previous = { ...this.current, onDevice: false };
        this.current = null;
      }
      await this.run(() => this.client.setEffect("", 0));
      // Deck B: the first "" parks it, so the effect shown there goes dark too.
      if (this.decksUsable() && this.liveDeck() === 1) await this.run(() => this.client.setEffect("", 1));
      this.live = 0;
      if ((this.xf ?? 0) > 0 && this.decksUsable()) await this.snapCrossfade(0);
    } else if (this.decksUsable()) {
      const st = await this.deckStatus();
      const on = st.decks.find((d) => d.effect_id === id);
      const deck: Deck = on?.deck ?? st.live ?? 0;
      await this.run(() => this.client.setEffect(id, deck));
      if (deck !== (st.live ?? 0)) {
        await this.snapCrossfade(deck === 1 ? 1 : 0);
        this.swapIfParked(deck);
      }
      this.live = deck;
    } else {
      await this.run(() => this.client.setEffect(id));
    }
    const a = await this.activeEffect().catch(() => null);
    return { active_effect: a?.effectId || null, ...(this.decksUsable() ? { deck: this.live === 1 ? "B" : "A" } : {}) };
  }

  /** Restore the effect active before the last deploy or crossfade. Still loaded
   * on the other deck (after a crossfade, or a deploy while deck B was showing):
   * fade back to it over `seconds` (0 = at once). Otherwise re-upload its
   * bytecode to deck A, then its last-known uniform values (the defaults where
   * none were set). */
  async rollback(seconds = 0): Promise<Record<string, unknown>> {
    this.assertUnlocked();
    this.effectGen++;
    const prev = this.previous;
    this.parked = null;
    if (prev?.onDevice && this.decksUsable()) {
      await this.run(() => this.client.setEffect(prev.effectId, prev.deck));
      await this.fadeCrossfade(prev.deck === 1 ? 1 : 0, seconds, { curve: "ease" });
      this.swapIfParked(prev.deck);
      this.live = prev.deck;
      return {
        restored: prev.effectId,
        deck: prev.deck === 1 ? "B" : "A",
        how: seconds > 0 ? `faded back over ${seconds} s` : "switched back",
        ...(this.previous ? { rollback_again: `restores ${this.previous.effectId}` } : {}),
      };
    }
    if (prev?.fxb) {
      const fxb = prev.fxb;
      await this.run(() => this.client.submitEffect(prev.effectId, fxb, true));
      if (this.decksUsable() && (this.liveDeck() === 1 || (this.xf ?? 0) > 0)) await this.snapCrossfade(0);
      const outgoing = this.current;
      this.current = { ...prev, deck: 0, onDevice: false };
      this.previous = outgoing?.deck === 1 ? { ...outgoing, onDevice: true } : null;
      this.live = 0;
      const known = prev.values;
      this.current.values = new Map();
      await this.sendActivationValues(this.current, known);
      return { restored: prev.effectId };
    }
    await this.run(() => this.client.setEffect(""));
    this.current = null;
    return { restored: null, note: "no earlier effect was deployed by this bridge; the effect was turned off" };
  }

  // -- decks + crossfade (FUG-110) ------------------------------------------------

  /** Both ends can do two decks + a crossfade. */
  decksUsable(): boolean {
    return this.has("decks") && this.has("crossfade") && DECKS_IN_PROTO;
  }

  private requireDecks(): void {
    if (!this.has("decks") || !this.has("crossfade")) {
      throw new ToolError(`the player's firmware (${this.fwVersion}) has no second FX deck to crossfade with`);
    }
    if (!DECKS_IN_PROTO) throw new ToolError("this agent bundle predates FX decks; update it");
  }

  /** The crossfade position: as this session last set it, else Welcome's. */
  crossfadePosition(): number {
    if (this.xf !== null) return this.xf;
    const w = this.client.welcome as unknown as { crossfade?: number } | null;
    return Math.min(1, Math.max(0, w?.crossfade ?? 0));
  }

  private crossfadeMode(): number {
    if (this.xfMode !== null) return this.xfMode;
    return (this.client.welcome as unknown as { crossfadeMode?: number } | null)?.crossfadeMode ?? 0;
  }

  /** The deck the crossfade shows: what this session set, else from Welcome. */
  liveDeck(): Deck {
    if (!this.decksUsable()) return 0;
    if (this.live !== null) return this.live;
    return this.crossfadePosition() >= 0.5 ? 1 : 0;
  }

  /** Both decks: what is loaded, running and shown (ListEffects when the firmware
   * has it, else this session's own record). */
  async deckStatus(): Promise<DeckStatus> {
    this.requireDecks();
    const pos = this.crossfadePosition();
    const views: DeckView[] = ([0, 1] as const).map((d) => ({
      deck: d,
      name: d === 0 ? "A" : "B",
      effect_id: null,
      active: false,
      visible: false,
    }));
    let inferred = false;
    if (this.has("list_effects")) {
      const l = await this.run(() => this.client.listEffects());
      for (const e of l.effects ?? []) {
        const v = views[e.deck === 1 ? 1 : 0]!;
        v.effect_id = e.effectId || null;
        v.active = e.active;
      }
    } else {
      inferred = true;
      for (const d of [this.current, this.previous]) {
        if (d && (d === this.current || d.onDevice)) {
          views[d.deck]!.effect_id = d.effectId;
          views[d.deck]!.active = true;
        }
      }
    }
    const [a, b] = views as [DeckView, DeckView];
    a.visible = a.active && !(b.active && pos >= 1);
    b.visible = b.active && !(a.active && pos <= 0);
    const live: Deck | null = a.active && b.active ? (pos >= 0.5 ? 1 : 0) : a.active ? 0 : b.active ? 1 : null;
    if (live !== null) this.live = live;
    return { live, crossfade: +pos.toFixed(3), mode: this.crossfadeMode() === 1 ? "hsv" : "rgb", decks: views, ...(inferred ? { inferred } : {}) };
  }

  /** An effect loaded on `deck` that this bridge didn't upload (or forgot): its id
   * and manifest from the device, no bytecode. */
  private async deviceHeld(deck: Deck): Promise<Deployed | null> {
    try {
      const a = await this.activeEffect(deck);
      if (!a.effectId) return null;
      const values = new Map<number, number[]>();
      for (const u of a.uniforms) {
        const v = a.current.get(u.name);
        if (v) values.set(u.slot, v);
      }
      return { effectId: a.effectId, fxb: undefined, deck, uniforms: a.uniforms, values, onDevice: true };
    } catch {
      return null;
    }
  }

  /** The crossfade landed on `deck`: if that is where the rollback target was
   * parked, the two swap (rollback again goes back). */
  private swapIfParked(deck: Deck): void {
    if (this.previous?.onDevice && this.previous.deck === deck) {
      const back = this.current;
      this.current = { ...this.previous, onDevice: false };
      this.previous = back && back.deck !== deck ? { ...back, onDevice: true } : null;
    }
  }

  /**
   * Step 1 of a crossfade: load the incoming effect onto the IDLE deck (the one the
   * crossfade isn't showing), running but not yet visible, with its uniform values.
   * The outgoing effect stays loaded and running on its deck — the rollback
   * target. `effectId` alone (no `compiled`) cues the effect already loaded on the
   * idle deck under that id. The fade itself is fadeCrossfade (the hub runs every
   * player's fade on one clock).
   */
  async cueCrossfade(
    effectId: string,
    source: string | undefined,
    compiled: CompileOutcome | undefined,
    uniforms?: Record<string, UniformInput>,
    opts: { reuseLoaded?: boolean } = {},
  ): Promise<CueResult> {
    this.assertUnlocked();
    this.requireDecks();
    this.effectGen++;
    const st = await this.deckStatus();
    // Nothing running: there is nothing to fade from, so the effect goes onto deck
    // A (the persisted one) and simply starts.
    const from: Deck = st.live ?? 1;
    const to: Deck = st.live === null ? 0 : from === 0 ? 1 : 0;
    const fromPos = from === 0 ? 0 : 1;
    // Show only the outgoing deck before the incoming one starts running (a
    // half-way crossfade left by the app would otherwise flash the new effect).
    if (st.live !== null && Math.abs(this.crossfadePosition() - fromPos) > 1e-3) await this.snapCrossfade(fromPos);
    const outgoing =
      st.live === null
        ? null
        : this.current?.deck === from && this.current.effectId === st.decks[from]!.effect_id
          ? this.current
          : await this.deviceHeld(from);
    let incoming: Deployed;
    let uploaded = false;
    // No new source: an effect already waiting on the idle deck under this id is
    // faded to as it is (no re-upload).
    if (compiled && opts.reuseLoaded && st.decks[to]!.effect_id === effectId) compiled = undefined;
    if (compiled) {
      if (!compiled.ok) throw new ToolError("the effect doesn't compile");
      try {
        await this.run(() => this.client.submitEffect(effectId, compiled.fxb, true, to));
      } catch (e) {
        if (e instanceof ToolError && /too large|effect_too_large/.test(e.message)) {
          throw new ToolError(
            `${e.message}. While crossfading BOTH effects are loaded: the two decks share one 24 KB buffer arena ` +
              `(and each .fxb must fit 4 KB). Use fewer/smaller buffers, or deploy_effect to replace the effect outright.`,
          );
        }
        throw e;
      }
      uploaded = true;
      incoming = { effectId, fxb: compiled.fxb, deck: to, uniforms: compiled.uniforms, values: new Map() };
      if (source !== undefined) incoming.source = source;
      await this.sendActivationValues(incoming);
    } else {
      if (st.decks[to]!.effect_id !== effectId) {
        throw new ToolError(
          `"${effectId}" isn't loaded on the idle deck ${to === 1 ? "B" : "A"} ` +
            `(it holds ${st.decks[to]!.effect_id ?? "nothing"}): pass its source`,
        );
      }
      await this.run(() => this.client.setEffect(effectId, to));
      incoming =
        (this.previous?.onDevice && this.previous.deck === to ? this.previous : null) ??
        (await this.deviceHeld(to)) ?? { effectId, fxb: undefined, deck: to, uniforms: [], values: new Map() };
    }
    if (uniforms && Object.keys(uniforms).length) {
      const a = await this.activeEffect(to);
      const wire = resolve(a.uniforms, uniforms);
      await this.run(async () => this.sendUniforms(wire, false, to));
      for (const v of wire) incoming.values.set(v.slot, v.value);
    }
    // The outgoing effect is the rollback target, still loaded on its deck.
    this.previous = outgoing ? { ...outgoing, onDevice: true } : this.previous?.deck === from ? this.previous : null;
    this.current = { ...incoming, onDevice: false };
    if (st.live === null) await this.snapCrossfade(0);
    return {
      from_deck: from,
      to_deck: to,
      outgoing: outgoing?.effectId ?? null,
      incoming: effectId,
      uploaded,
      ...(uploaded ? { bytecode_bytes: compiled!.bytecodeBytes } : {}),
      from: st.live === null ? 0 : fromPos,
      to: to === 1 ? 1 : 0,
    };
  }

  /**
   * The live mux's crossfader (a fader drag): set the position at once, keeping
   * this session's deck state in step with crossfade_to's — the side the fader
   * is on is the live deck, and landing on the deck where the rollback target is
   * parked swaps them, exactly like a crossfade_to that ends there. False when
   * the firmware or this bundle has no decks.
   */
  async liveCrossfade(position: number, mode?: number): Promise<boolean> {
    this.assertUnlocked();
    if (!this.decksUsable()) return false;
    const before = this.liveDeck();
    await this.snapCrossfade(position, mode);
    const now: Deck = this.crossfadePosition() >= 0.5 ? 1 : 0;
    this.live = now;
    if (now !== before) this.swapIfParked(now);
    return true;
  }

  /**
   * Show Mode's "cue onto deck X" (the live mux): upload + activate an effect on
   * `deck` WITHOUT touching the crossfade (a performer cueing the deck that's off
   * air must not cut to it). Deck state follows crossfade_to's model: cueing the
   * idle deck makes the effect on the live deck the rollback target (parked,
   * still on the device); cueing the live deck replaces it, like deploy_effect.
   * Firmware without decks: deck 0 is a plain deploy.
   */
  async cueDeck(effectId: string, source: string, deck: Deck, compiled?: CompileOutcome): Promise<Record<string, unknown>> {
    this.assertUnlocked();
    if (!this.decksUsable()) {
      if (deck !== 0) this.requireDecks();
      return this.asLiveInternal(() => this.deployEffect(effectId, source, true, compiled));
    }
    const c = compiled ?? (await this.compile(source));
    if (!c.ok) {
      const d = c.diagnostics.map((x) => `${x.line}:${x.col}: ${x.msg}`).join("\n");
      throw new ToolError(`the effect doesn't compile:\n${d}`);
    }
    await this.run(() => this.client.submitEffect(effectId, c.fxb, true, deck));
    this.effectGen++;
    const incoming: Deployed = { effectId, fxb: c.fxb, deck, source, uniforms: c.uniforms, values: new Map() };
    const cur = this.current;
    if (deck === this.liveDeck()) {
      // The live deck was overwritten; a parked rollback target on the other deck stays.
      this.previous = cur && cur.deck === deck ? { ...cur, onDevice: false } : this.previous;
    } else {
      // The live deck keeps running: it is the rollback target, parked on the device.
      this.previous = cur && cur.deck !== deck ? { ...cur, onDevice: true } : this.previous;
    }
    this.current = incoming;
    await this.sendActivationValues(incoming);
    return { effect_id: effectId, deck: deck === 1 ? "B" : "A", bytecode_bytes: c.bytecodeBytes, uniforms: c.uniforms.map((u) => u.name) };
  }

  /** Call a guarded method from inside an already-authorized one (the guard's key is
   * only set synchronously, so a nested call after an await re-supplies it). */
  private asLiveInternal<T>(fn: () => T): T {
    return this.liveLock ? this.asLive(this.liveLock.key, fn) : fn();
  }

  /** Set the crossfade at once (and wait for the device's ack). */
  async snapCrossfade(position: number, mode?: number): Promise<void> {
    const m = mode ?? this.crossfadeMode();
    await this.run(() => this.client.setCrossfade(position, m));
    this.xf = Math.min(1, Math.max(0, position));
    this.xfMode = m;
  }

  /**
   * Glide the crossfade to `target` over `seconds`, from where it is. Progress is
   * read off the wall clock from `t0` (performance.now() ms; the hub passes ONE
   * t0 to every player so a room fades together). Each step is ACKNOWLEDGED
   * before the next is sent (at most `hz` a second): on hardware a C6 fed
   * fire-and-forget sets at 25 Hz fell ~20 s behind (its wss queue backed up), so
   * the step rate follows what the player can take while the fade still ends on
   * time. When it lands, the target side is the live deck.
   */
  async fadeCrossfade(
    target: number,
    seconds: number,
    opts: {
      curve?: Curve;
      mode?: number;
      t0?: number;
      from?: number;
      hz?: number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ): Promise<{ from: number; to: number; seconds: number; steps: number }> {
    this.assertUnlocked();
    this.requireDecks();
    if (!(seconds >= 0 && seconds <= 600)) throw new ToolError("seconds must be within 0..600");
    const mode = opts.mode ?? this.crossfadeMode();
    const from = opts.from ?? this.crossfadePosition();
    const t0 = opts.t0 ?? performance.now();
    const hz = Math.max(1, Math.min(opts.hz ?? this.streamHz, 60));
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const curve = opts.curve ?? "ease";
    let steps = 0;
    if (seconds > 0) {
      let lastPct = 0;
      for (;;) {
        const tStep = performance.now();
        const u = (tStep - t0) / (seconds * 1000);
        if (u >= 1) break;
        const pos = from + (target - from) * curveAt(curve, u);
        await this.run(() => this.client.setCrossfade(pos, mode));
        this.xf = pos;
        steps++;
        const pct = Math.floor(u * 4) * 25;
        if (seconds >= 2 && pct > lastPct) {
          lastPct = pct;
          progress(`crossfade ${pct}%`);
        }
        const wait = 1000 / hz - (performance.now() - tStep);
        if (wait > 0) await sleep(wait);
      }
    }
    await this.snapCrossfade(target, mode);
    this.live = target >= 0.5 ? 1 : 0;
    return { from: +from.toFixed(3), to: target, seconds, steps: steps + 1 };
  }

  /** BASIC perf for `seconds`: frame cost vs budget, overruns, heap.
   *
   * On firmware with the framerate autoscaler (the "fps" feature, FUG-82) the
   * budget is the live target (cpu_hz / current_fps) and an overrun above the
   * 25-fps floor is just the autoscaler stepping down, so the verdict is "over
   * budget" only when the player PARKED the effect (fps_state{aborted}) or its
   * mean frame cost can't keep 5% headroom even at the floor. */
  async measureEffect(
    seconds: number,
    opts: { sleep?: (ms: number) => Promise<void> } = {},
  ): Promise<Record<string, unknown>> {
    if (!(seconds > 0 && seconds <= 60)) throw new ToolError("seconds must be within (0, 60]");
    progress(`measuring for ${seconds} s…`);
    const t0 = performance.now();
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
    // The abort counts if it landed during this measurement, or before it with
    // nothing rendering since (an effect that is running again isn't parked).
    const parked = this.parked && (this.parked.at >= t0 || live.length === 0) ? this.parked : null;
    const parkedNote = parked
      ? {
          aborted: true,
          verdict:
            `over budget: the player parked the effect — it can't hold ${parked.auto ? `even ${parked.minFps || 25} fps` : `the pinned ${parked.targetFps} fps`} ` +
            "with 5% headroom. Roll back (rollback_effect) and simplify it.",
        }
      : {};
    if (live.length === 0) {
      return { reports: 0, note: "no frames were measured (is an effect active?)", ...parkedNote };
    }
    const last = live[live.length - 1]!;
    const meanCycles = live.reduce((s, r) => s + r.frameCyclesMean, 0) / live.length;
    const maxCycles = Math.max(...live.map((r) => r.frameCyclesMax));
    const overruns = live.reduce((s, r) => s + r.overruns, 0);
    const budget = last.budgetCycles;
    const currentFps = last.currentFps ?? 0;
    const toMs = (c: number) => (last.cpuHz > 0 ? +((c / last.cpuHz) * 1000).toFixed(2) : null);
    // Autoscaling firmware: the hard limit is the 25-fps floor with 5% headroom.
    const floorCycles = currentFps > 0 && last.cpuHz > 0 ? (last.cpuHz / FPS_FLOOR) * 0.95 : 0;
    let verdict: string;
    if (currentFps > 0) {
      verdict =
        meanCycles > floorCycles
          ? `over budget: it can't keep 5% headroom even at ${FPS_FLOOR} fps — the player will park it. Roll back and simplify.`
          : `within budget (the player runs it at ${currentFps} fps)`;
    } else {
      verdict =
        overruns > 0 || (budget > 0 && maxCycles > budget)
          ? "over budget: roll back (set_effect / rollback) and simplify"
          : "within budget";
    }
    return {
      effect_id: last.effectId,
      reports: live.length,
      budget_cycles: budget,
      // The autoscaler's live target (FUG-82); absent on fixed-30-fps firmware.
      ...(currentFps > 0 ? { current_fps: currentFps, fps_per_window: live.map((r) => r.currentFps ?? 0) } : {}),
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
      verdict,
      ...parkedNote,
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
    this.assertUnlocked();
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
    this.assertUnlocked();
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

/** Whether this build's protocol carries the FX-deck arms (set_crossfade + the
 * `deck` fields). */
export const DECKS_IN_PROTO = ClientMessageSchema.fields.some((f) => f.name === "set_crossfade");

/** Whether this build's protocol carries the uniform-keypoint arms. */
export const KEYPOINTS_IN_PROTO = ClientMessageSchema.fields.some((f) => f.name === "blend_keypoints");

interface KeypointListReply {
  effectId: string;
  keypoints?: { index: number; name: string; stale?: boolean }[];
  capacity: number;
}

interface KeypointReply {
  effectId: string;
  name: string;
  stale?: boolean;
  values?: { uniform: string; value: number[] }[];
}

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
