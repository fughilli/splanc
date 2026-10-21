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
import { certChangedMessage, certPins } from "../../net/deviceTrust";
import { deviceProber } from "../../net/deviceProber";
import { toast, type PillState } from "../kit";
import type { FpsStateMessage } from "../../net/proto";

export interface ConnStatus {
  state: PillState;
  text: string;
  /** Set when a self-signed cert must be trusted (cross-origin wss). */
  certUrl: string | null;
  /** Last server/connection error detail (surfaced in the device sheet). */
  error: string | null;
  /** The connected device reported a DIFFERENT certificate than the one first seen
   * for its id (TOFU, net/deviceTrust.ts): warn, offer re-trust (factory reset). */
  certChanged?: { mac: string; label: string; reported: string; message: string } | null;
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
    opts?: { coldRetryLimit?: number; socketFactory?: SocketFactory; uploadChunkBytes?: number },
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
    if (opts?.uploadChunkBytes !== undefined) clientOpts.uploadChunkBytes = opts.uploadChunkBytes;
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
    // FUG-82: the player parks an effect it can't render within budget and pushes
    // fps_state{aborted}; tell the user wherever they are in the app.
    client.onFpsState((s) => {
      if (s.aborted) toast(fpsAbortMessage(s), { error: true });
    });
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
        // Fold the device's identity (MAC + name + build) into its record as soon
        // as we're connected — BEFORE the clock sync — so the device is recorded by
        // its true MAC even if a later step fails, and so a provisional BLE entry
        // that never learns a MAC is distinguishable from a confirmed one in the
        // failure path below. Also push a rename queued while disconnected so the
        // device's Bluetooth name tracks the display name the user set.
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
        await this.checkCert(client, dev.id);
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
        // Drop a PROVISIONAL BLE entry that never learned an identity (no welcome
        // MAC). It's keyed on an ephemeral Web Bluetooth device.id, so a failed or
        // aborted (re)connect would otherwise strand a duplicate next to the
        // device's real MAC-keyed record — and a `ble:` URL can't be reconnected
        // anyway (the live GATT object is gone; there's nothing to retry). An
        // already-identified device (has a MAC) and every wss entry (stable host
        // key, retryable) are kept.
        if (wssUrl.startsWith("ble:") && !deviceStore.get(dev.id)?.bleMac) {
          deviceStore.forget(dev.id);
          this.setStatus({
            state: "error",
            text: "connection failed",
            certUrl: null,
            error: "Bluetooth connection failed — re-scan to try again",
          });
          return;
        }
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
        // Watch for a background reconnect in BOTH cases. A cert-trust target whose
        // client was given a retry budget (the trust flow / the HITL journey pass
        // coldRetryLimit > 1) keeps retrying after this first connect() rejects —
        // typically its first socket timed out at the 10 s bound while the player's
        // single TLS slot was still held by the cert page's connection. That retry
        // then reaches `welcome`, but nothing ran the post-welcome chain any more,
        // so the pill sat at "syncing clock…" forever with a live socket. A client
        // that has given up never connects, so the watch just idles until the next
        // connect()/disconnect() clears it.
        this.watchReconnect(dev.id);
      }
    })();
  }

  /** Poll for a background reconnect completing (after cert trust / a flaky
   * network) so the pill flips to connected without a page reload. */
  private watchReconnect(devId?: string): void {
    if (this.connTimer !== null) return;
    this.connTimer = window.setInterval(() => {
      const c = this.client;
      if (c === null) {
        this.clearReconnectWatch();
        return;
      }
      if (c.isConnected) {
        this.clearReconnectWatch();
        const w = c.welcome;
        if (devId !== undefined && w) {
          deviceStore.applyWelcome(devId, {
            mac: w.mac,
            deviceName: w.deviceName,
            fwGitCommit: w.fwGitCommit,
            fwGitDirty: w.fwGitDirty,
            fwVersion: w.fwVersion,
          });
        }
        this.setStatus({ state: "connected", text: "connected", certUrl: null, error: null });
        void (async () => {
          if (devId !== undefined) await this.checkCert(c, devId).catch(() => undefined);
          await c.syncClock().catch(() => undefined);
        })();
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

  /** TOFU check of the device's own TLS certificate (per-device-cert.md): remember
   * it on first sight (or replacing the legacy shared one), warn if a known device
   * now reports a different one. Best-effort: older firmware has no tls_info. */
  private async checkCert(client: LedMapperClient, devId: string): Promise<void> {
    const w = client.welcome;
    if (!w?.mac || !(w.features ?? []).includes("tls_info")) return;
    const info = await client.getTlsInfo().catch(() => null);
    const v = certPins.check(w.mac, info);
    if (v.kind === "changed") {
      const label = deviceStore.get(devId)?.label ?? w.deviceName ?? w.mac;
      this.setStatus({
        certChanged: { mac: w.mac, label, reported: v.reported, message: certChangedMessage(label) },
      });
    } else {
      this.setStatus({ certChanged: null });
    }
  }

  /** The user confirmed the device was factory-reset: accept its new certificate. */
  retrustCert(): void {
    const c = this.status.certChanged;
    if (!c) return;
    certPins.retrust(c.mac, c.reported);
    this.setStatus({ certChanged: null });
  }

  /** Expose the raw welcome (LED count seed etc.) when connected. */
  welcome(): WelcomeMessage | null {
    return this.client?.welcome ?? null;
  }
}

/** The user-facing notice for an autoscaler abort (FUG-82). */
export function fpsAbortMessage(s: FpsStateMessage): string {
  return s.auto
    ? `Effect stopped: this device can't render it even at ${s.minFps || 25} fps. Simplify it (fewer ops per LED) and try again.`
    : `Effect stopped: this device can't hold the pinned ${s.targetFps} fps. Set Framerate to Auto or a lower rate, then restart it.`;
}

export const appState = new AppState();
