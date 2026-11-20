/**
 * "Send feedback to Fug Studio" (docs/design/device-metrics.md): the app side.
 *
 * OFF by default. Until the user switches it on, nothing here runs: no timer,
 * no player request, no counting, no network. When on:
 *
 *   - every connected player that serves "device_metrics" is read about every
 *     15 minutes (get_device_metrics: a few hundred bytes, never during a map
 *     capture or an upload; the render loop never sees it); only the latest
 *     sample per player is kept;
 *   - with Usage on, the app counts sessions, effect deploys and which screens
 *     open (counts only);
 *   - about every 6 hours the pending samples are uploaded to the relay
 *     (POST /metrics), retried with exponential backoff (1 h .. 24 h, and the
 *     relay's retry-after) when it fails.
 *
 * Only the fields of the categories the user switched on are read into a sample
 * (metricsSchema.ts deviceFieldsFromReply), and the relay drops anything else
 * again. The install and each player go by random pseudonyms derived from a
 * secret only this app holds; the secret rotates every 30 days, and the last
 * four are kept (just) so "Delete my data" covers every pseudonym the relay could
 * still hold (90-day retention).
 *
 * Storage: localStorage (settings + the pending batch); a blocked storage just
 * means nothing persists and nothing is sent.
 */

import {
  CATEGORY_INFO,
  DEVICE_FIELDS,
  METRICS_SCHEMA_VERSION,
  METRIC_CATEGORIES,
  USAGE_SCREENS,
  deviceFieldsFromReply,
  installFromSecret,
  type DeviceSample,
  type MetricCategory,
  type MetricsUpload,
  type UsageScreen,
} from "./metricsSchema";

export { CATEGORY_INFO, METRIC_CATEGORIES };

const SETTINGS_KEY = "splanc.metrics.v1";
const PENDING_KEY = "splanc.metrics.pending.v1";

export const SAMPLE_EVERY_MS = 15 * 60_000;
export const UPLOAD_EVERY_MS = 6 * 3600_000;
export const ROTATE_EVERY_MS = 30 * 86400_000;
const KEEP_SECRETS_MS = 120 * 86400_000; // > the relay's 90-day retention
const BACKOFF_MIN_MS = 3600_000;
const BACKOFF_MAX_MS = 24 * 3600_000;
const TICK_MS = 60_000;

/** The relay the app sends through (bugs/appBugReport.ts APP_RELAY). */
export const METRICS_RELAY = "https://splanc.pages.dev";

export interface MetricsSettings {
  enabled: boolean;
  categories: Record<MetricCategory, boolean>;
  /** Newest first. */
  secrets: { s: string; since: number }[];
  lastUploadAt: number;
  nextAttemptAt: number;
  failures: number;
  lastResult?: { at: number; ok: boolean; message: string };
  lastSent?: { at: number; payload: MetricsUpload };
  deletion?: { at: number; status: "deleted" | "queued" | "failed"; message: string };
}

interface Pending {
  samples: Record<string, DeviceSample & { taken: number }>;
  usage: Record<string, number>;
}

/** What a collector reads from a connected player. */
export interface MetricsPlayer {
  key: string;
  fw: string;
  transport: "wss" | "ble" | "lan";
  supports: boolean;
  read: () => Promise<Record<string, unknown>>;
}

export interface CollectorDeps {
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  now?: () => number;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  random?: (n: number) => Uint8Array;
  players?: () => MetricsPlayer[];
  app?: () => string;
  platform?: () => MetricsUpload["platform"];
  relay?: string;
  /** false: never start the background timer (tests drive tick() themselves). */
  schedule?: boolean;
}

const NO_CATS = (): Record<MetricCategory, boolean> => ({ performance: false, reliability: false, mesh: false, usage: false });

export function defaultSettings(): MetricsSettings {
  return { enabled: false, categories: NO_CATS(), secrets: [], lastUploadAt: 0, nextAttemptAt: 0, failures: 0 };
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha(s: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}

export class MetricsCollector {
  private readonly d: Required<Omit<CollectorDeps, "storage">> & { storage: CollectorDeps["storage"] };
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private listeners = new Set<() => void>();

  constructor(deps: CollectorDeps = {}) {
    let storage: CollectorDeps["storage"] = null;
    try {
      storage = deps.storage === undefined ? globalThis.localStorage ?? null : deps.storage;
    } catch {
      storage = null;
    }
    this.d = {
      storage,
      now: deps.now ?? Date.now,
      fetch: deps.fetch ?? ((i, init) => fetch(i, init)),
      random: deps.random ?? ((n) => crypto.getRandomValues(new Uint8Array(n))),
      players: deps.players ?? (() => []),
      app: deps.app ?? (() => "0.0.0-dev"),
      platform: deps.platform ?? (() => "web"),
      relay: deps.relay ?? METRICS_RELAY,
      schedule: deps.schedule ?? true,
    };
  }

  // -- settings ------------------------------------------------------------------

  settings(): MetricsSettings {
    try {
      const raw = this.d.storage?.getItem(SETTINGS_KEY);
      if (!raw) return defaultSettings();
      const s = { ...defaultSettings(), ...(JSON.parse(raw) as Partial<MetricsSettings>) };
      s.categories = { ...NO_CATS(), ...s.categories };
      return s;
    } catch {
      return defaultSettings();
    }
  }

  private save(s: MetricsSettings): void {
    try {
      this.d.storage?.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch {
      /* storage blocked: nothing persists */
    }
    for (const l of this.listeners) l();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The categories that are on (empty when sending is off). */
  activeCategories(s = this.settings()): Set<MetricCategory> {
    return new Set(s.enabled ? METRIC_CATEGORIES.filter((c) => s.categories[c]) : []);
  }

  /** The master switch. Turning it on with no category picked turns them all on
   * (the switch alone must send something; each can be turned off after). Off
   * drops whatever was waiting to be sent. */
  setEnabled(on: boolean): void {
    const s = this.settings();
    s.enabled = on;
    if (on) {
      if (!METRIC_CATEGORIES.some((c) => s.categories[c])) s.categories = { performance: true, reliability: true, mesh: true, usage: true };
      this.rotate(s, true);
      s.nextAttemptAt = Math.max(s.nextAttemptAt, this.d.now() + 10 * 60_000);
    } else {
      this.clearPending();
    }
    this.save(s);
    this.sync();
  }

  setCategory(c: MetricCategory, on: boolean): void {
    const s = this.settings();
    s.categories[c] = on;
    this.save(s);
    // Drop what a turned-off category already collected.
    if (!on) this.prunePending(this.activeCategories(s));
    this.sync();
  }

  /** A new secret when none exists or the newest is older than 30 days. */
  private rotate(s: MetricsSettings, ifNone = false): boolean {
    const t = this.d.now();
    const newest = s.secrets[0];
    if (newest && (ifNone || t - newest.since < ROTATE_EVERY_MS)) return false;
    s.secrets = [{ s: b64url(this.d.random(32)), since: t }, ...s.secrets].filter((x) => t - x.since < KEEP_SECRETS_MS).slice(0, 4);
    // A new pseudonym starts a new batch: old samples belong to the old one.
    this.clearPending();
    return true;
  }

  // -- pending batch -------------------------------------------------------------

  private pending(): Pending {
    try {
      const raw = this.d.storage?.getItem(PENDING_KEY);
      const p = raw ? (JSON.parse(raw) as Pending) : null;
      return p && typeof p === "object" ? { samples: p.samples ?? {}, usage: p.usage ?? {} } : { samples: {}, usage: {} };
    } catch {
      return { samples: {}, usage: {} };
    }
  }

  private savePending(p: Pending): void {
    try {
      this.d.storage?.setItem(PENDING_KEY, JSON.stringify(p));
    } catch {
      /* blocked */
    }
  }

  private clearPending(): void {
    try {
      this.d.storage?.removeItem(PENDING_KEY);
    } catch {
      /* blocked */
    }
  }

  private prunePending(cats: Set<MetricCategory>): void {
    const p = this.pending();
    if (!cats.has("usage")) p.usage = {};
    for (const smp of Object.values(p.samples)) {
      for (const f of Object.keys(smp)) {
        if (SAMPLE_KEYS.has(f)) continue;
        const cat = categoryOf(f);
        if (!cat || !cats.has(cat)) delete (smp as Record<string, unknown>)[f];
      }
    }
    this.savePending(p);
  }

  // -- usage counts (no-ops unless Usage is on) -----------------------------------

  countUsage(field: "sessions" | "effects_deployed" | `screen_${UsageScreen}`): void {
    if (!this.activeCategories().has("usage")) return;
    const p = this.pending();
    p.usage[field] = (p.usage[field] ?? 0) + 1;
    this.savePending(p);
  }

  // -- sampling ------------------------------------------------------------------

  /** Read every connected player due a sample. Returns how many were read. */
  async sampleNow(force = false): Promise<number> {
    const cats = this.activeCategories();
    const devCats = new Set([...cats].filter((c) => c !== "usage"));
    if (!devCats.size) return 0;
    const s = this.settings();
    const secret = s.secrets[0]?.s;
    if (!secret) return 0;
    let n = 0;
    for (const pl of this.d.players()) {
      if (!pl.supports) continue;
      const dev = (await sha(`${secret}\ndev\n${pl.key}`)).slice(0, 16);
      const p = this.pending();
      const prev = p.samples[dev];
      if (!force && prev && this.d.now() - prev.taken < SAMPLE_EVERY_MS) continue;
      let reply: Record<string, unknown>;
      try {
        reply = await pl.read();
      } catch {
        continue; // busy / older firmware: try next tick
      }
      const fields = deviceFieldsFromReply(reply, devCats);
      const board = typeof reply["board"] === "string" && /^[a-z0-9][a-z0-9_-]{0,15}$/.test(reply["board"]) ? reply["board"] : "unknown";
      const fresh = this.pending(); // re-read: a concurrent tick may have written
      fresh.samples[dev] = { dev, fw: pl.fw || "unknown", board, transport: pl.transport, age_s: 0, taken: this.d.now(), ...fields };
      this.savePending(fresh);
      n++;
    }
    return n;
  }

  // -- the upload ----------------------------------------------------------------

  /** Exactly what the next upload would send (null: nothing to send). Shown
   * verbatim in "See exactly what's sent". */
  async nextUpload(): Promise<MetricsUpload | null> {
    const s = this.settings();
    const cats = this.activeCategories(s);
    if (!cats.size || !s.secrets[0]) return null;
    const p = this.pending();
    const t = this.d.now();
    const devices: DeviceSample[] = Object.values(p.samples).map(({ taken, ...smp }) => ({ ...smp, age_s: Math.max(0, Math.round((t - taken) / 1000)) }));
    const usage = cats.has("usage") ? { ...p.usage, players: this.d.players().length } : undefined;
    if (!devices.length && !(usage && Object.keys(p.usage).length)) return null;
    return {
      schema: METRICS_SCHEMA_VERSION,
      install: await installFromSecret(s.secrets[0].s),
      app: this.d.app(),
      platform: this.d.platform(),
      categories: METRIC_CATEGORIES.filter((c) => cats.has(c)),
      devices,
      ...(usage ? { usage } : {}),
    };
  }

  /** Upload the pending batch now (the scheduler calls it when due). */
  async uploadNow(): Promise<{ ok: boolean; message: string }> {
    const payload = await this.nextUpload();
    if (!payload) return { ok: true, message: "Nothing to send yet." };
    const t = this.d.now();
    let res: Response;
    try {
      res = await this.d.fetch(`${this.d.relay.replace(/\/+$/, "")}/metrics`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        // No cookies or credentials: the upload is tied to nothing but its pseudonym.
        credentials: "omit",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return this.failed(t, 0, "Couldn't reach the server; it tries again later.");
    }
    if (res.status === 202) {
      this.clearPending();
      const s = this.settings();
      s.lastUploadAt = t;
      s.nextAttemptAt = t + UPLOAD_EVERY_MS;
      s.failures = 0;
      s.lastSent = { at: t, payload };
      s.lastResult = { at: t, ok: true, message: "Sent." };
      this.save(s);
      return { ok: true, message: "Sent." };
    }
    if (res.status === 410) {
      // This pseudonym was deleted on request: start a new one, drop the batch.
      const s = this.settings();
      s.secrets = [];
      this.rotate(s, true);
      this.save(s);
      return this.failed(t, 410, "Started a new pseudonym after a deletion.");
    }
    const ra = Number(res.headers.get("retry-after") ?? "");
    return this.failed(t, res.status, res.status === 503 ? "The server isn't collecting right now." : `The server answered ${res.status}.`, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0);
  }

  private failed(t: number, status: number, message: string, retryAfterMs = 0): { ok: boolean; message: string } {
    const s = this.settings();
    s.failures = Math.min(s.failures + 1, 10);
    const backoff = status === 503 ? BACKOFF_MAX_MS : Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (s.failures - 1));
    s.nextAttemptAt = t + Math.max(backoff, retryAfterMs);
    s.lastResult = { at: t, ok: false, message };
    this.save(s);
    return { ok: false, message };
  }

  // -- delete my data ------------------------------------------------------------

  /** Ask the relay to delete everything sent under every pseudonym this app
   * still knows, then forget them. Sending is switched off. */
  async deleteMyData(): Promise<{ status: "deleted" | "queued" | "failed" | "nothing"; message: string }> {
    const s = this.settings();
    if (!s.secrets.length && !s.lastSent) {
      this.clearPending();
      return { status: "nothing", message: "Nothing was ever sent from this app." };
    }
    let worst: "deleted" | "queued" | "failed" = "deleted";
    let message = "";
    for (const { s: secret } of s.secrets) {
      try {
        const res = await this.d.fetch(`${this.d.relay.replace(/\/+$/, "")}/metrics/delete`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ secret }),
          credentials: "omit",
          signal: AbortSignal.timeout(20_000),
        });
        const j = (await res.json().catch(() => ({}))) as { status?: string; message?: string };
        if (res.status !== 202) {
          worst = "failed";
          message = j.message ?? `The server answered ${res.status}.`;
        } else if (j.status === "queued" && worst === "deleted") {
          worst = "queued";
          message = j.message ?? "";
        } else if (worst === "deleted") message = j.message ?? "";
      } catch {
        worst = "failed";
        message = "Couldn't reach the server. Nothing was deleted yet; try again.";
      }
    }
    const t = this.d.now();
    if (worst === "failed") {
      s.deletion = { at: t, status: worst, message };
      this.save(s);
      return { status: worst, message };
    }
    const after = defaultSettings();
    after.categories = s.categories;
    after.deletion = { at: t, status: worst, message };
    this.clearPending();
    this.save(after);
    this.sync();
    return { status: worst, message };
  }

  // -- scheduler -----------------------------------------------------------------

  /** Start or stop the background tick to match the switch (zero cost when off). */
  sync(): void {
    const on = this.d.schedule && this.activeCategories().size > 0;
    if (on && !this.timer) {
      this.timer = setInterval(() => void this.tick(), TICK_MS);
      this.first = setTimeout(() => void this.tick(), 15_000);
    } else if (!on) {
      this.stop();
    }
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const s = this.settings();
      if (!this.activeCategories(s).size) return;
      if (this.rotate(s)) this.save(s);
      await this.sampleNow();
      if (this.d.now() >= this.settings().nextAttemptAt) await this.uploadNow();
    } finally {
      this.busy = false;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
    this.timer = null;
    this.first = null;
  }
}

const SAMPLE_KEYS = new Set(["dev", "fw", "board", "transport", "age_s", "taken"]);

/** The category a device field belongs to (undefined: not a field). */
function categoryOf(name: string): MetricCategory | undefined {
  return DEVICE_FIELDS.find((f) => f.name === name)?.category;
}

/** Screen a hash route counts as, for Usage (undefined: not counted). */
export function usageScreenFor(hash: string): UsageScreen | undefined {
  const p = hash.replace(/^#/, "").split("?")[0] ?? "";
  if (p.startsWith("/play")) return "play";
  if (p.startsWith("/effects/edit")) return "editor";
  if (p.startsWith("/capture")) return "mapping";
  if (p === "/maps" || p.startsWith("/map/")) return "maps";
  if (p.startsWith("/settings")) return "settings";
  return USAGE_SCREENS.includes(p.slice(1) as UsageScreen) ? (p.slice(1) as UsageScreen) : undefined;
}
