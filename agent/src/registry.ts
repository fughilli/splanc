/**
 * The hub's live set of players (docs/design/agent-multi-fixture.md §1). Sources,
 * merged by player id (the MAC):
 *
 * - explicit hosts (`--host`, repeatable, or the add_player tool);
 * - players remembered from earlier runs (hub config);
 * - mDNS `_splanc._tcp` adverts;
 * - a bounded sweep of the local /24s for `GET /.well-known/splanc.json`, for
 *   networks that drop multicast: on request, or automatically when nothing else
 *   finds a player. 254 hosts per subnet, at most two subnets, a short TCP probe
 *   on :443 first, so it finishes in a few seconds and touches only hosts that
 *   serve TLS.
 *
 * A player without the manifest route (older firmware) is identified once its
 * /ws session reports a Welcome ({@link Registry.identify}).
 */

import net from "node:net";
import { networkInterfaces } from "node:os";

import type { HubConfig } from "./config";
import { advertHost, browse, resolveTarget, type Advert, type Manifest, type Target } from "./discovery";

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
}

export interface RegistryDeps {
  browse?: (ms: number) => Promise<Advert[]>;
  resolve?: (host: string, opts: { pin?: string; timeoutMs?: number }) => Promise<Target>;
  /** Hosts to sweep instead of the local /24s (tests). */
  sweepHosts?: () => string[];
  probePort?: (host: string, port: number, ms: number) => Promise<boolean>;
}

export interface RefreshOptions {
  mdns?: boolean;
  mdnsMs?: number;
  /** "auto" sweeps only when nothing else found a player. */
  sweep?: "auto" | "on" | "off";
}

export class Registry {
  private readonly players = new Map<string, PlayerRecord>();
  private readonly explicit: string[];

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

  /** Re-discover. Hosts in `live` (connected sessions) are not re-probed — the
   * device has two TLS slots, and its session already holds one. */
  async refresh(opts: RefreshOptions = {}, live: Set<string> = new Set()): Promise<PlayerRecord[]> {
    const candidates = new Map<string, Source>();
    for (const h of this.explicit) candidates.set(h, "host");
    for (const r of Object.values(this.config.players)) if (!candidates.has(r.host)) candidates.set(r.host, "remembered");
    if (opts.mdns !== false) {
      const ads = await (this.deps.browse ?? browse)(opts.mdnsMs ?? 2500).catch(() => [] as Advert[]);
      for (const a of ads) {
        const h = advertHost(a);
        if (!candidates.has(h) || candidates.get(h) === "remembered") candidates.set(h, "mdns");
      }
    }
    await this.probeAll([...candidates].filter(([h]) => !live.has(h)), 8, 6000);
    const sweep = opts.sweep ?? "auto";
    if (sweep === "on" || (sweep === "auto" && this.players.size === 0)) {
      const hosts = (this.deps.sweepHosts ?? localSweepHosts)().filter((h) => !candidates.has(h));
      const open: string[] = [];
      await pool(hosts, 48, async (h) => {
        const [host, port] = splitHost(h);
        if (await (this.deps.probePort ?? probePort)(host, port, 350)) open.push(h);
      });
      await this.probeAll(
        open.map((h) => [h, "sweep"] as [string, Source]),
        16,
        2500,
        true,
      );
    }
    this.remember();
    return this.list();
  }

  /** Probe hosts' manifests; `strict` (the sweep) keeps only hosts that serve one. */
  private async probeAll(hosts: [string, Source][], width: number, timeoutMs: number, strict = false) {
    await pool(hosts, width, async ([host, source]) => {
      const pin = Object.values(this.config.players).find((p) => p.host === host)?.pin;
      const t = await (this.deps.resolve ?? resolveTarget)(host, { ...(pin ? { pin } : {}), timeoutMs });
      if (strict && !t.manifest) return;
      if (!t.reachable && source !== "host") return; // gone: keep only what was asked for explicitly
      this.upsert(host, t, source);
    });
  }

  private upsert(host: string, t: Target, source: Source): PlayerRecord {
    const mid = t.manifest?.device?.id?.toUpperCase();
    const remembered = Object.entries(this.config.players).find(([, p]) => p.host === host);
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
      manifest: t.manifest ?? prev?.manifest ?? null,
      ...(t.manifestError ? { manifestError: t.manifestError } : {}),
      target: t,
      sources: [...new Set([...(prev?.sources ?? []), source])],
      lastSeen: t.reachable ? Date.now() : (prev?.lastSeen ?? 0),
    };
    this.players.set(id, rec);
    return rec;
  }

  private byHost(host: string): PlayerRecord | undefined {
    return [...this.players.values()].find((p) => p.host === host);
  }

  /** A /ws session reached `host` and its Welcome named it: key the record by
   * MAC, folding duplicates (the same player reached by two hosts). Returns the
   * surviving record. */
  identify(host: string, w: { mac: string; deviceName: string; fwVersion: string }): PlayerRecord | undefined {
    const rec = this.byHost(host);
    if (!rec || !w.mac) return rec;
    const id = w.mac.toUpperCase();
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

  private remember(): void {
    let changed = false;
    for (const p of this.players.values()) {
      if (p.id.startsWith("host:")) continue;
      const pin = p.target?.tls.pinSha256;
      const next = {
        host: p.host,
        name: p.name,
        ...(p.fw ? { fw: p.fw } : {}),
        ...(pin ? { pin } : {}),
        lastSeen: new Date(p.lastSeen || Date.now()).toISOString(),
      };
      const old = this.config.players[p.id];
      if (!old || old.host !== next.host || old.name !== next.name || old.fw !== next.fw || old.pin !== next.pin) {
        this.config.players[p.id] = next;
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  forget(id: string): boolean {
    const had = this.players.delete(id) || id in this.config.players;
    delete this.config.players[id];
    this.persist();
    return had;
  }
}

function splitHost(h: string): [string, number] {
  const m = /^(.*):(\d+)$/.exec(h);
  return m && !m[1]!.includes(":") ? [m[1]!, Number(m[2])] : [h, 443];
}

/** Every host of this machine's local IPv4 /24s (at most two), excluding itself. */
export function localSweepHosts(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const base = a.address.split(".").slice(0, 3).join(".");
      if (seen.has(base) || seen.size >= 2) continue;
      seen.add(base);
      for (let i = 1; i < 255; i++) {
        const h = `${base}.${i}`;
        if (h !== a.address) out.push(h);
      }
    }
  }
  return out;
}

export function probePort(host: string, port: number, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(ms, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/** Run `fn` over `items`, at most `width` at a time. */
export async function pool<T>(items: T[], width: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const t = items[i++]!;
      await fn(t).catch(() => undefined);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
}
