/**
 * The hub (docs/design/agent-multi-fixture.md): one bridge, every player on the
 * LAN. It owns the registry (registry.ts), one lazily-opened /ws session per
 * player (never two sockets to one device: the player serves TLS from two slots),
 * the version-matched toolchains (toolchain.ts), rooms/groups and fixture poses
 * (config + room.ts), and the shared time base (timesync.ts).
 *
 * Every device operation takes a player SELECTOR — a name, MAC, group/room name,
 * "all", or a list of those — and fans out: in parallel across players,
 * serialized per player (DeviceSession.run), with a result per player; a failure
 * on one player is reported, never hidden, and doesn't stop the others.
 *
 * Default target (no selector): the only player; else every player when they form
 * a single room (no groups, or one group holding them all); else an error that
 * lists the rooms, so the agent asks.
 */

import { loadConfig, saveConfig, type HubConfig, type Pose } from "./config";
import { checkSamePlayer, resolveTarget, type Manifest } from "./discovery";
import { Liveness, type LivenessOptions } from "./liveness";
import { neighbourHint } from "./netdiag";
import { ms, progress } from "./progress";
import { Registry, isMacId, type PlayerRecord, type RefreshOptions, type RegistryDeps } from "./registry";
import { DeviceSession, ToolError } from "./session";
import { nodeSocketFactory } from "./socket";
import { RESYNC_MS, deviceEpochs, skewBoundMs, type ClockSync } from "./timesync";
import { Toolchains, type ToolchainChoice } from "./toolchain";
import { decideTrust, trustError, trusted } from "./trust";

export type Selector = string | string[] | undefined;

type WelcomeOf = Awaited<ReturnType<DeviceSession["connect"]>>;

export interface PlayerResult<T> {
  player: { id: string; name: string };
  ok: boolean;
  result?: T;
  error?: string;
}

export interface HubOptions {
  hosts?: string[];
  /** Bundle root (compiler/, simulator/, bundle.json). */
  root: string;
  streamHz?: number;
  pin?: string;
  config?: HubConfig;
  /** Persist config changes (default: the config file). */
  persist?: (cfg: HubConfig) => void;
  registryDeps?: RegistryDeps;
  toolchains?: Toolchains;
  /** mDNS browsing (default on). */
  mdns?: boolean;
  connectTimeoutMs?: number;
  log?: (...a: unknown[]) => void;
  /** Session heartbeat tuning (liveness.ts). */
  liveness?: LivenessOptions;
  /** How long a dropped session may take to reconnect by itself before the
   * player is taken as gone and looked for (ms, default 10 s). */
  reconnectGraceMs?: number;
  /** Background search for players that stopped answering: delays between
   * rounds (ms; the last repeats). [] turns it off. */
  huntBackoffMs?: number[];
}

/** Background search rounds for a lost player: soon, then backing off to 5 min. */
const HUNT_BACKOFF_MS = [2_000, 5_000, 10_000, 20_000, 40_000, 60_000, 120_000, 300_000];
/** A session silent this long is pinged before a tool uses it. */
const PREFLIGHT_SILENCE_MS = 10_000;

export class Hub {
  readonly config: HubConfig;
  readonly registry: Registry;
  readonly toolchains: Toolchains;
  private readonly sessions = new Map<string, DeviceSession>();
  private readonly connecting = new Map<string, Promise<DeviceSession>>();
  /** Sessions opened by discovery (identifying a host), by host, until a tool adopts them. */
  private readonly dialed = new Map<string, DeviceSession>();
  private readonly choice = new Map<string, ToolchainChoice>();
  /** The room epoch (hub clock, ms) last applied to each player by alignTime. */
  private readonly epochs = new Map<string, number>();
  private refreshed: Promise<unknown> | null = null;
  private readonly log: (...a: unknown[]) => void;
  /** Each session's heartbeat (liveness.ts) and the host it was opened to. */
  private readonly liveness = new Map<DeviceSession, Liveness>();
  private readonly sessionHost = new Map<DeviceSession, string>();
  /** Why a session was declared dead (for the error of a call it was running). */
  private readonly deaths = new WeakMap<DeviceSession, string>();
  /** The background search for lost players (hunt()). */
  private huntTimer: ReturnType<typeof setTimeout> | null = null;
  private huntRound = 0;
  private hunting: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly opts: HubOptions) {
    this.config = opts.config ?? loadConfig();
    const persist = opts.persist ?? ((c: HubConfig) => void saveConfig(c));
    this.registry = new Registry(opts.hosts ?? [], this.config, () => persist(this.config), {
      // An unknown host is identified by opening its session (one TLS handshake,
      // kept for the tool that needs it) rather than by a separate manifest GET.
      identify: async (host, pin) => {
        const { s, w, fp } = await this.dial(host, host, pin);
        const prior = this.dialed.get(host);
        if (prior) this.forgetSession(prior);
        // TOFU by device id: a session whose certificate isn't the one remembered
        // for its MAC is not kept (the registry records the verdict; the tool
        // that wants it is refused with the explanation).
        const id = (w.mac || "").toUpperCase();
        const v = this.opts.pin ? null : decideTrust({ id, presented: fp, known: this.config.players[id]?.pin });
        if (v && !trusted(v) && v.kind !== "unverified") this.forgetSession(s);
        else this.dialed.set(host, s);
        return {
          id: w.mac || `host:${host}`,
          name: w.deviceName || host,
          ...(w.fwVersion ? { fw: w.fwVersion } : {}),
          ...(fp ? { pin: fp } : {}),
        };
      },
      ...opts.registryDeps,
    });
    this.toolchains = opts.toolchains ?? new Toolchains(opts.root);
    this.log = opts.log ?? (() => undefined);
    this.persistConfig = () => persist(this.config);
  }

  private readonly persistConfig: () => void;

  /** A hub around one already-connected session (no discovery, no persistence):
   * the single-player bridge, and the tests' MCP surface. */
  static forSession(session: DeviceSession, root = ""): Hub {
    const hub = new Hub({
      root,
      config: { players: {}, groups: {}, poses: {} },
      persist: () => undefined,
      mdns: false,
      toolchains: new Toolchains(root),
    });
    const w = session.client.welcome;
    const id = (w?.mac || "player").toUpperCase();
    hub.registry.put({
      id,
      name: w?.deviceName || "player",
      host: "(connected)",
      ...(w?.fwVersion ? { fw: w.fwVersion } : {}),
      manifest: null,
      target: null,
      sources: ["host"],
      lastSeen: Date.now(),
    });
    hub.sessions.set(id, session);
    hub.refreshed = Promise.resolve();
    return hub;
  }

  // -- discovery -----------------------------------------------------------------

  /** Discover (once, lazily, before the first use; again on refresh()). */
  async ready(): Promise<void> {
    // For tools: remembered players straight from the cache (their sessions are
    // the check); unknown hosts identified; discovery only when nothing is known.
    if (this.refreshed === null) this.refreshed = this.refresh({ sweep: "auto", lazy: true });
    await this.refreshed;
  }

  async refresh(opts: RefreshOptions = {}): Promise<PlayerRecord[]> {
    const live = new Set(
      [...this.sessions].filter(([, s]) => this.alive(s)).map(([id]) => this.registry.get(id)?.host ?? ""),
    );
    const p = this.registry.refresh({ mdns: this.opts.mdns !== false, ...opts }, live);
    this.refreshed = p;
    return p;
  }

  addHost(host: string): void {
    this.registry.addHost(host);
  }

  /** Every player, each confirmed this run: list_players answers "who is here",
   * so cache-only records get their (cheap, TCP-only) check. */
  async players(): Promise<PlayerRecord[]> {
    await this.ready();
    if (this.registry.list().some((p) => p.checked === "cached")) await this.refresh({ sweep: "auto" });
    // A session that died since is not "checked: session" any more.
    for (const p of this.registry.list()) {
      if (p.checked === "session" && !this.isConnected(p.id) && !this.dialedFor(p)) {
        this.registry.markUnreachable(p.id, p.manifestError ?? "its session closed");
      }
    }
    this.kickHunt();
    return this.registry.list();
  }

  /** A discovery-opened session for this player, still connected. */
  private dialedFor(p: PlayerRecord): boolean {
    const s = this.dialed.get(p.host);
    return s !== undefined && this.alive(s);
  }

  groupsOf(id: string): string[] {
    return Object.entries(this.config.groups)
      .filter(([, ids]) => ids.includes(id))
      .map(([g]) => g);
  }

  /** Resolve a selector to player records. */
  async select(sel: Selector): Promise<PlayerRecord[]> {
    await this.ready();
    const all = this.registry.list();
    if (all.length === 0) {
      throw new ToolError(
        "no Splanc players found (mDNS, remembered players and a LAN sweep came up empty). Is a player on this " +
          "network and powered? Pass a host: add_player {host: '<ip or name>'} (CLI: --host <ip>).",
      );
    }
    const want = sel === undefined ? [] : Array.isArray(sel) ? sel : [sel];
    if (want.length === 0) {
      if (all.length === 1) return all;
      // The implicit target is the players that answer; a lost one is still
      // targeted by name (and its error says why it's unreachable).
      const up = all.filter((p) => p.checked !== "unreachable");
      if (up.length > 0 && up.length < all.length) return this.defaultTarget(up);
      return this.defaultTarget(all);
    }
    return this.selectNamed(all, want);
  }

  private defaultTarget(all: PlayerRecord[]): PlayerRecord[] {
    {
      if (all.length === 1) return all;
      const groups = Object.entries(this.config.groups).filter(([, ids]) => ids.length > 0);
      const grouped = new Set(groups.flatMap(([, ids]) => ids));
      if (groups.length === 0 || (groups.length === 1 && all.every((p) => grouped.has(p.id)))) return all;
      throw new ToolError(
        `there are ${all.length} players in ${groups.length} rooms (${groups.map(([g]) => g).join(", ")}): pass ` +
          `players: a room, a player name, or "all"`,
      );
    }
  }

  private selectNamed(all: PlayerRecord[], want: string[]): PlayerRecord[] {
    const out = new Map<string, PlayerRecord>();
    for (const w of want) {
      const key = w.trim();
      if (key.toLowerCase() === "all") {
        for (const p of all) out.set(p.id, p);
        continue;
      }
      const group = Object.entries(this.config.groups).find(([g]) => g.toLowerCase() === key.toLowerCase());
      if (group) {
        for (const id of group[1]) {
          const p = this.registry.get(id);
          if (p) out.set(p.id, p);
        }
        continue;
      }
      const hit =
        all.find((p) => p.id.toLowerCase() === key.toLowerCase()) ??
        all.find((p) => p.name.toLowerCase() === key.toLowerCase()) ??
        all.find((p) => p.host === key) ??
        uniquePrefix(all, key);
      if (!hit) {
        throw new ToolError(
          `no player or room "${key}". Players: ${all.map((p) => `${p.name} (${p.id})`).join(", ")}` +
            (Object.keys(this.config.groups).length ? `; rooms: ${Object.keys(this.config.groups).join(", ")}` : ""),
        );
      }
      out.set(hit.id, hit);
    }
    return [...out.values()];
  }

  // -- sessions --------------------------------------------------------------------

  /** The player's session, connecting on first use (one socket per device, ever). */
  async session(p: PlayerRecord): Promise<DeviceSession> {
    const have = this.sessions.get(p.id);
    // The player was found at another host since this session opened (add_player,
    // the search): the old socket must prove itself before it is used.
    const movedOn = have !== undefined && this.sessionHost.has(have) && this.sessionHost.get(have) !== (this.registry.get(p.id) ?? p).host;
    if (have && (await this.verify(have, movedOn))) return have;
    let c = this.connecting.get(p.id);
    if (!c) {
      // The record may have moved (a new host) since the caller looked it up.
      c = this.open(this.registry.get(p.id) ?? p);
      this.connecting.set(p.id, c);
      c.finally(() => this.connecting.delete(p.id)).catch(() => undefined);
    }
    return c;
  }

  /** Is this session usable? Connected and not declared dead; one that went quiet
   * a while is pinged first (a rebooted player's socket looks open forever); one
   * reconnecting by itself gets the grace period. A session found dead is dropped
   * (and its player looked for). */
  private async verify(s: DeviceSession, force = false): Promise<boolean> {
    const live = this.liveness.get(s);
    if (!live) return true; // forSession's fixed session: as it is
    if (live.dead) return false;
    if (!s.client.isConnected) {
      const grace = this.opts.reconnectGraceMs ?? 10_000;
      const t0 = performance.now();
      while (!s.client.isConnected && !live.dead && performance.now() - t0 < grace) await sleep(100);
      if (!s.client.isConnected) {
        live.kill(`the connection closed and didn't come back within ${grace / 1000} s`);
        return false;
      }
    }
    if ((force || live.silentMs > PREFLIGHT_SILENCE_MS) && !(await live.beat()) && !(await live.beat())) {
      live.kill(
        force
          ? `no reply to two heartbeat pings at ${this.sessionHost.get(s)} (the player was found at another address)`
          : `no reply to two heartbeat pings after ${Math.round(live.silentMs / 1000)} s of silence: it rebooted, moved to another IP, or dropped off Wi-Fi`,
      );
      return false;
    }
    return !live.dead;
  }

  /** Connected, and not declared dead by its heartbeat. */
  private alive(s: DeviceSession): boolean {
    return s.client.isConnected && !this.liveness.get(s)?.dead;
  }

  /** A session died (heartbeat, or it closed and stayed closed): drop it, mark its
   * player unreachable with the reason, and start looking for it. */
  private lost(s: DeviceSession, why: string): void {
    const ids = [...this.sessions].filter(([, v]) => v === s).map(([k]) => k);
    for (const k of ids) this.sessions.delete(k);
    for (const [h, v] of [...this.dialed]) if (v === s) this.dialed.delete(h);
    const host = this.sessionHost.get(s);
    this.deaths.set(s, why);
    this.liveness.get(s)?.stop();
    this.liveness.delete(s);
    this.sessionHost.delete(s);
    s.close();
    const rec = ids.map((id) => this.registry.get(id)).find((r) => r !== undefined);
    if (!rec) return;
    const msg = `${why} (last at ${host ?? rec.host})`;
    if (rec.host === host || host === undefined) this.registry.markUnreachable(rec.id, msg);
    progress(`${rec.name}: session lost — ${msg}; looking for it`);
    this.log(`${rec.name}: session lost — ${msg}`);
    this.kickHunt(true);
  }

  /** Watch a fresh session: heartbeat, and a close that doesn't heal by itself. */
  private watchSession(s: DeviceSession, host: string, live: Liveness): void {
    this.liveness.set(s, live);
    this.sessionHost.set(s, host);
    const mac = (s.client.welcome?.mac ?? "").toUpperCase();
    const ev = s.client.events;
    const prevDown = ev.onDisconnected;
    const prevUp = ev.onConnected;
    let grace: ReturnType<typeof setTimeout> | null = null;
    ev.onDisconnected = () => {
      prevDown?.();
      if (grace || live.dead) return;
      const ms = this.opts.reconnectGraceMs ?? 10_000;
      grace = setTimeout(() => {
        grace = null;
        if (!s.client.isConnected) live.kill(`the connection closed and didn't come back within ${ms / 1000} s`);
      }, ms);
      grace.unref?.();
    };
    ev.onConnected = (w) => {
      prevUp?.(w);
      if (grace) clearTimeout(grace);
      grace = null;
      live.rx();
      // The reconnect reached whoever has that IP now: it must be the same player.
      if (mac && w.mac && w.mac.toUpperCase() !== mac) live.kill(`another player (${w.mac}) now answers at ${host}`);
    };
  }

  // -- the background search for lost players -------------------------------------------

  /** Players that stopped answering (by id), with no live session. */
  private lostPlayers(): PlayerRecord[] {
    return this.registry.list().filter((p) => p.checked === "unreachable" && isMacId(p.id) && !this.isConnected(p.id));
  }

  /** Start (or, with `now`, restart from the first, short delay) the search. */
  private kickHunt(now = false): void {
    const backoff = this.opts.huntBackoffMs ?? HUNT_BACKOFF_MS;
    if (this.closed || backoff.length === 0) return;
    if (now) {
      this.huntRound = 0;
      if (this.huntTimer) clearTimeout(this.huntTimer);
      this.huntTimer = null;
    }
    if (this.huntTimer || this.hunting || this.lostPlayers().length === 0) return;
    const delay = backoff[Math.min(this.huntRound, backoff.length - 1)]!;
    this.huntTimer = setTimeout(() => {
      this.huntTimer = null;
      this.hunting = this.hunt().finally(() => {
        this.hunting = null;
        this.huntRound++;
        this.kickHunt();
      });
    }, delay);
    this.huntTimer.unref?.();
  }

  /** One search round: mDNS for the lost players' ids, then a LAN sweep. */
  private async hunt(): Promise<void> {
    const lost = this.lostPlayers();
    if (lost.length === 0) return;
    try {
      const found = await this.registry.locate(
        lost.map((p) => p.id),
        { mdns: this.opts.mdns !== false },
      );
      for (const id of found) {
        const r = this.registry.get(id);
        if (r) this.log(`${r.name}: found again at ${r.host}`);
      }
      if (found.length === lost.length) this.huntRound = -1; // all back: next loss starts over
    } catch (e) {
      this.log(`player search failed: ${(e as Error).message}`);
    }
  }

  /** Session state for list_players: live (heard from recently), reconnecting, or none. */
  sessionState(id: string): { state: "live" | "reconnecting" | "none"; heard_s_ago?: number } {
    const s = this.sessions.get(id);
    if (!s) return { state: "none" };
    const live = this.liveness.get(s);
    if (live?.dead) return { state: "none" };
    if (!s.client.isConnected) return { state: "reconnecting" };
    return { state: "live", ...(live ? { heard_s_ago: Math.round(live.silentMs / 100) / 10 } : {}) };
  }

  /** Open a /ws session to `host` (hello/welcome), reporting progress. `fp` is
   * the certificate's SHA-256 (trust on first use). */
  private async dial(
    host: string,
    name: string,
    pin?: string,
    opts: { url?: string; features?: string[]; id?: string } = {},
  ): Promise<{ s: DeviceSession; w: WelcomeOf; fp?: string }> {
    const t0 = performance.now();
    const usePin = this.opts.pin ?? pin;
    progress(`connecting ${name === host ? host : `${name} (${host})`}…`);
    let fp: string | undefined;
    let sockErr: string | undefined;
    let live: Liveness | undefined;
    const connectTimeoutMs = this.opts.connectTimeoutMs ?? 8000; // a C6 handshake is ~1 s, 3 s at worst
    const s = new DeviceSession({
      url: opts.url ?? `wss://${host}/ws`,
      socketFactory: nodeSocketFactory(usePin ? { pinSha256: usePin } : {}, {
        onPeer: (x) => (fp = x),
        onError: (e) => (sockErr ??= e.message),
        onRx: () => live?.rx(),
      }),
      features: opts.features ?? [],
      ...(this.opts.streamHz ? { streamHz: this.opts.streamHz } : {}),
      connectTimeoutMs,
    });
    try {
      const w = await s.connect();
      progress(`${w.deviceName || name}: connected ${ms(t0)}${w.fwVersion ? ` (firmware ${w.fwVersion})` : ""}`);
      live = new Liveness((t) => s.client.ping(t), (why) => this.lost(s, why), this.opts.liveness);
      this.watchSession(s, host, live);
      return { s, w, ...(fp ? { fp } : {}) };
    } catch (e) {
      s.close();
      const took = performance.now() - t0;
      let why = sockErr ?? (e as Error).message;
      // Our own connect timeout closes the socket, which ws reports as "closed before
      // the connection was established" — say what actually happened.
      if (took >= connectTimeoutMs - 50 && /closed before the connection|connection failed/i.test(why)) {
        why = `no TLS/WebSocket handshake within ${connectTimeoutMs / 1000} s`;
      } else if (why === "connection failed") {
        why = "the connection closed during the TLS/WebSocket handshake";
      }
      const hint = /EHOSTUNREACH|ETIMEDOUT|ENETUNREACH|handshake within/.test(why) ? neighbourHint(host) : "";
      if (hint) why = `${why}; ${hint}`;
      if (/pin mismatch/.test(why) && !this.opts.pin && fp && pin) {
        // The player presented another certificate than the one remembered for it
        // (trust.ts): the legacy shared cert moving to a per-device one is expected
        // (re-pin silently, one redial); anything else is refused, with how to
        // re-trust after a factory reset.
        const id = opts.id ?? host;
        if (isMacId(id)) {
          // Another certificate at this player's last address may just be ANOTHER
          // player that got its IP (random-MAC firmware changes lease every boot):
          // its manifest says which device it is. That is "moved", not "changed".
          const other = await resolveTarget(host, { timeoutMs: 6000 }).catch(() => null);
          const oid = other?.manifest?.device?.id?.toUpperCase();
          if (oid && oid !== id) {
            throw new ToolError(`${name} (${id}) isn't at ${host} any more: ${elsewhere(other!.manifest!.device!.name, oid)} answers there now`);
          }
        }
        const v = decideTrust({ id, presented: fp, known: pin });
        if (v.kind === "legacy-repin") {
          progress(`${name}: now has its own TLS certificate (was the shared legacy one); re-pinned`);
          this.log(`${name}: now has its own TLS certificate (was the shared legacy one); re-pinned`);
          return this.dial(host, name, v.pin, opts);
        }
        this.registry.markTrust(id, v);
        const msg = trustError(name, id, v) ?? why;
        progress(`${name}: ${msg}`);
        throw new ToolError(msg);
      }
      progress(`${name}: failed after ${ms(t0)}: ${why}`);
      throw new ToolError(`can't reach ${name} at ${host}: ${why}`);
    }
  }

  private async open(p: PlayerRecord): Promise<DeviceSession> {
    // TOFU (trust.ts): a player whose certificate changed (or is intercepted) is
    // refused before any connection, with the reason and how to re-trust it.
    const refused = !this.opts.pin && p.trust ? trustError(p.name, p.id, p.trust) : null;
    if (refused) throw new ToolError(refused);
    const t = p.target;
    // Discovery may already hold this host's session (it identified the host by it).
    let s = this.dialed.get(p.host);
    this.dialed.delete(p.host);
    let fp: string | undefined;
    const isOther = (x: DeviceSession) => isMacId(p.id) && (x.client.welcome?.mac ?? "").toUpperCase() !== p.id;
    if (!s || !this.alive(s) || isOther(s)) {
      if (s) this.forgetSession(s);
      let d;
      try {
        d = await this.dial(p.host, p.name, t?.tls.pinSha256, {
          url: t?.wsUrl ?? `wss://${p.host}/ws`,
          features: p.manifest?.protocol?.features ?? [],
          id: p.id,
        });
        if (isOther(d.s)) {
          // Its address now belongs to another player (an IP reused): never run
          // this player's tool on that one.
          const w = d.s.client.welcome!;
          this.forgetSession(d.s);
          throw new ToolError(`${p.name} (${p.id}) isn't at ${p.host} any more: ${elsewhere(w.deviceName, w.mac.toUpperCase())} answers there now`);
        }
      } catch (e) {
        if (p.trust && !trusted(p.trust) && p.trust.kind !== "unverified") throw e; // refused: don't hunt for it
        if (!isMacId(p.id)) throw e;
        // A known player that stopped answering may just have a new lease (firmware
        // with a random Wi-Fi MAC per boot gets a new IP every reboot): find it by
        // id — its mDNS advert (TXT id), else a LAN sweep for its manifest. One
        // retry there.
        this.registry.markUnreachable(p.id, (e as Error).message);
        const moved = await this.registry.relocate(p.id, { mdns: this.opts.mdns !== false });
        if (!moved) {
          this.kickHunt(true);
          throw new ToolError(
            `${(e as Error).message}. Not found anywhere else either (mDNS + a sweep of the local /24s): is ` +
              `${p.name} powered and on this Wi-Fi? The bridge keeps looking in the background.`,
          );
        }
        const refusedMoved = !this.opts.pin && moved.trust ? trustError(moved.name, moved.id, moved.trust) : null;
        if (refusedMoved) throw new ToolError(refusedMoved);
        d = await this.dial(moved.host, moved.name, moved.target?.tls.pinSha256, {
          url: moved.target?.wsUrl ?? `wss://${moved.host}/ws`,
          id: moved.id,
        });
        p = moved;
      }
      s = d.s;
      fp = d.fp;
    }
    const w = s.welcome;
    const mismatch = checkSamePlayer(p.manifest, w);
    if (mismatch) this.log(`WARNING (${p.name}): ${mismatch}`);
    const rec = this.registry.identify(p.host, w, fp) ?? p;
    const refusedNow = !this.opts.pin && rec.trust ? trustError(rec.name, rec.id, rec.trust) : null;
    if (refusedNow) {
      this.forgetSession(s);
      throw new ToolError(refusedNow);
    }
    const dup = this.sessions.get(rec.id);
    if (dup && dup !== s) {
      if (this.alive(dup)) {
        // The same device reached by another host: keep the one socket.
        this.forgetSession(s);
        return dup;
      }
      // The old session is dead (the player moved): this one replaces it.
      for (const [k, v] of [...this.sessions]) if (v === dup) this.sessions.delete(k);
      this.forgetSession(dup);
    }
    // The version-matched compiler is picked (maybe fetched) on first compile:
    // brightness or uniforms don't need it, and a bad bundle mustn't block them.
    // The manifest (for the player's bundle URL) is read only when this bundle
    // doesn't cover the player's firmware.
    const fw = w.fwVersion || rec.fw;
    s.toolchainLoader = async () => {
      const choice = await this.toolchains.forPlayer(fw, rec.manifest, () => this.readManifest(rec));
      this.choice.set(rec.id, choice);
      if (choice.note) this.log(`${rec.name}: ${choice.note}`);
      return choice.toolchain;
    };
    this.sessions.set(rec.id, s);
    if (rec.id !== p.id && !isMacId(p.id)) this.sessions.set(p.id, s); // a `host:` placeholder's session
    return s;
  }

  /** Read (and remember) a player's discovery manifest, once something needs it. */
  private async readManifest(rec: PlayerRecord): Promise<Manifest | null> {
    if (rec.manifest) return rec.manifest;
    const pin = this.opts.pin ?? rec.target?.tls.pinSha256;
    const t = await resolveTarget(rec.host, { ...(pin ? { pin } : {}), timeoutMs: 8000 });
    if (t.manifest) this.registry.noteManifest(rec.id, t.manifest);
    return t.manifest;
  }

  /** Open every reachable player's session ahead of the first tool (the MCP
   * server does this after its background discovery, so the agent's first tool
   * call doesn't pay the TLS handshakes). Errors are left for the tools to report. */
  async warm(): Promise<void> {
    await this.ready();
    await Promise.all(
      this.registry
        .list()
        .filter((p) => p.checked !== "unreachable")
        .map((p) => this.session(p).catch(() => undefined)),
    );
  }

  /** A /ws session to this player is open (connected, and its heartbeat says alive). */
  isConnected(id: string): boolean {
    const s = this.sessions.get(id);
    return s !== undefined && this.alive(s);
  }

  /** Close a session and stop watching it (no "lost" handling). */
  private forgetSession(s: DeviceSession): void {
    this.liveness.get(s)?.stop();
    this.liveness.delete(s);
    this.sessionHost.delete(s);
    s.close();
  }

  /** This player's session if one was opened (connected or reconnecting), without dialing. */
  openSession(id: string): DeviceSession | undefined {
    return this.sessions.get(id);
  }

  /** Drop a session that stopped reconnecting (the player rebooted past its retry
   * budget, or moved) and dial it again; the live mux calls this for a player whose
   * socket has been down a while. The old session goes through forgetSession, so its
   * heartbeat stops too. Callers holding the old session see it closed. */
  async reopen(id: string): Promise<DeviceSession> {
    const old = this.sessions.get(id);
    for (const [k, v] of [...this.sessions]) if (v === old) this.sessions.delete(k);
    if (old) this.forgetSession(old);
    const p = this.registry.get(id);
    if (!p) throw new ToolError(`no player ${id}`);
    return this.session(p);
  }

  toolchainNote(id: string): string | undefined {
    return this.choice.get(id)?.note;
  }

  close(): void {
    this.closed = true;
    if (this.huntTimer) clearTimeout(this.huntTimer);
    this.huntTimer = null;
    for (const s of new Set([...this.sessions.values(), ...this.dialed.values()])) this.forgetSession(s);
    this.sessions.clear();
    this.dialed.clear();
  }

  /** Run `fn` on every selected player in parallel; one result per player. */
  async each<T>(sel: Selector, fn: (s: DeviceSession, p: PlayerRecord) => Promise<T>): Promise<PlayerResult<T>[]> {
    const targets = await this.select(sel);
    return Promise.all(
      targets.map(async (p) => {
        let s: DeviceSession | undefined;
        try {
          s = await this.session(p);
          const cur = this.registry.get(p.id) ?? [...this.registry.list()].find((r) => this.sessions.get(r.id) === s) ?? p;
          const live = this.liveness.get(s);
          const result = live ? await live.watch(fn(s, cur)) : await fn(s, cur);
          return { player: { id: cur.id, name: cur.name }, ok: true, result };
        } catch (e) {
          const cur = this.registry.get(p.id) ?? p;
          const error =
            s && this.deaths.has(s)
              ? `${cur.name} stopped answering during the call: ${this.deaths.get(s)}. It is marked unreachable and ` +
                `the bridge is looking for it (mDNS + LAN sweep); list_players shows where it is once found, then retry.`
              : (e as Error).message;
          return { player: { id: p.id, name: p.name }, ok: false, error };
        }
      }),
    );
  }

  // -- rooms -----------------------------------------------------------------------

  setGroup(name: string, ids: string[]): void {
    const clean = name.trim();
    if (!clean) throw new ToolError("a room name can't be empty");
    if (ids.length === 0) delete this.config.groups[clean];
    else this.config.groups[clean] = [...new Set(ids)];
    this.persistConfig();
  }

  /** The room a player belongs to (its first group), if any. */
  roomOf(id: string): string | undefined {
    return this.groupsOf(id)[0];
  }

  pose(id: string): Pose | undefined {
    return this.config.poses[id];
  }

  setPose(id: string, pose: Pose): void {
    this.config.poses[id] = pose;
    this.persistConfig();
  }

  // -- time base ----------------------------------------------------------------------

  /** The most recent room epoch alignTime gave any of `ids` (undefined: none).
   * Re-aligning with it keeps effects that already share it from jumping in time
   * (crossfade_to), while bringing the others onto it. */
  sharedEpoch(ids: string[]): number | undefined {
    let best: number | undefined;
    for (const id of ids) {
      const e = this.epochs.get(id);
      if (e !== undefined && (best === undefined || e > best)) best = e;
    }
    return best;
  }

  /**
   * One shared start for a canned ramp across the selected players
   * (docs/design/ramps.md): with two or more players that run ramps themselves,
   * re-sync any stale clock, then pick a hub time `leadMs` ahead; each player gets
   * it in its own clock (DeviceSession.deviceTime), so they start together and a
   * request that arrives late joins mid-way in step. Undefined for a single
   * player (it starts on receipt).
   */
  async rampStart(sel: Selector, leadMs = 200): Promise<number | undefined> {
    const synced = await this.each(sel, async (s) => {
      if (!s.rampsUsable()) return false;
      if (!s.clock || performance.now() - s.clock.at >= RESYNC_MS) await s.syncClock();
      return true;
    });
    if (synced.filter((r) => r.ok && r.result).length < 2) return undefined;
    return performance.now() + leadMs;
  }

  /**
   * Give every selected player the same effect-clock epoch ("now", unless an
   * epoch on the hub clock is passed): sync clocks (re-using a fresh sync), then
   * SetTimeBase on the players that support it. Reports the skew bound and who
   * couldn't take it.
   */
  async alignTime(sel: Selector, hubEpochMs = performance.now()): Promise<Record<string, unknown>> {
    const syncs = new Map<string, ClockSync>();
    const per = await this.each(sel, async (s, p) => {
      const c = s.clock && performance.now() - s.clock.at < RESYNC_MS ? s.clock : await s.syncClock();
      syncs.set(p.id, c);
      return c;
    });
    const epochs = deviceEpochs(hubEpochMs, syncs);
    const applied = await this.each(sel, async (s, p) => {
      const e = epochs.get(p.id);
      return e === undefined ? false : s.setTimeBase(e);
    });
    for (const r of applied) if (r.ok && r.result === true) this.epochs.set(r.player.id, hubEpochMs);
    const unsupported = applied.filter((r) => r.ok && r.result === false).map((r) => r.player.name);
    return {
      players: per.map((r) => ({
        ...r.player,
        ok: r.ok,
        ...(r.ok ? { offset_ms: +r.result!.offsetMs.toFixed(1), rtt_ms: +r.result!.rttMs.toFixed(1) } : { error: r.error }),
      })),
      time_base: unsupported.length === 0 ? "applied" : unsupported.length === applied.length ? "unsupported" : "partial",
      skew_bound_ms: +skewBoundMs(syncs.values()).toFixed(1),
      ...(unsupported.length
        ? {
            note:
              `time base unsupported on ${unsupported.join(", ")} (firmware lacks the time_base feature): their ` +
              "effects run on their own clocks and won't stay in phase across fixtures",
          }
        : {}),
    };
  }
}

const elsewhere = (name: string | undefined, id: string) => (name ? `${name} (${id})` : id);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function uniquePrefix(all: PlayerRecord[], key: string): PlayerRecord | undefined {
  const k = key.toLowerCase();
  const hits = all.filter((p) => p.name.toLowerCase().startsWith(k) || p.name.toLowerCase().endsWith(k));
  return hits.length === 1 ? hits[0] : undefined;
}

/** Collapse per-player results for a single implicit target into the legacy flat
 * shape (one player, no selector), else keep the per-player list. */
export function shape<T>(results: PlayerResult<T>[], explicit: boolean): unknown {
  if (!explicit && results.length === 1) {
    const r = results[0]!;
    if (!r.ok) throw new ToolError(r.error ?? "failed");
    return r.result;
  }
  const failed = results.filter((r) => !r.ok).length;
  return {
    results,
    summary: failed === 0 ? `ok on all ${results.length}` : `${results.length - failed} ok, ${failed} failed`,
  };
}
