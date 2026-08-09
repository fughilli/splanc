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

## Hill-climb findings (24×24 scrolling bars, C6, window=30)

| config                    | FPS    | jitter σ   | max   | B/frame |
| ------------------------- | ------ | ---------- | ----- | ------- |
| rgb565+rle _(TD default)_ | 74     | 1.3 ms     | 15 ms | 786     |
| rgb888+rle                | 56     | 1.3 ms     | 20 ms | 978     |
| rgb332+rle                | 79     | 2.2 ms     | 18 ms | 594     |
| **rgb332+rle kf=1**       | **87** | 1.4 ms     | 14 ms | **499** |
| gray8                     | 84     | **1.1 ms** | 12 ms | 593     |
| gray8 kf=1                | 87     | 2.8 ms     | 18 ms | 593     |

Takeaways:

- **Bytes/texel is the dominant FPS lever** — device cost scales with payload
  (transfer + dequant): rgb888 (3 B) < rgb565 (2 B) < 1-byte formats.
- **`gray8` is fastest + smoothest** where color isn't needed (grayscale dequant
  is `(g,g,g)`; no per-channel bit math like rgb332). For **color**, `rgb332`
  (1 B) leads; `rgb565` is the quality/speed default.
- **RLE only helps `rgb565`** here (786 vs 1169 B/frame). For 1-byte formats the
  horizontally-scrolling vertical-bar XOR delta scatters changed bytes across the
  row-major raster, so zero-run RLE can't coalesce them — its decode cost then
  makes `gray8` _without_ RLE faster than with.

## Keyframes for drop-resilience

An XOR-delta frame is coded against the _previous_ frame, so on a **lossy**
transport one dropped frame corrupts every frame after it until the raster is
re-sent. `--keyframe-interval N` (and `TextureStreamer::with_keyframe_interval`)
emits a full keyframe every N frames, bounding that damage to ≤ N frames.

Cost of keyframes depends on the format:

- **1-byte formats: free — often a net win.** `rgb332+rle kf=1` (a self-contained
  keyframe _every_ frame) is the fastest config _and_ the smallest (499 vs 594
  B/frame): the raw bar pattern RLE-compresses better than the scattered delta. So
  a fully drop-resilient stream costs nothing here.
- **`rgb565`: ~9%.** kf=1 dropped it from 74 → 67 FPS (a keyframe is larger than
  its delta), so use a periodic interval rather than every frame.

Recommendation for a lossy codec: **`rgb332` (or `gray8`) with RLE and a short
keyframe interval** — self-contained-ish frames, smallest payload, highest FPS.
Over the current lossless TCP/WebSocket transport keyframes aren't needed, so the
plugin default is `keyframe_interval = 0`.
