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

/** Browse the LAN for `_splanc._tcp` adverts for `timeoutMs`. */
export function browse(timeoutMs = 3000): Promise<Advert[]> {
  return new Promise((resolve) => {
    const mdns = makeMdns();
    const found = new Map<string, Advert>();
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
        found.set(inst, {
          instance: inst,
          host: s.target,
          port: s.port,
          addresses: addrs.get(s.target) ?? [],
          txt: txt.get(inst) ?? {},
        });
      }
    });
    mdns.query({ questions: [{ name: SERVICE, type: "PTR" }] });
    setTimeout(() => {
      mdns.destroy();
      resolve([...found.values()]);
    }, timeoutMs);
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
}

/**
 * Resolve a target: fetch its manifest (404 / unreachable -> fallback), take the
 * TLS pin from the operator's `pin` or the manifest's `tls.cert_sha256`.
 */
export async function resolveTarget(host: string, opts: { pin?: string } = {}): Promise<Target> {
  let manifest: Manifest | null = null;
  let manifestError: string | undefined;
  const tls: TlsPolicy = opts.pin ? { pinSha256: opts.pin } : {};
  try {
    const r = await httpsGet(`https://${host}/.well-known/splanc.json`, tls);
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
  };
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
