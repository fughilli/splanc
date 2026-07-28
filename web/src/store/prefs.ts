/**
 * Small preferences wrapped over localStorage (design doc §5.3 / §7.5). These
 * are the existing keys the capture app already used, centralized so screens
 * never touch localStorage directly.
 */

/** Last WiFi credentials sent to a player (BLE provisioning), pre-filled on the
 * next setup so re-provisioning doesn't retype the network. */
const WIFI_CACHE_KEY = "ledmapper.wifi";
/** All WiFi networks used for provisioning, most-recent first — the add-device
 * flow offers them as a pick list so common networks are one tap away. */
const WIFI_LIST_KEY = "ledmapper.wifiList";
/** Focal calibration cached by earlier sessions (see main.ts / capture.ts). */
const K_CACHE_KEY = "ledmapper.calibratedK";
/** UI theme (reserved; dark-first today). */
const THEME_KEY = "ledmapper.theme";

export interface WifiCreds {
  ssid: string;
  password: string;
}

export interface CalibratedK {
  k: [number, number, number, number];
  imgW: number;
  imgH: number;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage blocked (private mode / quota) — non-fatal
  }
}

export const prefs = {
  getWifi(): WifiCreds {
    return readJson<WifiCreds>(WIFI_CACHE_KEY, { ssid: "", password: "" });
  },
  setWifi(creds: WifiCreds): void {
    writeJson(WIFI_CACHE_KEY, creds);
  },
  /** Saved WiFi networks, most-recent first (migrates the single-entry cache). */
  getWifiList(): WifiCreds[] {
    const list = readJson<WifiCreds[]>(WIFI_LIST_KEY, []);
    if (Array.isArray(list) && list.length > 0) return list.filter((c) => c && c.ssid);
    const one = this.getWifi();
    return one.ssid ? [one] : [];
  },
  /** Remember a network (dedup by SSID, move to front) + keep the single-entry
   * cache in sync as the most-recent. */
  addWifi(creds: WifiCreds): void {
    if (!creds.ssid) return;
    const list = this.getWifiList().filter((c) => c.ssid !== creds.ssid);
    list.unshift(creds);
    writeJson(WIFI_LIST_KEY, list.slice(0, 8));
    this.setWifi(creds);
  },
  getCalibratedK(): CalibratedK | undefined {
    const raw = readJson<CalibratedK | null>(K_CACHE_KEY, null);
    return raw ?? undefined;
  },
  getTheme(): "dark" | "light" {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  },
  setTheme(theme: "dark" | "light"): void {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* non-fatal */
    }
  },
};
