/**
 * Wi-Fi rejoin policy (docs/design/wifi-rejoin-policy.md; the "wifi_policy"
 * feature): how a player (re)joins its stored network when it isn't on it.
 *
 * Pure (no DOM): the wire <-> app shape conversion the client uses, and the
 * status wording the device card / settings section show — unit-tested in
 * tests/wifiPolicy.test.ts.
 *
 * Modes: auto (backoff rescans 5 s -> scanCapS; after decayAfterH hours without
 * seeing the network it slows to sparseIntervalS), fixed (every intervalS),
 * manual (never on its own; rejoinNow opens a ~2 min join window), offline
 * (forward-deployed: radio silent, credentials KEPT; reconfigure over BLE or the
 * wired console). Going to manual/offline is refused while a fresh firmware
 * update is unconfirmed unless forced.
 */

import type { SetWifiPolicyMessage, WifiModeName, WifiPolicyStateMessage } from "./proto";

export type WifiMode = "auto" | "fixed" | "manual" | "offline";
export const WIFI_MODES: WifiMode[] = ["auto", "fixed", "manual", "offline"];

export type WifiLink = "unknown" | "offline" | "unprovisioned" | "idle" | "searching" | "joining" | "joined";

/** A set_wifi_policy request, app side. Unset fields keep the device's value. */
export interface WifiPolicyRequest {
  mode?: WifiMode | undefined;
  scanCapS?: number | undefined;
  intervalS?: number | undefined;
  decayAfterH?: number | undefined;
  sparseIntervalS?: number | undefined;
  /** Override the "update awaiting confirmation" refusal for manual/offline.
   * Only ever set after an explicit second confirmation. */
  force?: boolean | undefined;
  rejoinNow?: boolean | undefined;
}

/** The device's policy + link state (proto WifiPolicyState), normalized. */
export interface WifiPolicy {
  mode: WifiMode;
  scanCapS: number;
  intervalS: number;
  decayAfterH: number;
  sparseIntervalS: number;
  state: WifiLink;
  nextScanS: number;
  scans: number;
  ssid: string;
  unseenS: number;
  decayed: boolean;
  otaPending: boolean;
  /** Why the last set was not applied ("" = it was): "ota_pending". */
  refused: string;
  radioOn: boolean;
}

const MODE_TO_WIRE: Record<WifiMode, WifiModeName> = {
  auto: "WIFI_MODE_AUTO",
  fixed: "WIFI_MODE_FIXED",
  manual: "WIFI_MODE_MANUAL",
  offline: "WIFI_MODE_OFFLINE",
};
const MODE_BY_NUM: WifiMode[] = ["auto", "fixed", "manual", "offline"];
const LINK_BY_NUM: WifiLink[] = ["unknown", "offline", "unprovisioned", "idle", "searching", "joining", "joined"];

export function wifiModeToWire(mode: WifiMode): WifiModeName {
  return MODE_TO_WIRE[mode];
}

/** A wire enum (its proto name, or the number) -> the app's mode. */
export function wifiModeFromWire(v: unknown): WifiMode {
  if (typeof v === "number") return MODE_BY_NUM[v] ?? "auto";
  if (typeof v === "string") {
    const m = v.replace(/^WIFI_MODE_/, "").toLowerCase();
    if ((WIFI_MODES as string[]).includes(m)) return m as WifiMode;
  }
  return "auto";
}

export function wifiLinkFromWire(v: unknown): WifiLink {
  if (typeof v === "number") return LINK_BY_NUM[v] ?? "unknown";
  if (typeof v === "string") {
    const s = v.replace(/^WIFI_LINK_/, "").toLowerCase();
    if ((LINK_BY_NUM as string[]).includes(s)) return s as WifiLink;
  }
  return "unknown";
}

/** The flat set_wifi_policy message for a request (unset fields stay unset;
 * `force` / `rejoinNow` only when true). */
export function wifiPolicyMessage(req: WifiPolicyRequest): SetWifiPolicyMessage {
  const msg: SetWifiPolicyMessage = { type: "set_wifi_policy" };
  if (req.mode !== undefined) msg.mode = wifiModeToWire(req.mode);
  if (req.scanCapS !== undefined) msg.scanCapS = req.scanCapS;
  if (req.intervalS !== undefined) msg.intervalS = req.intervalS;
  if (req.decayAfterH !== undefined) msg.decayAfterH = req.decayAfterH;
  if (req.sparseIntervalS !== undefined) msg.sparseIntervalS = req.sparseIntervalS;
  if (req.force === true) msg.force = true;
  if (req.rejoinNow === true) msg.rejoinNow = true;
  return msg;
}

/** Normalize a decoded wifi_policy_state (proto3 drops zero / false fields). */
export function normalizeWifiPolicy(r: Partial<WifiPolicyStateMessage> | Record<string, unknown>): WifiPolicy {
  const m = r as Partial<WifiPolicyStateMessage>;
  return {
    mode: wifiModeFromWire(m.mode),
    scanCapS: m.scanCapS ?? 0,
    intervalS: m.intervalS ?? 0,
    decayAfterH: m.decayAfterH ?? 0,
    sparseIntervalS: m.sparseIntervalS ?? 0,
    state: wifiLinkFromWire(m.state),
    nextScanS: m.nextScanS ?? 0,
    scans: m.scans ?? 0,
    ssid: m.ssid ?? "",
    unseenS: m.unseenS ?? 0,
    decayed: m.decayed ?? false,
    otaPending: m.otaPending ?? false,
    refused: m.refused ?? "",
    radioOn: m.radioOn ?? false,
  };
}

/** A short human duration: "40 s", "5 min", "3 h", "2 d". */
export function formatDuration(s: number): string {
  const n = Math.max(0, Math.round(s));
  if (n < 60) return `${n} s`;
  if (n < 3600) return `${Math.round(n / 60)} min`;
  if (n < 86400) return `${Math.round(n / 3600)} h`;
  return `${Math.round(n / 86400)} d`;
}

/** The device card's one-line Wi-Fi status, e.g. "Wi-Fi: joined (Venue1)". */
export function formatWifiStatus(p: WifiPolicy): string {
  if (p.mode === "offline") return "Wi-Fi: offline mode";
  const named = p.ssid ? ` (${p.ssid})` : "";
  switch (p.state) {
    case "joined":
      return `Wi-Fi: joined${named}`;
    case "joining":
      return `Wi-Fi: joining${named}`;
    case "unprovisioned":
      return "Wi-Fi: not set up";
    case "idle":
      return "Wi-Fi: manual — not joining";
    case "offline":
      return "Wi-Fi: radio off";
    case "searching":
      if (p.decayed) return `Wi-Fi: searching (slowed: unseen ${formatDuration(p.unseenS)})`;
      if (p.mode === "manual") return "Wi-Fi: manual — trying to join now";
      return p.nextScanS > 0 ? `Wi-Fi: rejoining, next scan in ${formatDuration(p.nextScanS)}` : "Wi-Fi: rejoining, scanning";
    default:
      return "Wi-Fi: unknown";
  }
}

export const OTA_PENDING_WARNING =
  "A firmware update is installed but not yet confirmed. Keep the device online until the update " +
  "is confirmed, so its networking gets checked before the device leaves the network.";

/** The confirmation a mode change needs (null = none): leaving the network on
 * purpose is the only change that can strand a unit. */
export function wifiModeConfirmation(from: WifiMode, to: WifiMode): { title: string; message: string } | null {
  if (to === from) return null;
  if (to === "offline") {
    return {
      title: "Go offline?",
      message:
        "The device turns its Wi-Fi radio off: no scans, no joining, no Wi-Fi at all (also after a reboot) " +
        "until you switch it back over Bluetooth or the wired console. Your Wi-Fi credentials are kept, so " +
        "switching back to Auto rejoins without re-entering them. The stored show keeps playing.",
    };
  }
  if (to === "manual") {
    return {
      title: "Manual Wi-Fi?",
      message:
        "The device stops looking for its network on its own. It only (re)joins when you tap \"Rejoin now\" " +
        "(over Bluetooth or the console if it is off the network) or provision it again.",
    };
  }
  return null;
}

/** Whether going to `to` is refused by the firmware while an update is pending. */
export function wifiModeNeedsConfirmedUpdate(to: WifiMode): boolean {
  return to === "manual" || to === "offline";
}

/** Parse a whole-number field; null when empty / not a non-negative integer. */
export function parseWholeNumber(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  return Number(t);
}
