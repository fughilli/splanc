/**
 * Device metrics ("Send feedback to Fug Studio", docs/design/device-metrics.md):
 * the ONE list of what may ever be sent, shared by
 *
 *   - the app: what it reads from each player (get_device_metrics), which
 *     category a value belongs to, and the "See exactly what's sent" view;
 *   - the relay: the intake validator (agent/relay/src/deviceMetrics.ts) and
 *     the Grafana allowlist (agent/relay/src/ops.ts, component device-metrics).
 *
 * Every value is a number, a boolean, or a short version / closed-vocabulary
 * token. Nothing here can carry a name, an SSID, an IP or MAC, a location,
 * effect code, a map or anything typed by the user. A field that isn't listed
 * here is never sent, and the relay drops it if it shows up anyway.
 *
 * Pure (no DOM, no fetch): imported by the relay too.
 */

export const METRICS_SCHEMA_VERSION = 1;

/** The categories the user switches on one by one (all off by default). */
export const METRIC_CATEGORIES = ["performance", "reliability", "mesh", "usage"] as const;
export type MetricCategory = (typeof METRIC_CATEGORIES)[number];

export const CATEGORY_INFO: Record<MetricCategory, { title: string; summary: string }> = {
  performance: {
    title: "Performance",
    summary: "Frame rates, whether an effect is lagging, free memory and the number of LEDs.",
  },
  reliability: {
    title: "Reliability",
    summary: "Uptime, why a player last restarted, Wi-Fi rejoins and signal strength, and Bluetooth drops.",
  },
  mesh: {
    title: "Mesh",
    summary: "How a mesh of players delivers updates: its mode, size, delivery rate, airtime and relay load.",
  },
  usage: {
    title: "Usage",
    summary: "How many players you have, how often you open the app and which screens you use. Never what you make.",
  },
};

export type MetricKind = "count" | "gauge" | "bool" | "enum";

export interface MetricField {
  /** The wire / Grafana name (snake_case, flat). */
  name: string;
  category: MetricCategory;
  kind: MetricKind;
  /** Shown in "See exactly what's sent". */
  label: string;
  unit?: string;
  /** Upper bound the relay accepts (values above are dropped). */
  max: number;
  /** The camelCase key of the player's device_metrics reply (absent: app-side). */
  wire?: string;
}

const U32 = 0xffff_ffff;

/** Per-player fields: what get_device_metrics returns, in its categories. */
export const DEVICE_FIELDS: readonly MetricField[] = [
  // -- performance ---------------------------------------------------------------
  { name: "fps_target", category: "performance", kind: "gauge", label: "Pinned frame rate (0 = automatic)", unit: "fps", max: 1000, wire: "fpsTarget" },
  { name: "fps_current", category: "performance", kind: "gauge", label: "Frame rate the effect is set to run at", unit: "fps", max: 1000, wire: "fpsCurrent" },
  { name: "fps_achieved", category: "performance", kind: "gauge", label: "Frame rate it really ran at (last ~30 frames)", unit: "fps", max: 1000, wire: "fpsAchieved" },
  { name: "fps_min", category: "performance", kind: "gauge", label: "Lowest automatic frame rate for this strip", unit: "fps", max: 1000, wire: "fpsMin" },
  { name: "fps_max", category: "performance", kind: "gauge", label: "Highest automatic frame rate for this strip", unit: "fps", max: 1000, wire: "fpsMax" },
  { name: "fps_lagging", category: "performance", kind: "bool", label: "The effect is running below its frame rate", max: 1, wire: "fpsLagging" },
  { name: "lag_events", category: "performance", kind: "count", label: "Times an effect started lagging since the player started", max: U32, wire: "lagEvents" },
  { name: "heap_free", category: "performance", kind: "gauge", label: "Free memory now", unit: "bytes", max: 64 * 1024 * 1024, wire: "heapFree" },
  { name: "heap_min_free", category: "performance", kind: "gauge", label: "Least free memory since the player started", unit: "bytes", max: 64 * 1024 * 1024, wire: "heapMinFree" },
  { name: "heap_largest_free", category: "performance", kind: "gauge", label: "Largest free memory block", unit: "bytes", max: 64 * 1024 * 1024, wire: "heapLargestFree" },
  { name: "led_count", category: "performance", kind: "gauge", label: "Number of LEDs", max: 65536, wire: "ledCount" },
  // -- reliability ---------------------------------------------------------------
  { name: "uptime_s", category: "reliability", kind: "gauge", label: "Time since the player started", unit: "s", max: U32, wire: "uptimeS" },
  { name: "reset_reason", category: "reliability", kind: "enum", label: "Why the player last started (power on, update, watchdog, crash, brownout...)", max: 32, wire: "resetReason" },
  { name: "boot_count", category: "reliability", kind: "count", label: "Restarts since it was last powered on", max: U32, wire: "bootCount" },
  { name: "wdt_resets", category: "reliability", kind: "count", label: "Watchdog restarts since it was last powered on", max: U32, wire: "wdtResets" },
  { name: "panic_resets", category: "reliability", kind: "count", label: "Crash restarts since it was last powered on", max: U32, wire: "panicResets" },
  { name: "brownout_resets", category: "reliability", kind: "count", label: "Low-power (brownout) restarts since it was last powered on", max: U32, wire: "brownoutResets" },
  { name: "wifi_joins", category: "reliability", kind: "count", label: "Wi-Fi joins since the player started (1 = never dropped)", max: U32, wire: "wifiJoins" },
  { name: "wifi_link_losses", category: "reliability", kind: "count", label: "Wi-Fi connections lost since the player started", max: U32, wire: "wifiLinkLosses" },
  { name: "wifi_rssi_dbm", category: "reliability", kind: "gauge", label: "Wi-Fi signal strength (0 = not known)", unit: "dBm", max: 0, wire: "wifiRssiDbm" },
  { name: "ble_drops", category: "reliability", kind: "count", label: "Bluetooth connections that dropped since the player started", max: U32, wire: "bleDrops" },
  // -- mesh (reported once the mesh stack ships; 0 / absent until then) ----------------
  { name: "mesh_mode", category: "mesh", kind: "enum", label: "Mesh mode (0 none, 1 flood, 2 tree)", max: 8, wire: "meshMode" },
  { name: "mesh_members", category: "mesh", kind: "gauge", label: "Players in the mesh", max: 1024, wire: "meshMembers" },
  { name: "mesh_delivery_permille", category: "mesh", kind: "gauge", label: "Updates delivered to every member (per mille)", max: 1000, wire: "meshDeliveryPermille" },
  { name: "mesh_airtime_permille", category: "mesh", kind: "gauge", label: "Share of airtime the mesh uses (per mille)", max: 1000, wire: "meshAirtimePermille" },
  { name: "mesh_relay_load_permille", category: "mesh", kind: "gauge", label: "Relay load on this player (per mille)", max: 1000, wire: "meshRelayLoadPermille" },
  { name: "mesh_mode_switches", category: "mesh", kind: "count", label: "Flood/tree mode switches since the player started", max: U32, wire: "meshModeSwitches" },
];

/** App-side usage counts (never what was made, named or typed). */
export const USAGE_FIELDS: readonly MetricField[] = [
  { name: "players", category: "usage", kind: "gauge", label: "Players this app knows", max: 1024 },
  { name: "sessions", category: "usage", kind: "count", label: "Times the app was opened since the last upload", max: 10_000 },
  { name: "effects_deployed", category: "usage", kind: "count", label: "Effects sent to a player since the last upload", max: 100_000 },
  { name: "screen_play", category: "usage", kind: "count", label: "Play screen opened", max: 100_000 },
  { name: "screen_editor", category: "usage", kind: "count", label: "Effect editor opened", max: 100_000 },
  { name: "screen_mapping", category: "usage", kind: "count", label: "Mapping (capture) opened", max: 100_000 },
  { name: "screen_maps", category: "usage", kind: "count", label: "Maps opened", max: 100_000 },
  { name: "screen_settings", category: "usage", kind: "count", label: "Settings opened", max: 100_000 },
];

/** Usage screen keys the app counts (USAGE_FIELDS screen_<key>). */
export const USAGE_SCREENS = ["play", "editor", "mapping", "maps", "settings"] as const;
export type UsageScreen = (typeof USAGE_SCREENS)[number];

export const PLATFORMS = ["web", "ios", "android"] as const;
export const TRANSPORTS = ["wss", "ble", "lan"] as const;

/** Install / device pseudonyms: random, rotatable, never derived from an account. */
export const PSEUDONYM_RE = /^[A-Za-z0-9_-]{12,24}$/;
export const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9_.+\-]{0,31}$/;
export const BOARD_RE = /^[a-z0-9][a-z0-9_-]{0,15}$/;

/** Caps on one upload (the relay refuses anything bigger). */
export const MAX_DEVICES = 32;
export const MAX_UPLOAD_BYTES = 24 * 1024;

/** One player's sample in an upload. Only the opted-in categories' fields are set. */
export interface DeviceSample {
  dev: string;
  fw: string;
  board: string;
  transport: (typeof TRANSPORTS)[number];
  /** Seconds between this sample and the upload (samples are taken while connected). */
  age_s: number;
  [field: string]: string | number | boolean;
}

export interface MetricsUpload {
  schema: number;
  install: string;
  app: string;
  platform: (typeof PLATFORMS)[number];
  categories: MetricCategory[];
  devices: DeviceSample[];
  usage?: Record<string, number>;
}

const FIELD_BY_NAME = new Map<string, MetricField>([...DEVICE_FIELDS, ...USAGE_FIELDS].map((f) => [f.name, f]));
export const fieldByName = (n: string): MetricField | undefined => FIELD_BY_NAME.get(n);

/** A value as the relay keeps it, or undefined (dropped). */
export function keepMetricValue(f: MetricField, v: unknown): number | boolean | undefined {
  if (f.kind === "bool") return typeof v === "boolean" ? v : undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) return undefined;
  if (f.name === "wifi_rssi_dbm") return v >= -127 && v <= 0 ? v : undefined;
  return v >= 0 && v <= f.max ? v : undefined;
}

/**
 * The player's get_device_metrics reply -> the fields of the categories the
 * user enabled (snake_case, validated). Unknown / out-of-range values drop.
 */
export function deviceFieldsFromReply(reply: Record<string, unknown>, cats: ReadonlySet<MetricCategory>): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const f of DEVICE_FIELDS) {
    if (!cats.has(f.category) || !f.wire) continue;
    let v = reply[f.wire];
    if (v === undefined) continue;
    if (f.kind === "bool") v = v === true;
    const k = keepMetricValue(f, v);
    if (k !== undefined) out[f.name] = k;
  }
  // A player without a mesh reports mode 0 and nothing else: send nothing then.
  if (out["mesh_mode"] === 0) for (const f of DEVICE_FIELDS) if (f.category === "mesh") delete out[f.name];
  return out;
}

export type ValidateResult = { ok: true; upload: MetricsUpload; dropped: number } | { ok: false; status: number; message: string };

/**
 * The relay's intake check. Structure errors refuse the upload; a field that
 * isn't allowed (or isn't in an enabled category) is dropped and counted.
 */
export function validateMetricsUpload(text: string): ValidateResult {
  if (new TextEncoder().encode(text).length > MAX_UPLOAD_BYTES) return { ok: false, status: 413, message: `larger than ${MAX_UPLOAD_BYTES} bytes` };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, message: "not JSON" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, status: 400, message: "not an object" };
  const r = raw as Record<string, unknown>;
  if (r["schema"] !== METRICS_SCHEMA_VERSION) return { ok: false, status: 400, message: `schema must be ${METRICS_SCHEMA_VERSION}` };
  if (typeof r["install"] !== "string" || !PSEUDONYM_RE.test(r["install"])) return { ok: false, status: 400, message: "bad install" };
  if (typeof r["app"] !== "string" || !VERSION_RE.test(r["app"])) return { ok: false, status: 400, message: "bad app version" };
  if (!PLATFORMS.includes(r["platform"] as (typeof PLATFORMS)[number])) return { ok: false, status: 400, message: "bad platform" };
  const cats = Array.isArray(r["categories"]) ? (r["categories"] as unknown[]).filter((c): c is MetricCategory => METRIC_CATEGORIES.includes(c as MetricCategory)) : [];
  if (!cats.length) return { ok: false, status: 400, message: "no categories" };
  const on = new Set(cats);
  const devsIn = Array.isArray(r["devices"]) ? (r["devices"] as unknown[]) : [];
  if (devsIn.length > MAX_DEVICES) return { ok: false, status: 400, message: `more than ${MAX_DEVICES} devices` };
  let dropped = 0;
  const devices: DeviceSample[] = [];
  for (const d of devsIn) {
    if (!d || typeof d !== "object") return { ok: false, status: 400, message: "bad device" };
    const o = d as Record<string, unknown>;
    if (typeof o["dev"] !== "string" || !PSEUDONYM_RE.test(o["dev"])) return { ok: false, status: 400, message: "bad dev" };
    const fw = typeof o["fw"] === "string" && VERSION_RE.test(o["fw"]) ? o["fw"] : "unknown";
    const board = typeof o["board"] === "string" && BOARD_RE.test(o["board"]) ? o["board"] : "unknown";
    const transport = TRANSPORTS.includes(o["transport"] as (typeof TRANSPORTS)[number]) ? (o["transport"] as DeviceSample["transport"]) : "wss";
    const age = typeof o["age_s"] === "number" && Number.isInteger(o["age_s"]) && o["age_s"] >= 0 && o["age_s"] <= 30 * 86400 ? o["age_s"] : 0;
    const s: DeviceSample = { dev: o["dev"], fw, board, transport, age_s: age };
    for (const [k, v] of Object.entries(o)) {
      if (k === "dev" || k === "fw" || k === "board" || k === "transport" || k === "age_s") continue;
      const f = FIELD_BY_NAME.get(k);
      const kept = f && f.category !== "usage" && on.has(f.category) ? keepMetricValue(f, v) : undefined;
      if (kept === undefined) dropped++;
      else s[k] = kept;
    }
    devices.push(s);
  }
  const upload: MetricsUpload = { schema: METRICS_SCHEMA_VERSION, install: r["install"], app: r["app"], platform: r["platform"] as MetricsUpload["platform"], categories: cats, devices };
  if (r["usage"] !== undefined) {
    if (!r["usage"] || typeof r["usage"] !== "object") return { ok: false, status: 400, message: "bad usage" };
    if (on.has("usage")) {
      const u: Record<string, number> = {};
      for (const [k, v] of Object.entries(r["usage"] as Record<string, unknown>)) {
        const f = FIELD_BY_NAME.get(k);
        const kept = f && f.category === "usage" ? keepMetricValue(f, v) : undefined;
        if (typeof kept === "number") u[k] = kept;
        else dropped++;
      }
      upload.usage = u;
    } else dropped += Object.keys(r["usage"] as object).length;
  }
  for (const k of Object.keys(r)) if (!["schema", "install", "app", "platform", "categories", "devices", "usage"].includes(k)) dropped++;
  return { ok: true, upload, dropped };
}

/** The install pseudonym is derived from a secret only the app holds, so only
 * that app can ask for its data to be deleted (POST /metrics/delete {secret}). */
export const SECRET_RE = /^[A-Za-z0-9_-]{32,64}$/;

export async function installFromSecret(secret: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`splanc-metrics-install\n${secret}`)));
  let bin = "";
  for (const b of d) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 22);
}
