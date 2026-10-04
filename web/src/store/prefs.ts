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
/** Whether diffuse/strided capture mode is enabled by default. Toggled inline on
 * the capture screen; persisted so re-mapping a diffused fixture never requires
 * re-typing the ?diffuse=1 URL param (which remains an override). */
const DIFFUSE_ENABLED_KEY = "ledmapper.diffuseCapture";
/** App-global diffuse capture-engine parameters (anchor density, local-contrast
 * gain, detection threshold, downscale, flip-V). Surfaced in Behavior Settings;
 * per-device stride lives on the device record instead. URL params override. */
const DIFFUSE_PARAMS_KEY = "ledmapper.diffuseParams";
/** Default manual-exposure ceiling (ms) — generous headroom over a typical
 * Nyquist cap so a well-lit frame is reachable without changing the setting. */
// LEDs are bright: even in a naturally lit room the useful manual range tops out
// well under this, and a high ceiling only wastes slider travel on exposures
// nobody wants (measured on-device 2026-08-17).
export const DEFAULT_MANUAL_EXPOSURE_CEILING_MS = 50;

export interface WifiCreds {
  ssid: string;
  password: string;
}

/** App-global capture-engine parameters for diffuse/strided mode. Stride is NOT
 * here — it's per-device (deviceStore.captureStride). Every field has a safe
 * default reproducing today's behavior, so this store is purely opt-in. */
export interface DiffuseCaptureParams {
  /** Registration anchors per stride phase (>= 3). */
  anchorDensity: number;
  /** Local-contrast (top-hat) prefilter gain; ~1 fully removes the diffuse
   * background. Only applied in diffuse mode. */
  lcGain: number;
  /** Detection threshold in [0,1] used in diffuse mode (low; the top-hat makes
   * detection local so this reads residual contrast, not absolute brightness).
   * Non-diffuse capture keeps its own 0.6 default + servo, untouched by this. */
  threshold: number;
  /** Integer downsample factor for the detect pass (applies in both modes). */
  downscale: number;
  /** Mirror the detection vertically (applies in both modes). */
  flipV: boolean;
}

export const DEFAULT_DIFFUSE_CAPTURE_PARAMS: DiffuseCaptureParams = {
  anchorDensity: 3,
  lcGain: 1.0,
  threshold: 0.18,
  downscale: 2,
  flipV: false,
};

function clampNum(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
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
  /** Whether diffuse/strided capture mode is on by default (the inline capture
   * toggle). A ?diffuse=1 URL param forces it on regardless. */
  getDiffuseEnabled(): boolean {
    return localStorage.getItem(DIFFUSE_ENABLED_KEY) === "1";
  },
  setDiffuseEnabled(on: boolean): void {
    try {
      if (on) localStorage.setItem(DIFFUSE_ENABLED_KEY, "1");
      else localStorage.removeItem(DIFFUSE_ENABLED_KEY);
    } catch {
      /* non-fatal */
    }
  },
  /** App-global diffuse capture-engine parameters, each clamped + defaulted so a
   * missing/garbled field reproduces today's behavior. */
  getDiffuseParams(): DiffuseCaptureParams {
    const raw = readJson<Partial<DiffuseCaptureParams>>(DIFFUSE_PARAMS_KEY, {});
    const d = DEFAULT_DIFFUSE_CAPTURE_PARAMS;
    return {
      anchorDensity: Math.round(clampNum(raw.anchorDensity, 3, 32, d.anchorDensity)),
      lcGain: clampNum(raw.lcGain, 0, 4, d.lcGain),
      threshold: clampNum(raw.threshold, 0.01, 1, d.threshold),
      downscale: Math.round(clampNum(raw.downscale, 1, 8, d.downscale)),
      flipV: typeof raw.flipV === "boolean" ? raw.flipV : d.flipV,
    };
  },
  /** Merge a partial update into the stored diffuse params (re-clamped on read). */
  setDiffuseParams(patch: Partial<DiffuseCaptureParams>): void {
    writeJson(DIFFUSE_PARAMS_KEY, { ...this.getDiffuseParams(), ...patch });
  },
  /** Reset the diffuse capture-engine params to their defaults. */
  resetDiffuseParams(): void {
    try {
      localStorage.removeItem(DIFFUSE_PARAMS_KEY);
    } catch {
      /* non-fatal */
    }
  },
};
