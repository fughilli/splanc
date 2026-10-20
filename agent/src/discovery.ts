/**
 * Discovery (spec "Discovery"): find a player by mDNS (`_splanc._tcp`, TXT
 * id/name/fw/path) or take a host directly, then read its static manifest
 * (`GET https://<host>/.well-known/splanc.json`). On firmware without the route
 * the bridge still works: it connects to /ws and reads Welcome.fw_version.
 */

import makeMdns from "multicast-dns";

import { httpsGet, type TlsPolicy } from "./socket";

export interface Advert {
  instance: string;
  host: string;
  port: number;
  addresses: string[];
  txt: Record<string, string>;
}

export const SERVICE = "_splanc._tcp.local";

export interface BrowseOptions {
  /** Called once per advert as soon as it is complete (PTR + SRV), so callers can
   * start connecting while the browse is still listening. */
  onAdvert?: (a: Advert) => void;
  /** Return this long after the last NEW advert, once at least one arrived
   * (responders answer within ~120 ms of a query; default 300). */
  quietMs?: number;
  /** Stop early (the caller already has what it needs). */
  signal?: AbortSignal;
}

/**
 * Browse the LAN for `_splanc._tcp` adverts: at most `timeoutMs`, but returns
 * `quietMs` after the last new advert once any arrived, or on `signal`. The
 * query goes out twice (at 0 and 250 ms) to ride out one lost multicast frame.
 */
export function browse(timeoutMs = 1500, opts: BrowseOptions = {}): Promise<Advert[]> {
  return new Promise((resolve) => {
    let mdns: ReturnType<typeof makeMdns>;
    try {
      mdns = makeMdns();
    } catch {
      resolve([]);
      return;
    }
    const found = new Map<string, Advert>();
    const quietMs = opts.quietMs ?? 300;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let quiet: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      if (quiet) clearTimeout(quiet);
      opts.signal?.removeEventListener("abort", finish);
      try {
        mdns.destroy();
      } catch {
        // already closed
      }
      resolve([...found.values()]);
    };
    if (opts.signal?.aborted) {
      finish();
      return;
    }
    opts.signal?.addEventListener("abort", finish);
    mdns.on("error", finish);
    const srv = new Map<string, { target: string; port: number }>();
    const txt = new Map<string, Record<string, string>>();
    const addrs = new Map<string, string[]>();
    const ptrs = new Set<string>();
    mdns.on("response", (res) => {
      for (const a of [...(res.answers ?? []), ...(res.additionals ?? [])]) {
        if (a.type === "PTR" && a.name === SERVICE) ptrs.add(String(a.data));
        else if (a.type === "SRV") {
          const d = a.data as { target: string; port: number };
          srv.set(a.name, { target: d.target, port: d.port });
        } else if (a.type === "TXT") {
          const rec: Record<string, string> = {};
          for (const b of (Array.isArray(a.data) ? a.data : [a.data]) as (Buffer | string)[]) {
            const s = b.toString();
            const i = s.indexOf("=");
            if (i > 0) rec[s.slice(0, i)] = s.slice(i + 1);
          }
          txt.set(a.name, rec);
        } else if (a.type === "A" || a.type === "AAAA") {
          addrs.set(a.name, [...(addrs.get(a.name) ?? []), String(a.data)]);
        }
      }
      for (const inst of ptrs) {
        const s = srv.get(inst);
        if (!s) continue;
        const fresh = !found.has(inst);
        const a: Advert = {
          instance: inst,
          host: s.target,
          port: s.port,
          addresses: addrs.get(s.target) ?? [],
          txt: txt.get(inst) ?? {},
        };
        found.set(inst, a);
        if (fresh && !done) {
          opts.onAdvert?.(a);
          if (quiet) clearTimeout(quiet);
          quiet = setTimeout(finish, quietMs);
        }
      }
    });
    const query = () => {
      if (done) return;
      try {
        mdns.query({ questions: [{ name: SERVICE, type: "PTR" }] });
      } catch {
        // no multicast route: the timeout ends the browse
      }
    };
    query();
    timers.push(setTimeout(query, Math.min(250, timeoutMs / 2)));
    timers.push(setTimeout(finish, timeoutMs));
  });
}

/** The discovery manifest (schema splanc-agent/1). Fields beyond these are kept. */
export interface Manifest {
  schema: string;
  device?: { id?: string; name?: string; board?: string };
  firmware?: { version?: string; commit?: string; dirty?: boolean };
  protocol?: { package?: string; ws_path?: string; profile?: string; features?: string[] };
  bundle?: { url?: string; sha256?: string; mcp?: unknown };
  tls?: { cert_sha256?: string };
  [k: string]: unknown;
}

export interface Target {
  /** host[:port] to connect to. */
  host: string;
  manifest: Manifest | null;
  /** Why there is no manifest (route missing, unreachable…), when there isn't. */
  manifestError?: string;
  tls: TlsPolicy;
  wsUrl: string;
  /** The host answered HTTPS at all (a 404 counts; a refused/timed-out probe doesn't). */
  reachable: boolean;
}

/**
 * Resolve a target: fetch its manifest (404 / unreachable -> fallback), take the
 * TLS pin from the operator's `pin` or the manifest's `tls.cert_sha256`.
 */
export async function resolveTarget(
  host: string,
  opts: { pin?: string; timeoutMs?: number } = {},
): Promise<Target> {
  let manifest: Manifest | null = null;
  let manifestError: string | undefined;
  const tls: TlsPolicy = opts.pin ? { pinSha256: opts.pin } : {};
  let reachable = false;
  try {
    const r = await httpsGet(`https://${host}/.well-known/splanc.json`, tls, opts.timeoutMs);
    reachable = true;
    if (r.status === 200) {
      manifest = JSON.parse(r.body) as Manifest;
      if (manifest.schema !== "splanc-agent/1") {
        manifestError = `unknown manifest schema ${JSON.stringify(manifest.schema)}`;
        manifest = null;
      }
    } else {
      manifestError = `GET /.well-known/splanc.json -> HTTP ${r.status} (older firmware: falling back to Welcome)`;
    }
  } catch (e) {
    manifestError = `manifest unavailable: ${(e as Error).message}`;
  }
  const pin = tls.pinSha256 ?? manifest?.tls?.cert_sha256;
  const wsPath = manifest?.protocol?.ws_path ?? "/ws";
  return {
    host,
    manifest,
    ...(manifestError !== undefined ? { manifestError } : {}),
    tls: pin ? { pinSha256: pin } : {},
    wsUrl: `wss://${host}${wsPath}`,
    reachable,
  };
}

/** A target from what is already known (no network): the cached manifest and pin,
 * if any. */
export function knownTarget(host: string, opts: { pin?: string; manifest?: Manifest | null; reachable?: boolean } = {}): Target {
  const pin = opts.pin ?? opts.manifest?.tls?.cert_sha256;
  return {
    host,
    manifest: opts.manifest ?? null,
    tls: pin ? { pinSha256: pin } : {},
    wsUrl: `wss://${host}${opts.manifest?.protocol?.ws_path ?? "/ws"}`,
    reachable: opts.reachable ?? true,
  };
}

/** host[:port] to dial for an mDNS advert (its first address, else its name). */
export function advertHost(a: Advert): string {
  return `${a.addresses.find((x) => !x.includes(":")) ?? a.addresses[0] ?? a.host}${
    a.port && a.port !== 443 ? `:${a.port}` : ""
  }`;
}

/** Check the /ws session reached the player the manifest describes. */
export function checkSamePlayer(
  manifest: Manifest | null,
  welcome: { mac: string; deviceName: string; fwVersion: string },
): string | null {
  if (!manifest?.device) return null;
  const id = manifest.device.id;
  if (id && welcome.mac && id.toUpperCase() !== welcome.mac.toUpperCase()) {
    return `the manifest describes ${id} but /ws reached ${welcome.mac}`;
  }
  const v = manifest.firmware?.version;
  if (v && welcome.fwVersion && v !== welcome.fwVersion) {
    return `the manifest says firmware ${v} but the player reports ${welcome.fwVersion}`;
  }
  return null;
}
