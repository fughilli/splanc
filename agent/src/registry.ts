/**
 * The hub's live set of players (docs/design/agent-multi-fixture.md §1). Sources,
 * merged by player id (the MAC):
 *
 * - explicit hosts (`--host`, repeatable, or the add_player tool);
 * - players remembered from earlier runs (hub config);
 * - mDNS `_splanc._tcp` adverts (TXT id/name/fw name a player with no round trip);
 * - a bounded sweep of the local /24s for `GET /.well-known/splanc.json`, for
 *   networks that drop multicast: on request, or automatically when nothing else
 *   finds a player. 254 hosts per subnet, at most two subnets, a short TCP probe
 *   on :443 first, so it finishes in a couple of seconds and touches only hosts
 *   that serve TLS.
 *
 * Fast by default (every TLS handshake costs the ESP32 ~0.7 s of ECDHE, and it
 * serves one at a time): a remembered player is taken from the cache after a
 * bare TCP check — no TLS until a tool needs its session; an unknown explicit host
 * is identified by opening its /ws session ({@link RegistryDeps.identify}, which
 * the hub keeps for the tool) instead of a separate manifest GET; mDNS is skipped
 * when hosts are given, and otherwise runs alongside, returning as soon as answers
 * stop arriving. `fresh` (refresh_players) re-reads every reachable player's
 * manifest the slow, thorough way.
 */

import net from "node:net";
import { networkInterfaces } from "node:os";

import type { HubConfig, RememberedPlayer } from "./config";
import {
  advertHost,
  browse,
  knownTarget,
  resolveTarget,
  type Advert,
  type BrowseOptions,
  type Manifest,
  type ResolveOptions,
  type Target,
} from "./discovery";
import { ms, progress } from "./progress";
import { decideTrust, trusted, type TrustVerdict } from "./trust";

export type Source = "host" | "remembered" | "mdns" | "sweep";

export interface PlayerRecord {
  /** The player's MAC (upper case), or `host:<host>` until a Welcome names it. */
  id: string;
  name: string;
  host: string;
  fw?: string;
  manifest: Manifest | null;
  manifestError?: string;
  target: Target | null;
  sources: Source[];
  lastSeen: number;
  /** How this run last confirmed the player: its /ws session, its manifest, a TCP
   * answer on :443 (identity from the cache), an mDNS advert, not yet (cached:
   * taken from the cache for a tool whose session will confirm it), or not at all. */
  checked?: "session" | "manifest" | "tcp" | "mdns" | "cached" | "unreachable";
  /** The TOFU decision on its certificate (trust.ts), once a connection showed one.
   * A "changed"/"mismatch" verdict makes the hub refuse the player. */
  trust?: TrustVerdict;
}

/** What a probe learned about the player at a host. */
export interface Identity {
  id: string;
  name: string;
  fw?: string;
  /** SHA-256 of its TLS certificate (trust on first use). */
  pin?: string;
}

export interface RegistryDeps {
  browse?: (ms: number, opts?: BrowseOptions) => Promise<Advert[]>;
  resolve?: (host: string, opts: ResolveOptions) => Promise<Target>;
  /** Identify an unknown host by opening its session (the hub keeps the session).
   * Without it, unknown hosts are identified by their manifest. */
  identify?: (host: string, pin?: string) => Promise<Identity>;
  /** Hosts to sweep instead of the local /24s (tests). */
  sweepHosts?: () => string[];
  probePort?: (host: string, port: number, ms: number) => Promise<boolean>;
}

export interface RefreshOptions {
  mdns?: boolean;
  /** The longest mDNS listens (it returns early once answers stop). */
  mdnsMs?: number;
  /** "auto" sweeps only when nothing else found a player. */
  sweep?: "auto" | "on" | "off";
  /** Re-read every reachable player's manifest and browse mDNS even with hosts
   * given (refresh_players), instead of trusting the cache. */
  fresh?: boolean;
  /** For a device tool: take remembered players from the cache with no network
   * at all (the tool's session is the check — a TCP probe right before it would
   * only delay it, and can cost the session's SYN a 1 s retransmit while the
   * player's listener re-arms), and skip mDNS when any are remembered. */
  lazy?: boolean;
}

/** TCP answer on :443 within this, or the player is taken as gone. */
const REACH_MS = 1500;

export class Registry {
  private readonly players = new Map<string, PlayerRecord>();
  private readonly explicit: string[];
  /** Hosts whose mDNS advert says tls=generating (a first-boot player still
   * generating its key + certificate): their manifest read waits for it. */
  private readonly generating = new Set<string>();

  constructor(
    hosts: string[],
    private readonly config: HubConfig,
    private readonly persist: () => void,
    private readonly deps: RegistryDeps = {},
  ) {
    this.explicit = [...hosts];
  }

  list(): PlayerRecord[] {
    return [...this.players.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  get(id: string): PlayerRecord | undefined {
    return this.players.get(id);
  }

  /** Insert a known record without probing (a pre-connected session). */
  put(rec: PlayerRecord): void {
    this.players.set(rec.id, rec);
  }

  addHost(host: string): void {
    if (!this.explicit.includes(host)) this.explicit.push(host);
  }

  get hasExplicitHosts(): boolean {
    return this.explicit.length > 0;
  }

  /** Re-discover. Hosts in `live` (connected sessions) are not re-probed — the
   * device has two TLS slots, and its session already holds one. */
  async refresh(opts: RefreshOptions = {}, live: Set<string> = new Set()): Promise<PlayerRecord[]> {
    const t0 = performance.now();
    const candidates = new Map<string, Source>();
    for (const h of this.explicit) candidates.set(h, "host");
    for (const r of Object.values(this.config.players)) if (!candidates.has(r.host)) candidates.set(r.host, "remembered");
    const lazy = opts.lazy === true && opts.fresh !== true;
    const cached = [...candidates.keys()].some((h) => this.rememberedByHost(h));
    const useMdns =
      opts.mdns !== false && (opts.fresh === true || (this.explicit.length === 0 && !(lazy && cached)));
    const sweep = opts.sweep ?? "auto";
    const todo = [...candidates].filter(([h]) => !live.has(h));
    const sweepNow = sweep === "on" || (sweep === "auto" && candidates.size === 0 && live.size === 0);
    // A lazy pass over remembered players only touches no network: say nothing.
    const silent = lazy && !useMdns && !sweepNow && todo.every(([h]) => this.rememberedByHost(h));
    if (!silent) progress(
      todo.length === 0 && !useMdns && !sweepNow
        ? "players: none to check"
        : `discovering (${[
            todo.length ? `${todo.length} known` : "",
            useMdns ? "mDNS" : "",
            sweepNow ? "LAN sweep" : "",
          ]
            .filter(Boolean)
            .join(" + ")})…`,
    );

    const handled = new Set<string>([...live]);
    const work: Promise<void>[] = [];
    let allKnownUp = true;
    const handle = (host: string, source: Source, advert?: Advert) => {
      if (advert?.txt["tls"] === "generating") this.generating.add(host);
      if (handled.has(host)) {
        if (advert) this.noteAdvert(host, advert);
        return;
      }
      handled.add(host);
      work.push(
        this.probe(host, source, advert, opts.fresh === true, lazy).then(
          (up) => {
            if (!up && source !== "mdns") allKnownUp = false;
          },
          () => undefined,
        ),
      );
    };
    for (const [h, s] of todo) handle(h, s);

    // mDNS alongside the known players: stop listening once answers dry up, or —
    // when every known player already answered — shortly after they did.
    const mdnsCtl = new AbortController();
    const mdnsDone = useMdns
      ? (this.deps.browse ?? browse)(opts.mdnsMs ?? 1500, {
          signal: mdnsCtl.signal,
          onAdvert: (a) => handle(advertHost(a), "mdns", a),
        })
          .catch(() => [] as Advert[])
          .then((ads) => {
            for (const a of ads) handle(advertHost(a), "mdns", a);
            return ads;
          })
      : Promise.resolve([] as Advert[]);
    if (useMdns && todo.length > 0) {
      void Promise.all(work.slice()).then(() => {
        if (allKnownUp) setTimeout(() => mdnsCtl.abort(), 300).unref();
      });
    }

    const sweepCtl = new AbortController();
    let swept: Promise<void> = Promise.resolve();
    if (sweepNow) {
      swept = this.sweep(candidates, sweepCtl.signal);
      // In auto mode an mDNS answer makes the sweep moot: stop probing (whatever
      // it already found is kept).
      if (sweep === "auto") void mdnsDone.then((ads) => ads.length > 0 && sweepCtl.abort());
    }
    const ads = await mdnsDone;
    // Adverts may have queued probes after the first snapshot of `work`.
    for (let n = 0; n !== work.length; ) {
      n = work.length;
      await Promise.all(work.slice());
    }
    await swept;
    if (sweep === "auto" && !sweepNow && this.players.size === 0 && ads.length === 0) {
      progress("nothing answered: sweeping the LAN…");
      await this.sweep(candidates, new AbortController().signal);
    }
    this.remember();
    const found = this.list().filter((p) => p.checked !== "unreachable");
    if (!silent) progress(`found ${found.length} player${found.length === 1 ? "" : "s"} (${ms(t0)})`);
    return this.list();
  }

  /** Check one host; true when it answered. */
  private async probe(
    host: string,
    source: Source,
    advert: Advert | undefined,
    fresh: boolean,
    lazy = false,
  ): Promise<boolean> {
    const rem = this.rememberedByHost(host);
    const pin = rem?.[1].pin;
    if (lazy && rem && !advert) {
      this.upsertIdentity(host, { id: rem[0], name: rem[1].name ?? host, ...(rem[1].fw ? { fw: rem[1].fw } : {}) }, source, rem[1], "cached");
      return true;
    }
    if (fresh) {
      const t = await (this.deps.resolve ?? resolveTarget)(host, this.resolveOpts(host, 6000));
      if (!t.reachable && source !== "host") return false; // gone: keep only what was asked for explicitly
      this.upsert(host, t, source, t.manifest ? "manifest" : t.reachable ? "tcp" : "unreachable");
      return t.reachable;
    }
    const txtId = advert?.txt["id"];
    if (advert && txtId) {
      // The advert names the player: nothing to ask it.
      const r = this.upsertIdentity(host, { id: txtId, name: advert.txt["name"] ?? rem?.[1].name ?? host, ...(advert.txt["fw"] ? { fw: advert.txt["fw"] } : {}) }, source, rem?.[1], "mdns");
      progress(`mDNS: ${r.name} (${host})`);
      return true;
    }
    const [h, port] = splitHost(host);
    const t0 = performance.now();
    // For a tool, an unknown explicit host goes straight to its session (which
    // fails fast enough on a dead host); the TCP probe is for listings.
    const skipProbe = lazy && source === "host" && !rem && this.deps.identify !== undefined;
    if (!skipProbe && !(await (this.deps.probePort ?? probePort)(h, port, REACH_MS))) {
      if (source === "host") {
        this.upsert(host, { ...knownTarget(host, { ...(pin ? { pin } : {}), reachable: false }), manifestError: "no answer on :443" }, source, "unreachable");
        progress(`${rem?.[1].name ?? host}: no answer (${ms(t0)})`);
      } else {
        // Gone (or moved): drop a cache-only record a lazy pass put in.
        const stale = this.byHost(host);
        if (stale?.checked === "cached") this.players.delete(stale.id);
      }
      return false;
    }
    if (rem) {
      // Known: identity, pin and manifest from the cache; the session (if a tool
      // needs one) confirms it — a Welcome with another MAC re-keys the record.
      this.upsertIdentity(host, { id: rem[0], name: rem[1].name ?? host, ...(rem[1].fw ? { fw: rem[1].fw } : {}) }, source, rem[1], "tcp");
      return true;
    }
    if (this.deps.identify) {
      try {
        const who = await this.deps.identify(host, pin);
        this.upsertIdentity(host, who, source, undefined, "session");
        return true;
      } catch (e) {
        if (source === "host" || source === "mdns") {
          const rec = this.upsert(host, { ...knownTarget(host, { reachable: false }), manifestError: (e as Error).message }, source, "unreachable");
          progress(`${rec.name}: ${(e as Error).message}`);
        }
        return false;
      }
    }
    const t = await (this.deps.resolve ?? resolveTarget)(host, this.resolveOpts(host, 6000));
    if (!t.reachable && source !== "host") return false;
    this.upsert(host, t, source, t.manifest ? "manifest" : t.reachable ? "tcp" : "unreachable");
    return t.reachable;
  }

  /** Manifest-read options: the pin is looked up by the DEVICE ID the manifest names
   * (TOFU, trust.ts) — never by host, since an IP can move to another device. */
  private resolveOpts(host: string, timeoutMs: number): ResolveOptions {
    return {
      timeoutMs,
      knownPin: (id) => this.config.players[id]?.pin,
      ...(this.generating.has(host) ? { waitGeneratingMs: 30000 } : {}),
    };
  }

  /** Judge a certificate a session presented for device `id` against the pin
   * remembered for that id (trust.ts). */
  private judge(id: string, presented: string | undefined): TrustVerdict {
    return decideTrust({ id, presented, known: this.config.players[id]?.pin });
  }

  /** Record a trust verdict found outside discovery (the hub's session dial). */
  markTrust(id: string, v: TrustVerdict): void {
    const rec = this.players.get(id);
    if (rec) rec.trust = v;
  }

  /** The /24 sweep: TCP :443 first (wide, short timeout), then the manifest of
   * each host that answered; only manifest-serving hosts count. */
  private async sweep(skip: Map<string, Source>, signal: AbortSignal): Promise<void> {
    const t0 = performance.now();
    const hosts = (this.deps.sweepHosts ?? localSweepHosts)().filter((h) => !skip.has(h) && !this.byHost(h));
    const open: string[] = [];
    await pool(
      hosts,
      128,
      async (h) => {
        const [host, port] = splitHost(h);
        if (await (this.deps.probePort ?? probePort)(host, port, 350)) open.push(h);
      },
      signal,
    );
    await pool(open, 16, async (host) => {
      if (this.byHost(host)) return;
      const t = await (this.deps.resolve ?? resolveTarget)(host, this.resolveOpts(host, 2500));
      if (!t.manifest) return;
      const r = this.upsert(host, t, "sweep", "manifest");
      progress(`sweep: ${r.name} (${host})`);
    });
    progress(`LAN sweep: ${hosts.length} hosts, ${open.length} serve :443 (${ms(t0)})`);
  }

  private rememberedByHost(host: string): [string, RememberedPlayer] | undefined {
    return Object.entries(this.config.players).find(([, p]) => p.host === host);
  }

  /** An mDNS advert for a host already handled: add the source, refresh the name. */
  private noteAdvert(host: string, a: Advert): void {
    const rec = this.byHost(host);
    if (!rec) return;
    if (!rec.sources.includes("mdns")) rec.sources.push("mdns");
    if (a.txt["name"] && rec.checked !== "session") rec.name = a.txt["name"];
  }

  private upsertIdentity(
    host: string,
    who: Identity,
    source: Source,
    rem: RememberedPlayer | undefined,
    checked: NonNullable<PlayerRecord["checked"]>,
  ): PlayerRecord {
    const id = who.id.toUpperCase();
    const prevHost = this.byHost(host);
    if (prevHost && prevHost.id !== id) this.players.delete(prevHost.id);
    const prev = this.players.get(id);
    const manifest = prev?.manifest ?? rem?.manifest ?? this.config.players[id]?.manifest ?? null;
    // A session's certificate is judged against the pin remembered for THIS id: a
    // different one (factory reset / impostor) never replaces it.
    const trust = who.pin ? this.judge(id, who.pin) : prev?.trust;
    const pin = trust && !trusted(trust) ? this.config.players[id]?.pin : (who.pin ?? rem?.pin ?? this.config.players[id]?.pin);
    const rec: PlayerRecord = {
      id,
      name: who.name || prev?.name || host,
      host,
      ...(who.fw ? { fw: who.fw } : prev?.fw ? { fw: prev.fw } : {}),
      manifest,
      target: knownTarget(host, { ...(pin ? { pin } : {}), manifest }),
      sources: [...new Set([...(prev?.sources ?? []), ...(prevHost?.sources ?? []), source])],
      lastSeen: Date.now(),
      checked,
      ...(trust ? { trust } : {}),
    };
    this.players.set(id, rec);
    return rec;
  }

  private upsert(host: string, t: Target, source: Source, checked: NonNullable<PlayerRecord["checked"]>): PlayerRecord {
    const mid = t.manifest?.device?.id?.toUpperCase();
    const remembered = this.rememberedByHost(host);
    const id = mid ?? this.byHost(host)?.id ?? remembered?.[0] ?? `host:${host}`;
    const prev = this.players.get(id) ?? this.byHost(host);
    if (prev && prev.id !== id) this.players.delete(prev.id);
    const rec: PlayerRecord = {
      id,
      name: t.manifest?.device?.name ?? prev?.name ?? remembered?.[1].name ?? host,
      host,
      ...(t.manifest?.firmware?.version
        ? { fw: t.manifest.firmware.version }
        : prev?.fw
          ? { fw: prev.fw }
          : remembered?.[1].fw
            ? { fw: remembered[1].fw }
            : {}),
      manifest: t.manifest ?? prev?.manifest ?? remembered?.[1].manifest ?? null,
      ...(t.manifestError ? { manifestError: t.manifestError } : {}),
      target: t,
      sources: [...new Set([...(prev?.sources ?? []), source])],
      lastSeen: t.reachable ? Date.now() : (prev?.lastSeen ?? 0),
      checked,
      ...(t.trust ? { trust: t.trust } : prev?.trust ? { trust: prev.trust } : {}),
    };
    this.players.set(id, rec);
    return rec;
  }

  private byHost(host: string): PlayerRecord | undefined {
    return [...this.players.values()].find((p) => p.host === host);
  }

  /** A /ws session reached `host` and its Welcome named it: key the record by
   * MAC, folding duplicates (the same player reached by two hosts). Returns the
   * surviving record. `pin` is the session's certificate (trust on first use). */
  identify(host: string, w: { mac: string; deviceName: string; fwVersion: string }, pin?: string): PlayerRecord | undefined {
    const rec = this.byHost(host);
    if (!rec || !w.mac) return rec;
    const id = w.mac.toUpperCase();
    rec.checked = "session";
    if (pin) {
      const v = this.judge(id, pin);
      rec.trust = v;
      // Trusted (first sight / known / legacy re-pin): pin to what it presented.
      if (trusted(v) && rec.target) rec.target = { ...rec.target, tls: { pinSha256: v.pin } };
    }
    const dup = this.players.get(id);
    if (dup && dup !== rec) {
      // Keep the record that was asked for explicitly / found live; merge sources.
      dup.sources = [...new Set([...dup.sources, ...rec.sources])];
      this.players.delete(rec.id);
      return dup;
    }
    this.players.delete(rec.id);
    rec.id = id;
    rec.name = w.deviceName || rec.name;
    if (w.fwVersion) rec.fw = w.fwVersion;
    rec.lastSeen = Date.now();
    this.players.set(id, rec);
    this.remember();
    return rec;
  }

  /** A remembered player didn't answer at its last host (a new DHCP lease?): look
   * for its mDNS advert (TXT id = its MAC) and move the record there. Returns the
   * moved record, or undefined when mDNS doesn't see it. */
  async relocate(id: string, mdnsMs = 1500): Promise<PlayerRecord | undefined> {
    const rec = this.players.get(id);
    if (!rec) return undefined;
    const ctl = new AbortController();
    let hit: Advert | undefined;
    await (this.deps.browse ?? browse)(mdnsMs, {
      signal: ctl.signal,
      onAdvert: (a) => {
        if (a.txt["id"]?.toUpperCase() === id) {
          hit = a;
          ctl.abort();
        }
      },
    }).catch(() => []);
    if (!hit) return undefined;
    const host = advertHost(hit);
    if (host === rec.host) return undefined;
    progress(`${rec.name} moved: ${rec.host} -> ${host} (mDNS)`);
    rec.host = host;
    rec.target = knownTarget(host, { ...(rec.target?.tls.pinSha256 ? { pin: rec.target.tls.pinSha256 } : {}), manifest: rec.manifest });
    if (!rec.sources.includes("mdns")) rec.sources.push("mdns");
    this.remember();
    return rec;
  }

  /** Keep a manifest read later (a toolchain lookup), so it isn't read again. */
  noteManifest(id: string, manifest: Manifest): void {
    const rec = this.players.get(id);
    if (rec) rec.manifest = manifest;
    this.remember();
  }

  private remember(): void {
    let changed = false;
    for (const p of this.players.values()) {
      if (p.id.startsWith("host:")) continue;
      const old = this.config.players[p.id];
      // Only a trusted verdict moves the remembered pin; a changed/mismatched
      // certificate never overwrites it (trust_player does, on the user's word).
      const pin = p.trust && !trusted(p.trust) ? old?.pin : p.target?.tls.pinSha256;
      const manifest = p.manifest ?? old?.manifest;
      const next: RememberedPlayer = {
        host: p.host,
        name: p.name,
        ...(p.fw ? { fw: p.fw } : {}),
        ...(pin ? { pin } : {}),
        lastSeen: new Date(p.lastSeen || Date.now()).toISOString(),
        ...(manifest ? { manifest } : {}),
      };
      if (
        !old ||
        old.host !== next.host ||
        old.name !== next.name ||
        old.fw !== next.fw ||
        old.pin !== next.pin ||
        (!!next.manifest && JSON.stringify(old.manifest) !== JSON.stringify(next.manifest))
      ) {
        this.config.players[p.id] = next;
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  /** Re-trust a player whose certificate changed (the user confirmed a factory
   * reset): accept the certificate it presents now. Returns the new pin, or null
   * when there is nothing to re-trust. */
  retrust(id: string): string | null {
    const rec = this.players.get(id);
    if (!rec?.trust || rec.trust.kind !== "changed") return null;
    const pin = rec.trust.presented;
    rec.trust = { kind: "known", pin };
    if (rec.target) rec.target = { ...rec.target, tls: { pinSha256: pin } };
    const old = this.config.players[id];
    this.config.players[id] = { ...(old ?? { host: rec.host }), pin };
    this.persist();
    return pin;
  }

  forget(id: string): boolean {
    const had = this.players.delete(id) || id in this.config.players;
    delete this.config.players[id];
    this.persist();
    return had;
  }
}

export function splitHost(h: string): [string, number] {
  const m = /^(.*):(\d+)$/.exec(h);
  return m && !m[1]!.includes(":") ? [m[1]!, Number(m[2])] : [h, 443];
}

/** Interfaces that are never the players' LAN: VPN / overlay tunnels (Tailscale,
 * WireGuard, macOS utun, ZeroTier, PPP). */
const TUNNEL_IFACE = /^(tailscale|utun|tun|tap|wg|zt|ppp|ipsec)/i;

type Iface = { address: string; netmask: string; family: string | number; internal: boolean };

const ipv4 = (a: string): number => a.split(".").reduce((n, o) => n * 256 + (Number(o) & 255), 0);
const dotted = (n: number): string => [24, 16, 8, 0].map((b) => (n >>> b) & 255).join(".");

/**
 * Every host of this machine's local IPv4 LANs (at most two), excluding its own addresses:
 * the interface's subnet when it is a /24 or smaller, else the /24 around the
 * address. Only on-link LANs: tunnels, Tailscale's CGNAT range (100.64.0.0/10)
 * and point-to-point /31-/32 addresses are skipped. Sweeping the /24 "around" a
 * Tailscale /32 sent 254 SYNs into the tailnet, after which EVERY new outbound TCP
 * connection on the machine went unanswered for ~70 s (the bridge's relay
 * reconnects, and any client on it: SYN backoff made it a 134 s list_players).
 */
export function localSweepHosts(ifaces: NodeJS.Dict<Iface[]> = networkInterfaces()): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const mine = new Set(Object.values(ifaces).flatMap((as) => (as ?? []).map((a) => a.address)));
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (TUNNEL_IFACE.test(name)) continue;
    for (const a of addrs ?? []) {
      if ((a.family !== "IPv4" && a.family !== 4) || a.internal) continue;
      const ip = ipv4(a.address);
      if (ip >>> 22 === ipv4("100.64.0.0") >>> 22) continue; // 100.64.0.0/10: CGNAT / Tailscale
      const mask = ipv4(a.netmask);
      const prefix = Math.clz32(~mask); // leading one bits (a contiguous netmask)
      if (prefix >= 31) continue; // point-to-point: no neighbours to find
      const net = prefix >= 24 ? (ip & mask) >>> 0 : (ip & 0xffffff00) >>> 0;
      const size = prefix >= 24 ? 2 ** (32 - prefix) : 256;
      const key = `${dotted(net)}/${size}`;
      if (seen.has(key) || seen.size >= 2) continue;
      seen.add(key);
      for (let i = 1; i < size - 1; i++) {
        const h = dotted(net + i);
        if (!mine.has(h)) out.push(h);
      }
    }
  }
  return out;
}

/**
 * Does `host:port` accept a TCP connection within `ms`? Closed gracefully (FIN,
 * then wait for the peer's close) rather than reset: the player's single listener
 * must be back in LISTEN before the session's SYN arrives, or that SYN is dropped
 * and costs a 1 s retransmit.
 */
export function probePort(host: string, port: number, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    let up = false;
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      s.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(up), ms);
    s.once("connect", () => {
      up = true;
      s.end();
      // The peer's FIN (or a short grace) ends the probe.
      setTimeout(() => done(true), 150).unref();
    });
    s.on("data", () => undefined);
    s.once("close", () => done(up));
    s.once("error", () => done(up));
  });
}

/** Run `fn` over `items`, at most `width` at a time (stops taking new items on `signal`). */
export async function pool<T>(items: T[], width: number, fn: (t: T) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length && !signal?.aborted) {
      const t = items[i++]!;
      await fn(t).catch(() => undefined);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
}
