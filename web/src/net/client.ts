/**
 * M7 — WebSocket control-plane client (design doc §6 M7, §7).
 *
 * One `LedMapperClient` owns the socket to the Pi: hello/welcome handshake,
 * SNTP-style clock sync ({@link syncClock}), start/stop mapping, detection
 * batching, and status/pattern polling.
 *
 * Reliability model: detection batches are appended to an outbound queue and
 * only dropped once written to an OPEN socket; if the socket drops, the queue
 * survives, the client reconnects with backoff, re-runs the hello handshake,
 * and flushes. The §7 contract has no per-batch ack, so an in-flight batch on
 * a dying socket can still be lost — acceptable at ~1 batch/second against a
 * 70-observation-per-LED capture.
 *
 * The transport is injectable (`SocketFactory`) so the whole state machine is
 * unit-testable with a fake socket.
 */

import type {
  ClientMessage,
  CodeParams,
  ConfigureOptions,
  DetectionRecord,
  ExposureStats,
  FrameTimingMessage,
  ImuSample,
  LiveMapMessage,
  MappingStartedMessage,
  MappingStoppedMessage,
  OutputMap,
  PatternStateMessage,
  PlaybackParams,
  PlaybackStateMessage,
  Topology,
  ResultReadyMessage,
  ServerMessage,
  SolveStatusMessage,
  StartMappingOptions,
  StatusMessage,
  WelcomeMessage,
} from "@ledmapper/protocol";
import { bestSample, ServerClock, syncSample, type SyncSample } from "./clocksync";
import { decodeServer, encodeClient } from "./proto";

/** The subset of the WebSocket API the client uses (fakeable in tests). */
export interface SocketLike {
  readonly readyState: number;
  binaryType?: string;
  send(data: string | Uint8Array): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

const SOCKET_OPEN = 1; // WebSocket.OPEN

export interface ClientOptions {
  socketFactory?: SocketFactory;
  /** Local monotonic clock, ms (performance.now in the browser). */
  now?: () => number;
  /** setTimeout-compatible scheduler (fakeable in tests). */
  schedule?: (fn: () => void, ms: number) => void;
  /** Reconnect backoff steps, ms. */
  backoffMs?: number[];
  /** Give up on a socket that hasn't reached `welcome` this long and retry.
   * The browser's own WS/TCP connect timeout is tens of seconds on mobile, so
   * without this a not-yet-reachable player (e.g. just after it joins WiFi)
   * hangs the UI at "connecting…". Default 5000. */
  connectTimeoutMs?: number;
  appVersion?: string;
  clientName?: string;
}

export interface ClientEvents {
  /** Connection state changes (true right after welcome). */
  onConnected?: (welcome: WelcomeMessage) => void;
  onDisconnected?: () => void;
  /** Fired at the start of each connect attempt (attempt is 1-based within a
   * run; resets after a successful welcome), for progress UI. */
  onConnecting?: (attempt: number, url: string) => void;
  /** Any server error message not consumed by a pending request. */
  onServerError?: (code: string, message: string) => void;
}

/** Default WebSocket URL for the page's own origin (wss on https pages). */
export function defaultWsUrl(loc: { protocol: string; host: string } = location): string {
  const scheme = loc.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${loc.host}/ws`;
}

/**
 * The player origin to visit for a one-tap self-signed-certificate approval
 * (R2 trust flow — firmware/landing/README.md). Browsers never show a cert
 * interstitial for a WebSocket, so a hosted app targeting a cross-origin
 * `wss:` player with an untrusted cert fails with no user-visible fix; the
 * fix is a TOP-LEVEL visit to the player's own origin. Null when the socket
 * targets the serving origin (loading the page already took the approval)
 * or the target is not `wss:`.
 */
export function certApprovalUrl(
  wsUrl: string,
  loc: { host: string } = location,
): string | null {
  try {
    const u = new URL(wsUrl);
    if (u.protocol !== "wss:" || u.host === loc.host) return null;
    return `https://${u.host}/`;
  } catch {
    return null;
  }
}

export class LedMapperClient {
  private sock: SocketLike | null = null;
  private readonly factory: SocketFactory;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => void;
  private readonly backoffMs: number[];
  private readonly connectTimeoutMs: number;
  private readonly appVersion: string;
  private readonly clientName: string;

  private welcome_: WelcomeMessage | null = null;
  private closed = false;
  private backoffIdx = 0;
  private attempt = 0;

  /** Outbound detection batches not yet written to an open socket. */
  private pendingBatches: DetectionRecord[][] = [];

  // Single-flight response waiters, keyed by the reply's message type.
  private waiters = new Map<string, { resolve: (m: ServerMessage) => void; reject: (e: Error) => void }>();
  private pingWaiters = new Map<number, { resolve: (m: ServerMessage) => void; reject: (e: Error) => void }>();

  readonly clock: ServerClock;
  events: ClientEvents = {};

  constructor(readonly url: string, opts: ClientOptions = {}) {
    this.factory = opts.socketFactory ?? ((u) => new WebSocket(u) as unknown as SocketLike);
    this.now = opts.now ?? (() => performance.now());
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.backoffMs = opts.backoffMs ?? [250, 500, 1000, 2000, 4000];
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 5000;
    this.appVersion = opts.appVersion ?? "0.1.0";
    this.clientName = opts.clientName ?? "android-web";
    this.clock = new ServerClock({ offsetMs: 0, rttMs: Infinity }, this.now);
  }

  get welcome(): WelcomeMessage | null {
    return this.welcome_;
  }

  get isConnected(): boolean {
    return this.sock !== null && this.sock.readyState === SOCKET_OPEN && this.welcome_ !== null;
  }

  /** Open the socket and complete the hello/welcome handshake. */
  connect(): Promise<WelcomeMessage> {
    this.closed = false;
    this.events.onConnecting?.(++this.attempt, this.url);
    return new Promise((resolve, reject) => {
      let settled = false;
      let welcomed = false;
      const sock = this.factory(this.url);
      sock.binaryType = "arraybuffer"; // binary protobuf frames (proto-comms)
      this.sock = sock;
      // Bounded open timeout: if this socket hasn't reached `welcome` in time,
      // force it closed so onclose runs the (short) backoff retry instead of
      // waiting out the browser's tens-of-seconds TCP timeout. Guarded by
      // `welcomed` and scoped to this captured `sock`, so it's a no-op once
      // connected or once a newer socket has replaced this one.
      this.schedule(() => {
        if (!welcomed) {
          try {
            sock.close();
          } catch {
            // already closing — fine
          }
        }
      }, this.connectTimeoutMs);
      sock.onopen = () => {
        this.send({ type: "hello", client: this.clientName, appVersion: this.appVersion });
      };
      sock.onmessage = (ev) => {
        const msg = this.parse(ev.data);
        if (msg === null) return;
        if (msg.type === "welcome") {
          this.welcome_ = msg;
          this.backoffIdx = 0;
          this.attempt = 0;
          welcomed = true;
          this.flushBatches();
          this.events.onConnected?.(msg);
          if (!settled) {
            settled = true;
            resolve(msg);
          }
          return;
        }
        this.dispatch(msg);
      };
      sock.onerror = () => {
        // onclose always follows; reconnect handled there.
      };
      sock.onclose = () => {
        const hadWelcome = this.welcome_ !== null;
        this.welcome_ = null;
        this.failWaiters(new Error("socket closed"));
        if (hadWelcome) this.events.onDisconnected?.();
        if (!this.closed) {
          const delay = this.backoffMs[Math.min(this.backoffIdx++, this.backoffMs.length - 1)]!;
          this.schedule(() => {
            if (!this.closed) void this.connect().catch(() => undefined);
          }, delay);
        }
        if (!settled) {
          settled = true;
          reject(new Error("connection failed"));
        }
      };
    });
  }

  close(): void {
    this.closed = true;
    this.sock?.close();
    this.sock = null;
    this.welcome_ = null;
    this.failWaiters(new Error("client closed"));
  }

  /**
   * §7.3: N ping/pong rounds; keeps the min-RTT sample and updates
   * {@link clock}. Resolves with the winning sample.
   */
  async syncClock(rounds = 8): Promise<SyncSample> {
    const samples: SyncSample[] = [];
    for (let i = 0; i < rounds; i++) {
      const t0 = this.now();
      const pong = await this.roundtripPing(t0);
      const t3 = this.now();
      if (pong.type !== "time_sync_pong") throw new Error(`expected time_sync_pong, got ${pong.type}`);
      samples.push(syncSample(pong.t0, pong.t1, pong.t2, t3));
    }
    const best = bestSample(samples);
    this.clock.update(best);
    return best;
  }

  /**
   * Begin a capture. The client is the configuration authority (§7.1): pass
   * the negotiated encoding/bitPeriodMs in `config`; omitted fields fall back
   * to server defaults.
   */
  async startMapping(
    ledCount: number,
    config: Omit<StartMappingOptions, "ledCount"> = {},
  ): Promise<MappingStartedMessage> {
    const reply = await this.request(
      { type: "start_mapping", options: { ledCount, ...config } },
      "mapping_started",
    );
    return reply as MappingStartedMessage;
  }

  /**
   * Mid-capture renegotiation (§7.1 configure): overlay the given fields on
   * the active capture's code-book. The server restamps the pattern epoch;
   * the reply carries the new epoch + params to rebuild the decode pipeline
   * against. Detections already sent are preserved server-side.
   */
  async configure(options: ConfigureOptions): Promise<PatternStateMessage> {
    return (await this.request({ type: "configure", options }, "pattern_state")) as PatternStateMessage;
  }

  /**
   * Fire-and-forget exposure telemetry (§7.1 exposure_report). Unlike
   * detections these are snapshots, not evidence — a report lost to a
   * reconnect is stale by the time the socket is back, so no queueing.
   */
  sendExposureReport(report: ExposureStats): void {
    this.send({ type: "exposure_report", report });
  }

  /**
   * Fire-and-forget inertial batch (§7.1 imu_batch, WebXR-free path). A
   * batch lost to a reconnect leaves a dead-reckoning gap the solver bridges
   * (or degrades around) — queueing stale motion data isn't worth the
   * complexity at this stage.
   */
  sendImuBatch(samples: ImuSample[]): void {
    if (samples.length === 0) return;
    this.send({ type: "imu_batch", samples });
  }

  /**
   * Stop the capture. The server runs reconstruction before answering, so
   * this can take seconds; resolves with the result_ready message.
   */
  async stopMapping(): Promise<ResultReadyMessage> {
    const reply = await this.request({ type: "stop_mapping" }, "result_ready");
    return reply as ResultReadyMessage;
  }

  /**
   * Stop the capture WITHOUT a host solve (solver placement chose the
   * phone): the server persists the session log and replies immediately;
   * the caller solves locally and uploads via {@link submitMap}.
   */
  async stopMappingNoSolve(): Promise<MappingStoppedMessage> {
    const reply = await this.request(
      { type: "stop_mapping", solveOnHost: false },
      "mapping_stopped",
    );
    return reply as MappingStoppedMessage;
  }

  /** Upload a phone-solved OutputMap; the server persists it and acks. */
  async submitMap(map: OutputMap): Promise<ResultReadyMessage> {
    return (await this.request({ type: "submit_map", map }, "result_ready")) as ResultReadyMessage;
  }

  /** Upload the extracted graph topology for an already-submitted map; the
   * player persists it (keyed to map_id) for the pulse engine. */
  async submitTopology(topology: Topology): Promise<ResultReadyMessage> {
    return (await this.request(
      { type: "submit_topology", topology },
      "result_ready",
    )) as ResultReadyMessage;
  }

  /** Start/stop a topology-aware playback effect (`"off"`, `"pulse"`, or
   * `"flood"`); the player runs it against the stored topology. Reply: the
   * effective state. */
  async setPlayback(effect: string, params?: PlaybackParams): Promise<PlaybackStateMessage> {
    return (await this.request(
      { type: "set_playback", effect, ...(params ? { params } : {}) },
      "playback_state",
    )) as PlaybackStateMessage;
  }

  /** Host solver-benchmark score from welcome (ms); null while measuring. */
  get hostSolverBenchMs(): number | null {
    return this.welcome_?.solverBenchMs ?? null;
  }

  async getStatus(): Promise<StatusMessage> {
    return (await this.request({ type: "get_status" }, "status")) as StatusMessage;
  }

  async getPattern(): Promise<PatternStateMessage> {
    return (await this.request({ type: "get_pattern" }, "pattern_state")) as PatternStateMessage;
  }

  /** Drain the player's rendered-frame timing log (monotonic-clock time of
   * each mapping-pattern frame it pushed to the LEDs). Polled while tracing so
   * the samples can be forwarded to the trace server for stutter diagnosis. */
  async getFrameTiming(): Promise<FrameTimingMessage> {
    return (await this.request(
      { type: "get_frame_timing" },
      "frame_timing",
    )) as FrameTimingMessage;
  }

  /** Poll the continuous solver for the latest interim reconstruction. */
  async getLiveMap(): Promise<LiveMapMessage> {
    return (await this.request({ type: "get_live_map" }, "live_map")) as LiveMapMessage;
  }

  /** Poll the FINAL solve's progress while stopMapping() is pending. */
  async getSolveStatus(): Promise<SolveStatusMessage> {
    return (await this.request({ type: "get_solve_status" }, "solve_status")) as SolveStatusMessage;
  }

  /** Queue a detection batch; delivered now or after reconnect. */
  sendDetections(batch: DetectionRecord[]): void {
    if (batch.length === 0) return;
    this.pendingBatches.push(batch);
    this.flushBatches();
  }

  get pendingBatchCount(): number {
    return this.pendingBatches.length;
  }

  /** Code params for the capture: from mapping_started if running, else welcome. */
  get codeParams(): CodeParams | null {
    return this.welcome_?.codeParams ?? null;
  }

  // -- internals ----------------------------------------------------------

  private parse(data: unknown): ServerMessage | null {
    // Binary protobuf frames (proto-comms). Anything else is not our wire.
    try {
      if (data instanceof ArrayBuffer) return decodeServer(new Uint8Array(data));
      if (data instanceof Uint8Array) return decodeServer(data);
      return null;
    } catch {
      return null;
    }
  }

  private send(msg: ClientMessage): boolean {
    if (this.sock === null || this.sock.readyState !== SOCKET_OPEN) return false;
    try {
      this.sock.send(encodeClient(msg));
      return true;
    } catch {
      return false;
    }
  }

  private flushBatches(): void {
    while (this.pendingBatches.length > 0 && this.isConnected) {
      const batch = this.pendingBatches[0]!;
      if (!this.send({ type: "detections", batch })) return;
      this.pendingBatches.shift();
    }
  }

  private dispatch(msg: ServerMessage): void {
    if (msg.type === "time_sync_pong") {
      const w = this.pingWaiters.get(msg.t0);
      if (w) {
        this.pingWaiters.delete(msg.t0);
        w.resolve(msg);
      }
      return;
    }
    const w = this.waiters.get(msg.type);
    if (w) {
      this.waiters.delete(msg.type);
      w.resolve(msg);
      return;
    }
    if (msg.type === "error") {
      // An error can be the failure-reply to any single pending request
      // (e.g. stop_mapping -> reconstruction_failed). Fail the oldest waiter.
      const first = this.waiters.entries().next();
      if (!first.done) {
        const [key, waiter] = first.value;
        this.waiters.delete(key);
        waiter.reject(new Error(`${msg.code}: ${msg.message}`));
        return;
      }
      this.events.onServerError?.(msg.code, msg.message);
    }
  }

  private roundtripPing(t0: number): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      if (!this.send({ type: "time_sync_ping", t0 })) {
        reject(new Error("not connected"));
        return;
      }
      this.pingWaiters.set(t0, { resolve, reject });
    });
  }

  private request(msg: ClientMessage, replyType: string): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      if (this.waiters.has(replyType)) {
        reject(new Error(`request already pending for ${replyType}`));
        return;
      }
      if (!this.send(msg)) {
        reject(new Error("not connected"));
        return;
      }
      this.waiters.set(replyType, { resolve, reject });
    });
  }

  private failWaiters(err: Error): void {
    for (const w of this.waiters.values()) w.reject(err);
    this.waiters.clear();
    for (const w of this.pingWaiters.values()) w.reject(err);
    this.pingWaiters.clear();
  }
}
