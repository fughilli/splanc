/**
 * The bridge setup flow's real I/O (#698): Improv over Bluetooth, the bridge's LAN
 * healthz, and the relay. Swapped for a scripted bridge by `?demo=bridge-*`
 * (demo/bridgeSetupDemo.ts) and by tests.
 */

import { BridgeLiveClient, pairWithCode } from "../../net/bridgeLive";
import { provisionViaBle, type ImprovDevice } from "../../net/improv";
import type { LanHealth } from "../../net/liveProtocol";
import { parseHealth } from "../../net/bridgeSetup";
import { isNativePlatform } from "../../net/native";
import { nativeRequest } from "../../net/nativeHttp";
import { prefs } from "../../store/prefs";
import { wifiDraft } from "../../store/wifiDraft";
import { DEFAULT_RELAY, loadCreds, newClientId, saveCreds } from "./bridgeLive";
import { abortableSleep, type BridgeSetupIO, type PairedWelcome } from "./bridgeSetupRun";

/** The bridge's direct LAN port (agent/src/bridge/liveLan.ts DEFAULT_LIVE_PORT). */
export const BRIDGE_LAN_PORT = 8443;


function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  const stop = (): void => {
    clearTimeout(t);
    ctl.abort();
  };
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });
  return ctl.signal;
}

async function readHealth(ip: string, signal: AbortSignal): Promise<LanHealth | null> {
  const host = ip.includes(":") ? `[${ip}]` : ip;
  const url = `https://${host}:${BRIDGE_LAN_PORT}/healthz`;
  try {
    if (isNativePlatform()) {
      // The native HTTP path trusts the bridge's self-signed certificate.
      const r = await nativeRequest(url, "GET", { accept: "application/json" });
      return r.ok ? parseHealth(await r.text()) : null;
    }
    // A browser only gets here once it trusts the certificate (else: TypeError).
    const r = await fetch(url, { cache: "no-store", signal: withTimeout(signal, 4000) });
    return r.ok ? parseHealth(await r.text()) : null;
  } catch {
    return null;
  }
}

async function relayReachable(relay: string): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const r = await fetch(`${relay.replace(/\/+$/, "")}/healthz`, { cache: "no-store", signal: withTimeout(ctl.signal, 5000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Connect through the relay with the saved credential until the bridge welcomes us. */
async function welcomeFromRelay(deadlineMs: number, signal?: AbortSignal): Promise<PairedWelcome | "revoked" | "timeout"> {
  const creds = loadCreds();
  if (!creds) return "revoked";
  const end = Date.now() + deadlineMs;
  while (!signal?.aborted && Date.now() < end) {
    const c = new BridgeLiveClient(creds, { preferLan: false });
    try {
      const w = await c.connect();
      // The welcome carries the bridge's LAN endpoint on its NEW network: keep it.
      saveCreds(c.creds);
      return { players: w.players.map((p) => p.name), sha256: w.lan?.sha256 ?? null };
    } catch (e) {
      if ((e as Error).message === "revoked") return "revoked";
    } finally {
      c.close();
    }
    if (signal) await abortableSleep(3000, signal);
    else await new Promise((r) => setTimeout(r, 3000));
  }
  return "timeout";
}

export function defaultBridgeSetupIO(): BridgeSetupIO {
  return {
    provision: async (device: ImprovDevice, creds, onStatus, signal) => {
      const urls = await provisionViaBle(device, creds.ssid, creds.password, onStatus, { signal });
      prefs.addWifi(creds); // only after the bridge reports it JOINED
      wifiDraft.clear();
      return urls;
    },
    readHealth,
    healthCertain: isNativePlatform(),
    relayReachable,
    checkPaired: (deadlineMs, signal) => welcomeFromRelay(deadlineMs, signal),
    pair: async (relay, code, label) => {
      const token = await pairWithCode(relay, code, label);
      saveCreds({ relay, token, clientId: newClientId(), name: label });
    },
    confirmPaired: async (deadlineMs) => {
      const r = await welcomeFromRelay(deadlineMs);
      return typeof r === "object" ? r.players : null;
    },
    defaultRelay: DEFAULT_RELAY,
    get credsRelay() {
      return loadCreds()?.relay ?? null;
    },
    now: () => Date.now(),
    sleep: abortableSleep,
  };
}

// -- swapping it -------------------------------------------------------------------------

let override: (() => BridgeSetupIO) | null = null;

/** Demo mode and tests: a scripted bridge in place of the real one. */
export function setBridgeSetupIO(make: (() => BridgeSetupIO) | null): void {
  override = make;
}

export function bridgeSetupIO(): BridgeSetupIO {
  return override ? override() : defaultBridgeSetupIO();
}

// -- the hand-off from the fixture flow ---------------------------------------------------

let handoff: { ip: string; ssid: string } | null = null;

/** The fixture flow's Improv answered as a bridge: the setup flow picks up from there. */
export function handOffJoinedBridge(ip: string, ssid: string): void {
  handoff = { ip, ssid };
}

export function takeBridgeHandoff(): { ip: string; ssid: string } | null {
  const h = handoff;
  handoff = null;
  return h;
}
