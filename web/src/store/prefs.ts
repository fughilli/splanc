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
/** Last LED count chosen in the "New map" dialog — prefills the next capture. */
const LED_COUNT_KEY = "ledmapper.captureLedCount";
/** Upper bound (ms) of the MANUAL camera-exposure slider. The auto/servo path
 * stays Nyquist-capped (bitPeriodMs/2) for decode integrity; this only widens
 * the manual override so the frame can be brought up under artificial light. */
const EXPOSURE_CEILING_KEY = "ledmapper.manualExposureCeilingMs";

/** Set once the user dismisses the Effects-tab AI-generation hint. */
const AI_HINT_KEY = "ledmapper.aiHintDismissed";
/** Default manual-exposure ceiling (ms) — generous headroom over a typical
 * Nyquist cap so a well-lit frame is reachable without changing the setting. */
export const DEFAULT_MANUAL_EXPOSURE_CEILING_MS = 250;

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
  /** Last LED count entered in the New-map dialog, or undefined if never set. */
  getCaptureLedCount(): number | undefined {
    const raw = localStorage.getItem(LED_COUNT_KEY);
    const n = raw === null ? NaN : parseInt(raw, 10);
    return Number.isFinite(n) && n >= 1 ? n : undefined;
  },
  setCaptureLedCount(n: number): void {
    if (!Number.isFinite(n) || n < 1) return;
    try {
      localStorage.setItem(LED_COUNT_KEY, String(Math.round(n)));
    } catch {
      /* non-fatal */
    }
  },
  /** Manual-exposure slider ceiling in ms (see EXPOSURE_CEILING_KEY). */
  getManualExposureCeilingMs(): number {
    const raw = localStorage.getItem(EXPOSURE_CEILING_KEY);
    const n = raw === null ? NaN : parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MANUAL_EXPOSURE_CEILING_MS;
  },
  setManualExposureCeilingMs(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    try {
      localStorage.setItem(EXPOSURE_CEILING_KEY, String(Math.round(ms)));
    } catch {
      /* non-fatal */
    }
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
  /** Whether the user has dismissed the first-run "configure AI generation"
   * hint on the Effects tab. Once dismissed it never shows again. */
  getAiHintDismissed(): boolean {
    return localStorage.getItem(AI_HINT_KEY) === "1";
  },
  setAiHintDismissed(): void {
    try {
      localStorage.setItem(AI_HINT_KEY, "1");
    } catch {
      /* non-fatal */
    }
  },
};
