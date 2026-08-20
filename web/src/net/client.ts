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
  StoredMapChunkMessage,
  WelcomeMessage,
} from "@ledmapper/protocol";
import {
  type ChunkAckMessage,
  decodeMappingBundle,
  type EffectUniformsMessage,
  type MappingBundle,
  type PerfMode,
  type PerfReportMessage,
  type SetTextureMessage,
  type UniformValueFlat,
} from "./proto";
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

// Byte-window size for sharded uploads (submit_map / submit_topology). Kept
// well under a TLS record so the player's mbedtls allocates a small (~this-big)
// record buffer per window on its fragmented heap, instead of one ~15 KB block
// that OOMs the C6's handshake. A whole frame <= this is sent as one window.
const CHUNK_BYTES = 4096;

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
   * hangs the UI at "connecting…". This is the REAL per-attempt ceiling (it
   * fires before any outer race, e.g. the prober's), so it must exceed the
   * device's actual cold-handshake latency: a heap-tight, freshly-booted C6
   * needs several seconds for the ~28 KB mbedTLS session on its fragmented heap.
   * At 5000 a slow-but-trusted reconnect timed out and was misread as "cert not
   * trusted". Default 10000. */
  connectTimeoutMs?: number;
  appVersion?: string;
  clientName?: string;
  /** How many times to attempt a socket that has NEVER reached `welcome` before
   * giving up, when the target needs a self-signed-cert trust (cross-origin
   * wss). Past this, stop auto-retrying and wait for an explicit reconnect — the
   * cert won't get trusted without the user, and each doomed handshake burns a
   * heap-tight TLS slot the cert-approval page needs. Default 1. */
  coldRetryLimit?: number;
  /** Like coldRetryLimit but for a target we HAD welcomed on, whose reconnects
   * then keep failing without re-welcoming — the tell-tale of a rotated cert (a
   * rename regenerates the device's self-signed cert; FUG-83). Higher than the
   * cold limit so an ordinary reboot (same cert) reconnects within the backoff
   * instead of prematurely dropping the user to "trust needed". Default 4. */
  warmRetryLimit?: number;
  /** Whether a manual self-signed-cert approval is even POSSIBLE on this
   * transport. True for a browser WebSocket. False when the socket is opened by
   * the native bridge (net/nativeSocket.ts), whose URLSession delegate already
   * trusts the device cert and shares nothing with WebKit's cert store — there,
   * a failure is never "the user hasn't trusted the cert", so retry with backoff
   * instead of dead-ending on an affordance that cannot fix anything. Default
   * true. (Independent of certApprovalUrl(), which only compares origins and is
   * ALWAYS non-null in the wrapper, whose page origin is capacitor://localhost.) */
  certTrustPossible?: boolean;
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
  /** Fired when we stop auto-retrying a never-connected cert-trust target (see
   * coldRetryLimit): the UI should show the "trust the cert" affordance and wait
   * for the user rather than expect a background reconnect. */
  onCertTrustNeeded?: (url: string) => void;
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
  loc: { host: string } | undefined = typeof location !== "undefined" ? location : undefined,
): string | null {
  try {
    if (!loc) return null; // no page origin (e.g. a unit-test/node context)
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
  // Whether this client has EVER completed a welcome. Distinguishes a cold
  // never-connected socket (likely an untrusted cert) from a warm drop (a
  // genuine disconnect that should reconnect with backoff).
  private everWelcomed = false;
  // Consecutive reconnects that closed without reaching welcome (reset on every
  // welcome). On a cert-trust target a run of these means the TLS handshake can't
  // complete without the user — the cert was never trusted (cold) OR it rotated
  // under us (warm; e.g. a rename regenerates the device's self-signed cert).
  private failsSinceWelcome = 0;
  private readonly needsTrust: boolean;
  private readonly coldRetryLimit: number;
  private readonly warmRetryLimit: number;

  /** Outbound detection batches not yet written to an open socket. */
  private pendingBatches: DetectionRecord[][] = [];

  // Monotonic id grouping the frames of one sharded upload (see sendChunked).
  private uploadSeq = 0;

  // Single-flight response waiters, keyed by the reply's message type.
  private waiters = new Map<string, { resolve: (m: ServerMessage) => void; reject: (e: Error) => void }>();
  private pingWaiters = new Map<number, { resolve: (m: ServerMessage) => void; reject: (e: Error) => void }>();

  // Perf-report subscribers: perf_report arrives both as a reply to
  // set_perf/get_perf_report AND unsolicited while a stream is active, so it
  // can't be a single-flight waiter. The panel subscribes here for live frames.
  private perfSubs = new Set<(r: PerfReportMessage) => void>();

  readonly clock: ServerClock;
  events: ClientEvents = {};

  constructor(readonly url: string, opts: ClientOptions = {}) {
    this.factory = opts.socketFactory ?? ((u) => new WebSocket(u) as unknown as SocketLike);
    this.now = opts.now ?? (() => performance.now());
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    // Gentle by default: a wss player (self-signed cert) rejects the socket
    // fast until the user accepts the cert, and a heap-tight ESP can only hold
    // ~2 TLS sessions — hammering every 250 ms fills both slots and starves the
    // cert-approval page load. Spacing retries out (1–8 s) keeps a slot free for
    // it and still reconnects within ~8 s once the cert is trusted.
    this.backoffMs = opts.backoffMs ?? [1000, 2000, 4000, 8000];
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    this.coldRetryLimit = opts.coldRetryLimit ?? 1;
    this.warmRetryLimit = opts.warmRetryLimit ?? 4;
    this.needsTrust = (opts.certTrustPossible ?? true) && certApprovalUrl(url) !== null;
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
          if (welcomed) {
            // A re-welcome on an already-connected socket: the device echoes a
            // fresh welcome (updated identity) as the REPLY to set_device_name /
            // set_color_correction. Resolve that pending request, but do NOT
            // re-run the connect handshake — onConnected drives the UI to
            // "syncing clock…", and nothing follows up to put it back to
            // "connected" (that only happens in the initial connect() chain), so
            // firing it again would strand the pill mid-sync after a rename.
            this.dispatch(msg);
            return;
          }
          this.backoffIdx = 0;
          this.attempt = 0;
          this.everWelcomed = true;
          this.failsSinceWelcome = 0;
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
          // A run of reconnects that never reach `welcome` against a cert-trust
          // target is almost certainly failing on the self-signed cert: retrying
          // is futile (only the user can trust it) and actively harmful on the
          // heap-tight ESP — every doomed TLS handshake holds one of the player's
          // two TLS slots, starving BOTH the cert-approval page load and any
          // concurrent wss. So past a limit, surface the trust affordance and stop
          // (a fresh connect() resumes once the user accepts).
          //
          // A cold client (never welcomed) is untrusted from the start → give up
          // fast (coldRetryLimit, default 1). A warm client that starts failing is
          // the rotated-cert case (a rename regenerates the device cert; FUG-83) —
          // but an ordinary reboot brings the SAME cert back, so allow more
          // attempts (warmRetryLimit) to reconnect within the backoff before we
          // conclude the cert changed and ask the user to re-trust.
          const limit = this.everWelcomed ? this.warmRetryLimit : this.coldRetryLimit;
          const certGiveUp = this.needsTrust && ++this.failsSinceWelcome >= limit;
          if (certGiveUp) {
            this.events.onCertTrustNeeded?.(this.url);
          } else {
            const delay = this.backoffMs[Math.min(this.backoffIdx++, this.backoffMs.length - 1)]!;
            this.schedule(() => {
              if (!this.closed) void this.connect().catch(() => undefined);
            }, delay);
          }
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

  /** Upload a phone-solved OutputMap; the server persists it and acks. Large
   * maps are sharded (see {@link sendChunked}) so the player's mbedtls never
   * has to allocate a big contiguous TLS record buffer on its fragmented heap. */
  async submitMap(map: OutputMap): Promise<ResultReadyMessage> {
    return this.sendChunked("MAP", { type: "submit_map", map });
  }

  /** Upload the extracted graph topology for an already-submitted map; the
   * player persists it (keyed to map_id) for the pulse engine. Sharded like
   * {@link submitMap}. */
  async submitTopology(topology: Topology): Promise<ResultReadyMessage> {
    return this.sendChunked("TOPOLOGY", { type: "submit_topology", topology });
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

  /** Upload a compiled effect (`.fxb` = bytecode + embedded uniform manifest)
   * to the connected device. `activate` makes it the running effect on receipt
   * (the editor's "Send to device" path). Reply: result_ready (id=effectId). */
  async submitEffect(
    effectId: string,
    fxb: Uint8Array,
    activate = true,
  ): Promise<ResultReadyMessage> {
    return (await this.request(
      { type: "submit_effect", effectId, fxb, activate } as unknown as ClientMessage,
      "result_ready",
    )) as ResultReadyMessage;
  }

  /** Select the active effect by id ("" or "off" clears it). Reply:
   * playback_state. */
  async setEffect(effectId: string): Promise<PlaybackStateMessage> {
    return (await this.request(
      { type: "set_effect", effectId } as unknown as ClientMessage,
      "playback_state",
    )) as PlaybackStateMessage;
  }

  /**
   * Push live uniform values on the active effect (slider drags). Fire-and-forget
   * on purpose: a live push has no reply worth awaiting, and — crucially — it must
   * NOT go through the single-flight request() path. request() rejects (and never
   * sends) a second call while a prior reply of the same type is still pending, so
   * a rapid drag (many set_uniforms, each awaiting one ~50-200ms playback_state)
   * had all-but-the-first-per-window SILENTLY DROPPED before hitting the wire —
   * frequently including the final value the user let go on. The device applies
   * each set_uniforms it receives in order (TCP, no coalescing), so just send them
   * all and the last one wins. Returns false if the socket isn't open.
   */
  setUniforms(values: UniformValueFlat[]): boolean {
    return this.send({ type: "set_uniforms", values } as unknown as ClientMessage);
  }

  /** Rename the player: sets its display name, which becomes the Bluetooth-
   * advertised name too and is persisted on the device. Reply: welcome (echoing
   * the new device_name + mac). */
  async setDeviceName(name: string): Promise<WelcomeMessage> {
    return (await this.request(
      { type: "set_device_name", name } as unknown as ClientMessage,
      "welcome",
    )) as unknown as WelcomeMessage;
  }

  /** Configure the LED strip's per-channel color correction: either a built-in
   * profile name (e.g. "ws2812b") or explicit per-channel gamma + relative
   * luminance. The device rebuilds its flash LUTs and applies them to the
   * running effect immediately, so this can be pushed live while dialing in
   * curves. Reply: welcome. */
  async setColorCorrection(cc: {
    profile?: string;
    gamma?: [number, number, number];
    luminance?: [number, number, number];
    /** Persist to flash (default). Pass false for live preview so a rapid drag
     * stream stays in device RAM; send one commit:true when done. */
    commit?: boolean;
  }): Promise<WelcomeMessage> {
    const msg: Record<string, unknown> = { type: "set_color_correction" };
    if (cc.profile !== undefined) msg.profile = cc.profile;
    if (cc.gamma) {
      msg.gammaR = cc.gamma[0];
      msg.gammaG = cc.gamma[1];
      msg.gammaB = cc.gamma[2];
    }
    if (cc.luminance) {
      msg.lumR = cc.luminance[0];
      msg.lumG = cc.luminance[1];
      msg.lumB = cc.luminance[2];
    }
    if (cc.commit !== undefined) msg.commit = cc.commit;
    return (await this.request(
      msg as unknown as ClientMessage,
      "welcome",
    )) as unknown as WelcomeMessage;
  }

  /** Set the global output brightness — a single scale (0..1) applied to every
   * rendered LED just before the strip write (1.0 = the effect's own output).
   * Runtime-only on the device (a reboot returns to full brightness). Used as a
   * master dimmer and by the performance-measurement driver, which sets it to 0
   * while it runs the calibration effects (so a fixture on a low-ampacity supply
   * doesn't brown out and drop its link) and restores the user setpoint after.
   * Reply: welcome (echoes the applied brightness). */
  async setBrightness(brightness: number): Promise<WelcomeMessage> {
    const b = Math.min(1, Math.max(0, brightness));
    const msg: Record<string, unknown> = { type: "set_brightness", brightness: b };
    return (await this.request(
      msg as unknown as ClientMessage,
      "welcome",
    )) as unknown as WelcomeMessage;
  }

  /** Stream a video frame into a loaded effect's 2D texture. Build the message
   * with the textureCodec (quantize + optional XOR-delta + RLE); fire-and-forget
   * so a high frame rate isn't gated on a round trip. Returns false if the
   * socket isn't open (the frame is dropped — video is lossy by nature). */
  setTexture(msg: SetTextureMessage): boolean {
    return this.send(msg as unknown as ClientMessage);
  }

  /** Fetch an effect's uniform manifest + current live values for UI
   * hydration. Omit `effectId` for the active effect. Reply: effect_uniforms. */
  async getEffectUniforms(effectId?: string): Promise<EffectUniformsMessage> {
    return (await this.request(
      {
        type: "get_effect_uniforms",
        ...(effectId !== undefined ? { effectId } : {}),
      } as unknown as ClientMessage,
      "effect_uniforms",
    )) as unknown as EffectUniformsMessage;
  }

  /** Configure effect perf instrumentation (perf-monitoring.md). `mode` picks
   * the tier (OFF/BASIC/FULL); `intervalMs` > 0 asks the device to push
   * perf_report unsolicited (0 = poll-only). Reply: an immediate perf_report
   * for the current window. */
  async setPerf(mode: PerfMode, intervalMs = 0): Promise<PerfReportMessage> {
    return (await this.request(
      { type: "set_perf", mode, intervalMs } as unknown as ClientMessage,
      "perf_report",
    )) as unknown as PerfReportMessage;
  }

  /** Drain the perf ring + rolling-window summary now (perf-monitoring.md).
   * Reply: perf_report. Used when interval_ms == 0 (poll-only). */
  async getPerfReport(): Promise<PerfReportMessage> {
    return (await this.request(
      { type: "get_perf_report" } as unknown as ClientMessage,
      "perf_report",
    )) as unknown as PerfReportMessage;
  }

  /** Subscribe to perf_report frames — both replies and unsolicited pushes.
   * Returns an unsubscribe fn. The perf panel drives its live graph from here. */
  onPerfReport(fn: (r: PerfReportMessage) => void): () => void {
    this.perfSubs.add(fn);
    return () => this.perfSubs.delete(fn);
  }

  /** Pull the player's stored map+topology back off the device — streamed in
   * chunks and decoded as a MappingBundle. Rejects if the player has nothing
   * stored (server error `no_map`). `onProgress(done, total)` tracks assembly. */
  async pullStoredMap(
    onProgress?: (done: number, total: number) => void,
    chunkLen = 1024,
  ): Promise<MappingBundle> {
    let assembled = new Uint8Array(0);
    let total = 0;
    for (;;) {
      const reply = (await this.request(
        { type: "get_stored_map", offset: assembled.length, maxLen: chunkLen },
        "stored_map_chunk",
      )) as StoredMapChunkMessage;
      total = reply.totalLen;
      const data = b64ToBytes(reply.data);
      if (data.length === 0) break;
      const next = new Uint8Array(assembled.length + data.length);
      next.set(assembled);
      next.set(data, assembled.length);
      assembled = next;
      onProgress?.(assembled.length, total);
      if (assembled.length >= total) break;
    }
    if (total === 0 || assembled.length === 0) throw new Error("device has no stored map");
    return decodeMappingBundle(assembled);
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
    if ((msg.type as string) === "perf_report") {
      // Fan out to subscribers (live panel) first, then resolve any pending
      // set_perf/get_perf_report waiter — the same frame satisfies both.
      const report = msg as unknown as PerfReportMessage;
      for (const fn of this.perfSubs) fn(report);
      const pw = this.waiters.get("perf_report");
      if (pw) {
        this.waiters.delete("perf_report");
        pw.resolve(msg);
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

  /** Upload a large control frame (submit_map / submit_topology) as a stream of
   * small UploadChunk windows, so no single frame makes the player's mbedtls
   * allocate a big contiguous TLS record buffer on its fragmented heap (the C6
   * OOMs its handshake/read trying to alloc a ~15 KB record for a whole map).
   *
   * We encode the full envelope once, then send it in <=CHUNK_BYTES slices. Each
   * non-final window is awaited to a chunk_ack BEFORE the next send: the await
   * lets the browser's TLS layer flush one small record per window instead of
   * re-coalescing queued writes back into one big record (which would defeat the
   * whole point). The device reassembles the identical bytes and decodes them
   * through the normal submit_map / submit_topology path on `last`.
   *
   * Small frames (<= CHUNK_BYTES) still go as a single window — one send, one
   * result_ready — so the common case keeps its single round trip. */
  private async sendChunked(
    kind: "MAP" | "TOPOLOGY",
    msg: ClientMessage,
  ): Promise<ResultReadyMessage> {
    // Shard anything past one window. On wss this dodges the big contiguous TLS
    // record that OOMs the C6's fragmented heap; on both transports it lets the
    // player stream the upload to flash instead of holding a whole frame in RAM.
    // A frame that already fits one window takes the ordinary single-frame path.
    const frame = encodeClient(msg);
    if (frame.length <= CHUNK_BYTES) {
      return (await this.request(msg, "result_ready")) as ResultReadyMessage;
    }
    const uploadId = (this.uploadSeq = (this.uploadSeq + 1) >>> 0);
    let seq = 0;
    for (let off = 0; off < frame.length; off += CHUNK_BYTES) {
      const end = Math.min(off + CHUNK_BYTES, frame.length);
      const last = end >= frame.length;
      // Copy the slice: encodeClient's bytes-field path base64s the payload, and
      // a subarray view would keep the whole frame's backing buffer alive.
      const payload = frame.slice(off, end);
      const chunk = {
        type: "upload_chunk",
        uploadId,
        seq,
        last,
        kind,
        payload,
      } as unknown as ClientMessage;
      if (last) {
        return (await this.request(chunk, "result_ready")) as ResultReadyMessage;
      }
      const ack = (await this.request(chunk, "chunk_ack")) as unknown as ChunkAckMessage;
      if (ack.uploadId !== uploadId || ack.seq !== seq) {
        throw new Error(`chunk_ack mismatch: got ${ack.uploadId}/${ack.seq}, want ${uploadId}/${seq}`);
      }
      seq++;
    }
    // Unreachable: the loop always sends a `last` window and returns from it.
    throw new Error("chunked upload produced no final frame");
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

/** Decode a base64 string (a proto `bytes` field over the JSON-parity boundary)
 * to raw bytes. */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
