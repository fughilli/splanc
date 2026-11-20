/**
 * Saved Wi-Fi networks (D-72): the list the add-device sheet offers as one-tap
 * picks, and that Settings ▸ Wi-Fi networks manages (edit, delete, make default).
 *
 * Any details the user enters and then presses Connect with are saved here at
 * once, upserted by SSID, so they never have to be typed twice. The outcome of
 * the join is recorded on the entry: `joined` once a device reported it joined,
 * `rejected` when a device reported the password wrong (the entry stays, flagged,
 * so the user sees which saved password is bad and can fix it in one place).
 *
 * Order is the user's: the first entry is the default (prefills the sheet and is
 * what "Find over Bluetooth" provisions with). A NEW network goes to the top, as
 * the most recent one typed; an existing one is updated in place, so a default the
 * user chose is not displaced by re-entering another network's password.
 *
 * Stored in the same localStorage key the earlier pick list used
 * (`ledmapper.wifiList`, plain `{ssid, password}` entries), so saved networks
 * carry over; the extra fields are optional.
 */

import type { WifiCreds } from "./prefs";

/** The earlier single-entry cache (still kept in step as the default). */
const WIFI_CACHE_KEY = "ledmapper.wifi";
const WIFI_LIST_KEY = "ledmapper.wifiList";
/** Generous: a list of real networks never gets near it; it only bounds storage. */
export const MAX_SAVED_NETWORKS = 24;

export type JoinState = "joined" | "rejected" | "unverified";

export interface SavedNetwork extends WifiCreds {
  /** What happened the last time a device tried it (absent = unknown/legacy). */
  state?: JoinState;
  /** When it was last sent to a device (ms since epoch). */
  lastUsed?: number;
}

// -- pure list operations (unit-tested) ---------------------------------------

/** Insert or update `creds` by SSID. A new SSID goes first (it becomes the
 * default); an existing one keeps its place and takes the new password. */
export function upsertNetwork(
  list: readonly SavedNetwork[],
  creds: WifiCreds,
  patch: Partial<Pick<SavedNetwork, "state" | "lastUsed">> = {},
): SavedNetwork[] {
  const ssid = creds.ssid.trim();
  if (!ssid) return [...list];
  const at = list.findIndex((n) => n.ssid === ssid);
  if (at >= 0) {
    const prev = list[at]!;
    // A changed password invalidates the previous verdict about the old one.
    const changed = prev.password !== creds.password;
    const next: SavedNetwork = {
      ...prev,
      password: creds.password,
      ...(changed ? { state: "unverified" as JoinState } : {}),
      ...patch,
    };
    return list.map((n, i) => (i === at ? next : n));
  }
  const fresh: SavedNetwork = { ssid, password: creds.password, state: "unverified", ...patch };
  return [fresh, ...list].slice(0, MAX_SAVED_NETWORKS);
}

/** Replace the entry `oldSsid` with `creds` (rename and/or new password) in
 * place. Renaming onto another saved SSID merges into that one's place. */
export function editNetwork(list: readonly SavedNetwork[], oldSsid: string, creds: WifiCreds): SavedNetwork[] {
  const ssid = creds.ssid.trim();
  const at = list.findIndex((n) => n.ssid === oldSsid);
  if (!ssid || at < 0) return [...list];
  if (ssid !== oldSsid && list.some((n) => n.ssid === ssid)) {
    return upsertNetwork(removeNetwork(list, oldSsid), { ssid, password: creds.password });
  }
  const prev = list[at]!;
  const changed = prev.password !== creds.password || prev.ssid !== ssid;
  return list.map((n, i) =>
    i === at ? { ...prev, ssid, password: creds.password, ...(changed ? { state: "unverified" as JoinState } : {}) } : n,
  );
}

export function removeNetwork(list: readonly SavedNetwork[], ssid: string): SavedNetwork[] {
  return list.filter((n) => n.ssid !== ssid);
}

/** Move `ssid` to the top: it becomes the default. */
export function makeDefaultNetwork(list: readonly SavedNetwork[], ssid: string): SavedNetwork[] {
  const hit = list.find((n) => n.ssid === ssid);
  return hit ? [hit, ...list.filter((n) => n !== hit)] : [...list];
}

/** Move `ssid` by `delta` places (clamped). */
export function moveNetwork(list: readonly SavedNetwork[], ssid: string, delta: number): SavedNetwork[] {
  const from = list.findIndex((n) => n.ssid === ssid);
  if (from < 0) return [...list];
  const to = Math.max(0, Math.min(list.length - 1, from + delta));
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item!);
  return out;
}

/** Parse whatever is stored: tolerate the legacy shape and junk. */
export function parseStoredNetworks(raw: unknown, legacy?: unknown): SavedNetwork[] {
  const ok = (v: unknown): v is SavedNetwork =>
    !!v && typeof v === "object" && typeof (v as SavedNetwork).ssid === "string" && (v as SavedNetwork).ssid !== "";
  if (Array.isArray(raw) && raw.some(ok)) {
    const seen = new Set<string>();
    const out: SavedNetwork[] = [];
    for (const v of raw) {
      if (!ok(v) || seen.has(v.ssid)) continue;
      seen.add(v.ssid);
      const n: SavedNetwork = { ssid: v.ssid, password: typeof v.password === "string" ? v.password : "" };
      if (v.state === "joined" || v.state === "rejected" || v.state === "unverified") n.state = v.state;
      if (typeof v.lastUsed === "number") n.lastUsed = v.lastUsed;
      out.push(n);
    }
    return out;
  }
  if (ok(legacy)) return [{ ssid: legacy.ssid, password: typeof legacy.password === "string" ? legacy.password : "" }];
  return [];
}

// -- the persisted store ------------------------------------------------------

type Listener = () => void;
const listeners = new Set<Listener>();

function readKey(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function write(list: SavedNetwork[]): void {
  try {
    localStorage.setItem(WIFI_LIST_KEY, JSON.stringify(list));
    const first = list[0];
    if (first) localStorage.setItem(WIFI_CACHE_KEY, JSON.stringify({ ssid: first.ssid, password: first.password }));
    else localStorage.removeItem(WIFI_CACHE_KEY);
  } catch {
    // storage blocked (private mode / quota) — non-fatal
  }
  for (const fn of [...listeners]) fn();
}

export const savedNetworks = {
  list(): SavedNetwork[] {
    return parseStoredNetworks(readKey(WIFI_LIST_KEY), readKey(WIFI_CACHE_KEY));
  },
  /** The default network (first), if any. */
  default(): SavedNetwork | undefined {
    return this.list()[0];
  },
  get(ssid: string): SavedNetwork | undefined {
    return this.list().find((n) => n.ssid === ssid);
  },
  /** Save what the user entered and pressed Connect with (D-72). */
  saveOnConnect(creds: WifiCreds): void {
    if (!creds.ssid.trim()) return;
    write(upsertNetwork(this.list(), creds, { lastUsed: Date.now() }));
  },
  /** Record the outcome a device reported for `creds`. */
  markResult(creds: WifiCreds, state: JoinState): void {
    if (!creds.ssid.trim()) return;
    write(upsertNetwork(this.list(), creds, { state }));
  },
  edit(oldSsid: string, creds: WifiCreds): void {
    write(editNetwork(this.list(), oldSsid, creds));
  },
  add(creds: WifiCreds): void {
    write(upsertNetwork(this.list(), creds));
  },
  remove(ssid: string): void {
    write(removeNetwork(this.list(), ssid));
  },
  makeDefault(ssid: string): void {
    write(makeDefaultNetwork(this.list(), ssid));
  },
  move(ssid: string, delta: number): void {
    write(moveNetwork(this.list(), ssid, delta));
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
