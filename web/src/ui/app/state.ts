/**
 * App state (design doc §7.3) — a tiny observable store plus the global device
 * ConnectionManager. Screens read `appState` and subscribe; the connection is
 * shared chrome (a single LedMapperClient), so every screen sees the same
 * status pill and every "needs a device" action routes through here.
 */

import type { WelcomeMessage } from "@ledmapper/protocol";
import { certApprovalUrl, LedMapperClient, type ClientOptions, type SocketFactory } from "../../net/client";
import { connectionRegistry } from "../../net/connectionRegistry";
import { nativeSocketFactory } from "../../net/nativeSocket";
import { deviceStore } from "../../store/deviceStore";
import { deviceProber } from "../../net/deviceProber";
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
  connect(
    wssUrl: string,
    label?: string,
    opts?: { coldRetryLimit?: number; socketFactory?: SocketFactory },
  ): void {
    this.disconnect();
    const dev = deviceStore.upsert(wssUrl, label);
    deviceStore.setActive(dev.id);
    // coldRetryLimit defaults to 1 (give up fast on an untrusted cert so we don't
    // starve the cert-approval page's TLS slot). The trust flow passes a higher
    // value: once the user has accepted the cert the only thing left that can
    // fail is a transient — the player freeing a TLS slot the just-closed socket
    // still holds — so retry over the backoff instead of dumping the user back to
    // "trust needed" and making them reconnect by hand.
    const clientOpts: ClientOptions = {};
    if (opts?.coldRetryLimit !== undefined) clientOpts.coldRetryLimit = opts.coldRetryLimit;
    // In the native wrapper, route the socket through the cert-pinning bridge so
    // the device's self-signed wss:// is trusted (no manual cert accept). Off
    // native this is undefined and the client uses the browser WebSocket.
    // An explicit factory (BLE transport — connect over Bluetooth, offline) wins
    // over the native cert-pinning bridge; both make cert-trust meaningless.
    const factory = opts?.socketFactory ?? nativeSocketFactory();
    if (factory) {
      clientOpts.socketFactory = factory;
      // …and tell the client the trust affordance is meaningless on this
      // transport, so a transient cold failure (device waking, or one of the
      // ESP's two TLS slots still held by the socket we just closed) retries
      // over the backoff instead of dead-ending at "trust needed".
      clientOpts.certTrustPossible = false;
    }
    const client = new LedMapperClient(wssUrl, clientOpts);
    this.client = client;
    // Register as the sole owner of this device's socket so the liveness prober
    // multiplexes onto it instead of opening a parallel (slot-starving) handshake.
    connectionRegistry.register(client);
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
      // The client gave up auto-retrying because the cert isn't trusted — show
      // the trust affordance and STOP hammering; the user's "Trust & connect"
      // does a fresh connect() once the cert is accepted.
      onCertTrustNeeded: (url) =>
        this.setStatus({ state: "connecting", text: "trust needed", certUrl: certApprovalUrl(url), error: null }),
    };
    void (async () => {
      try {
        await client.connect();
        const sync = await client.syncClock();
        deviceStore.upsert(wssUrl, label); // refresh lastSeen
        // Fold the device's identity (MAC + name) into its record, and push a
        // rename that was queued while it was disconnected so its Bluetooth name
        // tracks the display name the user set.
        const w = client.welcome;
        if (w) {
          deviceStore.applyWelcome(dev.id, {
            mac: w.mac,
            deviceName: w.deviceName,
            fwGitCommit: w.fwGitCommit,
            fwGitDirty: w.fwGitDirty,
            fwVersion: w.fwVersion,
          });
          const pending = deviceStore.takePending(dev.id);
          if (pending && pending !== w.deviceName) {
            await client
              .setDeviceName(pending)
              .then((nw) =>
                deviceStore.applyWelcome(dev.id, {
                  mac: nw.mac,
                  deviceName: nw.deviceName,
                  fwGitCommit: nw.fwGitCommit,
                  fwGitDirty: nw.fwGitDirty,
                  fwVersion: nw.fwVersion,
                }),
              )
              .catch(() => undefined);
          }
        }
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
        // trust URL. For a cert-trust target the client has STOPPED retrying (so
        // it doesn't starve the cert page's TLS slot); reconnection is driven by
        // the user's "Trust & connect". For other failures it reconnects with
        // backoff, so poll for that completing.
        // …but only where the user could actually DO something about a cert: in
        // the native wrapper the socket comes from the cert-pinning bridge, which
        // already trusts it, so this is an ordinary failure to retry (and note
        // certApprovalUrl alone can't tell — it's always non-null in the wrapper).
        const certUrl = factory ? null : certApprovalUrl(wssUrl);
        this.setStatus({
          state: certUrl ? "connecting" : "error",
          text: certUrl ? "trust needed" : "connection failed",
          certUrl,
          error: certUrl ? null : "connection failed — retrying",
        });
        if (!certUrl) this.watchReconnect();
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
    if (this.client) connectionRegistry.unregister(this.client);
    this.client?.close();
    this.client = null;
    const wasActive = deviceStore.activeId();
    deviceStore.setActive(null);
    this.setStatus({ state: "offline", text: "offline", certUrl: null, error: null });
    // While connected the prober skips the active device; now that it's freed,
    // probe it immediately so its row flips to reachable/offline right away
    // instead of after up to a full poll interval.
    if (wasActive) void deviceProber.probeNow(wasActive);
  }

  /** Capture/demo-mode seam (FUG-103 docs screenshots): force a connected client
   * + status without opening a real socket, so the user guide can show a
   * connected device with a plausible RTT. Only the `?demo` bootstrap
   * (src/demo/init.ts) ever calls this; no production path does. */
  setDemoConnection(client: LedMapperClient, status: ConnStatus): void {
    this.client = client;
    this.setStatus(status);
  }

  /** Restore the previously-active device on boot (back-compat with ?url=). */
  restoreActive(urlOverride?: string | null): void {
    // A restored device is one we've already connected to, so its cert is almost
    // certainly still trusted — a fresh-page reconnect that fails is far more
    // likely a slow cold handshake (heap-tight C6, maybe still booting) than a
    // genuinely untrusted cert. Retry over the backoff before concluding "trust
    // needed" (default coldRetryLimit 1 dead-ended at the trust prompt after a
    // single slow miss, stranding a reload that used to just reconnect).
    if (urlOverride) {
      this.connect(urlOverride, undefined, { coldRetryLimit: 6 });
      return;
    }
    const active = deviceStore.active();
    if (active) this.connect(active.wssUrl, undefined, { coldRetryLimit: 6 });
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
