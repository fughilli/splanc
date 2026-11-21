/**
 * The smart-home view of the hub's players (docs/design/smart-home-integrations.md,
 * Phase 1): each player is a LAMP with an on/off state and a brightness. The Matter
 * bridge (matter.ts) is written against {@link LampDriver} only, so it can be tested
 * with a fake and never reaches into sessions itself.
 *
 * {@link HubLamps} implements it over the hub, as a POLITE background client:
 *
 * - A netstack player serves ONE wss session, and hands an IDLE one (no client
 *   message for 15 s) to a newcomer (firmware/player_app/session_takeover.h, #444).
 *   To hear the lamp's power_state pushes (a lid tap, the app), the bridge keeps its
 *   session open with a hold, but never sends anything just to stay "busy": the
 *   phone app always wins.
 * - Taken over: the session is released (hub.ts) and the lamp's state is kept as
 *   last known. The bridge re-dials after a back-off (1 min, doubling to 10 min),
 *   which only succeeds once the other client has gone idle, and re-reads the state.
 * - A command from the smart home dials at once (hub.session resumes a released
 *   session), so control always works; the state is re-read on every (re)connect.
 * - Pushes: the player sends power_state only to sessions that have sent a power
 *   arm (docs/design/lamp-power.md), so every (re)connect sends get_power first.
 *
 * Players without the "power" feature (older firmware) fall back to brightness:
 * off = brightness 0, on = the last non-zero brightness. They push nothing, so their
 * state is what the bridge last set or read.
 */

import type { Hub } from "../hub";
import type { PlayerRecord } from "../registry";
import type { DeviceSession } from "../session";

export interface LampInfo {
  /** Stable id: the player's MAC (or `host:<host>` before a Welcome named it). */
  id: string;
  name: string;
  room?: string;
  fw?: string;
}

export interface LampState {
  on: boolean;
  /** Output brightness 0..1 (set_brightness): kept while off. */
  brightness: number;
  /** The bridge can reach the lamp (its session is open, or it was seen recently). */
  reachable: boolean;
  /** The firmware has real on/off ("power"); false = emulated with brightness 0. */
  power: boolean;
}

export interface LampDriver {
  list(): LampInfo[];
  state(id: string): LampState | undefined;
  setOn(id: string, on: boolean): Promise<void>;
  setBrightness(id: string, level: number): Promise<void>;
  /** Lamps were added, removed or renamed. */
  onList(fn: () => void): () => void;
  /** A lamp's state changed (a push, a re-read, a command's reply). */
  onState(fn: (id: string, st: LampState) => void): () => void;
  start(): void;
  stop(): void;
}

/** The power_state fields the bridge needs (lamp-power.md; ServerMessage arm 70). */
export interface PowerStateLike {
  on: boolean;
  brightness: number;
  seq?: number;
}

/** The power API on firmware/bundles that have it (agent/lamp-touch-power): looked up
 * at run time, so this file builds against a protocol without the power arms. */
interface PowerClient {
  getPower?: (timeoutMs?: number) => Promise<PowerStateLike>;
  setPower?: (req: { on?: boolean; toggle?: boolean; instant?: boolean; durationMs?: number }, timeoutMs?: number) => Promise<PowerStateLike>;
  onPowerState?: (fn: (s: PowerStateLike) => void) => () => void;
}

/** Re-dial back-off after a takeover (ms): the last one repeats. */
export const TAKEOVER_BACKOFF_MS = [60_000, 120_000, 300_000, 600_000];
/** A session that stayed ours this long resets the back-off. */
const STABLE_MS = 10 * 60_000;
/** How often the driver looks at the hub (no network unless something is due). */
const TICK_MS = 5_000;
/** Re-read a lamp that has no push (old firmware / never subscribed) at most this often. */
const REREAD_MS = 5 * 60_000;

interface Track {
  info: LampInfo;
  st: LampState;
  /** The session object we subscribed to (subscriptions survive release/resume). */
  session: DeviceSession | null;
  /** Our hold on it (null: not held, the hub may idle-release it). */
  unhold: (() => void) | null;
  /** The Welcome we last re-read the state for (a new one = a reconnect). */
  readFor: unknown;
  readAt: number;
  seq: number;
  /** Takeover back-off: index into TAKEOVER_BACKOFF_MS, and when to dial again. */
  backoff: number;
  retryAt: number;
  ownedSince: number;
  dialing: boolean;
  /** The last non-zero brightness (the emulated "on" level). */
  lastLevel: number;
}

export interface HubLampsOptions {
  /** Keep sessions open for pushes, and re-dial after takeovers, only while this says
   * so (the Matter bridge: while a controller has commissioned it). Otherwise lamps are
   * only dialed for commands, and the hub idle-releases them as usual. Default: always. */
  active?: () => boolean;
  log?: (...a: unknown[]) => void;
  now?: () => number;
  tickMs?: number;
  backoffMs?: number[];
}

export class HubLamps implements LampDriver {
  private readonly lamps = new Map<string, Track>();
  private readonly listSubs = new Set<() => void>();
  private readonly stateSubs = new Set<(id: string, st: LampState) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly log: (...a: unknown[]) => void;
  private readonly backoffMs: number[];

  constructor(
    private readonly hub: Hub,
    private readonly opts: HubLampsOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => undefined);
    this.backoffMs = opts.backoffMs ?? TAKEOVER_BACKOFF_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs ?? TICK_MS);
    this.timer.unref?.();
    void this.hub.ready().then(
      () => this.tick(),
      () => undefined,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const t of this.lamps.values()) {
      t.unhold?.();
      t.unhold = null;
    }
  }

  list(): LampInfo[] {
    return [...this.lamps.values()].map((t) => t.info);
  }

  state(id: string): LampState | undefined {
    const t = this.lamps.get(id);
    return t ? { ...t.st } : undefined;
  }

  onList(fn: () => void): () => void {
    this.listSubs.add(fn);
    return () => this.listSubs.delete(fn);
  }

  onState(fn: (id: string, st: LampState) => void): () => void {
    this.stateSubs.add(fn);
    return () => this.stateSubs.delete(fn);
  }

  async setOn(id: string, on: boolean): Promise<void> {
    const t = this.need(id);
    const s = await this.dial(t, true);
    const pc = s.client as unknown as PowerClient;
    if (s.has("power") && pc.setPower) {
      const p = await s.run(() => pc.setPower!({ on }));
      this.applyPower(t, p);
      return;
    }
    // Emulated: off = brightness 0, on = the last non-zero level.
    const level = on ? t.lastLevel || 1 : 0;
    await s.setBrightness(level);
    this.update(t, { on, brightness: on ? level : t.st.brightness, power: false });
  }

  async setBrightness(id: string, level: number): Promise<void> {
    const t = this.need(id);
    const v = Math.min(1, Math.max(0, level));
    const s = await this.dial(t, true);
    await s.setBrightness(v);
    if (v > 0) t.lastLevel = v;
    // With real power the brightness is independent of on/off (the push confirms it);
    // emulated, a level IS the on state.
    if (s.has("power")) this.update(t, { brightness: v });
    else this.update(t, { brightness: v, on: v > 0 });
  }

  // -- internals ---------------------------------------------------------------------

  private isActive(): boolean {
    return this.opts.active ? this.opts.active() : true;
  }

  private need(id: string): Track {
    const t = this.lamps.get(id);
    if (!t) throw new Error(`no lamp ${id}`);
    return t;
  }

  /** Look at the hub: new/renamed/gone players, takeovers, due re-dials and re-reads. */
  async tick(): Promise<void> {
    let listChanged = false;
    const seen = new Set<string>();
    for (const p of this.hub.registry.list()) {
      seen.add(p.id);
      const info = this.infoOf(p);
      const t = this.lamps.get(p.id);
      if (!t) {
        this.lamps.set(p.id, {
          info,
          st: { on: false, brightness: 1, reachable: p.checked !== "unreachable", power: false },
          session: null,
          unhold: null,
          readFor: null,
          readAt: 0,
          seq: -1,
          backoff: 0,
          retryAt: 0,
          ownedSince: 0,
          dialing: false,
          lastLevel: 1,
        });
        listChanged = true;
      } else if (t.info.name !== info.name || t.info.room !== info.room || t.info.fw !== info.fw) {
        t.info = info;
        listChanged = true;
      }
    }
    for (const id of [...this.lamps.keys()]) {
      if (!seen.has(id)) {
        this.lamps.delete(id);
        listChanged = true;
      }
    }
    if (listChanged) for (const fn of this.listSubs) fn();
    await Promise.all([...this.lamps.values()].map((t) => this.tend(t).catch(() => undefined)));
  }

  private infoOf(p: PlayerRecord): LampInfo {
    const room = this.hub.roomOf(p.id);
    return { id: p.id, name: p.name, ...(room ? { room } : {}), ...(p.fw ? { fw: p.fw } : {}) };
  }

  /** One lamp's upkeep. */
  private async tend(t: Track): Promise<void> {
    const rec = this.hub.registry.get(t.info.id);
    const s = t.session;
    const now = this.now();
    if (!this.isActive()) {
      // Nobody listens: let the hub release the session when idle, dial for commands only
      // (and once, to know the state before a controller first reads it).
      t.unhold?.();
      t.unhold = null;
      if (t.readAt === 0 && rec?.checked !== "unreachable" && now >= t.retryAt) {
        await this.dial(t, false).catch(() => {
          t.retryAt = now + this.backoffMs[0]!;
        });
      }
      return;
    }
    if (s && s.released === "taken_over") {
      if (t.retryAt === 0) {
        // Just taken over: back off before dialing again (only an idle peer yields).
        if (t.ownedSince && now - t.ownedSince > STABLE_MS) t.backoff = 0;
        const wait = this.backoffMs[Math.min(t.backoff, this.backoffMs.length - 1)]!;
        t.backoff++;
        t.retryAt = now + wait;
        t.ownedSince = 0;
        this.log(`${t.info.name}: another client took the session; smart-home state may lag (retry in ${Math.round(wait / 1000)} s)`);
      }
      if (now < t.retryAt) return;
    }
    const open = s !== null && !s.released && s.client.isConnected;
    if (!open) {
      if (rec?.checked === "unreachable") return this.update(t, { reachable: false });
      if (now < t.retryAt) return;
      try {
        await this.dial(t, false);
      } catch {
        // Busy with another client, or not answering: keep backing off.
        t.retryAt = now + this.backoffMs[Math.min(t.backoff, this.backoffMs.length - 1)]!;
        t.backoff++;
        return;
      }
    }
    await this.reread(t);
  }

  /** The lamp's session, dialing (or resuming a released one) if needed; held, subscribed. */
  private async dial(t: Track, forCommand: boolean): Promise<DeviceSession> {
    const rec = this.hub.registry.get(t.info.id);
    if (!rec) throw new Error(`lamp ${t.info.name} is gone`);
    if (t.dialing && !forCommand) throw new Error("dialing");
    t.dialing = true;
    try {
      const s = await this.hub.session(rec);
      if (t.session !== s) {
        t.unhold?.();
        t.unhold = null;
        t.session = s;
        t.readFor = null;
        const pc = s.client as unknown as PowerClient;
        pc.onPowerState?.((p) => this.applyPower(t, p));
      }
      // Keep it open for the pushes (it stays takeover-able: we send nothing while idle).
      if (!t.unhold && this.isActive()) t.unhold = s.hold("smart home: state push");
      if (t.retryAt !== 0) {
        t.retryAt = 0;
      }
      if (!t.ownedSince) t.ownedSince = this.now();
      this.update(t, { reachable: true });
      await this.reread(t);
      return s;
    } finally {
      t.dialing = false;
    }
  }

  /** Re-read the state after a (re)connect (also subscribes to power pushes). */
  private async reread(t: Track): Promise<void> {
    const s = t.session;
    if (!s || s.released || !s.client.isConnected) return;
    const w = s.client.welcome;
    const pc = s.client as unknown as PowerClient;
    const power = s.has("power") && typeof pc.getPower === "function";
    const due = t.readFor !== w || (!power && this.now() - t.readAt > REREAD_MS);
    if (!due) return;
    t.readFor = w;
    t.readAt = this.now();
    if (power) {
      t.seq = -1; // a new session: its first power_state wins whatever its seq
      this.applyPower(t, await s.run(() => pc.getPower!()));
    } else {
      const b = (w as { brightness?: number } | null)?.brightness;
      if (typeof b === "number") {
        if (b > 0) t.lastLevel = b;
        this.update(t, { on: b > 0, brightness: b > 0 ? b : t.st.brightness, power: false });
      }
    }
  }

  private applyPower(t: Track, p: PowerStateLike): void {
    if (typeof p.seq === "number") {
      if (t.seq >= 0 && p.seq < t.seq && t.seq - p.seq < 1 << 30) return; // stale push
      t.seq = p.seq;
    }
    if (p.brightness > 0) t.lastLevel = p.brightness;
    this.update(t, { on: p.on, brightness: p.brightness, power: true, reachable: true });
  }

  private update(t: Track, patch: Partial<LampState>): void {
    const next = { ...t.st, ...patch };
    if (next.on === t.st.on && next.brightness === t.st.brightness && next.reachable === t.st.reachable && next.power === t.st.power) return;
    t.st = next;
    for (const fn of this.stateSubs) fn(t.info.id, { ...next });
  }
}
