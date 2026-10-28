/**
 * Push a pending IMU calibration (capture/imuCalWriteback.ts) whenever the app
 * (re)connects to the device it belongs to. Called from the connection
 * manager's onConnected, which fires on every welcome — the first connect and
 * every automatic reconnect alike.
 */

import { parseBundleHeader } from "../store/deviceMap";
import { deviceKeyOf, imuCalPending, pushPendingImuCal, type MountClient, type PendingImuCalStore } from "./imuCalWriteback";

/** The parts of LedMapperClient the reconnect push needs. */
export interface ReconnectClient extends MountClient {
  readonly welcome: { mac?: string; features?: string[] } | null;
  peekStoredMap?(): Promise<{ prefix: Uint8Array }>;
}

const inFlight = new WeakSet<object>();

/** Push `client`'s device's pending calibration, once per (re)connection;
 * resolves with what happened (for logs / tests). `delayMs` lets the connect
 * chain (cert check, clock sync) go first. */
export async function pushPendingOnConnect(
  client: ReconnectClient,
  opts: {
    store?: PendingImuCalStore;
    delayMs?: number;
    isCurrent?: () => boolean;
    notify?: (text: string) => void;
  } = {},
): Promise<string> {
  const store = opts.store ?? imuCalPending;
  const key = deviceKeyOf(client.welcome?.mac);
  if (!key || store.get(key) === null) return "none";
  if (!(client.welcome?.features ?? []).includes("imu_extrinsic")) return "unsupported";
  if (inFlight.has(client)) return "busy";
  inFlight.add(client);
  try {
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if ((opts.isCurrent && !opts.isCurrent()) || !client.isConnected) return "gone";
    const peek = client.peekStoredMap?.bind(client);
    const r = await pushPendingImuCal(client, store, key, {
      ...(peek && (client.welcome?.features ?? []).includes("stored_map")
        ? { deviceMapId: async () => parseBundleHeader((await peek()).prefix)?.mapId ?? null }
        : {}),
    });
    if (r.kind === "confirmed") {
      console.info(`[imucal] pending calibration ${r.wrote ? "written to" : "already on"} ${key}`);
      if (r.wrote) opts.notify?.("Motion sensor calibration written to the fixture");
    } else if (r.kind === "stale") {
      console.info(`[imucal] dropped a pending calibration for map ${r.mapId}: ${key} now holds ${r.deviceMapId}`);
    } else if (r.kind !== "none") {
      console.info(`[imucal] pending calibration for ${key} still pending: ${r.kind} (${r.detail})`);
    }
    return r.kind === "confirmed" ? "confirmed" : r.kind;
  } finally {
    inFlight.delete(client);
  }
}
