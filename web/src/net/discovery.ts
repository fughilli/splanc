/**
 * Automatic fixture discovery (D-72): fixtures already on the network show up in
 * the device list by themselves, with no pull-to-refresh and no address to type.
 *
 * Every fixture advertises itself over mDNS as `_splanc._tcp` (firmware/mdns: TXT
 * id = MAC, name, fw, path, tls; SRV → its wss port 443). Who can hear that
 * depends on the platform, so discovery merges whatever sources this one has:
 *
 *   - **iOS app** — native Bonjour browse through the WssBridge plugin
 *     (NetServiceBrowser; Info.plist declares `_splanc._tcp`). Continuous while a
 *     list is on screen; adverts that vanish drop out.
 *   - **Any platform with a paired Splanc bridge** — the bridge browses mDNS (and
 *     sweeps the LAN) itself; its welcome lists every player it found with its
 *     address. Read once when a list opens, at most every two minutes.
 *   - **Plain browser** (desktop or Android Chrome, the installed PWA) — a web
 *     page cannot send or receive mDNS, and it cannot sweep the LAN for wss
 *     servers either (each fixture's self-signed certificate fails the same way
 *     an absent host does). What remains is the background prober's view of the
 *     fixtures this browser already knows (net/deviceProber.ts), the address a
 *     fixture reports when set up over Bluetooth, and typing an address.
 *
 * `mergeDiscovered` (pure, unit-tested) folds what was found into the known
 * devices: a match by MAC (TXT id) or by address marks that device as on the
 * network (and gives its current address, which survives a DHCP change); the rest
 * are new fixtures the list offers to connect.
 */

import type { KnownDevice } from "../store/deviceStore";
import { deviceStore } from "../store/deviceStore";
import { isIosNative } from "./native";
import type { NativeMdnsEvent } from "./nativeSocket";
import type { LivePlayer } from "./liveProtocol";
import type { BridgeCreds } from "./bridgeLive";

export type FoundSource = "mdns" | "bridge";

export interface FoundFixture {
  /** Dedup key: the MAC when known, else the advert's instance name. */
  key: string;
  /** Uppercase MAC with colons ("AA:BB:CC:DD:EE:FF"), "" when not advertised. */
  id: string;
  /** Display name (TXT name, else the instance name, else the host). */
  name: string;
  /** IPv4 address or hostname. */
  host: string;
  /** The player's control socket. */
  url: string;
  fw?: string;
  source: FoundSource;
  /** When it was last heard (ms). */
  seenAt: number;
}

/** A MAC in canonical form ("AA:BB:CC:DD:EE:FF"), or "" if it isn't one. */
export function normalizeMac(s: string | undefined): string {
  const hex = (s ?? "").replace(/[^0-9a-f]/gi, "").toUpperCase();
  return hex.length === 12 ? hex.match(/../g)!.join(":") : "";
}

function wssUrl(host: string, port = 443): string {
  return port === 443 || !port ? `wss://${host}/ws` : `wss://${host}:${port}/ws`;
}

function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** A resolved native mDNS advert as a found fixture (null for a loss/error). */
export function fixtureFromMdns(e: NativeMdnsEvent, now: number): FoundFixture | null {
  if (e.lost || e.error) return null;
  const host = (e.addresses?.[0] ?? e.host ?? "").replace(/\.$/, "");
  if (!host) return null;
  const id = normalizeMac(e.txt?.["id"]);
  const name = e.txt?.["name"] || e.name || host;
  const fw = e.txt?.["fw"];
  return {
    key: id || `name:${e.name ?? host}`,
    id,
    name,
    host,
    url: wssUrl(host, e.port ?? 443),
    ...(fw ? { fw } : {}),
    source: "mdns",
    seenAt: now,
  };
}

/** A player the paired bridge reports, as a found fixture. */
export function fixtureFromBridge(p: Pick<LivePlayer, "id" | "name" | "host" | "fw">, now: number): FoundFixture | null {
  const raw = (p.host ?? "").trim();
  if (!raw) return null;
  let host = raw;
  let port = 443;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    host = u.hostname;
    port = u.port ? Number(u.port) : 443;
  } catch {
    return null;
  }
  const id = normalizeMac(p.id);
  return {
    key: id || `bridge:${host}`,
    id,
    name: p.name || host,
    host,
    url: wssUrl(host, port),
    ...(p.fw ? { fw: p.fw } : {}),
    source: "bridge",
    seenAt: now,
  };
}

export interface DiscoveryView {
  /** Known device id → the fixture found for it (it is on the network now). */
  matched: Map<string, FoundFixture>;
  /** Fixtures on the network the app doesn't know yet, by name. */
  fresh: FoundFixture[];
}

/** Fold found fixtures into the known devices (see the module doc). */
export function mergeDiscovered(known: readonly KnownDevice[], found: readonly FoundFixture[]): DiscoveryView {
  // One entry per fixture: the same MAC heard from two sources keeps the newest.
  const byKey = new Map<string, FoundFixture>();
  for (const f of found) {
    const prev = byKey.get(f.key);
    if (!prev || f.seenAt >= prev.seenAt) byKey.set(f.key, f);
  }
  const matched = new Map<string, FoundFixture>();
  const fresh: FoundFixture[] = [];
  for (const f of byKey.values()) {
    const host = f.host.toLowerCase();
    const dev =
      (f.id && known.find((d) => normalizeMac(d.bleMac) === f.id)) ||
      known.find((d) => hostOf(d.wssUrl) === host || hostOf(d.lanUrl) === host);
    if (dev) {
      const prev = matched.get(dev.id);
      if (!prev || f.seenAt >= prev.seenAt) matched.set(dev.id, f);
    } else {
      fresh.push(f);
    }
  }
  fresh.sort((a, b) => a.name.localeCompare(b.name) || a.host.localeCompare(b.host));
  return { matched, fresh };
}

// -- the live discovery service ---------------------------------------------

const BRIDGE_CREDS_KEY = "splanc.bridge.v1";
const BRIDGE_MIN_INTERVAL_MS = 120_000;
const BRIDGE_TIMEOUT_MS = 8_000;
/** Bridge answers are a snapshot: forget them if not refreshed for this long. */
const BRIDGE_TTL_MS = 10 * 60_000;

/** What this platform can do on its own, for the list's one-line hint. */
export type DiscoveryReach = "native" | "bridge" | "browser";

type Listener = () => void;

class Discovery {
  private readonly found = new Map<string, FoundFixture>();
  private readonly listeners = new Set<Listener>();
  private users = 0;
  private nativeOn = false;
  private nativeSub: { remove(): Promise<void> } | null = null;
  private lastBridge = -Infinity;

  /** Start discovering (refcounted: each open list holds one). Returns its stop. */
  start(): () => void {
    this.users++;
    if (this.users === 1) void this.startNative();
    this.pollBridge();
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      this.users = Math.max(0, this.users - 1);
      if (this.users === 0) void this.stopNative();
    };
  }

  /** How this platform finds fixtures. */
  reach(): DiscoveryReach {
    if (isIosNative()) return "native";
    return readBridgeCreds() ? "bridge" : "browser";
  }

  /** Everything currently on the network, newest first. */
  list(): FoundFixture[] {
    const now = Date.now();
    for (const [k, f] of this.found) {
      if (f.source === "bridge" && now - f.seenAt > BRIDGE_TTL_MS) this.found.delete(k);
    }
    return [...this.found.values()].sort((a, b) => b.seenAt - a.seenAt);
  }

  /** The found fixtures folded into the known devices. */
  view(): DiscoveryView {
    return mergeDiscovered(deviceStore.list(), this.list());
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Record a fixture (sources, and the demo/test seam). */
  report(f: FoundFixture): void {
    this.found.set(f.key, f);
    this.emit();
  }

  /** Drop fixtures matching `pred` (an advert went away). */
  forget(pred: (f: FoundFixture) => boolean): void {
    let changed = false;
    for (const [k, f] of this.found) {
      if (pred(f)) {
        this.found.delete(k);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  /** Test seam: forget everything and reset the bridge rate limit. */
  reset(): void {
    this.found.clear();
    this.lastBridge = -Infinity;
    this.emit();
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }

  private async startNative(): Promise<void> {
    if (!isIosNative() || this.nativeOn) return;
    this.nativeOn = true;
    try {
      const { wssBridge } = await import("./nativeSocket");
      const plugin = wssBridge();
      this.nativeSub = await plugin.addListener("mdnsService", (e) => this.onNative(e));
      await plugin.startDiscovery();
    } catch {
      // Older app build without the browse method: the other sources still work.
      this.nativeOn = false;
    }
  }

  private async stopNative(): Promise<void> {
    if (!this.nativeOn) return;
    this.nativeOn = false;
    try {
      const { wssBridge } = await import("./nativeSocket");
      await wssBridge().stopDiscovery();
      await this.nativeSub?.remove();
    } catch {
      // already gone
    }
    this.nativeSub = null;
    // Adverts are only trustworthy while browsing; a stale one would offer a
    // fixture that has left. The next browse re-finds the live ones in < 1 s.
    this.forget((f) => f.source === "mdns");
  }

  private onNative(e: NativeMdnsEvent): void {
    if (e.lost) {
      this.forget((f) => f.source === "mdns" && (f.key === `name:${e.name}` || f.name === e.name));
      return;
    }
    const f = fixtureFromMdns(e, Date.now());
    if (f) this.report(f);
  }

  /** Ask the paired bridge which players it sees (rate-limited, best effort). */
  private pollBridge(): void {
    const creds = readBridgeCreds();
    const now = Date.now();
    if (!creds || now - this.lastBridge < BRIDGE_MIN_INTERVAL_MS) return;
    this.lastBridge = now;
    void (async () => {
      const { BridgeLiveClient } = await import("./bridgeLive");
      const client = new BridgeLiveClient(creds);
      try {
        const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), BRIDGE_TIMEOUT_MS));
        const w = await Promise.race([client.connect(), timeout]);
        const at = Date.now();
        for (const p of w.players ?? []) {
          const f = fixtureFromBridge(p, at);
          if (f) this.report(f);
        }
      } catch {
        // bridge offline / relay unreachable: nothing new
      } finally {
        client.close();
      }
    })();
  }
}

function readBridgeCreds(): BridgeCreds | null {
  try {
    const raw = globalThis.localStorage?.getItem(BRIDGE_CREDS_KEY);
    const c = raw ? (JSON.parse(raw) as BridgeCreds) : null;
    return c && c.token && c.relay ? c : null;
  } catch {
    return null;
  }
}

export const discovery = new Discovery();
