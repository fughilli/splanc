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
import { ms, progress } from "./progress";
import { Registry, type PlayerRecord, type RefreshOptions, type RegistryDeps } from "./registry";
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
}

export class Hub {
  readonly config: HubConfig;
  readonly registry: Registry;
  readonly toolchains: Toolchains;
  private readonly sessions = new Map<string, DeviceSession>();
  private readonly connecting = new Map<string, Promise<DeviceSession>>();
  /** Sessions opened by discovery (identifying a host), by host, until a tool adopts them. */
  private readonly dialed = new Map<string, DeviceSession>();
  private readonly choice = new Map<string, ToolchainChoice>();
  private refreshed: Promise<unknown> | null = null;
  private readonly log: (...a: unknown[]) => void;

  constructor(private readonly opts: HubOptions) {
    this.config = opts.config ?? loadConfig();
    const persist = opts.persist ?? ((c: HubConfig) => void saveConfig(c));
    this.registry = new Registry(opts.hosts ?? [], this.config, () => persist(this.config), {
      // An unknown host is identified by opening its session (one TLS handshake,
      // kept for the tool that needs it) rather than by a separate manifest GET.
      identify: async (host, pin) => {
        const { s, w, fp } = await this.dial(host, host, pin);
        this.dialed.get(host)?.close();
        // TOFU by device id: a session whose certificate isn't the one remembered
        // for its MAC is not kept (the registry records the verdict; the tool
        // that wants it is refused with the explanation).
        const id = (w.mac || "").toUpperCase();
        const v = this.opts.pin ? null : decideTrust({ id, presented: fp, known: this.config.players[id]?.pin });
        if (v && !trusted(v) && v.kind !== "unverified") s.close();
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
    const live = new Set([...this.sessions].map(([id]) => this.registry.get(id)?.host ?? ""));
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
    return this.registry.list();
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
      const groups = Object.entries(this.config.groups).filter(([, ids]) => ids.length > 0);
      const grouped = new Set(groups.flatMap(([, ids]) => ids));
      if (groups.length === 0 || (groups.length === 1 && all.every((p) => grouped.has(p.id)))) return all;
      throw new ToolError(
        `there are ${all.length} players in ${groups.length} rooms (${groups.map(([g]) => g).join(", ")}): pass ` +
          `players: a room, a player name, or "all"`,
      );
    }
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
    if (have) return have;
    let c = this.connecting.get(p.id);
    if (!c) {
      c = this.open(p);
      this.connecting.set(p.id, c);
      c.finally(() => this.connecting.delete(p.id)).catch(() => undefined);
    }
    return c;
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
    const s = new DeviceSession({
      url: opts.url ?? `wss://${host}/ws`,
      socketFactory: nodeSocketFactory(usePin ? { pinSha256: usePin } : {}, {
        onPeer: (x) => (fp = x),
        onError: (e) => (sockErr ??= e.message),
      }),
      features: opts.features ?? [],
      ...(this.opts.streamHz ? { streamHz: this.opts.streamHz } : {}),
      connectTimeoutMs: this.opts.connectTimeoutMs ?? 8000, // a C6 handshake is ~1 s, 3 s at worst
    });
    try {
      const w = await s.connect();
      progress(`${w.deviceName || name}: connected ${ms(t0)}${w.fwVersion ? ` (firmware ${w.fwVersion})` : ""}`);
      return { s, w, ...(fp ? { fp } : {}) };
    } catch (e) {
      s.close();
      const why = sockErr ?? (e as Error).message;
      if (/pin mismatch/.test(why) && !this.opts.pin && fp && pin) {
        // The player presented another certificate than the one remembered for it
        // (trust.ts): the legacy shared cert moving to a per-device one is expected
        // (re-pin silently, one redial); anything else is refused, with how to
        // re-trust after a factory reset.
        const id = opts.id ?? host;
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
    if (!s?.client.isConnected) {
      s?.close();
      let d;
      try {
        d = await this.dial(p.host, p.name, t?.tls.pinSha256, {
          url: t?.wsUrl ?? `wss://${p.host}/ws`,
          features: p.manifest?.protocol?.features ?? [],
          id: p.id,
        });
      } catch (e) {
        if (p.trust && !trusted(p.trust) && p.trust.kind !== "unverified") throw e; // refused: don't hunt for it
        // A remembered player that stopped answering may just have a new lease:
        // its mDNS advert (TXT id) says where it went. One retry there.
        const remembered = !p.sources.includes("host") && /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(p.id);
        const moved = remembered && this.opts.mdns !== false ? await this.registry.relocate(p.id) : undefined;
        if (!moved) throw e;
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
      s.close();
      throw new ToolError(refusedNow);
    }
    const dup = this.sessions.get(rec.id);
    if (dup) {
      // The same device reached by another host: keep the one socket.
      s.close();
      return dup;
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
    if (rec.id !== p.id) this.sessions.set(p.id, s);
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

  /** A /ws session to this player is open. */
  isConnected(id: string): boolean {
    return this.sessions.has(id);
  }

  toolchainNote(id: string): string | undefined {
    return this.choice.get(id)?.note;
  }

  close(): void {
    for (const s of new Set([...this.sessions.values(), ...this.dialed.values()])) s.close();
    this.sessions.clear();
    this.dialed.clear();
  }

  /** Run `fn` on every selected player in parallel; one result per player. */
  async each<T>(sel: Selector, fn: (s: DeviceSession, p: PlayerRecord) => Promise<T>): Promise<PlayerResult<T>[]> {
    const targets = await this.select(sel);
    return Promise.all(
      targets.map(async (p) => {
        try {
          const s = await this.session(p);
          const cur = this.registry.get(p.id) ?? [...this.registry.list()].find((r) => this.sessions.get(r.id) === s) ?? p;
          return { player: { id: cur.id, name: cur.name }, ok: true, result: await fn(s, cur) };
        } catch (e) {
          return { player: { id: p.id, name: p.name }, ok: false, error: (e as Error).message };
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
