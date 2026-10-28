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
  type ColorCorrectionStateMessage,
  type ColorOrder,
  decodeMappingBundle,
  type BlendOptions,
  type EffectListMessage,
  type EffectUniformsMessage,
  type KeypointListMessage,
  type KeypointMessage,
  type KeypointWeightFlat,
  type FixturePoseFlat,
  type HardwareConfigStateMessage,
  type MappingBundle,
  type OtaStatusMessage,
  type PerfMode,
  type PerfReportMessage,
  type SetTextureMessage,
  type TlsInfoMessage,
  type FpsStateMessage,
  flatFpsState,
  type SensorStateMessage,
  type SensorCalibration,
  type I2cScanResultMessage,
  type DriverStateMessage,
  type UniformValueFlat,
  type DebugFxLedMessage,
  type FxDebugControlMessage,
  type FxDebugMessage,
  type GetFxSnapshotMessage,
} from "./proto";
import type { ColorBlock } from "@ledmapper/protocol";
import { bestSample, ServerClock, syncSample, type SyncSample } from "./clocksync";
import { decodeServer, encodeClient } from "./proto";
import { LiveControl } from "./liveControl";
import type { CaptureProfileFlat } from "../capture/captureProfile";
import { normalizeWifiPolicy, wifiPolicyMessage, type WifiPolicy, type WifiPolicyRequest } from "./wifiPolicy";

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
  /** Bytes queued but not yet handed to the network (WebSocket.bufferedAmount);
   * absent when the transport can't tell. Paces the live-control channel. */
  readonly bufferedAmount?: number;
}

export type SocketFactory = (url: string) => SocketLike;

const SOCKET_OPEN = 1; // WebSocket.OPEN
const SOCKET_CLOSED = 3; // WebSocket.CLOSED

/** Backoff cap while a caller waits for the device to come back (waitForWelcome):
 * short, so a device that just finished rebooting is picked up within ~2 s. Each
 * attempt is still bounded by connectTimeoutMs, so this can't storm the device. */
export const AWAITED_RECONNECT_MAX_MS = 2000;

// Byte-window size for sharded uploads (submit_map / submit_topology). Kept
// well under a TLS record so the player's mbedtls allocates a small (~this-big)
// record buffer per window on its fragmented heap, instead of one ~15 KB block
// that OOMs the C6's handshake. A whole frame <= this is sent as one window.
const CHUNK_BYTES = 4096;

/** Default deadline (ms) for a short request/reply RPC that opts into a timeout
 * (get/set hardware config). A firmware too old to know a request type, or one
 * on a wedged link, otherwise never answers and leaves the promise — and the UI
 * waiting on it — pending forever. Long-running calls (map solve -> result_ready)
 * pass NO timeout and keep the wait-forever behavior. Sized to comfortably clear
 * a heap-tight C6's worst-case post-welcome round trip. */
const REQUEST_TIMEOUT_MS = 8000;

/** Deadline for an OTA begin/chunk reply (see otaChunk). */
export const OTA_TRANSFER_TIMEOUT_MS = 30_000;

/** A {@link LedMapperClient} request that opted into a deadline got no reply in
 * time. Distinct from a generic failure so callers (e.g. Hardware Setup) can
 * tell "the firmware never answered this request" (likely too old to implement
 * it) apart from "the firmware answered, with nothing to report". */
export class RequestTimeoutError extends Error {
  constructor(
    readonly replyType: string,
    readonly timeoutMs: number,
  ) {
    super(`timed out after ${timeoutMs} ms waiting for ${replyType}`);
    this.name = "RequestTimeoutError";
  }
}

/** How long {@link LedMapperClient.stopMappingNoSolve} waits for the device's
 * mapping_stopped. A player answers it straight away (no solve runs); a reply
 * this late means the link has stalled (e.g. the player's receive path wedged
 * with the socket still open), and nobody should wait on it. */
export const STOP_ACK_TIMEOUT_MS = 3000;

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
   * fires before any outer race, e.g. the prober's), so it must EXCEED the
   * device's real worst-case time-to-welcome — otherwise it aborts a legitimate
   * (just slow) handshake mid-flight, which emits the -0x7780 fatal alert and is
   * itself the storm. HITL measurement (//pi/hitl/harness:slot_guard): a served
   * welcome is ~2.5–4s normally but stretches to ~8.3s when both TLS slots are
   * contended (a reconnect racing a held session). 10000 covers that with margin;
   * 7000/5000 do NOT (a slot-contended welcome misses them) — the reason not to
   * shrink this. The real fix for the storm is keeping the app <=2 concurrent
   * (net/connectionRegistry single-flight), not a shorter timeout. Default 10000. */
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
  /** Byte-window size for sharded uploads (submit_map / submit_topology /
   * submit_effect). Defaults to {@link CHUNK_BYTES} (4096), sized for the wss
   * heap. The BLE transport passes a smaller value so each upload window — and
   * so each length-prefixed GATT frame — fits the device's small BLE reassembly
   * cap (esp. the heapless netstack build). Only affects windowing, not
   * correctness: the device reassembles any window size. */
  uploadChunkBytes?: number;
  /** Deadline (ms) for short RPCs that opt into a timeout (get/set hardware
   * config). Callers that may legitimately run long (map solve) never pass it.
   * Default {@link REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs?: number;
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
  // Set when onclose stopped auto-retrying (cert-trust give-up); cleared by connect().
  private gaveUp = false;
  // A backoff reconnect is already scheduled (never stack two).
  private reconnectScheduled = false;
  private reconnectGen = 0;
  private readonly needsTrust: boolean;
  private readonly coldRetryLimit: number;
  private readonly warmRetryLimit: number;

  /** Outbound detection batches not yet written to an open socket. */
  private pendingBatches: DetectionRecord[][] = [];

  // Monotonic id grouping the frames of one sharded upload (see sendChunked).
  private uploadSeq = 0;
  // Upload window size (see ClientOptions.uploadChunkBytes).
  private readonly chunkBytes: number;
  // Deadline for short RPCs that opt into a timeout (see requestTimeoutMs).
  private readonly requestTimeoutMs: number;

  // Single-flight response waiters, keyed by the reply's message type.
  private waiters = new Map<string, { resolve: (m: ServerMessage) => void; reject: (e: Error) => void }>();
  // One-shot listeners for the next handshake's welcome (waitForWelcome).
  private welcomeListeners = new Set<(w: WelcomeMessage) => void>();
  private pingWaiters = new Map<number, { resolve: (m: ServerMessage) => void; reject: (e: Error) => void }>();

  // Perf-report subscribers: perf_report arrives both as a reply to
  // set_perf/get_perf_report AND unsolicited while a stream is active, so it
  // can't be a single-flight waiter. The panel subscribes here for live frames.
  private perfSubs = new Set<(r: PerfReportMessage) => void>();

  // fps_state subscribers (FUG-82): fps_state is both the set_fps reply AND an
  // unsolicited push when the effect starts or stops lagging (below its target),
  // so — like perf_report — it fans out rather than going to a single waiter.
  private fpsSubs = new Set<(s: FpsStateMessage) => void>();

  /**
   * A stop_mapping(solveOnHost=false) the device has not acknowledged (it timed
   * out on a stalled link, or the socket was down). Re-sent after the next
   * welcome so the player's mapping pattern really stops; cleared by an ack, a
   * `no_session` error (nothing left to stop), or a new {@link startMapping}.
   */
  stopPending = false;
  readonly clock: ServerClock;
  events: ClientEvents = {};

  /** The device's render rate as last reported (fps_state / perf_report; 0 = unknown). */
  private renderFps_ = 0;

  /**
   * The real-time control channel (docs/design/live-control.md). EVERY live
   * control — sliders, MIDI, faders, the agent's live mux — goes through it:
   * latest value wins per uniform, at most one update in flight (paced on the
   * device's ack) and never faster than the device renders, so a knob stream of
   * any length never builds a backlog on the device.
   */
  readonly live: LiveControl;

  constructor(readonly url: string, opts: ClientOptions = {}) {
    this.factory = opts.socketFactory ?? ((u) => new WebSocket(u) as unknown as SocketLike);
    this.now = opts.now ?? (() => performance.now());
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    // Gentle by default: a wss player (self-signed cert) rejects the socket
    // fast until the user accepts the cert, and a heap-tight ESP can only hold
    // ~2 TLS sessions — hammering every 250 ms fills both slots and starves the
    // cert-approval page load. Spacing retries out (1–8 s) keeps a slot free for
    // it and still reconnects within ~8 s once the cert is trusted.
    this.chunkBytes = opts.uploadChunkBytes && opts.uploadChunkBytes > 0 ? opts.uploadChunkBytes : CHUNK_BYTES;
    this.requestTimeoutMs = opts.requestTimeoutMs && opts.requestTimeoutMs > 0 ? opts.requestTimeoutMs : REQUEST_TIMEOUT_MS;
    this.backoffMs = opts.backoffMs ?? [1000, 2000, 4000, 8000];
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    this.coldRetryLimit = opts.coldRetryLimit ?? 1;
    this.warmRetryLimit = opts.warmRetryLimit ?? 4;
    this.needsTrust = (opts.certTrustPossible ?? true) && certApprovalUrl(url) !== null;
    this.appVersion = opts.appVersion ?? "0.1.0";
    this.clientName = opts.clientName ?? "android-web";
    this.clock = new ServerClock({ offsetMs: 0, rttMs: Infinity }, this.now);
    this.live = new LiveControl(
      {
        sendFlat: (m) => this.send(m as unknown as ClientMessage),
        features: () => this.welcome_?.features ?? [],
        renderFps: () => this.renderFps_,
        bufferedAmount: () => this.bufferedAmount,
      },
      { now: this.now, schedule: this.schedule },
    );
  }

  get welcome(): WelcomeMessage | null {
    return this.welcome_;
  }

  /** Bytes the socket hasn't put on the wire yet (0 when closed or unknown): the
   * per-connection backpressure signal the live-control channel gates on — reuse
   * it (with LatestWinsSender) for other paced streams. */
  get bufferedAmount(): number {
    return this.sock?.bufferedAmount ?? 0;
  }

  get isConnected(): boolean {
    return this.sock !== null && this.sock.readyState === SOCKET_OPEN && this.welcome_ !== null;
  }

  /** Open the socket and complete the hello/welcome handshake. */
  connect(): Promise<WelcomeMessage> {
    this.closed = false;
    this.gaveUp = false;
    this.reconnectScheduled = false;
    this.reconnectGen++; // cancels a backoff reconnect still pending
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
          this.redeliverOwedStop();
          this.flushBatches();
          this.events.onConnected?.(msg);
          for (const l of [...this.welcomeListeners]) l(msg);
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
        this.live.onDisconnect();
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
          //
          // EXCEPT while someone is waiting for this device to come back
          // (waitForWelcome — an OTA handoff, resume, install or health check). The
          // device told us it is restarting, with the SAME identity and cert, and an
          // app -> loader handoff takes a reboot + Wi-Fi join (scan, auth, DHCP) + TLS
          // identity load: easily longer than the warm budget, and a give-up there
          // stranded the update at "Restarting into the updater…" with nothing left
          // reconnecting. So keep retrying the same target until the waiter's own
          // deadline, at a short capped backoff so the device is picked up promptly.
          const limit = this.everWelcomed ? this.warmRetryLimit : this.coldRetryLimit;
          const awaited = this.welcomeListeners.size > 0;
          const certGiveUp = this.needsTrust && ++this.failsSinceWelcome >= limit && !awaited;
          if (certGiveUp) {
            this.gaveUp = true;
            this.events.onCertTrustNeeded?.(this.url);
          } else {
            let delay = this.backoffMs[Math.min(this.backoffIdx++, this.backoffMs.length - 1)]!;
            if (awaited) delay = Math.min(delay, AWAITED_RECONNECT_MAX_MS);
            this.scheduleReconnect(delay);
          }
        }
        if (!settled) {
          settled = true;
          reject(new Error("connection failed"));
        }
      };
    });
  }

  /** Schedule one backoff reconnect (at most one outstanding). */
  private scheduleReconnect(delay: number): void {
    if (this.reconnectScheduled) return;
    this.reconnectScheduled = true;
    const gen = this.reconnectGen;
    this.schedule(() => {
      if (gen !== this.reconnectGen) return; // superseded by an explicit connect()
      this.reconnectScheduled = false;
      if (!this.closed) void this.connect().catch(() => undefined);
    }, delay);
  }

  /**
   * The device said it is about to restart (an OTA handoff into its loader, or the
   * loader booting a just-installed app). A restart sends no TCP FIN/RST, so the
   * socket would sit half-open — nothing closes it until TCP keepalive probes the
   * new boot (Chromium: 45 s idle, then 45 s apart), which is longer than the restart
   * itself. Drop it now so the reconnect path runs; pair with
   * {@link waitForWelcome}, which keeps that path retrying until the device is back.
   * Also the recovery for a link that stopped answering (a request timed out).
   */
  expectRestart(): void {
    const sock = this.sock;
    if (this.closed) return;
    if (sock !== null && sock.readyState !== SOCKET_CLOSED) {
      this.abandonSocket(sock);
      return;
    }
    // No live socket: make sure something is reconnecting (e.g. after a give-up).
    if (this.gaveUp) this.scheduleReconnect(0);
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
    // A new capture supersedes an owed stop from the previous one: re-sending it
    // later would kill THIS capture's pattern.
    this.stopPending = false;
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
   *
   * Bounded: the reply is awaited at most `timeoutMs`. A device that has not
   * answered by then has a stalled link (socket open, nothing read) — the stop
   * rejects, the wedged socket is recycled (the normal reconnect follows), and
   * the stop is re-sent after the next welcome ({@link stopPending}) so the
   * pattern stops once the player is reachable again. Callers that solve on the
   * phone must not gate the solve on this.
   */
  async stopMappingNoSolve(timeoutMs = STOP_ACK_TIMEOUT_MS): Promise<MappingStoppedMessage> {
    this.stopPending = true;
    try {
      const reply = await this.request(
        { type: "stop_mapping", solveOnHost: false },
        "mapping_stopped",
        timeoutMs,
      );
      this.stopPending = false;
      return reply as MappingStoppedMessage;
    } catch (e) {
      this.settleOwedStop(e);
      if (e instanceof RequestTimeoutError) this.recycleStalledSocket();
      throw e;
    }
  }

  /** A server error reply means the device processed the stop (e.g.
   * `no_session`: it has no capture to stop) — nothing is owed any more. A
   * transport failure / timeout leaves the stop owed. */
  private settleOwedStop(e: unknown): void {
    if (e instanceof ServerErrorReply) this.stopPending = false;
  }

  /** Close a socket that stopped answering so the reconnect path replaces it
   * (onclose fails the remaining waiters and schedules the backoff retry). */
  private recycleStalledSocket(): void {
    const sock = this.sock;
    if (sock === null || sock.readyState !== SOCKET_OPEN) return;
    this.abandonSocket(sock);
  }

  /** Close `sock` and run its close path NOW. A browser's close() starts the
   * closing handshake and only fires onclose once the peer answers it — a peer
   * that restarted or stalled never does, so Chrome sat in CLOSING for ~60 s
   * before any reconnect could start (measured on the HITL rig, web OTA
   * handoff). Detach its handlers, close it in the background, and run onclose
   * (fail the waiters, schedule the reconnect) ourselves. */
  private abandonSocket(sock: SocketLike): void {
    const onclose = sock.onclose;
    sock.onclose = null;
    sock.onmessage = null;
    sock.onerror = null;
    sock.onopen = null;
    try {
      sock.close();
    } catch {
      // already closing
    }
    onclose?.();
  }

  /** After a (re)welcome: deliver a stop the device never acknowledged. */
  private redeliverOwedStop(): void {
    if (!this.stopPending) return;
    this.request({ type: "stop_mapping", solveOnHost: false }, "mapping_stopped", STOP_ACK_TIMEOUT_MS)
      .then(() => {
        this.stopPending = false;
      })
      .catch((e: unknown) => this.settleOwedStop(e));
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
   * (the editor's "Send to device" path). `deck` (FUG-110) cues it onto FX deck
   * A (0, default) or B (1) for crossfading. Reply: result_ready (id=effectId). */
  async submitEffect(
    effectId: string,
    fxb: Uint8Array,
    activate = true,
    deck = 0,
  ): Promise<ResultReadyMessage> {
    // Sharded like submit_map: a compiled effect can exceed one window, and on
    // the BLE transport a whole-frame send would blow the small per-frame cap.
    // Small effects still take the single-window fast path inside sendChunked.
    this.live.resetDeck(deck);
    return this.sendChunked("EFFECT", {
      type: "submit_effect",
      effectId,
      fxb,
      activate,
      deck,
    } as unknown as ClientMessage);
  }

  /** Select the active effect by id ("" or "off" clears it). `deck` (FUG-110)
   * targets deck A (0, default) or B (1). Reply: playback_state. */
  async setEffect(effectId: string, deck = 0): Promise<PlaybackStateMessage> {
    this.live.resetDeck(deck);
    return (await this.request(
      { type: "set_effect", effectId, deck } as unknown as ClientMessage,
      "playback_state",
    )) as PlaybackStateMessage;
  }

  /**
   * Push live uniform values on a deck's effect (slider drags). `deck` (FUG-110)
   * targets deck A (0, default) or B (1). Fire-and-forget on purpose: a live push
   * has no reply worth awaiting, and — crucially — it must NOT go through the
   * single-flight request() path. request() rejects (and never sends) a second
   * call while a prior reply of the same type is still pending, so a rapid drag
   * (many set_uniforms, each awaiting one ~50-200ms playback_state) had
   * all-but-the-first-per-window SILENTLY DROPPED before hitting the wire —
   * frequently including the final value the user let go on. The device applies
   * each set_uniforms it receives in order (TCP, no coalescing), so just send them
   * all and the last one wins. Returns false if the socket isn't open.
   */
  setUniforms(values: UniformValueFlat[], commit?: boolean, deck = 0): boolean {
    // `commit: false` applies the values live without persisting them (honoured by
    // firmware advertising "uniform_commit"; omitted = persist, today's behaviour).
    // `deck` targets FX deck A (0, default) or B (1) on firmware advertising "decks".
    // One-shot sets only (an effect's defaults after a submit): a STREAM of moves
    // (drag, MIDI) goes through {@link live}, which paces itself on the device.
    this.live.noteValues(values, deck);
    const msg: Record<string, unknown> = { type: "set_uniforms", values };
    if (commit !== undefined) msg.commit = commit;
    if (deck) msg.deck = deck;
    return this.send(msg as unknown as ClientMessage);
  }

  /** Set the global FX crossfade: `position` 0.0 (all deck A) .. 1.0 (all deck
   * B), `mode` 0 = linear RGB, 1 = HSV. The device blends the two decks' per-LED
   * output. Runtime-only (a reboot returns to 0.0 / RGB). Reply: welcome (echoes
   * the applied crossfade). */
  async setCrossfade(position: number, mode = 0): Promise<WelcomeMessage> {
    const p = Math.min(1, Math.max(0, position));
    return (await this.request(
      { type: "set_crossfade", position: p, mode } as unknown as ClientMessage,
      "welcome",
    )) as unknown as WelcomeMessage;
  }

  /** Live crossfade (a fader drag at MIDI rate): through the {@link live}
   * channel — the last position wins, paced on the device. False when not
   * connected. */
  sendCrossfade(position: number, mode = 0): boolean {
    if (!this.isConnected) return false;
    this.live.setCrossfade(position, mode);
    return true;
  }

  // -- Uniform keypoints (docs/design/uniform-keypoints.md) ------------------

  /** Save (or overwrite by name) a keypoint of the effect on `deck`. Omit
   * `values` to save the device's live uniforms. Reply: keypoint_list. */
  async saveKeypoint(name: string, deck = 0, values?: UniformValueFlat[]): Promise<KeypointListMessage> {
    return (await this.request(
      { type: "save_keypoint", name, deck, ...(values ? { values } : {}) } as unknown as ClientMessage,
      "keypoint_list",
    )) as unknown as KeypointListMessage;
  }

  /** Delete a keypoint by name. Reply: keypoint_list. */
  async deleteKeypoint(name: string, deck = 0, effectId?: string): Promise<KeypointListMessage> {
    return (await this.request(
      {
        type: "delete_keypoint",
        name,
        deck,
        ...(effectId !== undefined ? { effectId } : {}),
      } as unknown as ClientMessage,
      "keypoint_list",
    )) as unknown as KeypointListMessage;
  }

  /** List an effect's keypoints (the one on `deck`, or `effectId`). */
  async listKeypoints(deck = 0, effectId?: string): Promise<KeypointListMessage> {
    return (await this.request(
      {
        type: "list_keypoints",
        deck,
        ...(effectId !== undefined ? { effectId } : {}),
      } as unknown as ClientMessage,
      "keypoint_list",
    )) as unknown as KeypointListMessage;
  }

  /** One keypoint's values (by uniform name, and resolved to slots). */
  async getKeypoint(name: string, deck = 0, effectId?: string): Promise<KeypointMessage> {
    return (await this.request(
      {
        type: "get_keypoint",
        name,
        deck,
        ...(effectId !== undefined ? { effectId } : {}),
      } as unknown as ClientMessage,
      "keypoint",
    )) as unknown as KeypointMessage;
  }

  /** Blend a deck's uniforms toward a weighted mix of keypoints, on the device.
   * `seconds` > 0 morphs there; 0 applies at once. Fire-and-forget (the fader /
   * MIDI path: the last one wins); errors arrive as an `error` message. */
  blendKeypoints(weights: KeypointWeightFlat[], opts: BlendOptions = {}): boolean {
    // Through the live channel: the last blend per deck wins, paced on the device.
    if (!this.isConnected) return false;
    this.live.blendKeypoints(weights, opts);
    return true;
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

  /** Configure an LED output channel's hardware wiring: which GPIO drives it, the
   * LED type ("ws281x"), and the wire color order ("GRB" etc). Every field is
   * optional — nudge one at a time; an unset field is left unchanged. `commit`
   * false applies from RAM only (the color-order test previews without wearing
   * flash). `ledCount` is how many LEDs are wired to the channel (0 clears it);
   * the channels' LEDs form one global index space in channel order. Reply:
   * hardware_config_state (the resulting per-channel config). */
  async setHardwareConfig(cfg: {
    channel?: number;
    gpio?: number;
    ledType?: string;
    colorOrder?: ColorOrder;
    ledCount?: number;
    commit?: boolean;
  }): Promise<HardwareConfigStateMessage> {
    const msg: Record<string, unknown> = { type: "set_hardware_config" };
    if (cfg.channel !== undefined) msg.channel = cfg.channel;
    if (cfg.gpio !== undefined) msg.gpio = cfg.gpio;
    if (cfg.ledType !== undefined) msg.ledType = cfg.ledType;
    if (cfg.colorOrder !== undefined) msg.colorOrder = cfg.colorOrder;
    if (cfg.ledCount !== undefined) msg.ledCount = cfg.ledCount;
    if (cfg.commit !== undefined) msg.commit = cfg.commit;
    return (await this.request(
      msg as unknown as ClientMessage,
      "hardware_config_state",
      this.requestTimeoutMs,
    )) as unknown as HardwareConfigStateMessage;
  }

  /** Fetch the device's per-channel hardware config (GPIO, LED type, wire color
   * order) for the Hardware Setup page to hydrate. Reply: hardware_config_state.
   * A firmware too old to know `get_hardware_config` never replies, so this opts
   * into a timeout and rejects with {@link RequestTimeoutError} rather than
   * hanging — the caller tells that apart from an answered-but-empty config. */
  async getHardwareConfig(): Promise<HardwareConfigStateMessage> {
    return (await this.request(
      { type: "get_hardware_config" } as unknown as ClientMessage,
      "hardware_config_state",
      this.requestTimeoutMs,
    )) as unknown as HardwareConfigStateMessage;
  }

  /** Fetch the device's current color correction — the resolved per-channel
   * gamma + relative luminance it is applying (what the last setColorCorrection
   * stored). Lets the Color Correction page hydrate its curves from the device
   * on open (instead of only the last locally-remembered profile), and lets a
   * gamma HITL journey assert the device reports the gamma it was set to. Reply:
   * color_correction_state (the WS2812B default on a freshly-booted device). */
  /** List the effects the device stores (proto ListEffects; one slot today).
   * Needs firmware advertising the "list_effects" feature. */
  async listEffects(): Promise<EffectListMessage> {
    return (await this.request(
      { type: "list_effects" } as unknown as ClientMessage,
      "effect_list",
    )) as unknown as EffectListMessage;
  }

  /** The device's TLS identity: its state ("generating" until the first-boot key +
   * certificate exist, then "ready") and the certificate SHA-256 to pin per device
   * id (net/deviceTrust.ts). Needs the "tls_info" feature; answers over BLE too. */
  async getTlsInfo(): Promise<TlsInfoMessage> {
    const r = (await this.request(
      { type: "get_tls_info" } as unknown as ClientMessage,
      "tls_info",
    )) as unknown as Partial<TlsInfoMessage>;
    return {
      type: "tls_info",
      state: r.state ?? "",
      certSha256: r.certSha256 ?? "",
      persisted: r.persisted ?? false,
    };
  }

  /** Resolve on the next connection handshake (a reconnect's welcome) that satisfies
   * `pred` — e.g. the device coming back up in its update loader after a handoff.
   * Rejects after `timeoutMs`. Needs the auto-reconnect of a client that was
   * welcomed at least once. */
  waitForWelcome(pred: (w: WelcomeMessage) => boolean, timeoutMs: number): Promise<WelcomeMessage> {
    return new Promise((resolve, reject) => {
      const done = (w: WelcomeMessage): void => {
        if (!pred(w)) return;
        this.welcomeListeners.delete(done);
        resolve(w);
      };
      this.welcomeListeners.add(done);
      // While anyone waits, the client keeps reconnecting (see onclose). If it had
      // already given up (cert-trust budget spent before this wait began), restart it.
      if (this.gaveUp && !this.closed) this.scheduleReconnect(0);
      this.schedule(() => {
        if (!this.welcomeListeners.delete(done)) return;
        reject(new RequestTimeoutError("welcome", timeoutMs));
      }, timeoutMs);
    });
  }

  // -- firmware update over the air (docs/design/ota.md; driver: net/otaUpdate.ts) --

  private async ota(msg: Record<string, unknown>, timeoutMs = this.requestTimeoutMs): Promise<OtaStatusMessage> {
    const r = (await this.request(msg as unknown as ClientMessage, "ota_status", timeoutMs)) as unknown as Partial<OtaStatusMessage>;
    return {
      type: "ota_status",
      mode: r.mode ?? "MODE_UNKNOWN",
      state: r.state ?? "STATE_IDLE",
      version: r.version ?? 0,
      size: r.size ?? 0,
      offset: r.offset ?? 0,
      error: r.error ?? "",
      appVersion: r.appVersion ?? 0,
      appFwVersion: r.appFwVersion ?? "",
      loaderReason: r.loaderReason ?? "",
      lastResult: r.lastResult ?? "",
      loaderVersion: r.loaderVersion ?? 0,
      maxChunk: r.maxChunk ?? 0,
      slotSize: r.slotSize ?? 0,
    };
  }

  /** The device's update state (needs the "ota" feature). */
  getOtaStatus(): Promise<OtaStatusMessage> {
    return this.ota({ type: "get_ota_status" });
  }

  /** Offer a signed image (its 108-byte manifest). The app answers STATE_REBOOTING
   * (it restarts into the loader); the loader answers STATE_RECEIVING + the offset. */
  otaBegin(manifest: Uint8Array, allowDowngrade = false, keyEpoch?: Uint8Array): Promise<OtaStatusMessage> {
    return this.ota(
      { type: "ota_begin", manifest, allowDowngrade, ...(keyEpoch ? { keyEpoch } : {}) },
      Math.max(this.requestTimeoutMs, OTA_TRANSFER_TIMEOUT_MS),
    );
  }

  /** One stop-and-wait chunk. Its deadline is the transfer's, not the 8 s short-RPC
   * one: on a lossy Wi-Fi a 4 KB chunk can ride out several TCP retransmits (and the
   * loader a flash erase), and giving up early costs a fresh TLS handshake + resume
   * for a link that was about to deliver (the Python client waits 30 s too). */
  otaChunk(offset: number, data: Uint8Array): Promise<OtaStatusMessage> {
    return this.ota({ type: "ota_chunk", offset, data }, Math.max(this.requestTimeoutMs, OTA_TRANSFER_TIMEOUT_MS));
  }

  /** Verify (a SHA-256 read-back of ~2 MB) and select the new app. */
  otaFinish(): Promise<OtaStatusMessage> {
    return this.ota({ type: "ota_finish" }, Math.max(this.requestTimeoutMs, 60_000));
  }

  otaAbort(): Promise<OtaStatusMessage> {
    return this.ota({ type: "ota_abort" });
  }

  /** Restart into the app or (recovery) the loader. */
  otaReboot(target: "TARGET_APP" | "TARGET_LOADER"): Promise<OtaStatusMessage> {
    return this.ota({ type: "ota_reboot", target });
  }

  // -- Wi-Fi rejoin policy (docs/design/wifi-rejoin-policy.md; net/wifiPolicy.ts) --

  /** The device's Wi-Fi rejoin policy + link state. Needs the "wifi_policy"
   * feature; answers over BLE too (the only way to reach an offline unit). */
  async getWifiPolicy(): Promise<WifiPolicy> {
    const r = await this.request({ type: "get_wifi_policy" } as unknown as ClientMessage, "wifi_policy_state");
    return normalizeWifiPolicy(r as unknown as Record<string, unknown>);
  }

  /** Change the rejoin policy (unset fields keep their value). Going to manual /
   * offline while a fresh update is unconfirmed comes back `refused:
   * "ota_pending"` (nothing applied) unless `force`. Reply: the resulting state. */
  async setWifiPolicy(req: WifiPolicyRequest): Promise<WifiPolicy> {
    const r = await this.request(wifiPolicyMessage(req) as unknown as ClientMessage, "wifi_policy_state");
    return normalizeWifiPolicy(r as unknown as Record<string, unknown>);
  }

  /** The motion sensor's live state (docs/design/sensor-core.md). Needs the
   * "sensors" feature. */
  async getSensors(): Promise<SensorStateMessage> {
    const r = (await this.sensorRequest({ type: "get_sensors" } as unknown as ClientMessage)) as unknown as
      Partial<SensorStateMessage>;
    return normalizeSensorState(r);
  }

  /** get_sensors / calibrate_sensors / set_sensor_mount all answer
   * sensor_state, and request() is single-flight per reply type: a poll in
   * flight made a concurrent set_sensor_mount reject ("request already
   * pending") before it was ever sent — the Calibrate IMU save was silently
   * lost that way. Queue them instead, each with a deadline so one lost reply
   * can't wedge every later sensor request. */
  private sensorRequest(msg: ClientMessage): Promise<ServerMessage> {
    const run = this.sensorChain.then(() => this.request(msg, "sensor_state", this.requestTimeoutMs));
    this.sensorChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  private sensorChain: Promise<void> = Promise.resolve();

  /** Run a sensor calibration action. Applied by the device's sensor task at its
   * next poll: the reply is the state BEFORE it ran — poll getSensors until
   * calibrationSeq advances, then read calibrationResult. */
  async calibrateSensors(action: SensorCalibration): Promise<SensorStateMessage> {
    const actions: Record<SensorCalibration, string> = {
      gyro_bias: "ACTION_GYRO_BIAS",
      level: "ACTION_LEVEL",
      reset: "ACTION_RESET",
    };
    const r = (await this.sensorRequest({
      type: "calibrate_sensors",
      action: actions[action],
    } as unknown as ClientMessage)) as unknown as Partial<SensorStateMessage>;
    return normalizeSensorState(r);
  }

  /** Install the IMU -> map extrinsic R_fi (sensor-core.md §7; feature
   * "imu_extrinsic"). Applied at the sensor's next sample: poll getSensors
   * until calibrationSeq advances. */
  async setSensorMount(
    quat: number[],
    meta: { residualDeg: number; poses: number; yawResolved: boolean; atMs?: number },
  ): Promise<SensorStateMessage> {
    const r = (await this.sensorRequest({
      type: "set_sensor_mount",
      quat,
      residualDeg: meta.residualDeg,
      poses: meta.poses,
      yawResolved: meta.yawResolved,
      calibratedAtMs: String(meta.atMs ?? Date.now()),
    } as unknown as ClientMessage)) as unknown as Partial<SensorStateMessage>;
    return normalizeSensorState(r);
  }

  /** Store the capture profile next to the device's map (feature
   * "capture_profile"); the device drops it when a new map is uploaded. */
  async setCaptureProfile(profile: CaptureProfileFlat): Promise<CaptureProfileFlat> {
    const r = (await this.request(
      {
        type: "set_capture_profile",
        profile: { ...profile, capturedAtMs: String(profile.capturedAtMs) },
      } as unknown as ClientMessage,
      "capture_profile",
    )) as unknown as Partial<CaptureProfileFlat>;
    return normalizeProfile(r);
  }

  /** The stored map's capture profile (mapId "" = none stored). */
  async getCaptureProfile(): Promise<CaptureProfileFlat> {
    // Deadline: the Calibrate IMU screen awaits this before starting the code,
    // so a device that never answers must not leave it stuck.
    const r = (await this.request(
      { type: "get_capture_profile" } as unknown as ClientMessage,
      "capture_profile",
      this.requestTimeoutMs,
    )) as unknown as Partial<CaptureProfileFlat>;
    return normalizeProfile(r);
  }

  /** Probe the sensor I2C bus (FUG-107 "drivers" feature): ACKing addresses. */
  async scanI2c(): Promise<number[]> {
    const r = (await this.request(
      { type: "scan_i2c" } as unknown as ClientMessage,
      "i2c_scan_result",
    )) as unknown as Partial<I2cScanResultMessage>;
    return r.addresses ?? [];
  }

  /** Load a compiled sensor driver (a program with `void poll()` + `export`s);
   * its exports reach effect uniforms of the same name. `feedImu` routes an
   * MPU-6050 driver's imu_raw_* exports into the native fusion instead. */
  async submitDriver(fxb: Uint8Array, pollIntervalMs = 10, feedImu = false): Promise<DriverStateMessage> {
    return normalizeDriverState(
      (await this.request(
        { type: "submit_driver", fxb, pollIntervalMs, feedImu } as unknown as ClientMessage,
        "driver_state",
      )) as unknown as Partial<DriverStateMessage>,
    );
  }

  async removeDriver(): Promise<DriverStateMessage> {
    return normalizeDriverState(
      (await this.request({ type: "remove_driver" } as unknown as ClientMessage, "driver_state")) as unknown as Partial<DriverStateMessage>,
    );
  }

  async getDriverState(): Promise<DriverStateMessage> {
    return normalizeDriverState(
      (await this.request({ type: "get_driver_state" } as unknown as ClientMessage, "driver_state")) as unknown as Partial<DriverStateMessage>,
    );
  }

  /** Place this fixture in a shared room frame (or clear it); resolves with the
   * echoing welcome. Needs the "fixture_pose" feature. */
  async setFixturePose(
    pose: FixturePoseFlat | null,
    commit?: boolean,
  ): Promise<Record<string, unknown>> {
    const msg: Record<string, unknown> = { type: "set_fixture_pose" };
    if (pose) msg.pose = pose;
    else msg.clear = true;
    if (commit !== undefined) msg.commit = commit;
    return (await this.request(
      msg as unknown as ClientMessage,
      "welcome",
    )) as unknown as Record<string, unknown>;
  }

  /** Align effect time to `epochMs` in the device's clock (null clears). Needs
   * the "time_base" feature. */
  async setTimeBase(epochMs: number | null): Promise<Record<string, unknown>> {
    const msg =
      epochMs === null
        ? { type: "set_time_base", epochMs: 0, clear: true }
        : { type: "set_time_base", epochMs };
    return (await this.request(
      msg as unknown as ClientMessage,
      "welcome",
    )) as unknown as Record<string, unknown>;
  }

  async getColorCorrection(): Promise<ColorCorrectionStateMessage> {
    return (await this.request(
      { type: "get_color_correction" } as unknown as ClientMessage,
      "color_correction_state",
    )) as unknown as ColorCorrectionStateMessage;
  }

  /** Paint a static color-block pattern on a channel (proto SetCountingPattern):
   * each block lights [start, start+count) — relative to THAT channel's strip
   * start — a solid [r,g,b] in [0,1]; everything else (incl. the other
   * channels) is off. Used by the Hardware Setup color-order test to drive three R/G/B
   * segments. Reply: counting_state. Pass empty `blocks` to clear.
   *
   * `colorOrder` (a permutation of "RGB") drives the probe through its OWN wire
   * order, independent of the channel's committed color order — so the color-
   * order test previews a candidate (or drives raw with "RGB") without mutating
   * the persisted config. Omit -> identity "RGB" (raw wire bytes). */
  async setCountingPattern(
    blocks: ColorBlock[],
    channel?: number,
    colorOrder?: ColorOrder,
  ): Promise<ServerMessage> {
    const msg: Record<string, unknown> = { type: "set_counting_pattern", blocks };
    if (channel !== undefined) msg.channel = channel;
    if (colorOrder !== undefined) msg.colorOrder = colorOrder;
    return await this.request(msg as unknown as ClientMessage, "counting_state");
  }

  /** Stream a video frame into a loaded effect's 2D texture. Build the message
   * with the textureCodec (quantize + optional XOR-delta + RLE); fire-and-forget
   * so a high frame rate isn't gated on a round trip. Returns false if the
   * socket isn't open (the frame is dropped — video is lossy by nature). */
  setTexture(msg: SetTextureMessage): boolean {
    return this.send(msg as unknown as ClientMessage);
  }

  /** Fetch an effect's uniform manifest + current live values for UI
   * hydration. Omit `effectId` for the active effect. `deck` (FUG-110) targets
   * deck A (0, default) or B (1). Reply: effect_uniforms. */
  async getEffectUniforms(effectId?: string, deck = 0): Promise<EffectUniformsMessage> {
    return (await this.request(
      {
        type: "get_effect_uniforms",
        ...(effectId !== undefined ? { effectId } : {}),
        deck,
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

  /** FX debugger (docs/design/fx-debugger.md): pause / resume / step the FX
   * engine, or read its state (`action` = FX_DEBUG_ACTION.*). Reply: fx_debug
   * with `state`. Needs the "fx_debug" feature. */
  async fxDebugControl(
    msg: Omit<FxDebugControlMessage, "type">,
    timeoutMs = 10_000,
  ): Promise<FxDebugMessage> {
    return (await this.request(
      { type: "fx_debug_control", ...msg } as unknown as ClientMessage,
      "fx_debug",
      timeoutMs,
    )) as unknown as FxDebugMessage;
  }

  /** One window of an FX debugger snapshot section. Reply: fx_debug with `chunk`. */
  async getFxSnapshot(
    msg: Omit<GetFxSnapshotMessage, "type">,
    timeoutMs = 10_000,
  ): Promise<FxDebugMessage> {
    return (await this.request(
      { type: "get_fx_snapshot", ...msg } as unknown as ClientMessage,
      "fx_debug",
      timeoutMs,
    )) as unknown as FxDebugMessage;
  }

  /** Re-run one LED of a paused frame with its VM locals. Reply: fx_debug with `led`. */
  async debugFxLed(msg: Omit<DebugFxLedMessage, "type">, timeoutMs = 10_000): Promise<FxDebugMessage> {
    return (await this.request(
      { type: "debug_fx_led", ...msg } as unknown as ClientMessage,
      "fx_debug",
      timeoutMs,
    )) as unknown as FxDebugMessage;
  }

  /** Subscribe to perf_report frames — both replies and unsolicited pushes.
   * Returns an unsubscribe fn. The perf panel drives its live graph from here. */
  onPerfReport(fn: (r: PerfReportMessage) => void): () => void {
    this.perfSubs.add(fn);
    return () => this.perfSubs.delete(fn);
  }

  /** Override the effect framerate (FUG-82; the "fps" feature). `targetFps` 0
   * returns to autoscale, any other value pins that rate (snapped to the 5-fps
   * ladder). An effect that can't hold the rate keeps running, slower (fps_state
   * `lagging`); the player never parks it. Reply: the adopted fps_state. */
  async setFps(targetFps: number): Promise<FpsStateMessage> {
    const r = await this.request({ type: "set_fps", targetFps } as unknown as ClientMessage, "fps_state");
    return flatFpsState(r as unknown as Partial<FpsStateMessage>);
  }

  /** Subscribe to fps_state frames: set_fps replies and the unsolicited
   * `lagging` change push. Returns an unsubscribe fn. */
  onFpsState(fn: (s: FpsStateMessage) => void): () => void {
    this.fpsSubs.add(fn);
    return () => this.fpsSubs.delete(fn);
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

  /** Read just the first `peekLen` bytes of the player's stored bundle: one small
   * get_stored_map window, enough for the map header (map_id, led_count; see
   * store/deviceMap.ts parseBundleHeader) plus the whole bundle's size, without
   * pulling every LED. Rejects with a {@link ServerErrorReply} (`no_map`, or
   * `unsupported` on a player without the dump) like {@link pullStoredMap}. */
  async peekStoredMap(
    peekLen = 192,
    timeoutMs = 8000,
  ): Promise<{ totalLen: number; hasTopology: boolean; prefix: Uint8Array }> {
    const reply = (await this.request(
      { type: "get_stored_map", offset: 0, maxLen: peekLen },
      "stored_map_chunk",
      timeoutMs,
    )) as StoredMapChunkMessage;
    return { totalLen: reply.totalLen, hasTopology: reply.hasTopology, prefix: b64ToBytes(reply.data) };
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
    // The live-control channel paces on acks + legacy replies (consumes only acks).
    if (this.live.onServerMessage(msg as unknown as { type: string } & Record<string, unknown>)) return;
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
      if ((report.currentFps ?? 0) > 0) this.renderFps_ = report.currentFps!;
      for (const fn of this.perfSubs) fn(report);
      const pw = this.waiters.get("perf_report");
      if (pw) {
        this.waiters.delete("perf_report");
        pw.resolve(msg);
      }
      return;
    }
    if ((msg.type as string) === "fps_state") {
      // Subscribers (live readout + the abort notice) first, then any pending
      // set_fps waiter — one frame satisfies both (FUG-82).
      const state = flatFpsState(msg as unknown as Partial<FpsStateMessage>);
      if (state.currentFps > 0) this.renderFps_ = state.currentFps;
      for (const fn of this.fpsSubs) fn(state);
      const fw = this.waiters.get("fps_state");
      if (fw) {
        this.waiters.delete("fps_state");
        fw.resolve(msg);
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
        waiter.reject(new ServerErrorReply(msg.code, msg.message));
        return;
      }
      this.events.onServerError?.(msg.code, msg.message);
    }
  }

  /** One time_sync_ping round trip as a liveness check (the clock is left alone):
   * resolves with the RTT (ms), rejects when the socket is down or no pong comes
   * within `timeoutMs`. */
  async ping(timeoutMs: number): Promise<number> {
    let t0 = this.now();
    while (this.pingWaiters.has(t0)) t0 += 1e-3; // a concurrent syncClock round
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.roundtripPing(t0),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new RequestTimeoutError("time_sync_pong", timeoutMs)), timeoutMs);
        }),
      ]);
      return this.now() - t0;
    } finally {
      clearTimeout(timer);
      this.pingWaiters.delete(t0);
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
    kind: "MAP" | "TOPOLOGY" | "EFFECT",
    msg: ClientMessage,
  ): Promise<ResultReadyMessage> {
    // Shard anything past one window. On wss this dodges the big contiguous TLS
    // record that OOMs the C6's fragmented heap; on both transports it lets the
    // player stream the upload to flash instead of holding a whole frame in RAM.
    // A frame that already fits one window takes the ordinary single-frame path.
    const frame = encodeClient(msg);
    if (frame.length <= this.chunkBytes) {
      return (await this.request(msg, "result_ready")) as ResultReadyMessage;
    }
    const uploadId = (this.uploadSeq = (this.uploadSeq + 1) >>> 0);
    let seq = 0;
    for (let off = 0; off < frame.length; off += this.chunkBytes) {
      const end = Math.min(off + this.chunkBytes, frame.length);
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

  /** Single-flight request keyed by the reply message type. `timeoutMs > 0` opts
   * into a deadline: if no matching reply arrives in time the promise rejects
   * with a {@link RequestTimeoutError} and the waiter is reaped — otherwise a
   * firmware that never answers (too old to know the request, or a wedged link)
   * would leave it pending forever. Callers that may legitimately take a long
   * time (map solve -> result_ready) pass no timeout and keep that behavior. */
  private request(msg: ClientMessage, replyType: string, timeoutMs = 0): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      if (this.waiters.has(replyType)) {
        reject(new Error(`request already pending for ${replyType}`));
        return;
      }
      if (!this.send(msg)) {
        reject(new Error("not connected"));
        return;
      }
      // Wrap resolve/reject so the first of {reply, timeout, disconnect} wins and
      // the timer firing after a resolve is a harmless no-op.
      let settled = false;
      const waiter = {
        resolve: (m: ServerMessage) => {
          if (settled) return;
          settled = true;
          resolve(m);
        },
        reject: (e: Error) => {
          if (settled) return;
          settled = true;
          reject(e);
        },
      };
      this.waiters.set(replyType, waiter);
      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        this.schedule(() => {
          // A later same-type request may have replaced our waiter; only reap ours.
          if (this.waiters.get(replyType) === waiter) this.waiters.delete(replyType);
          waiter.reject(new RequestTimeoutError(replyType, timeoutMs));
        }, timeoutMs);
      }
    });
  }

  private failWaiters(err: Error): void {
    for (const w of this.waiters.values()) w.reject(err);
    this.waiters.clear();
    for (const w of this.pingWaiters.values()) w.reject(err);
    this.pingWaiters.clear();
  }
}

/** The device answered a request with a protocol `error` message. */
export class ServerErrorReply extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ServerErrorReply";
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

/** Fill a decoded SensorState's absent fields (proto3 omits defaults). */
function normalizeSensorState(r: Partial<SensorStateMessage>): SensorStateMessage {
  return {
    type: "sensor_state",
    status: r.status ?? "SENSOR_STATUS_UNSPECIFIED",
    part: r.part ?? "",
    i2cAddress: r.i2cAddress ?? 0,
    whoAmI: r.whoAmI ?? 0,
    sdaGpio: r.sdaGpio ?? -1,
    sclGpio: r.sclGpio ?? -1,
    accel: r.accel ?? [],
    gyro: r.gyro ?? [],
    quat: r.quat ?? [],
    gravity: r.gravity ?? [],
    linearAccel: r.linearAccel ?? [],
    gyroBias: r.gyroBias ?? [],
    temperatureC: r.temperatureC ?? 0,
    shake: r.shake ?? 0,
    tapCount: r.tapCount ?? 0,
    shakeCount: r.shakeCount ?? 0,
    atRest: r.atRest ?? false,
    sampleRateHz: r.sampleRateHz ?? 0,
    samples: r.samples ?? 0,
    fifoOverflows: r.fifoOverflows ?? 0,
    busErrors: r.busErrors ?? 0,
    fifo: r.fifo ?? false,
    calibrated: r.calibrated ?? false,
    accelScaleCorrected: r.accelScaleCorrected ?? false,
    fusionCycles: r.fusionCycles ?? 0,
    calibrationSeq: r.calibrationSeq ?? 0,
    calibrationResult: r.calibrationResult ?? "",
    intGpio: r.intGpio ?? -1,
    restUpImu: r.restUpImu ?? [],
    restUpSigmaDeg: r.restUpSigmaDeg ?? 0,
    restSamples: r.restSamples ?? 0,
    mountQuat: r.mountQuat ?? [],
    mountExtrinsic: r.mountExtrinsic ?? false,
    mountYawResolved: r.mountYawResolved ?? false,
    mountPoses: r.mountPoses ?? 0,
    mountResidualDeg: r.mountResidualDeg ?? 0,
    mountCalibratedAtMs: Number(r.mountCalibratedAtMs ?? 0),
  };
}

function normalizeDriverState(r: Partial<DriverStateMessage>): DriverStateMessage {
  return {
    type: "driver_state",
    running: r.running ?? false,
    pollIntervalMs: r.pollIntervalMs ?? 0,
    exports: (r.exports ?? []).map((e) => ({ name: e.name ?? "", value: e.value ?? [] })),
    lastPoll: r.lastPoll ?? "",
    polls: r.polls ?? 0,
    busErrors: r.busErrors ?? 0,
    pollCyclesMean: r.pollCyclesMean ?? 0,
    pollCyclesMax: r.pollCyclesMax ?? 0,
    pollInstrsMean: r.pollInstrsMean ?? 0,
    busOps: r.busOps ?? 0,
    heapBytes: r.heapBytes ?? 0,
    jitterUsMax: r.jitterUsMax ?? 0,
    feedImu: r.feedImu ?? false,
  };
}

function normalizeProfile(r: Partial<CaptureProfileFlat>): CaptureProfileFlat {
  return {
    mapId: r.mapId ?? "",
    diffuse: r.diffuse ?? false,
    strideSpacing: r.strideSpacing ?? 0,
    anchorDensity: r.anchorDensity ?? 0,
    symbols: r.symbols ?? 0,
    bitPeriodMs: r.bitPeriodMs ?? 0,
    brightness: r.brightness ?? 0,
    detectThreshold: r.detectThreshold ?? 0,
    downscale: r.downscale ?? 0,
    lcGain: r.lcGain ?? 0,
    capturedAtMs: Number(r.capturedAtMs ?? 0),
    exposure: r.exposure ?? 0,
  };
}
