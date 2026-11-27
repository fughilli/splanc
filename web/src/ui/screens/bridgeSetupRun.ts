/**
 * The bridge setup flow's runner (#698): holds the state (net/bridgeSetup.ts), does what
 * `nextAction` asks through injected I/O ({@link BridgeSetupIO}), and feeds the answers
 * back as events. No DOM: the screen renders `state` on every change, tests drive it
 * with fakes, and `?demo=bridge-*` swaps in a scripted bridge for screenshots.
 */

import {
  classifyPairError,
  initialState,
  nextAction,
  reduce,
  type SetupAction,
  type SetupEvent,
  type SetupState,
  type StartOpts,
} from "../../net/bridgeSetup";
import { ImprovError, bridgeHostFromRedirect, wsUrlFromRedirect, type ImprovDevice } from "../../net/improv";
import type { LanHealth } from "../../net/liveProtocol";
import type { WifiCreds } from "../../store/prefs";

/** How long each stage may take before it counts as failed. */
export const AGENT_DEADLINE_MS = 45_000;
/** After a network change the bridge's relay link backs off up to a minute. */
export const RELAY_DEADLINE_MS = 90_000;
export const PAIRED_DEADLINE_MS = 90_000;
export const CONFIRM_DEADLINE_MS = 20_000;
export const HEALTH_EVERY_MS = 2_000;
export const CODE_WATCH_EVERY_MS = 5_000;

export interface PairedWelcome {
  players: string[];
  /** The bridge's LAN certificate (welcome `lan.sha256`), to tell it's this bridge. */
  sha256: string | null;
}

export interface BridgeSetupIO {
  /** Improv: send the network; resolves with the device's redirect URLs once it joined. */
  provision(device: ImprovDevice, creds: WifiCreds, onStatus: (s: string) => void, signal: AbortSignal): Promise<string[]>;
  /** GET https://<ip>:8443/healthz; null when it doesn't answer (or can't be read). */
  readHealth(ip: string, signal: AbortSignal): Promise<LanHealth | null>;
  /** A healthz read that fails means nothing is there (native app: no certificate wall). */
  readonly healthCertain: boolean;
  /** This phone reaches the relay (its /healthz). */
  relayReachable(relay: string): Promise<boolean>;
  /** Connect through the relay with this app's saved credential until the bridge
   * welcomes us (or the deadline). */
  checkPaired(deadlineMs: number, signal: AbortSignal): Promise<PairedWelcome | "revoked" | "timeout">;
  /** Redeem the code at `relay` and save the credential (throws PairError / TypeError). */
  pair(relay: string, code: string, label: string): Promise<void>;
  /** After pairing: the bridge's fixtures through the relay (null: no welcome in time). */
  confirmPaired(deadlineMs: number): Promise<string[] | null>;
  /** Where this app pairs when the bridge doesn't say (older bridges). */
  readonly defaultRelay: string;
  /** The relay this app's credential is for (null: none). */
  readonly credsRelay: string | null;
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

/** `sleep` on real timers that ends early (resolves) when aborted. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

/** What an Improv failure means for a bridge (it answers UNABLE_TO_CONNECT for any
 * failed join, after putting its saved networks back). */
export function joinFailure(e: unknown): SetupEvent {
  const kind = e instanceof ImprovError ? e.kind : null;
  const detail = e instanceof Error ? e.message : String(e);
  if (kind === "cancelled" || (e instanceof DOMException && e.name === "AbortError")) return { t: "cancelled" };
  if (kind === "not-found") return { t: "join-failed", kind: "not-found", detail };
  if (kind === "wrong-password" || kind === "unable-to-connect") return { t: "join-failed", kind: "join-refused", detail };
  if (kind === "timeout") return { t: "join-failed", kind: "join-timeout", detail };
  return { t: "join-failed", kind: "bluetooth", detail };
}

export class BridgeSetupRunner {
  state: SetupState;
  private readonly subs = new Set<(s: SetupState) => void>();
  private running: { key: string; ctl: AbortController } | null = null;
  private provisioning: AbortController | null = null;
  private disposed = false;

  constructor(
    private readonly io: BridgeSetupIO,
    opts: StartOpts,
  ) {
    this.state = initialState(opts);
  }

  subscribe(fn: (s: SetupState) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  /** Begin the work the starting state needs (a hand-off arrives mid-checking). */
  start(): void {
    this.schedule();
  }

  dispatch(e: SetupEvent): void {
    if (this.disposed) return;
    const next = reduce(this.state, e);
    if (next === this.state) return;
    this.state = next;
    for (const fn of this.subs) fn(next);
    this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    this.running?.ctl.abort();
    this.running = null;
    this.provisioning?.abort();
    this.subs.clear();
  }

  /** Send the network to a picked bridge over Improv (the device came from the click's
   * chooser; see addDevice.ts on the Web Bluetooth gesture rule). */
  async sendWifi(device: ImprovDevice, creds: WifiCreds, onStatus: (s: string) => void = () => undefined): Promise<void> {
    this.dispatch({ t: "send-wifi", ssid: creds.ssid });
    if (this.state.step !== "checking") return;
    const ctl = new AbortController();
    this.provisioning = ctl;
    try {
      const urls = await this.io.provision(device, creds, onStatus, ctl.signal);
      const ip = urls.map((u) => bridgeHostFromRedirect(u)).find((h) => h !== null);
      if (ip) this.dispatch({ t: "joined", ip, ssid: creds.ssid });
      else {
        const fixture = urls.map((u) => wsUrlFromRedirect(u)).find((u) => u !== null);
        this.dispatch(fixture ? { t: "not-a-bridge", address: fixture } : { t: "join-failed", kind: "bluetooth", detail: "it joined but sent no address" });
      }
    } catch (e) {
      this.dispatch(joinFailure(e));
    } finally {
      if (this.provisioning === ctl) this.provisioning = null;
    }
  }

  /** Stop waiting for the join (back to the Wi-Fi details). */
  cancelWifi(): void {
    this.provisioning?.abort();
  }

  async pair(code: string, label: string): Promise<void> {
    if (this.state.step !== "pair" || this.state.pairBusy) return;
    this.dispatch({ t: "pair-submit" });
    const relay = (this.state.health?.relay || this.io.defaultRelay).replace(/\/+$/, "");
    try {
      await this.io.pair(relay, code, label);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      const c = classifyPairError(e instanceof TypeError ? null : err);
      this.dispatch({ t: "pair-failed", ...c });
      return;
    }
    const players = await this.io.confirmPaired(CONFIRM_DEADLINE_MS).catch(() => null);
    this.dispatch({ t: "paired", players });
  }

  // -- actions ---------------------------------------------------------------------------

  private schedule(): void {
    if (this.disposed) return;
    const a = nextAction(this.state);
    const key = a.kind === "none" ? "" : `${a.kind}:${"ip" in a ? a.ip : ""}`;
    if (this.running?.key === key) return;
    this.running?.ctl.abort();
    this.running = null;
    if (!key) return;
    const ctl = new AbortController();
    this.running = { key, ctl };
    void this.run(a, ctl.signal).finally(() => {
      if (this.running?.ctl === ctl) this.running = null;
      // The action ended without changing what's needed (e.g. a watch that stopped):
      // nothing to do; a changed state already scheduled its own.
    });
  }

  private async run(a: SetupAction, signal: AbortSignal): Promise<void> {
    const io = this.io;
    if (a.kind === "probe-agent" || a.kind === "poll-relay") {
      const deadline = io.now() + (a.kind === "probe-agent" ? AGENT_DEADLINE_MS : RELAY_DEADLINE_MS);
      while (!signal.aborted) {
        const h = await io.readHealth(a.ip, signal).catch(() => null);
        if (signal.aborted) return;
        if (h) {
          this.dispatch({ t: "health", health: h });
          if (signal.aborted) return; // the state moved on
        }
        if (io.now() >= deadline) {
          if (a.kind === "probe-agent") this.dispatch({ t: "agent-timeout", certain: io.healthCertain });
          else {
            const relay = this.state.health?.relay || io.defaultRelay;
            const reach = await io.relayReachable(relay).catch(() => false);
            if (!signal.aborted) this.dispatch({ t: "relay-timeout", phoneReachesRelay: reach });
          }
          return;
        }
        await io.sleep(a.kind === "probe-agent" ? HEALTH_EVERY_MS : HEALTH_EVERY_MS + 1000, signal);
      }
      return;
    }
    if (a.kind === "check-paired") {
      const r = await io.checkPaired(PAIRED_DEADLINE_MS, signal).catch(() => "timeout" as const);
      if (signal.aborted) return;
      if (r === "revoked") this.dispatch({ t: "revoked" });
      else if (r === "timeout") {
        const reach = await io.relayReachable(io.credsRelay ?? io.defaultRelay).catch(() => false);
        if (!signal.aborted) this.dispatch({ t: "welcome-timeout", phoneReachesRelay: reach });
      } else this.dispatch({ t: "welcome", players: r.players, sha256: r.sha256 });
      return;
    }
    if (a.kind === "watch-code") {
      while (!signal.aborted) {
        await io.sleep(CODE_WATCH_EVERY_MS, signal);
        if (signal.aborted) return;
        const h = await io.readHealth(a.ip, signal).catch(() => null);
        if (h && !signal.aborted) this.dispatch({ t: "health", health: h });
      }
    }
  }
}
