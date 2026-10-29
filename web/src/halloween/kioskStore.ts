/**
 * App-wide kiosk countdown state: follows `appState.client`, reads the device's
 * KioskStatus (from welcome, else a get_kiosk_status on connect), re-syncs on
 * each push, and restarts the local clock on visitor activity this app sends.
 * Play mode, the floating countdown chip (effects workspace / Acid Mode) and the
 * owner's kiosk section all read it.
 */

import type { LedMapperClient } from "../net/client";
import { deviceHasKiosk, kioskFromWelcome, KioskClock, normalizeKioskStatus, type KioskStatus } from "../net/kiosk";
import { appState } from "../ui/app/state";

type Listener = () => void;
type RevertListener = (s: KioskStatus) => void;

class KioskStore {
  readonly clock = new KioskClock();
  private listeners = new Set<Listener>();
  private revertListeners = new Set<RevertListener>();
  private bound: LedMapperClient | null = null;
  private boundConnected = false;
  private unsubs: (() => void)[] = [];
  private started = false;

  /** Start following the app's connection (idempotent). */
  start(): void {
    if (this.started) return;
    this.started = true;
    appState.subscribe(() => this.follow());
    this.follow();
  }

  /** Kiosk is on for the connected device. */
  get active(): boolean {
    return this.clock.status?.enabled === true;
  }

  get status(): KioskStatus | null {
    return this.clock.status;
  }

  remaining(): number {
    return this.clock.remaining();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Fires when the device reverted to its attract show. */
  onRevert(fn: RevertListener): () => void {
    this.revertListeners.add(fn);
    return () => this.revertListeners.delete(fn);
  }

  /** Apply a status from anywhere (the owner section's set replies, demo mode). */
  apply(s: KioskStatus): void {
    const reverted = this.clock.sync(s);
    this.emit();
    if (reverted) for (const fn of this.revertListeners) fn(s);
  }

  /** Re-read the device's status (best-effort). */
  async refresh(): Promise<void> {
    const c = this.bound;
    if (!c?.isConnected || !deviceHasKiosk(c.welcome)) return;
    try {
      const s = normalizeKioskStatus(await c.getKioskStatus());
      if (s) this.apply(s);
    } catch {
      // Older firmware / transient: keep what we have.
    }
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private follow(): void {
    const c = appState.client;
    const connected = appState.status.state === "connected";
    if (c === this.bound && connected === this.boundConnected) return;
    if (c !== this.bound) {
      for (const u of this.unsubs) u();
      this.unsubs = [];
      this.clock.clear();
      this.bound = c;
      if (c) {
        this.unsubs.push(
          c.onKioskStatus((m) => {
            const s = normalizeKioskStatus(m);
            if (s) this.apply(s);
          }),
          c.onActivity(() => {
            this.clock.noteActivity();
            this.emit();
          }),
        );
      }
      this.emit();
    }
    this.boundConnected = connected;
    // (Re)connected: the device's welcome may carry the status; else ask.
    if (c && connected) {
      const embedded = kioskFromWelcome(c.welcome);
      if (embedded) this.apply(embedded);
      else void this.refresh();
    }
  }
}

export const kioskStore = new KioskStore();
