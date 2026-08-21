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
import { connectionRegistry } from "./connectionRegistry";
import { nativeSocketFactory } from "./nativeSocket";
import { deviceStore, type KnownDevice } from "../store/deviceStore";

const MIN_INTERVAL = 60_000; // one request / minute
const MAX_INTERVAL = 600_000; // backs off to one / ten minutes
// Generous on purpose: this device's cold wss handshake (a ~28 KB mbedTLS
// session alloc on a heap-tight, freshly-booted C6 that may still be joining
// WiFi + standing up its TLS server) routinely takes several seconds. At 4 s the
// background prober cut the still-connecting socket ("WebSocket is closed before
// the connection is established") and falsely marked a live device offline until
// it warmed up. The prober is lazy (≥1 min between ticks), so a longer ceiling
// costs nothing and only delays declaring a genuinely-dead device offline.
const PROBE_TIMEOUT = 10_000;

export interface ProbeInfo {
  mac: string;
  deviceName: string;
  fwGitCommit: string;
  fwGitDirty: boolean;
}

/** Read a device's welcome (MAC + name). If a comms client already owns this
 * device's socket, MULTIPLEX onto it (read its welcome — never open a parallel
 * TLS session to a device we're already talking to, which would starve the
 * player's two slots). Otherwise open a transient wss, read the welcome, close.
 * Null if it can't be reached (untrusted cert, offline, timeout) or the owning
 * client is still mid-handshake (unknown yet — don't race it with a probe). */
export async function probeDevice(wssUrl: string): Promise<ProbeInfo | null> {
  const live = connectionRegistry.clientFor(wssUrl);
  if (live) {
    // A comms client owns this device's single socket. Read its welcome for
    // liveness; if it hasn't welcomed yet, report unknown rather than opening a
    // competing handshake.
    const w = live.welcome;
    return w
      ? {
          mac: w.mac,
          deviceName: w.deviceName,
          fwGitCommit: w.fwGitCommit,
          fwGitDirty: w.fwGitDirty,
        }
      : null;
  }
  // Native wrapper: probe through the cert-pinning bridge too (same self-signed
  // wss:// trust as the main client), else the browser WebSocket.
  const factory = nativeSocketFactory();
  const client = new LedMapperClient(
    wssUrl,
    factory ? { socketFactory: factory, certTrustPossible: false } : {},
  );
  try {
    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error("probe timeout")), PROBE_TIMEOUT),
    );
    await Promise.race([client.connect(), timeout]);
    const w = client.welcome;
    return w
      ? {
          mac: w.mac,
          deviceName: w.deviceName,
          fwGitCommit: w.fwGitCommit,
          fwGitDirty: w.fwGitDirty,
        }
      : null;
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

  /** Probe ONE known device right now (bypassing the round-robin + backoff) and
   * notify listeners. Called on disconnect so the row reflects LAN reachability
   * immediately, instead of waiting up to a full interval for the loop to reach
   * the just-freed device. */
  async probeNow(id: string): Promise<void> {
    const dev = deviceStore.list().find((d) => d.id === id);
    if (!dev) return;
    await this.probeOne(dev);
    this.interval = MIN_INTERVAL; // stay brisk after a manual poke
    this.emit();
  }

  /** One-shot poll of every known non-active device (pull-to-refresh). */
  async probeAllNow(): Promise<void> {
    const activeId = deviceStore.activeId();
    const devices = deviceStore.list().filter((d) => d.id !== activeId);
    await Promise.all(devices.map((d) => this.probeOne(d)));
    this.interval = MIN_INTERVAL;
    this.emit();
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

  /** Probe one device: update reachability + folded-in identity; return whether
   * anything changed. Shared by the background tick and the on-demand probes. */
  private async probeOne(dev: KnownDevice): Promise<boolean> {
    const was = this.reachable.get(dev.id);
    const info = await probeDevice(dev.wssUrl);
    if (info) {
      const changed = !was || was.mac !== info.mac || was.deviceName !== info.deviceName;
      this.reachable.set(dev.id, info);
      deviceStore.applyWelcome(dev.id, info);
      return changed;
    }
    if (was) {
      this.reachable.delete(dev.id);
      return true;
    }
    return false;
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
    const changed = await this.probeOne(dev);
    // A change means the picture is moving — poll briskly again; otherwise ease
    // off toward the 10-minute cadence.
    this.interval = changed ? MIN_INTERVAL : Math.min(MAX_INTERVAL, this.interval * 2);
    if (changed) this.emit();
    this.schedule(this.interval);
  }
}

export const deviceProber = new DeviceProber();
