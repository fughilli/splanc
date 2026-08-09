# stream_bench — video-streaming performance probe

Streams a scrolling-vertical-bars test pattern into a player's texture port using
the **TouchDesigner plugin's own encoder** (`//tools/touchdesigner/core`:
quantize → XOR-delta → RLE via `TextureStreamer`, over the plain `ws:81` socket),
and reports the sustained applied-frame rate and jitter. Driven on real hardware
by `//pi/hitl/harness:video_stream`.

`--sweep` runs a curated (format × RLE × keyframe-interval) matrix over one
connection to hill-climb the encoder against a device in a single reservation.

## Measuring an applied-frame rate

`set_texture` is fire-and-forget, so the rate is measured by exploiting the
device's serial receive loop: stream frames in windows of `--sync-every`, and
between windows issue a `get_effect_uniforms` round-trip barrier (response-only,
unlike the occasionally-unsolicited `status`). The reply can't return until the
device has applied every frame queued ahead of it, so `frames / elapsed` is the
real applied rate, and each window's frame-time feeds the jitter stats.

**The window size matters a lot.** A small window is round-trip-bound — the
barrier RTT over the (container → rig → WiFi → device) tunnel dominates. Measured
on a real ESP32-C6, 24×24 into 256 LEDs, `rgb565+rle`:

| `--sync-every` | measured FPS |
| -------------- | ------------ |
| 10             | ~39          |
| 30             | ~74          |

The plugin streams with no barriers, so it sees the higher, window-independent
throughput. Use a large window (default 30) for a throughput number; a small
window only to resolve per-frame jitter finer.

## Hill-climb findings (24×24 scrolling bars, C6, window=30, adaptive fallback on)

| config                    | FPS     | jitter σ | max   | B/frame |
| ------------------------- | ------- | -------- | ----- | ------- |
| rgb565+rle _(TD default)_ | 74      | 1.4 ms   | 16 ms | 786     |
| rgb888+rle                | 62      | 3.2 ms   | 22 ms | 978     |
| rgb332+rle                | 84      | 1.6 ms   | 14 ms | **499** |
| **gray8+rle**             | **100** | 2.0 ms   | 14 ms | **499** |
| gray8 (no RLE)            | 96      | 1.6 ms   | 13 ms | 593     |

(±10% run-to-run from WiFi/thermal; the B/frame column is deterministic.)

Takeaways:

- **Bytes/texel is the dominant FPS lever** — device cost scales with payload
  (transfer + dequant): rgb888 (3 B) < rgb565 (2 B) < 1-byte formats.
- **`gray8`/`rgb332` + RLE win** because the adaptive fallback (below) ships
  RLE-compressed keyframes at ~499 B/frame instead of full 593 B deltas — smaller
  _and_ self-contained. `gray8` leads where color isn't needed (grayscale dequant
  is `(g,g,g)`, no per-channel bit math); `rgb332` is the 1-byte color option;
  `rgb565` is the quality/speed default.
- **RLE only helps if a run structure exists.** For 1-byte formats the
  horizontally-scrolling vertical-bar _delta_ scatters changed bytes across the
  row-major raster, so zero-run RLE can't coalesce it — but the _keyframe_ (whole
  bars) RLEs well, which is why the adaptive fallback prefers it there. For
  `rgb565` the 2-byte delta still RLEs smaller than its keyframe, so deltas stay.

## Keyframes for drop-resilience

An XOR-delta frame is coded against the _previous_ frame, so on a **lossy**
transport one dropped frame corrupts every frame after it until the raster is
re-sent. Two mechanisms guard this:

1. **Adaptive fallback (always on).** `encode_frame` encodes both the keyframe and
   the delta every frame and sends the keyframe whenever the delta isn't strictly
   smaller. This _bounds the delta blowup_: the sent frame never exceeds the
   keyframe size, and drop-recovery happens for free whenever a keyframe is no
   larger than the delta (a keyframe restarts the interval too).
2. **Periodic keyframes.** `--keyframe-interval N` (and
   `TextureStreamer::with_keyframe_interval`) forces a keyframe every N frames as a
   guaranteed refresh — needed for content whose deltas _do_ stay smaller for long
   stretches (real video), where the adaptive path alone would rarely keyframe.

Cost of keyframes depends on the format:

- **1-byte formats: free — often a net win.** For scrolling bars the raw pattern
  RLE-compresses better than the scattered delta, so with the adaptive fallback
  `rgb332+rle` (no forced interval) already sends keyframes on its own and matches
  the explicit every-frame case: fastest (~87 FPS) _and_ smallest (~499 B/frame),
  fully drop-resilient at no cost.
- **`rgb565`: deltas usually win**, so the adaptive path keeps sending deltas
  (~74 FPS) and only forced keyframes (a periodic interval) cost ~9%.

Recommendation for a lossy codec: **`rgb332` (or `gray8`) with RLE** — the
adaptive fallback self-selects keyframes, so payloads stay small and most frames
are self-contained; add a short `keyframe-interval` as a belt-and-braces refresh.
Over the current lossless TCP/WebSocket transport a forced interval isn't needed,
so the plugin default is `keyframe_interval = 0` (the adaptive fallback still
applies).
