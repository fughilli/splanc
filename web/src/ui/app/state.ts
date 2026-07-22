/**
 * App state (design doc §7.3) — a tiny observable store plus the global device
 * ConnectionManager. Screens read `appState` and subscribe; the connection is
 * shared chrome (a single LedMapperClient), so every screen sees the same
 * status pill and every "needs a device" action routes through here.
 */

import type { WelcomeMessage } from "@ledmapper/protocol";
import { certApprovalUrl, LedMapperClient } from "../../net/client";
import { deviceStore } from "../../store/deviceStore";
import type { PillState } from "../kit";

export interface ConnStatus {
  state: PillState;
  text: string;
  /** Set when a self-signed cert must be trusted (cross-origin wss). */
  certUrl: string | null;
  /** Last server/connection error detail (surfaced in the device sheet). */
  error: string | null;
}

type Listener = () => void;

class AppState {
  private listeners = new Set<Listener>();

  /** Currently active device client (null = explicit offline). */
  client: LedMapperClient | null = null;
  status: ConnStatus = { state: "offline", text: "offline", certUrl: null, error: null };
  /** id of the map selected in the workspace (drives Effects, deep links). */
  selectedMapId: string | null = null;
  theme: "dark" | "light" = "dark";

  private connTimer: number | null = null;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private setStatus(patch: Partial<ConnStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit();
  }

  /** Connect to a device by wss URL, tearing down any current client. Records
   * it in the known-devices list and marks it active. Reconnect + cert-trust
   * are handled here so the pill/sheet reflect them everywhere. */
  connect(wssUrl: string, label?: string): void {
    this.disconnect();
    const dev = deviceStore.upsert(wssUrl, label);
    deviceStore.setActive(dev.id);
    const client = new LedMapperClient(wssUrl);
    this.client = client;
    client.events = {
      onConnecting: (attempt, url) =>
        this.setStatus({
          state: "connecting",
          text: attempt <= 1 ? "connecting…" : `connecting (${attempt})…`,
          error: null,
        }),
      onConnected: () => this.setStatus({ state: "connecting", text: "syncing clock…", certUrl: null }),
      onDisconnected: () => this.setStatus({ state: "connecting", text: "reconnecting…" }),
      onServerError: (code, msg) => this.setStatus({ state: "error", text: "error", error: `server ${code}: ${msg}` }),
    };
    void (async () => {
      try {
        await client.connect();
        const sync = await client.syncClock();
        deviceStore.upsert(wssUrl, label); // refresh lastSeen
        this.setStatus({
          state: "connected",
          text: "connected",
          certUrl: null,
          error: null,
        });
        void sync;
      } catch {
        // The likely cause for a cross-origin wss target is the player's
        // self-signed cert (a WebSocket can never prompt for it). Surface the
        // trust URL; the client keeps auto-reconnecting in the background.
        const certUrl = certApprovalUrl(wssUrl);
        this.setStatus({
          state: certUrl ? "connecting" : "error",
          text: certUrl ? "trust needed" : "connection failed",
          certUrl,
          error: certUrl ? null : "connection failed — retrying",
        });
        this.watchReconnect();
      }
    })();
  }

  /** Poll for a background reconnect completing (after cert trust / a flaky
   * network) so the pill flips to connected without a page reload. */
  private watchReconnect(): void {
    if (this.connTimer !== null) return;
    this.connTimer = window.setInterval(() => {
      const c = this.client;
      if (c === null) {
        this.clearReconnectWatch();
        return;
      }
      if (c.isConnected) {
        this.clearReconnectWatch();
        this.setStatus({ state: "connected", text: "connected", certUrl: null, error: null });
        void c.syncClock().catch(() => undefined);
      }
    }, 600);
  }
  private clearReconnectWatch(): void {
    if (this.connTimer !== null) {
      clearInterval(this.connTimer);
      this.connTimer = null;
    }
  }

  disconnect(): void {
    this.clearReconnectWatch();
    this.client?.close();
    this.client = null;
    deviceStore.setActive(null);
    this.setStatus({ state: "offline", text: "offline", certUrl: null, error: null });
  }

  /** Restore the previously-active device on boot (back-compat with ?url=). */
  restoreActive(urlOverride?: string | null): void {
    if (urlOverride) {
      this.connect(urlOverride);
      return;
    }
    const active = deviceStore.active();
    if (active) this.connect(active.wssUrl);
  }

  setSelectedMap(id: string | null): void {
    this.selectedMapId = id;
    this.emit();
  }

  /** Expose the raw welcome (LED count seed etc.) when connected. */
  welcome(): WelcomeMessage | null {
    return this.client?.welcome ?? null;
  }
}

export const appState = new AppState();
