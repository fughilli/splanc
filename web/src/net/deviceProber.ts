/**
 * Background device-liveness prober. Very lazy on purpose: it probes ONE known
 * device per tick over the wss the app already uses (reading the device's
 * `welcome` → MAC + name), starting at one request/minute and backing off to one
 * request every ten minutes while things are stable. The work is deferred to
 * `requestIdleCallback` and paused while the tab is hidden, so liveness checks
 * never contend with the foreground.
 *
 * Reachability + the folded-in identity feed the device sheet's status dots and
 * connect affordances; the sheet subscribes and calls `refresh()` when opened.
 */

import { LedMapperClient } from "./client";
import { deviceStore } from "../store/deviceStore";

const MIN_INTERVAL = 60_000; // one request / minute
const MAX_INTERVAL = 600_000; // backs off to one / ten minutes
const PROBE_TIMEOUT = 4_000;

export interface ProbeInfo {
  mac: string;
  deviceName: string;
}

/** Open a transient wss to read a device's welcome (MAC + name), then close.
 * Null if it can't be reached (untrusted cert, offline, timeout). */
export async function probeDevice(wssUrl: string): Promise<ProbeInfo | null> {
  const client = new LedMapperClient(wssUrl);
  try {
    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error("probe timeout")), PROBE_TIMEOUT),
    );
    await Promise.race([client.connect(), timeout]);
    const w = client.welcome;
    return w ? { mac: w.mac, deviceName: w.deviceName } : null;
  } catch {
    return null;
  } finally {
    client.close();
  }
}

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
};

class DeviceProber {
  private reachable = new Map<string, ProbeInfo>();
  private interval = MIN_INTERVAL;
  private timer: number | null = null;
  private idx = 0;
  private running = false;
  private listeners = new Set<() => void>();

  isReachable(id: string): boolean {
    return this.reachable.has(id);
  }
  info(id: string): ProbeInfo | undefined {
    return this.reachable.get(id);
  }
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Begin the lazy background loop (idempotent). */
  start(): void {
    if (this.running) return;
    this.running = true;
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) this.refresh(); // catch up when the tab comes back
    });
    this.schedule(3_000); // first probe shortly after boot
  }

  /** Reset the backoff and probe soon — call when the device UI opens or the
   * device list changes, so a fresh look is responsive. */
  refresh(): void {
    this.interval = MIN_INTERVAL;
    this.schedule(400);
  }

  private schedule(delay: number): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.onTimer(), delay);
  }

  private onTimer(): void {
    if (document.hidden) {
      this.schedule(this.interval); // stay idle while backgrounded
      return;
    }
    // Defer the probe to idle time so it never competes with foreground paint.
    const run = (): void => void this.tick();
    const w = window as IdleWindow;
    if (typeof w.requestIdleCallback === "function") w.requestIdleCallback(run, { timeout: 3_000 });
    else run();
  }

  private async tick(): Promise<void> {
    const activeId = deviceStore.activeId();
    const devices = deviceStore.list().filter((d) => d.id !== activeId);
    if (devices.length === 0) {
      this.schedule(this.interval);
      return;
    }
    const dev = devices[this.idx % devices.length]!;
    this.idx++;
    const was = this.reachable.get(dev.id);
    const info = await probeDevice(dev.wssUrl);
    let changed = false;
    if (info) {
      if (!was || was.mac !== info.mac || was.deviceName !== info.deviceName) changed = true;
      this.reachable.set(dev.id, info);
      deviceStore.applyWelcome(dev.id, info);
    } else if (was) {
      this.reachable.delete(dev.id);
      changed = true;
    }
    // A change means the picture is moving — poll briskly again; otherwise ease
    // off toward the 10-minute cadence.
    this.interval = changed ? MIN_INTERVAL : Math.min(MAX_INTERVAL, this.interval * 2);
    if (changed) this.emit();
    this.schedule(this.interval);
  }
}

export const deviceProber = new DeviceProber();
