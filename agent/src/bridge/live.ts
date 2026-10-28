/**
 * The live multiplexer (docs/design/live-vj-relay.md): app sessions (the Splanc
 * PWA, via the relay or directly on the LAN) drive every player through the
 * bridge's ONE /ws session per player — the device serves one TLS session at a
 * time, so the bridge is the only thing that talks to it.
 *
 * - Continuous controls (`c`: uniforms, crossfade, brightness, keypoint morphs)
 *   are coalesced per player: the latest value of each control is kept, and a
 *   flush loop sends at most one frame per `minGapMs` per player, through the
 *   session's serialized queue (so they interleave safely with agents' MCP calls).
 *   Nothing is acknowledged (acks would be billed relay messages); failures come
 *   back as rate-limited `err` messages.
 * - Queries (`q`) fan out with Hub.each and answer once, per player.
 * - Arbitration: last writer wins, unless a client holds a player's Show Mode
 *   lock; then every other writer (other live clients AND MCP agents, via
 *   DeviceSession.liveLock) is refused with the holder's name. A lock survives
 *   its holder's disconnect for `lockGraceMs` (a phone switching networks).
 */

import {
  LIVE_FEATURES,
  LIVE_VERSION,
  TICK_LAN_MS,
  TICK_RELAY_MS,
  type AppMsg,
  type ControlMsg,
  type HelloMsg,
  type LanInfo,
  type LivePlayer,
  type PerPlayer,
  type QueryMsg,
  type UniformInput,
} from "../../../web/src/net/liveProtocol";
import { profileForMap } from "../../../web/src/capture/captureProfile";
import { encodeClient, type UniformValueFlat } from "../../../web/src/net/proto";
import type { Hub, PlayerResult } from "../hub";
import type { PlayerRecord } from "../registry";
import { ToolError, type DeviceSession } from "../session";
import { currentByName, describe, parseManifest, resolve, type ManifestUniform } from "../uniforms";

/** One app connection, whichever path it came by. */
export interface LiveConn {
  readonly id: string;
  readonly via: "relay" | "lan";
  /** The credential's label (relay) or the ticket's (LAN). */
  readonly label: string;
  /** The relay grant the credential belongs to (LAN tickets carry their minting grant). */
  readonly grant: string;
  /** A LAN connection is bound to the client id its ticket was minted for. */
  readonly clientId?: string;
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

/** Mints LAN tickets for clients connected via the relay (liveLan.ts). */
export interface TicketMinter {
  mint(clientId: string, label: string, grant: string): string;
  revokeGrants(grants: string[]): void;
}

export interface LiveMuxOptions {
  hub: Hub;
  bridgeId: () => string;
  /** The direct LAN endpoint, when enabled. */
  lan?: () => LanInfo | null;
  tickets?: TicketMinter;
  log?: (...a: unknown[]) => void;
  /** Minimum gap between two control flushes to one player (default 16 ms). */
  minGapMs?: number;
  /** Player-list poll (default 2 s): pushes `players` when it changed. */
  pollMs?: number;
  /** A lock outlives its holder's disconnect this long (default 30 s). */
  lockGraceMs?: number;
  /** Re-dial a player whose session has been down this long (default 20 s). */
  reopenAfterMs?: number;
}

interface ConnState {
  conn: LiveConn;
  clientId: string;
  name: string;
  hello: boolean;
  lastPlayers: string;
  /** (player|code) -> last time this error was sent. */
  errAt: Map<string, number>;
}

interface Pending {
  u: Map<number, Map<string, UniformInput>>;
  commit: boolean;
  xf?: { pos: number; mode: number };
  bri?: number;
  kb?: { w: Record<string, number>; seconds: number; deck: number };
  owner: ConnState | null;
}

interface PlayerQueue {
  pending: Pending;
  flushing: boolean;
  last: number;
}

interface Lock {
  clientId: string;
  by: string;
  key: object;
  /** Set while the holder is disconnected: released at this time (ms). */
  until?: number;
}

interface CachedManifest {
  gen: number;
  welcome: unknown;
  effectId: string;
  uniforms: ManifestUniform[];
}

const NO_LOCK = {};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** An `err` for the same player + code at most this often per connection. */
const ERR_EVERY_MS = 1000;

const emptyPending = (): Pending => ({ u: new Map(), commit: false, owner: null });
const isEmpty = (p: Pending) => p.u.size === 0 && !p.xf && p.bri === undefined && !p.kb;

export class LiveMux {
  private readonly conns = new Map<string, ConnState>();
  private readonly locks = new Map<string, Lock>();
  private readonly queues = new Map<string, PlayerQueue>();
  private readonly manifests = new Map<string, CachedManifest>();
  private readonly downSince = new Map<string, number>();
  /** Sessions whose fps_state we forward (re-subscribed when a session is re-dialed). */
  private readonly fpsWatched = new WeakSet<DeviceSession>();
  private readonly reopening = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly log: (...a: unknown[]) => void;
  private readonly hub: Hub;

  /** Frames flushed to players (tests and the design doc's numbers). */
  readonly stats = { controls: 0, flushes: 0, uniformsSent: 0 };

  constructor(private readonly opts: LiveMuxOptions) {
    this.hub = opts.hub;
    this.log = opts.log ?? (() => undefined);
  }

  /** Live connections now (the status file's `live.clients`). */
  get clients(): number {
    return this.conns.size;
  }

  /** The grants with a live connection open now (the status file's paired clients). */
  get grants(): Set<string> {
    return new Set([...this.conns.values()].map((c) => c.conn.grant));
  }

  // -- connections -----------------------------------------------------------------------

  attach(conn: LiveConn): void {
    this.conns.get(conn.id)?.conn.close(1000, "replaced");
    this.conns.set(conn.id, {
      conn,
      clientId: conn.clientId ?? conn.id,
      name: conn.label,
      hello: false,
      lastPlayers: "",
      errAt: new Map(),
    });
    this.log(`live: ${conn.via} session ${conn.id.slice(0, 8)} opened (${conn.label})`);
    if (!this.timer) {
      this.timer = setInterval(() => void this.poll(), this.opts.pollMs ?? 2000);
      this.timer.unref?.();
    }
  }

  detach(id: string): void {
    const cs = this.conns.get(id);
    if (!cs) return;
    this.conns.delete(id);
    this.log(`live: session ${id.slice(0, 8)} closed`);
    const still = [...this.conns.values()].some((c) => c.clientId === cs.clientId);
    if (!still) {
      for (const l of this.locks.values()) if (l.clientId === cs.clientId) l.until = Date.now() + (this.opts.lockGraceMs ?? 30_000);
    }
    if (this.conns.size === 0 && this.locks.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Close every connection whose grant was revoked ("*" = all) and drop their tickets. */
  revoke(grants: string[]): void {
    const all = grants.includes("*");
    for (const cs of [...this.conns.values()]) {
      if (all || grants.includes(cs.conn.grant)) {
        cs.conn.close(4003, "credential revoked");
        this.detach(cs.conn.id);
      }
    }
    this.opts.tickets?.revokeGrants(grants);
  }

  /** Drop the connections that came by one path (the relay link went down). */
  detachVia(via: "relay" | "lan"): void {
    for (const cs of [...this.conns.values()]) if (cs.conn.via === via) this.detach(cs.conn.id);
  }

  close(): void {
    for (const cs of [...this.conns.values()]) {
      cs.conn.close(1001, "bridge stopping");
      this.detach(cs.conn.id);
    }
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const [pid] of this.locks) this.unlock(pid);
  }

  /** One text message from a connection. */
  async message(id: string, text: string): Promise<void> {
    const cs = this.conns.get(id);
    if (!cs) return;
    let m: AppMsg;
    try {
      m = JSON.parse(text) as AppMsg;
    } catch {
      this.err(cs, "bad_message", "expected one JSON object per message");
      return;
    }
    if (m.t === "ping") {
      this.send(cs, { t: "pong", id: m.id });
      return;
    }
    if (m.t === "hello") {
      this.hello(cs, m);
      return;
    }
    if (!cs.hello) {
      this.err(cs, "no_hello", "send hello first");
      return;
    }
    if (m.t === "c") {
      await this.control(cs, m);
      return;
    }
    if (m.t === "q") {
      let reply: Record<string, unknown>;
      try {
        reply = { t: "r", id: m.id, ok: true, ...(await this.query(cs, m)) };
      } catch (e) {
        reply = { t: "r", id: m.id, ok: false, error: (e as Error).message };
      }
      this.send(cs, reply);
      return;
    }
    this.err(cs, "bad_message", `unknown message type ${JSON.stringify((m as { t?: unknown }).t)}`);
  }

  private send(cs: ConnState, msg: unknown): void {
    try {
      cs.conn.send(JSON.stringify(msg));
    } catch {
      // gone: its close detaches it
    }
  }

  /** A rate-limited asynchronous error. */
  private err(cs: ConnState | null, code: string, message: string, player?: PlayerRecord): void {
    if (!cs) return;
    const k = `${player?.id ?? ""}|${code}`;
    const t = Date.now();
    if (t - (cs.errAt.get(k) ?? 0) < ERR_EVERY_MS) return;
    cs.errAt.set(k, t);
    this.send(cs, { t: "err", code, message, ...(player ? { player: player.id } : {}) });
  }

  private hello(cs: ConnState, m: HelloMsg): void {
    // A LAN ticket is bound to the client it was minted for.
    if (!cs.conn.clientId && typeof m.client_id === "string" && CLIENT_ID_RE.test(m.client_id)) cs.clientId = m.client_id;
    cs.name = (typeof m.name === "string" && m.name.trim() ? m.name.trim() : cs.conn.label).slice(0, 60);
    cs.hello = true;
    // Back within the grace period: the locks are this client's again.
    for (const l of this.locks.values()) if (l.clientId === cs.clientId) delete l.until;
    const lan = this.opts.lan?.() ?? null;
    const players = this.players(cs);
    cs.lastPlayers = JSON.stringify(players);
    this.send(cs, {
      t: "welcome",
      v: LIVE_VERSION,
      bridge: { id: this.opts.bridgeId() },
      via: cs.conn.via,
      lan,
      ...(lan && cs.conn.via === "relay" && this.opts.tickets
        ? { lan_token: this.opts.tickets.mint(cs.clientId, cs.name, cs.conn.grant) }
        : {}),
      players: players.players,
      rooms: players.rooms,
      tick_ms: cs.conn.via === "lan" ? TICK_LAN_MS : TICK_RELAY_MS,
    });
    if (!this.hub.registry.list().length) void this.hub.ready().catch(() => undefined);
  }

  // -- the player list -----------------------------------------------------------------

  private players(cs: ConnState): { players: LivePlayer[]; rooms: Record<string, string[]> } {
    const players = this.hub.registry.list().map((p): LivePlayer => {
      const s = this.hub.openSession(p.id);
      const lock = this.locks.get(p.id);
      const feats = s ? [...s.features()].filter((f) => LIVE_FEATURES.includes(f)).sort() : [];
      const room = this.hub.roomOf(p.id);
      if (s) this.watchFps(s, p);
      const st = s?.fpsState;
      const fps = s && (st || s.renderFps > 0)
        ? {
            current: st?.currentFps || s.renderFps,
            target: st?.targetFps ?? 0,
            auto: st?.auto ?? true,
            lagging: st?.lagging ?? false,
            achieved: st?.achievedFps ?? 0,
          }
        : null;
      return {
        id: p.id,
        name: p.name,
        host: p.host,
        connected: s?.client.isConnected === true,
        ...(p.fw || s?.client.welcome?.fwVersion ? { fw: s?.client.welcome?.fwVersion || p.fw } : {}),
        features: feats,
        ...(room ? { room } : {}),
        lock: lock ? { by: lock.by, mine: lock.clientId === cs.clientId } : null,
        effect: this.manifests.get(`${p.id}:0`)?.effectId || null,
        ...(fps ? { fps } : {}),
      };
    });
    return { players, rooms: { ...this.hub.config.groups } };
  }

  /** Forward this session's fps_state: the effect starting/stopping to lag (it runs
   * below the floor / pinned rate, still playing) goes to every app at once; any
   * change also refreshes the player lists (coalesced by the 2 s poll's change
   * check, so autoscaler steps cost one message each). */
  private watchFps(s: DeviceSession, p: PlayerRecord): void {
    if (this.fpsWatched.has(s)) return;
    this.fpsWatched.add(s);
    let wasLagging = false;
    s.onFps((st) => {
      if (st.lagging !== wasLagging) {
        wasLagging = st.lagging;
        for (const cs of this.conns.values()) {
          if (!cs.hello) continue;
          this.send(cs, {
            t: "fps",
            player: p.id,
            name: p.name,
            current_fps: st.currentFps,
            target_fps: st.targetFps,
            min_fps: st.minFps,
            auto: st.auto,
            lagging: st.lagging,
            achieved_fps: st.achievedFps,
          });
        }
      }
    });
  }

  /** Periodic: expire locks, re-dial dead sessions, push changed player lists. */
  private async poll(): Promise<void> {
    const t = Date.now();
    for (const [pid, l] of [...this.locks]) if (l.until !== undefined && l.until <= t) this.unlock(pid);
    this.syncLocks();
    if (this.conns.size > 0) {
      for (const p of this.hub.registry.list()) {
        const s = this.hub.openSession(p.id);
        if (s?.client.isConnected) {
          this.downSince.delete(p.id);
          continue;
        }
        if (!s) continue;
        const since = this.downSince.get(p.id) ?? t;
        this.downSince.set(p.id, since);
        if (t - since >= (this.opts.reopenAfterMs ?? 20_000) && !this.reopening.has(p.id)) {
          this.reopening.add(p.id);
          this.log(`live: ${p.name} has been unreachable ${Math.round((t - since) / 1000)} s; reconnecting`);
          void this.hub
            .reopen(p.id)
            .then(() => this.syncLocks())
            .catch(() => undefined)
            .finally(() => {
              this.reopening.delete(p.id);
              this.downSince.set(p.id, Date.now());
            });
        }
      }
    }
    for (const cs of this.conns.values()) this.pushPlayers(cs);
  }

  private pushPlayers(cs: ConnState, force = false): void {
    if (!cs.hello) return;
    const p = this.players(cs);
    const key = JSON.stringify(p);
    if (!force && key === cs.lastPlayers) return;
    cs.lastPlayers = key;
    this.send(cs, { t: "players", ...p });
  }

  // -- locks -----------------------------------------------------------------------------

  /** Mirror the locks onto the sessions (a re-dialed session starts unlocked). */
  private syncLocks(): void {
    for (const p of this.hub.registry.list()) {
      const s = this.hub.openSession(p.id);
      if (!s) continue;
      const l = this.locks.get(p.id);
      s.liveLock = l ? { by: l.by, key: l.key } : null;
    }
  }

  private unlock(pid: string): void {
    this.locks.delete(pid);
    const s = this.hub.openSession(pid);
    if (s) s.liveLock = null;
  }

  private keyFor(pid: string, cs: ConnState): object {
    const l = this.locks.get(pid);
    return l && l.clientId === cs.clientId ? l.key : NO_LOCK;
  }

  private lockedOut(pid: string, cs: ConnState): Lock | null {
    const l = this.locks.get(pid);
    return l && l.clientId !== cs.clientId ? l : null;
  }

  // -- controls ----------------------------------------------------------------------------

  private async control(cs: ConnState, m: ControlMsg): Promise<void> {
    let targets: PlayerRecord[];
    try {
      targets = await this.hub.select(m.to);
    } catch (e) {
      this.err(cs, "bad_target", (e as Error).message);
      return;
    }
    this.stats.controls++;
    for (const p of targets) {
      const l = this.lockedOut(p.id, cs);
      if (l) {
        this.err(cs, "locked", `${p.name} is locked by ${l.by} (Show Mode)`, p);
        continue;
      }
      const q = this.queue(p.id);
      const pend = q.pending;
      if (m.u && typeof m.u === "object") {
        const deck = m.deck === 1 ? 1 : 0;
        const d = pend.u.get(deck) ?? new Map<string, UniformInput>();
        for (const [k, v] of Object.entries(m.u)) d.set(k, v);
        pend.u.set(deck, d);
        if (m.commit) pend.commit = true;
      }
      if (m.xf && Number.isFinite(m.xf.pos)) pend.xf = { pos: clamp01(m.xf.pos), mode: m.xf.mode === 1 ? 1 : 0 };
      if (typeof m.bri === "number" && Number.isFinite(m.bri)) pend.bri = clamp01(m.bri);
      if (m.kb && m.kb.w && typeof m.kb.w === "object") {
        pend.kb = { w: m.kb.w, seconds: Number(m.kb.seconds) || 0, deck: m.kb.deck === 1 ? 1 : 0 };
      }
      pend.owner = cs;
      void this.flush(p);
    }
  }

  private queue(pid: string): PlayerQueue {
    let q = this.queues.get(pid);
    if (!q) {
      q = { pending: emptyPending(), flushing: false, last: 0 };
      this.queues.set(pid, q);
    }
    return q;
  }

  /** Drain a player's pending controls: one frame per kind per flush, spaced by minGapMs. */
  private async flush(p: PlayerRecord): Promise<void> {
    const q = this.queue(p.id);
    if (q.flushing) return;
    q.flushing = true;
    try {
      while (!isEmpty(q.pending)) {
        // Never faster than the player renders (FUG-82 autoscaler: a C6 that dropped
        // to 25 fps gets a frame per 40 ms; more would only queue on its wss).
        const fps = this.hub.openSession(p.id)?.renderFps ?? 0;
        const gap = Math.max(this.opts.minGapMs ?? 16, fps > 0 ? 1000 / fps : 0);
        const wait = q.last + gap - Date.now();
        if (wait > 0) await sleep(wait);
        const pend = q.pending;
        q.pending = emptyPending();
        const owner = pend.owner;
        const s = this.hub.openSession(p.id);
        if (!s || !s.client.isConnected) {
          // The hub's specific reason when its heartbeat declared the player lost (#323).
          const rec = this.hub.registry.get(p.id);
          const why = rec?.checked === "unreachable" && rec.manifestError ? `: ${rec.manifestError}` : " right now";
          this.err(owner, "offline", `${p.name} isn't connected to the bridge${why}`, p);
          if (!s) void this.hub.session(p).catch(() => undefined);
          q.last = Date.now();
          continue;
        }
        const key = owner ? this.keyFor(p.id, owner) : NO_LOCK;
        try {
          for (const [deck, vals] of pend.u) {
            const m = await this.manifest(s, p.id, deck);
            const wire: UniformValueFlat[] = [];
            for (const [name, v] of vals) {
              try {
                wire.push(...resolve(m.uniforms, { [name]: v }));
              } catch (e) {
                this.err(owner, "bad_uniform", `${p.name}: ${(e as Error).message}`, p);
              }
            }
            if (wire.length) {
              await s.asLive(key, () => s.sendLiveUniforms(wire, pend.commit, deck === 1 ? 1 : 0));
              this.stats.uniformsSent += wire.length;
            }
          }
          if (pend.xf) {
            const xf = pend.xf;
            // Through the session's deck model, so crossfade_to / rollback_effect
            // see the same live deck the performer's fader is on.
            const ok = await s.asLive(key, () => s.liveCrossfade(xf.pos, xf.mode));
            if (!ok) this.err(owner, "unsupported", `${p.name}: firmware ${s.fwVersion} has no crossfade (decks)`, p);
          }
          if (pend.bri !== undefined) {
            const b = pend.bri;
            await s.asLive(key, () => s.setBrightness(b));
          }
          if (pend.kb) {
            const kb = pend.kb;
            await s.asLive(key, () => s.blendKeypoints(kb.w, { seconds: kb.seconds, deck: kb.deck }));
          }
          this.stats.flushes++;
        } catch (e) {
          this.err(owner, e instanceof ToolError ? "refused" : "failed", `${p.name}: ${(e as Error).message}`, p);
        }
        q.last = Date.now();
      }
    } finally {
      q.flushing = false;
    }
  }

  /** The active effect's uniform manifest on `deck`, cached until the effect changes. */
  private async manifest(s: DeviceSession, pid: string, deck: number, fresh = false): Promise<CachedManifest> {
    const k = `${pid}:${deck}`;
    const c = this.manifests.get(k);
    if (!fresh && c && c.gen === s.effectGen && c.welcome === s.client.welcome) return c;
    const gen = s.effectGen;
    const welcome = s.client.welcome;
    const raw = await s.run(() => s.client.getEffectUniforms(undefined, deck));
    const m: CachedManifest = { gen, welcome, effectId: raw.effectId ?? "", uniforms: parseManifest(raw.manifest ?? new Uint8Array(0)) };
    this.manifests.set(k, m);
    return m;
  }

  // -- queries -----------------------------------------------------------------------------

  private sel(m: QueryMsg): string[] {
    return Array.isArray(m.to) && m.to.length ? m.to : ["all"];
  }

  private async each<T>(
    cs: ConnState,
    m: QueryMsg,
    fn: (s: DeviceSession, p: PlayerRecord, key: object) => Promise<T>,
    mutates = true,
  ): Promise<PlayerResult<T>[]> {
    return this.hub.each(this.sel(m), async (s, p) => {
      const l = mutates ? this.lockedOut(p.id, cs) : null;
      if (l) throw new ToolError(`${p.name} is locked by ${l.by} (Show Mode)`);
      return fn(s, p, this.keyFor(p.id, cs));
    });
  }

  private async query(cs: ConnState, m: QueryMsg): Promise<{ results?: PerPlayer[]; data?: unknown }> {
    const deck = m["deck"] === 1 ? 1 : 0;
    switch (m.op) {
      case "players": {
        if (m["refresh"] === true) await this.hub.refresh({ sweep: "auto" });
        else await this.hub.ready();
        const data = this.players(cs);
        cs.lastPlayers = JSON.stringify(data);
        return { data };
      }
      case "effect":
        return {
          results: await this.each(
            cs,
            m,
            async (s, p) => {
              const man = await this.manifest(s, p.id, deck, true);
              const raw = await s.run(() => s.client.getEffectUniforms(undefined, deck));
              // Wide uniforms (mat3/mat4) arrive as ≤4-float slot chunks.
              const cur = currentByName(man.uniforms, raw.current ?? []);
              let keypoints: unknown = null;
              if (man.effectId && s.keypointsUsable()) keypoints = await s.listKeypoints(deck).then((k) => k.keypoints, () => null);
              return {
                effect_id: man.effectId || null,
                uniforms: man.uniforms.map((u) => describe(u, cur.get(u.name))),
                keypoints,
              };
            },
            false,
          ),
        };
      case "deploy": {
        const id = String(m["effect_id"] ?? "").trim();
        const source = String(m["source"] ?? "");
        if (!id || !source) throw new Error("deploy needs effect_id and source");
        const activate = m["activate"] !== false;
        // Cue onto the deck without touching the crossfade (Show Mode), in the
        // session's deck model (cueDeck); activate:false only uploads (deck A).
        const results = await this.each(cs, m, (s, _p, key) =>
          s.asLive(key, () => (activate ? s.cueDeck(id, source, deck) : s.deployEffect(id, source, false))),
        );
        const ok = results.filter((r) => r.ok).map((r) => r.player.id);
        let align: unknown;
        if (activate && ok.length > 1 && m["align"] !== false) align = await this.hub.alignTime(ok).catch((e: Error) => ({ error: e.message }));
        for (const c of this.conns.values()) this.pushPlayers(c);
        return { results, ...(align ? { data: { align } } : {}) };
      }
      case "set_effect": {
        const id = String(m["effect_id"] ?? "");
        // The session finds the deck an id is loaded on (and snaps to it), as for agents.
        const results = await this.each(cs, m, (s, _p, key) => s.asLive(key, () => s.setEffect(id || "off")));
        return { results };
      }
      case "keypoints":
        return { results: await this.each(cs, m, (s) => s.listKeypoints(deck), false) };
      case "align":
        return { data: await this.hub.alignTime(this.sel(m)) };
      case "lock": {
        const on = m["on"] === true;
        const results = await this.hub.each(this.sel(m), async (_s, p) => {
          const l = this.locks.get(p.id);
          if (on) {
            if (l && l.clientId !== cs.clientId) throw new ToolError(`${p.name} is locked by ${l.by}`);
            this.locks.set(p.id, l ?? { clientId: cs.clientId, by: cs.name, key: {} });
          } else if (l && l.clientId === cs.clientId) {
            this.unlock(p.id);
          }
          return { locked: this.locks.has(p.id), by: this.locks.get(p.id)?.by ?? null };
        });
        this.syncLocks();
        if (on && !this.timer) {
          this.timer = setInterval(() => void this.poll(), this.opts.pollMs ?? 2000);
          this.timer.unref?.();
        }
        for (const c of this.conns.values()) this.pushPlayers(c);
        return { results };
      }
      case "probe":
        return {
          results: await this.each(
            cs,
            m,
            async (s) => {
              const t0 = performance.now();
              const r = await s.run(() => s.client.syncClock(1));
              return { device_rtt_ms: round1(r.rttMs), bridge_ms: round1(performance.now() - t0) };
            },
            false,
          ),
        };
      case "identify":
        return { results: await this.each(cs, m, (s, _p, key) => s.asLive(key, () => s.identify())) };
      case "group_capture":
        return this.groupCapture(cs, m);
      default:
        throw new Error(`unknown op ${JSON.stringify(m.op)}`);
    }
  }

  /**
   * Multi-fixture localization through the bridge (docs/design/
   * multi-fixture-localization.md §4; app side web/src/net/groupCapture.ts).
   * The bridge already holds every player's one socket, so the app arms the
   * whole group in one query: the bridge picks a shared epoch on ITS clock (a
   * little in the past), converts it with a fresh LAN clock sync per player and
   * starts each player's group pattern on it; the reply carries the hub clock so
   * the app can express the epoch on its own.
   */
  private async groupCapture(cs: ConnState, m: QueryMsg): Promise<{ results?: PerPlayer[]; data?: unknown }> {
    const action = String(m["action"] ?? "");
    switch (action) {
      case "prepare":
        return {
          results: await this.each(
            cs,
            m,
            async (s, p) => {
              const w = s.client.welcome as (Record<string, unknown> & { features?: string[]; codeParams?: { ledCount?: number } }) | null;
              const bundle = await s.mappingBundle().catch(() => null);
              // The map's capture profile (#320) — only if it belongs to this map.
              const profile =
                (w?.features ?? []).includes("capture_profile") && bundle?.map
                  ? await s
                      .run(() => s.client.getCaptureProfile())
                      .then((p) => profileForMap(p, bundle.map!.mapId), () => null)
                  : null;
              return {
                name: p.name,
                features: w?.features ?? [],
                led_count: bundle?.map?.ledCount ?? w?.codeParams?.ledCount ?? 0,
                map: bundle?.map ?? null,
                pose: this.hub.pose(p.id) ?? (w?.["pose"] as unknown) ?? null,
                profile,
              };
            },
            false,
          ),
        };
      case "start": {
        const plans = (Array.isArray(m["members"]) ? m["members"] : []) as GroupMemberPlan[];
        if (plans.length === 0) throw new Error("group_capture start needs members");
        const lead = typeof m["epoch_lead_ms"] === "number" ? (m["epoch_lead_ms"] as number) : 1000;
        const hubEpoch = Math.round(performance.now() - lead);
        const results: PerPlayer[] = [];
        for (const plan of plans) {
          const [r] = await this.each(cs, { ...m, to: [plan.to] }, async (s) => {
            const c = await s.syncClock(8);
            const { ledCount, ...rest } = plan.options;
            const n = Number(ledCount);
            const config = { ...rest, epochMs: Math.round(hubEpoch + c.offsetMs) };
            try {
              encodeClient({ type: "start_mapping", options: { ledCount: n, ...config } } as never);
            } catch (e) {
              throw new ToolError(`this bridge can't encode the group capture (${(e as Error).message}): update it`);
            }
            const started = await s.groupCaptureScope(() => s.client.startMapping(n, config));
            return { code_params: started.codeParams, skew_bound_ms: round1(Math.max(0, c.rttMs) / 2) };
          });
          if (r) results.push(r);
        }
        return { results, data: { hub_epoch_ms: hubEpoch, hub_now_ms: performance.now() } };
      }
      case "stop":
        return {
          results: await this.each(cs, m, (s) => s.groupCaptureScope(() => s.client.stopMappingNoSolve()).then(() => ({ stopped: true }))),
        };
      case "set_pose": {
        const poses = (Array.isArray(m["poses"]) ? m["poses"] : []) as { to: string; pose: Record<string, unknown> | null }[];
        const results: PerPlayer[] = [];
        for (const e of poses) {
          const [r] = await this.each(cs, { ...m, to: [e.to] }, async (s, p) => {
            if (!e.pose) return { stored: false };
            const pose = {
              room: String(e.pose["room"] ?? ""),
              translation: (e.pose["translation"] as [number, number, number]) ?? [0, 0, 0],
              rotation: (e.pose["rotation"] as [number, number, number, number]) ?? [0, 0, 0, 1],
              scale: Number(e.pose["scale"] ?? 1) || 1,
            };
            this.hub.setPose(p.id, pose);
            return { stored: true, on_device: await s.setFixturePose(pose) };
          });
          if (r) results.push(r);
        }
        return { results };
      }
      default:
        throw new Error(`unknown group_capture action ${JSON.stringify(action)}`);
    }
  }
}

export interface GroupMemberPlan {
  to: string;
  options: Record<string, number>;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const round1 = (x: number) => Math.round(x * 10) / 10;
