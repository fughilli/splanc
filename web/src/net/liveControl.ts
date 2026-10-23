/**
 * The real-time control channel (docs/design/live-control.md): every live
 * control in the app — effect-editor sliders, acid mode, Show Mode's fader and
 * keypoint strip, the MIDI router, the agent's live mux — goes through one of
 * these per device connection, so turning knobs for an hour never builds a
 * backlog on the device.
 *
 * Built on {@link LatestWinsSender}: values are merged per (deck, slot) — the
 * crossfade and a keypoint blend per deck — and at most one batch is in flight,
 * paced on the device's reply and capped at its render rate. On firmware with
 * "control_ack" each update carries a `seq` and the device answers with a tiny
 * ControlAck; older firmware is paced on its legacy reply (playback_state for
 * set_uniforms / blend, welcome for set_crossfade).
 *
 * Persistence: on firmware with "uniform_commit", moving values go out with
 * `commit: false` (RAM only) and ONE `commit: true` set — every slot touched on
 * that deck since its effect changed — follows once the controls have been idle
 * for {@link LiveControlOptions.commitIdleMs} (or on {@link LiveControl.commit},
 * e.g. a slider release), so a flash write never fires mid-gesture.
 */

import { LatestWinsSender, type LiveTimer } from "./liveSender";
import type { BlendOptions, KeypointWeightFlat, UniformValueFlat } from "./proto";

/** What the channel needs from its connection (LedMapperClient implements it). */
export interface LiveHost {
  /** Write one flat client message; false when the socket isn't open. */
  sendFlat(msg: Record<string, unknown>): boolean;
  /** The connected firmware's feature list ([] when unknown/disconnected). */
  features(): readonly string[];
  /** The device's current render rate (0 = unknown). */
  renderFps(): number;
  /** Bytes the transport hasn't put on the wire yet (0 when it can't tell). */
  bufferedAmount(): number;
}

export interface LiveControlOptions {
  now?: () => number;
  schedule?: LiveTimer;
  /** Give up on a batch's ack after this long (ms). Default: adaptive — 3x the median
   * round trip of recent acked batches, 25..400 ms (400 until there are samples). */
  ackTimeoutMs?: number;
  /** Send a commit this long after the last live change on a deck (ms). Default 600. */
  commitIdleMs?: number;
  /** Rate cap when the device's fps is unknown. Default 40 Hz. */
  defaultFps?: number;
  /** Hold batches while the socket has more than this many bytes queued. Default 1024. */
  maxBuffered?: number;
  /** Batches allowed unacknowledged at once on firmware with `control_ack`. Default 1:
   * on the LAN bench a second batch didn't reliably help (the adaptive ack timeout
   * already removes the lost-ack stalls) and on pre-mailbox firmware it piled moves
   * behind the render mutex. Legacy reply pacing always keeps one. */
  maxInFlight?: number;
}

/** One batch on the wire: the replies it still expects, and its settle callback. */
interface Flight {
  expect: Matcher[];
  resolve: () => void;
  sentAt: number;
}

type Item =
  | { kind: "u"; deck: number; slot: number; value: number[] }
  | { kind: "commit"; deck: number }
  | { kind: "xf"; position: number; mode: number }
  | { kind: "kb"; weights: KeypointWeightFlat[]; opts: BlendOptions };

type Matcher = (msg: { type: string } & Record<string, unknown>) => boolean;

/** The fastest pace the channel ever sends at, whatever the device reports. */
const MIN_INTERVAL_MS = 8;
/** The slowest: a 5-fps fixture still feels live at 10 updates/s. */
const MAX_INTERVAL_MS = 100;
/** Adaptive ack timeout bounds (ms). */
const MIN_ACK_MS = 25;
const MAX_ACK_MS = 400;

export class LiveControl {
  private readonly sender: LatestWinsSender<string, Item>;
  private readonly now: () => number;
  private readonly schedule: LiveTimer;
  private readonly commitIdleMs: number;
  private readonly defaultFps: number;
  private seq = 0;
  private readonly maxInFlightOpt: number | undefined;
  /** Round trips (ms) of recently acked batches: the adaptive ack timeout. */
  private readonly rtts: number[] = [];
  /** The batches in flight, oldest first, each with the replies it still expects. */
  private flights: Flight[] = [];
  /** Every value set per deck since its effect changed (what a commit persists). */
  private readonly known = new Map<number, Map<number, number[]>>();
  /** Decks with uncommitted live changes, and when each last changed. */
  private readonly dirtyAt = new Map<number, number>();
  /** Decks with an idle-commit timer armed. */
  private readonly commitArmed = new Set<number>();

  constructor(
    private readonly host: LiveHost,
    opts: LiveControlOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.schedule = opts.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
    this.commitIdleMs = opts.commitIdleMs ?? 600;
    this.defaultFps = opts.defaultFps ?? 40;
    const maxBuffered = opts.maxBuffered ?? 1024;
    this.maxInFlightOpt =
      opts.maxInFlight === undefined ? undefined : Math.max(1, Math.floor(opts.maxInFlight));
    const fixedAck = opts.ackTimeoutMs;
    this.sender = new LatestWinsSender<string, Item>((batch) => this.sendBatch(batch), {
      now: this.now,
      schedule: this.schedule,
      ackTimeoutMs: fixedAck !== undefined ? fixedAck : () => this.adaptiveAckMs(),
      minIntervalMs: () => this.intervalMs(),
      canSend: () => this.host.bufferedAmount() <= maxBuffered,
      // Seq'd acks name their batch; legacy replies don't, so they pace one at a time.
      maxInFlight: () => this.inFlightBound(),
    });
  }

  /** Diagnostics: pushes, batches, coalesced, timeouts, dropped. */
  get stats(): Readonly<LatestWinsSender<string, Item>["stats"]> {
    return this.sender.stats;
  }

  /** Move one uniform live. */
  setUniform(slot: number, value: number[], deck = 0): void {
    this.setUniforms([{ slot, value }], { deck });
  }

  /** Move several uniforms live; `commit` persists them right away (a release). */
  setUniforms(values: UniformValueFlat[], opts: { deck?: number; commit?: boolean } = {}): void {
    const deck = opts.deck === 1 ? 1 : 0;
    const k = this.knownFor(deck);
    for (const v of values) {
      const value = [...v.value];
      k.set(v.slot, value);
      this.sender.push(`u|${deck}|${v.slot}`, { kind: "u", deck, slot: v.slot, value });
    }
    if (opts.commit) this.commit(deck);
    else this.markDirty(deck);
  }

  /** Move the deck crossfade live (0 = all A .. 1 = all B; mode 0 RGB, 1 HSV). */
  setCrossfade(position: number, mode = 0): void {
    const p = Number.isFinite(position) ? Math.min(1, Math.max(0, position)) : 0;
    this.sender.push("xf", { kind: "xf", position: p, mode: mode === 1 ? 1 : 0 });
  }

  /** Blend a deck toward weighted keypoints, live (the last blend per deck wins). */
  blendKeypoints(weights: KeypointWeightFlat[], opts: BlendOptions = {}): void {
    const deck = opts.deck === 1 ? 1 : 0;
    this.sender.push(`kb|${deck}`, { kind: "kb", weights: weights.map((w) => ({ ...w })), opts: { ...opts, deck } });
  }

  /** Persist a deck's live values now (a slider release) instead of on idle. */
  commit(deck = 0): void {
    if (!this.persists(deck)) return;
    this.dirtyAt.delete(deck);
    this.sender.push(`c|${deck}`, { kind: "commit", deck });
  }

  /** The deck's effect changed: its old slots mean nothing to the new effect. */
  resetDeck(deck = 0): void {
    const d = deck === 1 ? 1 : 0;
    this.known.delete(d);
    this.dirtyAt.delete(d);
    this.sender.discard((k) => k.startsWith(`u|${d}|`) || k === `c|${d}` || k === `kb|${d}`);
  }

  /** Remember values sent outside the channel (e.g. an effect's defaults after a
   * submit) so a later commit persists them too. */
  noteValues(values: UniformValueFlat[], deck = 0): void {
    const k = this.knownFor(deck === 1 ? 1 : 0);
    for (const v of values) k.set(v.slot, [...v.value]);
  }

  /** Resolves when nothing is pending or in flight. */
  settled(): Promise<void> {
    return this.sender.settled();
  }

  /** True while updates are pending or in flight. */
  get busy(): boolean {
    return this.sender.busy;
  }

  /** The socket closed: drop pending moves and release the batch in flight. */
  onDisconnect(): void {
    this.sender.clear();
    this.dirtyAt.clear();
    for (const f of this.flights.splice(0)) f.resolve();
  }

  /**
   * Feed every server message here. Returns true when it was a ControlAck (the
   * caller needn't look further); a legacy reply is matched but NOT consumed, so
   * a pending request for the same type still gets it.
   */
  onServerMessage(msg: { type: string } & Record<string, unknown>): boolean {
    const isAck = msg.type === "control_ack";
    for (let k = 0; k < this.flights.length; k++) {
      const f = this.flights[k]!;
      const i = f.expect.findIndex((m) => m(msg));
      if (i < 0) continue;
      f.expect.splice(i, 1);
      if (f.expect.length === 0) {
        this.flights.splice(k, 1);
        // Round trips of answered batches feed the adaptive ack timeout (a batch
        // dropped as timed out, or released by a disconnect, doesn't).
        this.rtts.push(this.now() - f.sentAt);
        if (this.rtts.length > 32) this.rtts.shift();
        f.resolve();
      }
      break;
    }
    return isAck;
  }

  // -- internals ----------------------------------------------------------------

  /** A lost ack (a dropped segment the device only resends on its >= 120 ms RTO, or
   * an ack dropped on a full window) costs ~this, not a fixed 400 ms. */
  private adaptiveAckMs(): number {
    if (this.rtts.length < 5) return MAX_ACK_MS;
    const s = [...this.rtts].sort((a, b) => a - b);
    const med = s[s.length >> 1]!;
    return Math.min(MAX_ACK_MS, Math.max(MIN_ACK_MS, 3 * med));
  }

  private inFlightBound(): number {
    if (!this.has("control_ack")) return 1;
    return this.maxInFlightOpt ?? 1;
  }

  private intervalMs(): number {
    const fps = this.host.renderFps() > 0 ? this.host.renderFps() : this.defaultFps;
    return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, 1000 / fps));
  }

  private has(feature: string): boolean {
    return this.host.features().includes(feature);
  }

  /** Deck A persists on firmware that honours commit; deck B never does. */
  private persists(deck: number): boolean {
    return deck === 0 && this.has("uniform_commit");
  }

  private knownFor(deck: number): Map<number, number[]> {
    let k = this.known.get(deck);
    if (!k) {
      k = new Map();
      this.known.set(deck, k);
    }
    return k;
  }

  private markDirty(deck: number): void {
    if (!this.persists(deck)) return;
    this.dirtyAt.set(deck, this.now());
    if (this.commitArmed.has(deck)) return;
    this.armCommit(deck, this.commitIdleMs);
  }

  /** One idle timer per deck (not one per move): when it fires early — the deck
   * moved since — it re-arms for the remainder. */
  private armCommit(deck: number, ms: number): void {
    this.commitArmed.add(deck);
    this.schedule(() => {
      this.commitArmed.delete(deck);
      const at = this.dirtyAt.get(deck);
      if (at === undefined) return; // committed (or reset) meanwhile
      const idle = this.now() - at;
      if (idle >= this.commitIdleMs) this.commit(deck);
      else this.armCommit(deck, this.commitIdleMs - idle);
    }, ms);
  }

  private sendBatch(batch: Map<string, Item>): Promise<void> | null {
    // The sender only sends with a slot free, so flights beyond the bound are ones it
    // already gave up on (ack timeout): forget what they still expected.
    const bound = this.inFlightBound();
    while (this.flights.length >= bound) this.flights.shift()!.resolve();
    const acks = this.has("control_ack");
    const commitOk = this.has("uniform_commit");
    const perDeck = new Map<number, { values: Map<number, number[]>; commit: boolean }>();
    let xf: Extract<Item, { kind: "xf" }> | null = null;
    const blends: Extract<Item, { kind: "kb" }>[] = [];
    for (const it of batch.values()) {
      if (it.kind === "u" || it.kind === "commit") {
        let d = perDeck.get(it.deck);
        if (!d) {
          d = { values: new Map(), commit: false };
          perDeck.set(it.deck, d);
        }
        if (it.kind === "u") d.values.set(it.slot, it.value);
        else d.commit = true;
      } else if (it.kind === "xf") xf = it;
      else blends.push(it);
    }
    const expect: Matcher[] = [];
    let wrote = false;
    const out = (msg: Record<string, unknown>, legacyReply: string): boolean => {
      let match: Matcher;
      if (acks) {
        const seq = (this.seq = (this.seq % 0x7fffffff) + 1);
        msg.seq = seq;
        match = (m) => m.type === "control_ack" && m.seq === seq;
      } else {
        match = (m) => m.type === legacyReply;
      }
      if (!this.host.sendFlat(msg)) return false;
      expect.push(match);
      wrote = true;
      return true;
    };
    for (const [deck, d] of perDeck) {
      // A commit carries every value the deck has been set to since its effect
      // changed, so the persisted frame restores the whole state, not one slot.
      const vals = d.commit ? (this.known.get(deck) ?? d.values) : d.values;
      if (vals.size === 0) continue;
      const msg: Record<string, unknown> = {
        type: "set_uniforms",
        values: [...vals].map(([slot, value]) => ({ slot, value })),
      };
      if (commitOk) msg.commit = d.commit;
      if (deck) msg.deck = deck;
      if (!out(msg, "playback_state")) return null;
    }
    if (xf && !out({ type: "set_crossfade", position: xf.position, mode: xf.mode }, "welcome")) return null;
    for (const kb of blends) {
      const o = kb.opts;
      const msg: Record<string, unknown> = {
        type: "blend_keypoints",
        weights: kb.weights,
        deck: o.deck ?? 0,
        seconds: o.seconds ?? 0,
        colorMode: o.colorMode ?? 0,
        ...(o.commit ? { commit: true } : {}),
      };
      // blend_keypoints has no seq: it is paced on its playback_state reply.
      if (!this.host.sendFlat(msg)) return null;
      expect.push((m) => m.type === "playback_state");
      wrote = true;
    }
    if (!wrote) return Promise.resolve();
    const sentAt = this.now();
    return new Promise<void>((resolve) => this.flights.push({ expect, resolve, sentAt }));
  }
}
