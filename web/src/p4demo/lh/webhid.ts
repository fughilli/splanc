/**
 * Vive tracking over WebHID: a Watchman dongle (or a wired tracker) read by the
 * page, tracked by @lighthouse's lh_device + lh_kernel in wasm (//web/lh_wasm,
 * served at /lh-wasm/, run in its worker). Implements {@link LhTracking}.
 *
 * WebHID is asynchronous; the lighthouse handshake (lh_device::handshake) is a
 * synchronous loop over a `Link`. The wasm side replays that handshake from the
 * start over the answers gathered so far and stops at the first request it has no
 * answer for (web/lh_wasm/src/core.rs): each `handshake` call returns the next
 * step (SETs to send, a delay, one GET), this file performs it with
 * sendFeatureReport / receiveFeatureReport and hands the GET's answer back, until
 * the step is "ready" (or "failed": a dongle without its tracker; retried every
 * 0.5 s, as lhd does). Input reports then go to the wasm with their arrival time
 * (the event's timeStamp, performance.now() ms), which maps the tracker's clock
 * onto the page's, so each pose's `t` is on performance.now().
 *
 * The calibration (lhd's calibration.json format) is kept in localStorage and
 * loaded as station priors on connect, so a reload doesn't recalibrate.
 */

import {
  defaultStorage,
  formatCalibration,
  fromCalibratedEvent,
  loadStored,
  parseCalibration,
  saveStored,
  stationsOf,
  type LhdCalibration,
  type StorageLike,
} from "./calibration";
import { loadBrowserEngine, type EngineOptions, type LhEngine, type LhEvent } from "./engine";
import type { LhPose, LhStation, LhStatus, LhTracking, Quat, Vec3 } from "./types";

// --------------------------------------------------------------- WebHID (the subset used)

export interface HidInputReportEventLike {
  reportId: number;
  data: DataView;
  /** performance.now() ms when the report arrived. */
  timeStamp?: number;
}

export interface HidDeviceLike {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName?: string;
  readonly opened: boolean;
  readonly collections?: ReadonlyArray<{ featureReports?: ReadonlyArray<unknown> }>;
  open(): Promise<void>;
  close(): Promise<void>;
  sendFeatureReport(reportId: number, data: BufferSource): Promise<void>;
  receiveFeatureReport(reportId: number): Promise<DataView>;
  addEventListener(type: "inputreport", listener: (ev: HidInputReportEventLike) => void): void;
  removeEventListener(type: "inputreport", listener: (ev: HidInputReportEventLike) => void): void;
}

export interface HidLike {
  requestDevice(options: { filters: Array<{ vendorId: number; productId?: number }> }): Promise<HidDeviceLike[]>;
  addEventListener(type: "disconnect", listener: (ev: { device: HidDeviceLike }) => void): void;
  removeEventListener(type: "disconnect", listener: (ev: { device: HidDeviceLike }) => void): void;
}

export const VALVE_VID = 0x28de;
/** Watchman dongle, Knuckles dongle, Tracker (2018 / 3.0) wired, Tracker (2017) wired. */
export const VIVE_PIDS = [0x2101, 0x2102, 0x2300, 0x2022] as const;
const WIRED_PIDS = new Set([0x2300, 0x2022]);

/** Why there's no WebHID here, or null if there is. */
export function webHidUnavailable(hid: unknown = (globalThis as { navigator?: { hid?: unknown } }).navigator?.hid): string | null {
  if (hid) return null;
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    return "WebHID needs a secure context (https or localhost)";
  }
  return (
    "WebHID is not available in this browser. Desktop Chrome/Edge have it; on Android " +
    "Chrome (154+, Android 17+) it's a developer trial: enable chrome://flags/#enable-experimental-web-platform-features " +
    "(or the WebHID flag) and reload"
  );
}

/** The status for a device picker that came back empty. On Android before 17 (API 37),
 * or with the system's HID access toggle for Chrome off, navigator.hid exists but
 * requestDevice() always resolves to an empty list, so say so there. */
export function noDeviceChosenDetail(
  userAgent: string = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? "",
): string {
  if (!/Android/i.test(userAgent)) return "no Vive device chosen";
  return (
    "no Vive device chosen. If the picker showed nothing: WebHID on Android needs Android 17 " +
    "or later and the system's HID access setting turned on for Chrome"
  );
}

// --------------------------------------------------------------- options

export interface WebHidTrackingDeps {
  /** navigator.hid by default; null = none (status says so). */
  hid?: HidLike | null;
  /** The wasm engine (default: /lh-wasm/ in its worker). */
  loadEngine?: (opts: EngineOptions) => Promise<LhEngine>;
  /** localStorage by default; null = don't persist. */
  storage?: StorageLike | null;
  /** The page clock (ms), performance.now() by default. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Housekeeping period (ms; quiet trackers, pose health). 0 = none. Default 100. */
  tickMs?: number;
  /** Batch input reports into one engine message per macrotask (the worker). Default true. */
  batchReports?: boolean;
  /** Engine options (default: host clock + streamed sweeps, as the P4 player). */
  engine?: EngineOptions;
}

interface Group {
  handle: number;
  pid: number;
  wired: boolean;
  devices: HidDeviceLike[];
  /** The interface that answers feature reports. */
  feature: HidDeviceLike;
  listeners: Array<[HidDeviceLike, (ev: HidInputReportEventLike) => void]>;
  configured: boolean;
  serial: string;
  failure: string | null;
  looping: boolean;
  /** Does this browser's receiveFeatureReport include the report id? Decided on the first answer. */
  idIncluded: boolean | null;
}

type HandshakeStep =
  | { step: "pending"; sets: number[][]; delay_ms: number; get: number; len: number }
  | { step: "ready"; sets: number[][]; serial: string }
  | { step: "failed"; why: string };

/** Interface number from a wired tracker's report id (lh_protocol::usb). */
function wiredInterface(reportId: number): number {
  if (reportId === 0x25 || reportId === 0x21) return 1;
  if (reportId === 0x01) return 2;
  return 0;
}

const HEALTH_NAMES = ["lost", "uncertain", "acquiring", "coasting", "locked"];

class WebHidTracking implements LhTracking {
  private readonly hid: HidLike | null;
  private readonly storage: StorageLike | null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly tickMs: number;
  private readonly batch: boolean;
  private readonly engineOpts: EngineOptions;
  private readonly loadEngine: (opts: EngineOptions) => Promise<LhEngine>;

  private engine: LhEngine | null = null;
  private enginePromise: Promise<LhEngine> | null = null;
  private groups: Group[] = [];
  private calib: LhdCalibration | null;
  /** lh_health state per serial (0 lost … 4 locked) and whether the kernel tracks it. */
  private health = new Map<string, number>();
  private tracked = new Map<string, boolean>();
  private everTracked = false;
  private lastSkip: string | null = null;
  private status: LhStatus = { state: "disconnected" };
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private queue: Uint8Array[] = [];
  private queued = 0;
  private flushScheduled = false;

  private readonly poseCbs = new Set<(p: LhPose) => void>();
  private readonly stationCbs = new Set<(s: LhStation[]) => void>();
  private readonly statusCbs = new Set<(s: LhStatus) => void>();
  private readonly buttonCbs = new Set<(serial: string, mask: number) => void>();

  private readonly onDisconnect = (ev: { device: HidDeviceLike }) => {
    const g = this.groups.find((x) => x.devices.includes(ev.device));
    if (g) void this.dropGroup(g, false);
  };

  constructor(deps: WebHidTrackingDeps) {
    this.hid =
      deps.hid !== undefined ? deps.hid : ((globalThis as { navigator?: { hid?: HidLike } }).navigator?.hid ?? null);
    this.storage = deps.storage !== undefined ? deps.storage : defaultStorage();
    this.now = deps.now ?? (() => performance.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.tickMs = deps.tickMs ?? 100;
    this.batch = deps.batchReports ?? true;
    this.engineOpts = deps.engine ?? {};
    this.loadEngine = deps.loadEngine ?? ((o) => loadBrowserEngine(o));
    this.calib = loadStored(this.storage);
    const why = webHidUnavailable(this.hid);
    if (why) this.status = { state: "disconnected", detail: why };
  }

  // ------------------------------------------------------------- LhTracking

  async connect(): Promise<void> {
    const why = webHidUnavailable(this.hid);
    if (why || !this.hid) {
      this.setStatus({ state: "disconnected", detail: why ?? "no WebHID" });
      throw new Error(why ?? "no WebHID");
    }
    // requestDevice first: it needs the click's user activation, which an await before
    // it (loading the wasm) could outlive.
    let picked: HidDeviceLike[];
    try {
      picked = await this.hid.requestDevice({ filters: VIVE_PIDS.map((productId) => ({ vendorId: VALVE_VID, productId })) });
    } catch (e) {
      this.setStatus({ state: "disconnected", detail: `device picker: ${e instanceof Error ? e.message : String(e)}` });
      throw e;
    }
    picked = picked.filter((d) => d.vendorId === VALVE_VID && (VIVE_PIDS as readonly number[]).includes(d.productId));
    picked = picked.filter((d) => !this.groups.some((g) => g.devices.includes(d)));
    if (picked.length === 0) {
      if (this.groups.length === 0) this.setStatus({ state: "disconnected", detail: noDeviceChosenDetail() });
      return;
    }
    this.setStatus({ state: "connecting", detail: "loading the tracker" });
    const engine = await this.ensureEngine();
    this.hid.removeEventListener("disconnect", this.onDisconnect);
    this.hid.addEventListener("disconnect", this.onDisconnect);

    // One group per physical device: a dongle is one HID interface; a wired tracker
    // shows up as several (IMU, lightcap, buttons) with the same product id.
    const groups: Array<{ first: HidDeviceLike; devices: HidDeviceLike[] }> = [];
    for (const d of picked) {
      const g = WIRED_PIDS.has(d.productId) ? groups.find((x) => x.first.productId === d.productId) : undefined;
      if (g) g.devices.push(d);
      else groups.push({ first: d, devices: [d] });
    }
    for (const { first, devices } of groups) {
      try {
        for (const d of devices) if (!d.opened) await d.open();
      } catch (e) {
        this.setStatus({ state: "disconnected", detail: `opening ${first.productName ?? "device"}: ${e instanceof Error ? e.message : String(e)}` });
        continue;
      }
      const pid = first.productId;
      const handle = await engine.call<number>("add_device", VALVE_VID, pid);
      if (!handle) continue;
      const feature = devices.find((d) => (d.collections ?? []).some((c) => (c.featureReports?.length ?? 0) > 0)) ?? first;
      const g: Group = {
        handle,
        pid,
        wired: WIRED_PIDS.has(pid),
        devices,
        feature,
        listeners: [],
        configured: false,
        serial: "",
        failure: null,
        looping: false,
        idIncluded: null,
      };
      for (const d of devices) {
        const l = (ev: HidInputReportEventLike) => this.onInput(g, ev);
        d.addEventListener("inputreport", l);
        g.listeners.push([d, l]);
      }
      this.groups.push(g);
      void this.handshakeLoop(g);
    }
    this.startTick();
    this.recompute();
  }

  async disconnect(): Promise<void> {
    const groups = [...this.groups];
    for (const g of groups) await this.dropGroup(g, true);
    this.stopTick();
    this.hid?.removeEventListener("disconnect", this.onDisconnect);
    this.recompute();
  }

  onPose(cb: (p: LhPose) => void): () => void {
    this.poseCbs.add(cb);
    return () => this.poseCbs.delete(cb);
  }

  onStations(cb: (s: LhStation[]) => void): () => void {
    this.stationCbs.add(cb);
    return () => this.stationCbs.delete(cb);
  }

  onStatus(cb: (s: LhStatus) => void): () => void {
    this.statusCbs.add(cb);
    cb(this.status);
    return () => this.statusCbs.delete(cb);
  }

  onButtons(cb: (serial: string, mask: number) => void): () => void {
    this.buttonCbs.add(cb);
    return () => this.buttonCbs.delete(cb);
  }

  stations(): LhStation[] {
    return stationsOf(this.calib);
  }

  exportCalibration(): string {
    return formatCalibration(this.calib ?? { version: 1, stations: [] });
  }

  importCalibration(json: string): void {
    const c = parseCalibration(json);
    this.calib = c;
    saveStored(this.storage, c);
    if (this.engine) this.pushPriors(this.engine, c);
    this.emitStations();
    this.recompute();
  }

  recalibrate(): void {
    this.calib = null;
    saveStored(this.storage, null);
    this.everTracked = false;
    this.health.clear();
    this.tracked.clear();
    this.engine?.send("reset");
    this.emitStations();
    this.recompute();
  }

  // ------------------------------------------------------------- engine

  private ensureEngine(): Promise<LhEngine> {
    if (!this.enginePromise) {
      this.enginePromise = this.loadEngine(this.engineOpts).then(
        (e) => {
          this.engine = e;
          e.onEvents((evs) => this.onEvents(evs));
          // The saved calibration first, before any device (as lhd --calibration).
          if (this.calib) this.pushPriors(e, this.calib);
          return e;
        },
        (err) => {
          this.enginePromise = null;
          this.setStatus({ state: "disconnected", detail: `loading the tracker: ${err instanceof Error ? err.message : String(err)}` });
          throw err;
        },
      );
    }
    return this.enginePromise;
  }

  private pushPriors(e: LhEngine, c: LhdCalibration): void {
    for (const s of c.stations) {
      const cal = s.cal ? Float64Array.from(s.cal.flat()) : new Float64Array(0);
      e.send("station_prior", s.id, Float64Array.from(s.pose), Float64Array.from(s.cov), cal);
    }
  }

  // ------------------------------------------------------------- handshake

  private async handshakeLoop(g: Group): Promise<void> {
    if (g.looping) return;
    g.looping = true;
    try {
      while (this.groups.includes(g) && !g.configured) {
        const engine = await this.ensureEngine();
        const step = JSON.parse(await engine.call<string>("handshake", g.handle)) as HandshakeStep;
        if (step.step !== "failed") for (const s of step.sets) await this.setFeature(g, s);
        if (step.step === "ready") {
          g.configured = true;
          g.serial = step.serial;
          g.failure = null;
          break;
        }
        if (step.step === "failed") {
          // A dongle answers only while its tracker is on and paired.
          g.failure = step.why;
          this.recompute();
          await this.sleep(500);
          continue;
        }
        if (step.delay_ms > 0) await this.sleep(step.delay_ms);
        const [status, bytes] = await this.getFeature(g, step.get);
        if (!this.groups.includes(g)) break;
        await engine.call("handshake_answer", g.handle, step.get, status, bytes);
      }
    } catch (e) {
      g.failure = e instanceof Error ? e.message : String(e);
    } finally {
      g.looping = false;
      this.recompute();
    }
  }

  private async setFeature(g: Group, data: number[]): Promise<void> {
    try {
      await g.feature.sendFeatureReport(data[0] ?? 0, Uint8Array.from(data.slice(1)));
    } catch (e) {
      // lh_device ignores SET results too (a wired tracker may re-enumerate on its first).
      console.warn("lh: SET_FEATURE", data[0], e);
    }
  }

  /** [status (0 ok, 1 NAK, 2 gone), reply with the report id first]. */
  private async getFeature(g: Group, id: number): Promise<[number, Uint8Array]> {
    try {
      const dv = await g.feature.receiveFeatureReport(id);
      const b = new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
      // Chrome hands back the report id as the first byte; the spec leaves it open. The
      // dongle's reports are 64 bytes with the id, so a 63-byte reply (or one not
      // starting with the id) has it stripped. Decided once per device.
      if (g.idIncluded === null && b.length > 0) g.idIncluded = b[0] === id && b.length !== 63;
      if (g.idIncluded) return [0, b];
      const out = new Uint8Array(b.length + 1);
      out[0] = id;
      out.set(b, 1);
      return [0, out];
    } catch {
      return [g.feature.opened ? 1 : 2, new Uint8Array(0)];
    }
  }

  // ------------------------------------------------------------- reports

  private onInput(g: Group, ev: HidInputReportEventLike): void {
    if (!g.configured || !this.engine) return;
    const t = ev.timeStamp !== undefined && ev.timeStamp > 0 ? ev.timeStamp : this.now();
    const hostUs = Math.round(t * 1000);
    const iface = g.wired ? wiredInterface(ev.reportId) : 0;
    const n = ev.data.byteLength;
    const rec = new Uint8Array(18 + 1 + n);
    const dv = new DataView(rec.buffer);
    dv.setUint32(0, g.handle, true);
    dv.setInt32(4, iface, true);
    dv.setFloat64(8, hostUs, true);
    dv.setUint16(16, n + 1, true);
    rec[18] = ev.reportId;
    rec.set(new Uint8Array(ev.data.buffer, ev.data.byteOffset, n), 19);
    if (!this.batch) {
      this.engine.send("reports", rec);
      return;
    }
    this.queue.push(rec);
    this.queued += rec.length;
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      setTimeout(() => this.flush(), 0);
    }
  }

  private flush(): void {
    this.flushScheduled = false;
    if (!this.engine || this.queue.length === 0) return;
    const packed = new Uint8Array(this.queued);
    let o = 0;
    for (const r of this.queue) {
      packed.set(r, o);
      o += r.length;
    }
    this.queue = [];
    this.queued = 0;
    this.engine.send("reports", packed);
  }

  // ------------------------------------------------------------- housekeeping

  private startTick(): void {
    if (this.tickTimer || this.tickMs <= 0) return;
    this.tickTimer = setInterval(() => void this.tick(), this.tickMs);
  }

  private stopTick(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  /** Quiet trackers (their dongle goes back to handshaking), health aging. */
  async tick(): Promise<void> {
    if (!this.engine) return;
    const redo = await this.engine.call<number[]>("tick", Math.round(this.now() * 1000));
    for (const h of redo) {
      const g = this.groups.find((x) => x.handle === h);
      if (g) {
        g.configured = false;
        void this.handshakeLoop(g);
      }
    }
    this.recompute();
  }

  private async dropGroup(g: Group, close: boolean): Promise<void> {
    this.groups = this.groups.filter((x) => x !== g);
    for (const [d, l] of g.listeners) d.removeEventListener("inputreport", l);
    if (g.serial) {
      this.health.delete(g.serial);
      this.tracked.delete(g.serial);
    }
    if (this.engine) await this.engine.call("remove_device", g.handle).catch(() => undefined);
    if (close) {
      for (const d of g.devices) {
        try {
          if (d.opened) await d.close();
        } catch {
          // already gone
        }
      }
    }
    this.recompute();
  }

  // ------------------------------------------------------------- events → state

  private onEvents(events: LhEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case "pose": {
          const p = e.p as number[];
          const q = e.q as number[];
          const hostUs = e.host_us as number | null;
          const pose: LhPose = {
            serial: e.serial as string,
            t: hostUs !== null && hostUs !== undefined ? hostUs / 1000 : this.now(),
            pos: [p[0], p[1], p[2]] as Vec3,
            quat: [q[0], q[1], q[2], q[3]] as Quat,
            ok: (e.health as number) >= 3,
          };
          for (const cb of this.poseCbs) cb(pose);
          break;
        }
        case "buttons":
          for (const cb of this.buttonCbs) cb(e.serial as string, Number(e.buttons) >>> 0);
          break;
        case "health":
          this.health.set(e.serial as string, e.state as number);
          break;
        case "tracking":
          this.tracked.set(e.serial as string, e.state === "started");
          if (e.state === "started") this.everTracked = true;
          break;
        case "calibrated":
          this.calib = fromCalibratedEvent(e.stations);
          this.lastSkip = null;
          saveStored(this.storage, this.calib);
          this.emitStations();
          break;
        case "calibration_skipped":
          this.lastSkip = String(e.why);
          break;
        case "device":
          if (e.state === "disconnected") {
            const g = this.groups.find((x) => x.handle === e.handle);
            if (g) g.configured = false;
            this.health.delete(e.serial as string);
            this.tracked.delete(e.serial as string);
          }
          break;
        default:
          break;
      }
    }
    this.recompute();
  }

  private emitStations(): void {
    const s = this.stations();
    for (const cb of this.stationCbs) cb(s);
  }

  private recompute(): void {
    const why = webHidUnavailable(this.hid);
    if (why) return this.setStatus({ state: "disconnected", detail: why });
    if (this.groups.length === 0) {
      return this.setStatus({ state: "disconnected", ...(this.status.state === "disconnected" && this.status.detail ? { detail: this.status.detail } : {}) });
    }
    const configured = this.groups.filter((g) => g.configured);
    if (configured.length === 0) {
      const failing = this.groups.find((g) => g.failure);
      if (failing) {
        const kind = failing.wired ? "tracker" : "dongle";
        return this.setStatus({
          state: "no-tracker",
          detail: `${kind} has no tracker answering (${failing.failure}); turn the tracker on (pair it: hold its button until the LED blinks blue)`,
        });
      }
      return this.setStatus({ state: "connecting", detail: "reading the tracker's config" });
    }
    if (!this.calib || this.calib.stations.length === 0) {
      return this.setStatus({
        state: "calibrating",
        detail:
          "set the tracker down, still, where it sees the base stations" + (this.lastSkip ? ` (last try: ${this.lastSkip})` : ""),
      });
    }
    // "tracking" while the kernel tracks a tracker; the detail (and each pose's `ok`) say
    // how far to trust it (lh_health: locked / coasting are poses to follow; uncertain is
    // a fix whose position sigma is past 2 cm, e.g. one far station).
    const tracked = configured.filter((g) => this.tracked.get(g.serial));
    if (tracked.length > 0) {
      let best = 0;
      for (const g of tracked) best = Math.max(best, this.health.get(g.serial) ?? 0);
      return this.setStatus({ state: "tracking", detail: HEALTH_NAMES[best] ?? "acquiring" });
    }
    return this.setStatus({
      state: "lost",
      detail: this.everTracked ? "tracking lost (occluded, or out of the stations' view)" : "looking for the tracker (is it in view of a base station?)",
    });
  }

  private setStatus(s: LhStatus): void {
    if (s.state === this.status.state && s.detail === this.status.detail) return;
    this.status = s;
    for (const cb of this.statusCbs) cb(s);
  }
}

/** Vive tracking over WebHID (see the module doc). `deps` are for tests and tuning. */
export function createWebHidTracking(deps: WebHidTrackingDeps = {}): LhTracking {
  return new WebHidTracking(deps);
}
