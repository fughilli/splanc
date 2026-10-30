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
import { isBleUrl } from "../../net/bleTransport";
import { deviceStore } from "../../store/deviceStore";
import { certChangedMessage, certPins } from "../../net/deviceTrust";
import { deviceProber } from "../../net/deviceProber";
import { toast, type PillState } from "../kit";
import type { FpsStateMessage } from "../../net/proto";
import { inLoader } from "../../net/otaUpdate";
import { pushPendingOnConnect } from "../../capture/imuCalReconnect";

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
    // A Bluetooth device is only reachable through its BLE socket factory (made by
    // the connect flow from a live GATT device). Without one, the fallback below
    // would hand `ble:<id>` to the native WssBridge, which crashes iOS. Keep it
    // offline instead; the user reconnects through the Bluetooth flow.
    if (isBleUrl(wssUrl) && !opts?.socketFactory) {
      this.setStatus({ state: "offline", text: "offline", certUrl: null, error: "Reconnect over Bluetooth" });
      return;
    }
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
    // FUG-82: an effect too heavy for its target keeps playing, slower; the
    // player pushes fps_state when it starts/stops lagging. Mention it once per
    // lagging spell (not an error). Older firmware parked it instead (aborted).
    let wasLagging = false;
    client.onFpsState((s) => {
      if (s.aborted) toast(fpsAbortMessage(s), { error: true });
      else if (s.lagging && !wasLagging) toast(fpsLagMessage(s));
      wasLagging = s.lagging;
    });
    client.events = {
      onConnecting: (attempt, url) =>
        this.setStatus({
          state: "connecting",
          text: attempt <= 1 ? "connecting…" : `connecting (${attempt})…`,
          error: null,
        }),
      onConnected: () => {
        this.setStatus({ state: "connecting", text: "syncing clock…", certUrl: null });
        // A Calibrate IMU solve that never reached this device (it dropped
        // mid-write): push it now, on every (re)connection, until confirmed.
        void pushPendingOnConnect(client, {
          delayMs: 1500,
          isCurrent: () => this.client === client,
          notify: (t) => toast(t),
        }).catch(() => undefined);
      },
      onDisconnected: () => {
        this.setStatus({ state: "connecting", text: "reconnecting…" });
        // The client reconnects by itself (e.g. the device restarting through a
        // firmware update), but only the initial connect() ran the post-welcome
        // chain — without this watch the pill sat at "syncing clock…" after the
        // reconnect, and a device back in its updater wasn't called out.
        if (this.client === client) this.watchReconnect(dev.id);
      },
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
        // A device in its OTA updater (recovery, docs/design/ota.md) answers only the
        // update protocol: say so, so the user goes to Flash firmware -> Update over Wi-Fi.
        const updater = inLoader(client.welcome);
        this.setStatus({
          state: "connected",
          text: updater ? "in updater" : "connected",
          certUrl: null,
          error: null,
        });
        if (updater) {
          const ota = (client.welcome as unknown as { ota?: { loaderReason?: string } }).ota;
          toast(
            `This device is in its firmware updater (${ota?.loaderReason || "recovery"}). ` +
              "Open Flash firmware to install an update over Wi-Fi.",
          );
        }
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
    // Bound to the client that is current NOW: if the user switches devices, the
    // next client's welcome must never be folded into this device's record.
    const owner = this.client;
    this.connTimer = window.setInterval(() => {
      const c = this.client;
      if (c === null || c !== owner) {
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
        this.setStatus({
          state: "connected",
          text: inLoader(w) ? "in updater" : "connected",
          certUrl: null,
          error: null,
        });
        void (async () => {
          if (devId !== undefined) await this.checkCert(c, devId).catch(() => undefined);
          // The updater answers only the update protocol (no clock sync).
          if (!inLoader(c.welcome)) await c.syncClock().catch(() => undefined);
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
    const old = this.client;
    // Detach first: closing fires onDisconnected, which must not treat this
    // deliberate close as a drop to watch for a reconnect.
    this.client = null;
    if (old) connectionRegistry.unregister(old);
    old?.close();
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
    // A Bluetooth device can't be reopened from its stored key alone (it needs a
    // fresh GATT pick/scan), so don't auto-restore it on boot.
    if (active && !isBleUrl(active.wssUrl)) this.connect(active.wssUrl, undefined, { coldRetryLimit: 6 });
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

/** The gentle notice when an effect starts lagging (FUG-82): it keeps playing. */
export function fpsLagMessage(s: FpsStateMessage): string {
  const rate = s.achievedFps || s.currentFps;
  const target = s.auto ? s.minFps || 25 : s.targetFps;
  return `Effect running at ${rate ? `${rate} fps` : "a reduced rate"} (below its ${target} fps target) — it keeps playing. Simplify it for smoother motion.`;
}

/** Older firmware (before effects lagged instead) parked an effect it couldn't
 * hold and set fps_state.aborted; current firmware never does. */
export function fpsAbortMessage(s: FpsStateMessage): string {
  return `Effect stopped by the device's older firmware: it couldn't hold ${s.auto ? `${s.minFps || 25}` : `the pinned ${s.targetFps}`} fps. Update the firmware (slow effects then keep playing) or simplify the effect.`;
}

export const appState = new AppState();
