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

## Formats

`SetTexture.format` (mirrored in the host `Format`, firmware `TEX_*`, and web
`FORMAT_CODE`): `rgb888`=0, `rgb565`=1, `rgb332`=2, `gray8`=3, `indexed8`=4,
`gray4`=5 (4-bit, 2 texels/byte), `mono`=6 (1-bit, 8 texels/byte). `gray4`/`mono`
are grayscale (Rec.601 luma), sub-byte packed LSB-first.

## Hill-climb findings (24×24 scrolling bars, C6, window=30, f32 texture)

| config     | FPS  | jitter σ | B/frame | notes                          |
| ---------- | ---- | -------- | ------- | ------------------------------ |
| **mono**   | ~104 | 1.2 ms   | **87**  | 1-bit; fastest, smallest       |
| **gray4**  | ~104 | 2.3 ms   | 305     | 4-bit gray; mono speed, 16 lvl |
| gray8+rle  | ~94  | 2.2 ms   | 499     | 8-bit gray                     |
| rgb332+rle | ~90  | 2.2 ms   | 499     | 8-bit color                    |
| rgb888+rle | ~66  | 3.6 ms   | 978     | full color                     |
| rgb565+rle | ~60  | 3.5 ms   | 786     | 2-byte color                   |

(±10–15% run-to-run from WiFi/thermal; compare within one sweep, not across.
B/frame is deterministic.)

Takeaways:

- **Bytes/texel is the top FPS lever** — device cost scales with payload
  (transfer + prev-buffer XOR/fill): rgb888 (3 B) → rgb565 (2 B) → 1-byte →
  gray4 (½ B) → mono (⅛ B). `mono` at 87 B/frame is ~9× smaller than rgb565.
- **`gray4` is the sweet spot for grayscale video** — mono's speed at 16 grey
  levels instead of 2, at a third of gray8's bytes.
- **After the decoder LUT fix (below), color formats no longer pay a float tax**
  — `rgb332` sits within ~4% of `gray8` at the same 499 B/frame (was ~17% behind).
- **RLE only helps if a run structure exists.** For 1-byte-and-narrower formats
  the horizontally-scrolling vertical-bar _delta_ scatters changed bytes across
  the row-major raster, so zero-run RLE can't coalesce it — the adaptive fallback
  then prefers the (RLE-friendly, whole-bar) keyframe. For `rgb565` the 2-byte
  delta still RLEs smaller than its keyframe, so deltas stay.

## Decoder efficiency (firmware)

The ESP32-C6 has **no FPU**, so every `channel / 255.0`-style dequant in
`handle_set_texture` was a software-float divide, run `w·h·channels` times per
frame. Measured cost: at an identical 499 B/frame, `gray8` (1 divide/texel) ran
82 FPS while `rgb332` (3 divides + bit math) ran 69 — a 17% gap that was pure
decode compute, not payload.

The decoder now:

- **Precomputes a channel-level → packed-bytes lookup** (via `comp_store_num`,
  keyed by the arena's component precision and cached until it changes; plus the
  reduced-bit `/31`, `/63`, `/7`, `/3` tables) and copies the packed bytes per
  texel — **zero per-texel software-float for _any_ texture arena precision**, f32
  or a narrow `fixed8`/`fixed16`. This closed the gray8↔rgb332 gap to ~4% (both
  are now table-lookup + copy).
- **Hoists the arena bounds check** out of the per-texel loop (one span check,
  then unchecked writes bounded by it).
- **Replicates grayscale once** (all colour channels equal → look up once, copy
  to each) and skips the luma dot-product for grayscale sources.
- Handles sub-byte `gray4`/`mono` by bit-unpacking per texel.

The LUT fast path is byte-identical to the general `comp_store_num` path (same
values), so decode output is unchanged; only `indexed8` and colour-into-scalar
textures use the general path.

### Narrow texture arenas (`: fixed8` / `: fixed16`)

A texture can declare a narrow component precision — `texture vec3 v(w,h) :
fixed8;` (Q1.6, 1 B/component) or `: fixed16;` (Q1.14, 2 B) — which quarters or
halves both its on-device RAM and its per-frame store bandwidth. With the LUT the
decode stays float-free, so a narrow arena is a near-pure win. Measured (24×24,
window=30), `fixed8` vs `f32` arena lifted most formats **+20–36% FPS** (rgb565
60→82, rgb332 90→110, gray4 104→**137**, mono+rle 92→124) at ¼ the texture RAM.
Drive it from the HITL harness with `--tex-comp fixed8`.

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
