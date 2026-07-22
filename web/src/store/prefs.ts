/**
 * Small preferences wrapped over localStorage (design doc §5.3 / §7.5). These
 * are the existing keys the capture app already used, centralized so screens
 * never touch localStorage directly.
 */

/** Last WiFi credentials sent to a player (BLE provisioning), pre-filled on the
 * next setup so re-provisioning doesn't retype the network. */
const WIFI_CACHE_KEY = "ledmapper.wifi";
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
