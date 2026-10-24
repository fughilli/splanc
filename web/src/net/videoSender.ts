/**
 * Per-fixture video sender: latest-wins, bounded in-flight, so a video stream's
 * latency stays at about one frame instead of growing a backlog.
 *
 * The old path encoded every captured frame and fired it at the socket. The
 * browser (and the kernel under it) queue without bound, while the fixture's
 * TCP window is 4 KB, so any slow patch on the device or the air (a lost
 * segment, a busy render) let frames pile up in the sender, and the fixture
 * then played the backlog back as a catch-up burst: the "laggy bursts".
 *
 * Here a captured frame becomes `pending`, replacing (dropping) any older
 * pending frame. A frame is only ENCODED when it is about to be sent, so a drop
 * never breaks the XOR-delta chain (the delta is always against what the device
 * last received). At most `maxInFlight` frames are unconfirmed at once:
 * after each frame the sender issues an in-order marker (a time_sync_ping: the
 * player handles messages in order, so its pong means the frame before it was
 * applied) and only sends the next frame once a marker returns. A marker that
 * isn't back within ~3x the recent round trip (min 100 ms) frees its slot
 * anyway: the stream is TCP, so the frame itself still arrives, but one lost
 * reply segment costs the fixture a retransmission timeout (120-265 ms measured
 * on the C6) and must not freeze the video for that long.
 *
 * Periodic keyframes bound how long a device-side mismatch can corrupt the
 * image: the player drops a set_texture while its effect is being swapped (no
 * texture to decode into), after which XOR deltas would apply to a stale base.
 *
 * Transport-agnostic: a LedMapperClient (direct wss) satisfies VideoTransport,
 * and so can any per-fixture channel of a fan-out hub.
 */

import type { SetTextureMessage } from "./proto";
import { TextureStreamer, type TextureFormat } from "./textureCodec";

/** What the sender needs from a fixture connection. */
export interface VideoTransport {
  readonly isConnected: boolean;
  /** Queue one set_texture; false when the socket isn't open. */
  setTexture(msg: SetTextureMessage): boolean;
  /**
   * An in-order round trip: resolves once the device has handled everything
   * sent before it (LedMapperClient.ping = time_sync_ping/pong). Rejects on
   * timeout or disconnect. Absent: the sender falls back to fire-and-forget.
   */
  ping?(timeoutMs: number): Promise<number>;
}

export interface VideoSenderOptions {
  texIndex: number;
  format?: TextureFormat;
  rle?: boolean;
  /** Frames sent but not yet confirmed applied. 2 keeps a 30 fps stream flowing
   * across a ~30 ms apply round trip while bounding the backlog to ~2 frames. */
  maxInFlight?: number;
  /** Force a keyframe at least this often (ms); 0 = only on start/errors. */
  keyframeIntervalMs?: number;
  /** Floor of the adaptive marker timeout (ms): a marker not answered within
   * max(this, 3x the recent median round trip) frees its slot. */
  ackTimeoutMs?: number;
  now?: () => number;
}

export interface VideoSenderStats {
  /** Frames handed to submit(). */
  submitted: number;
  /** Frames actually encoded + sent. */
  sent: number;
  /** Frames replaced while pending (stale, never encoded). */
  dropped: number;
  keyframes: number;
  /** Markers answered / timed out. */
  acked: number;
  timeouts: number;
  inFlight: number;
  /** Encoded bytes of the last frame sent. */
  lastBytes: number;
  /** Send -> applied round trip of recent frames (ms), median and p95. */
  latencyP50Ms: number;
  latencyP95Ms: number;
}

const LATENCY_WINDOW = 90;

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const k = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[k]!;
}

export class VideoSender {
  private readonly streamer: TextureStreamer;
  private readonly maxInFlight: number;
  private readonly keyframeIntervalMs: number;
  private readonly ackTimeoutMs: number;
  private readonly now: () => number;

  private pending: { width: number; height: number; rgba: Uint8Array | Uint8ClampedArray } | null =
    null;
  private inFlight = 0;
  // Bumped by reset(): markers from before a reset no longer touch the counters.
  private generation = 0;
  private lastKeyframeAt = Number.NEGATIVE_INFINITY;
  private latencies: number[] = [];
  private counters = { submitted: 0, sent: 0, dropped: 0, keyframes: 0, acked: 0, timeouts: 0 };
  private lastBytes = 0;

  constructor(
    private readonly transport: VideoTransport,
    opts: VideoSenderOptions,
  ) {
    this.streamer = new TextureStreamer(opts.texIndex, opts.format ?? "rgb565", opts.rle ?? true);
    this.maxInFlight = Math.max(1, opts.maxInFlight ?? 2);
    this.keyframeIntervalMs = opts.keyframeIntervalMs ?? 2000;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? 100;
    this.now = opts.now ?? (() => performance.now());
  }

  /** Offer the newest captured frame. It replaces any frame still waiting for a
   * free slot (that one is dropped, never encoded) and goes out as soon as the
   * in-flight bound allows. */
  submit(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray): void {
    this.counters.submitted++;
    if (this.pending) this.counters.dropped++;
    this.pending = { width, height, rgba };
    this.pump();
  }

  /** Start over (stream start, reconnect, texture/format change): the next
   * frame is a keyframe and nothing is considered in flight. */
  reset(): void {
    this.generation++;
    this.pending = null;
    this.inFlight = 0;
    this.streamer.reset();
    this.lastKeyframeAt = Number.NEGATIVE_INFINITY;
  }

  stats(): VideoSenderStats {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return {
      ...this.counters,
      inFlight: this.inFlight,
      lastBytes: this.lastBytes,
      latencyP50Ms: percentile(sorted, 0.5),
      latencyP95Ms: percentile(sorted, 0.95),
    };
  }

  private pump(): void {
    while (this.pending && this.inFlight < this.maxInFlight) {
      if (!this.transport.isConnected) {
        // Nothing reaches the device while down; whatever it holds after a
        // reconnect is unknown, so the next frame must be a keyframe.
        this.streamer.reset();
        return;
      }
      const { width, height, rgba } = this.pending;
      this.pending = null;
      const t = this.now();
      if (this.keyframeIntervalMs > 0 && t - this.lastKeyframeAt >= this.keyframeIntervalMs) {
        this.streamer.reset();
      }
      const msg = this.streamer.frame(width, height, rgba);
      if ((msg.flags & 0x01) === 0) {
        this.lastKeyframeAt = t;
        this.counters.keyframes++;
      }
      if (!this.transport.setTexture(msg)) {
        this.streamer.reset();
        return;
      }
      this.counters.sent++;
      this.lastBytes = msg.data.length;
      if (!this.transport.ping) continue; // no marker: legacy fire-and-forget
      this.inFlight++;
      const gen = this.generation;
      const recent = [...this.latencies].sort((a, b) => a - b);
      const timeout = Math.min(1000, Math.max(this.ackTimeoutMs, 3 * percentile(recent, 0.5)));
      this.transport.ping(timeout).then(
        () => {
          if (gen !== this.generation) return;
          this.counters.acked++;
          this.latencies.push(this.now() - t);
          if (this.latencies.length > LATENCY_WINDOW) this.latencies.shift();
          this.inFlight--;
          this.pump();
        },
        () => {
          if (gen !== this.generation) return;
          // Late or lost reply: free the slot. The frame itself rides TCP, so the
          // delta chain is intact; a real disconnect resets it (isConnected).
          this.counters.timeouts++;
          this.inFlight--;
          this.pump();
        },
      );
    }
  }
}
