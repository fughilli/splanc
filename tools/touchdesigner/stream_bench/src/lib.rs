//! Video-streaming performance probe for the player's `set_texture` path, built
//! on the SAME networking core the TouchDesigner plugin uses: it streams frames
//! through [`td_ledmapper::texture::TextureStreamer`] (the exact quantize → XOR
//! delta → RLE encoder), over [`td_ledmapper::ws::WsClient`] (the plugin's
//! RFC 6455 client on the plain `ws:81` player socket), speaking the same
//! [`td_ledmapper::proto`] envelopes. So a PASS here means the real plugin's
//! streaming path sustains the measured rate on the device — not a re-encoded
//! approximation of it.
//!
//! Measuring an applied-frame rate is the subtlety: `set_texture` is
//! fire-and-forget (no per-frame ack). But the device's WebSocket receive loop
//! is serial — it fully applies each incoming frame before reading the next — so
//! the reply to a query queued *behind* N `set_texture` frames only comes back
//! once the device has drained and applied all N. We exploit that: stream frames
//! in small windows, and between windows issue a `get_effect_uniforms` round-trip
//! (a response-only reply, unlike the occasionally-unsolicited `status`) as a
//! barrier. The wall-clock from the first frame to the final barrier therefore
//! reflects the device actually applying every frame. Each window also yields a
//! per-window frame time, whose spread is the **jitter** we report and minimize.

use std::time::{Duration, Instant};

use td_ledmapper::proto::{
    decode_server, encode_get_effect_uniforms, encode_hello, encode_set_effect, EffectUniforms,
    ServerMsg,
};
use td_ledmapper::texture::{ChannelOrder, Format, TextureStreamer};
use td_ledmapper::ws::WsClient;

/// The player WebSocket path (same as the plugin's).
pub const WS_PATH: &str = "/ws";

/// Generate one frame of a scrolling vertical-bars test pattern as a
/// 4-byte-per-pixel RGBA buffer (row-major). Column `x` is lit (white) when
/// `((x + phase) / bar_w)` is even and black otherwise, so the bars scroll one
/// column per `phase` step. Every frame differs from the last, which keeps the
/// encoder's XOR-delta + RLE path honest: a static pattern would delta to all
/// zeros after the first frame and measure nothing like real video.
pub fn scrolling_bars_rgba(w: usize, h: usize, phase: usize, bar_w: usize) -> Vec<u8> {
    let bw = bar_w.max(1);
    let mut px = vec![0u8; w * h * 4];
    for x in 0..w {
        let lit = ((x + phase) / bw) % 2 == 0;
        let v = if lit { 255u8 } else { 0u8 };
        for y in 0..h {
            let o = (y * w + x) * 4;
            px[o] = v;
            px[o + 1] = v;
            px[o + 2] = v;
            px[o + 3] = 255;
        }
    }
    px
}

/// Frames per second for a count over an elapsed duration (0 when no time
/// elapsed, so a degenerate run can't divide by zero).
pub fn fps(frames: u64, elapsed_s: f64) -> f64 {
    if elapsed_s <= 0.0 {
        0.0
    } else {
        frames as f64 / elapsed_s
    }
}

/// Whether the measured rate clears the acceptance threshold.
pub fn acceptable(fps: f64, min_fps: f64) -> bool {
    fps >= min_fps
}

/// Summary statistics of the per-window frame-time samples (all in ms).
#[derive(Clone, Copy, Debug, Default)]
pub struct Jitter {
    /// Mean per-frame interval.
    pub mean_ms: f64,
    /// Standard deviation of the per-frame interval — the headline jitter number.
    pub stddev_ms: f64,
    /// 99th-percentile per-frame interval (tail latency).
    pub p99_ms: f64,
    /// Worst single-window per-frame interval (e.g. a keyframe spike).
    pub max_ms: f64,
    /// Number of windows sampled.
    pub windows: usize,
}

/// Reduce a set of per-window frame-time samples (ms) to [`Jitter`].
pub fn summarize(mut samples_ms: Vec<f64>) -> Jitter {
    if samples_ms.is_empty() {
        return Jitter::default();
    }
    let n = samples_ms.len();
    let mean = samples_ms.iter().sum::<f64>() / n as f64;
    let var = samples_ms.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / n as f64;
    samples_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    // Nearest-rank p99 (index clamped into range).
    let idx = (((n as f64) * 0.99).ceil() as usize).saturating_sub(1).min(n - 1);
    Jitter {
        mean_ms: mean,
        stddev_ms: var.sqrt(),
        p99_ms: samples_ms[idx],
        max_ms: *samples_ms.last().unwrap(),
        windows: n,
    }
}

/// Static configuration for one streaming run.
#[derive(Clone)]
pub struct BenchConfig {
    /// `host:port` of the plain-`ws` player socket to stream into.
    pub addr: String,
    /// HTTP `Host:` header for the upgrade (the device ignores it; any value works).
    pub host_header: String,
    /// If non-empty, sent as `set_effect` to activate the effect we stream into
    /// when the already-active effect doesn't declare a matching texture.
    pub effect_id: String,
    pub tex_index: u32,
    pub width: usize,
    pub height: usize,
    pub bar_w: usize,
    pub format: Format,
    pub rle: bool,
    /// Emit a full keyframe every N frames (0 = only the initial one).
    pub keyframe_interval: u32,
    /// How long to stream before reporting.
    pub seconds: f64,
    /// Issue a barrier round-trip after every this-many frames. This is also the
    /// jitter sampling window: smaller windows resolve per-frame spikes better
    /// but pay one round-trip more often.
    pub sync_every: u32,
}

/// The outcome of a streaming run.
#[derive(Clone, Copy, Debug)]
pub struct BenchResult {
    pub frames: u64,
    pub elapsed_s: f64,
    pub fps: f64,
    pub jitter: Jitter,
    /// The device's declared texture size for `tex_index` (proves we streamed
    /// into a real port — the device silently drops mismatched frames).
    pub device_tex: (u32, u32),
    pub bytes_sent: u64,
    /// Mean encoded bytes per frame (payload + envelope).
    pub bytes_per_frame: f64,
}

/// Connect, say hello, and confirm the active effect declares the `width`x`height`
/// texture at `tex_index` — (re)activating `effect_id` if needed. Returns the
/// open socket + the device's declared texture size. `Err` is a setup failure
/// (couldn't connect, or no matching texture, so nothing would be measured).
pub fn connect_and_probe(cfg: &BenchConfig) -> Result<(WsClient, (u32, u32)), String> {
    let timeout = Duration::from_millis(3000);
    let mut ws = WsClient::connect(cfg.addr.as_str(), &cfg.host_header, WS_PATH, timeout)
        .map_err(|e| format!("connect {}: {e}", cfg.addr))?;
    ws.set_read_timeout(Some(timeout)).ok();

    ws.send_binary(&encode_hello("hitl_video_stream", env!("CARGO_PKG_VERSION")))
        .map_err(|e| format!("hello: {e}"))?;
    read_until(&mut ws, |m| matches!(m, ServerMsg::Welcome(_)), 8).ok_or("no welcome received")?;

    let want = (cfg.width as u32, cfg.height as u32);
    let mut device_tex = probe_texture(&mut ws, cfg.tex_index)?;
    if device_tex != want && !cfg.effect_id.is_empty() {
        ws.send_binary(&encode_set_effect(&cfg.effect_id))
            .map_err(|e| format!("set_effect: {e}"))?;
        device_tex = probe_texture(&mut ws, cfg.tex_index)?;
    }
    if device_tex != want {
        return Err(format!(
            "active effect declares no {}x{} texture at index {} (got {}x{}); \
             the device drops mismatched set_texture frames — nothing to measure",
            cfg.width, cfg.height, cfg.tex_index, device_tex.0, device_tex.1
        ));
    }
    Ok((ws, device_tex))
}

/// Stream scrolling bars for `cfg.seconds` over an already-connected socket and
/// return the measured applied-frame rate + jitter. Used by both a single run
/// and each point of a sweep (which reuses one connection).
pub fn stream_measure(
    ws: &mut WsClient,
    cfg: &BenchConfig,
    device_tex: (u32, u32),
) -> Result<BenchResult, String> {
    let mut streamer = TextureStreamer::new(cfg.tex_index, cfg.format, ChannelOrder::Rgba, cfg.rle)
        .with_keyframe_interval(cfg.keyframe_interval);

    // Warm up: send the keyframe + a few deltas and barrier once, so the timed
    // window measures steady state, not the one-off first-touch.
    for phase in 0..4 {
        let px = scrolling_bars_rgba(cfg.width, cfg.height, phase, cfg.bar_w);
        let frame = streamer.encode_frame(&px, cfg.width, cfg.height);
        ws.send_binary(&frame).map_err(|e| format!("warmup set_texture: {e}"))?;
    }
    barrier(ws)?;

    let window = cfg.sync_every.max(1) as u64;
    let deadline = Duration::from_secs_f64(cfg.seconds.max(0.1));
    let mut frames: u64 = 0;
    let mut bytes_sent: u64 = 0;
    let mut phase: usize = 4;
    let mut win_samples_ms: Vec<f64> = Vec::new();
    let start = Instant::now();
    let mut win_start = start;
    loop {
        let px = scrolling_bars_rgba(cfg.width, cfg.height, phase, cfg.bar_w);
        let frame = streamer.encode_frame(&px, cfg.width, cfg.height);
        ws.send_binary(&frame).map_err(|e| format!("set_texture: {e}"))?;
        bytes_sent += frame.len() as u64;
        frames += 1;
        phase = phase.wrapping_add(1);
        if frames % window == 0 {
            barrier(ws)?;
            let now = Instant::now();
            let dt = now.duration_since(win_start).as_secs_f64();
            win_samples_ms.push(dt / window as f64 * 1000.0);
            win_start = now;
        }
        if start.elapsed() >= deadline {
            break;
        }
    }
    // Final barrier so `elapsed` covers the application of every frame sent.
    barrier(ws)?;
    let elapsed_s = start.elapsed().as_secs_f64();

    Ok(BenchResult {
        frames,
        elapsed_s,
        fps: fps(frames, elapsed_s),
        jitter: summarize(win_samples_ms),
        device_tex,
        bytes_sent,
        bytes_per_frame: if frames > 0 { bytes_sent as f64 / frames as f64 } else { 0.0 },
    })
}

/// One-shot: connect, probe, stream, measure.
pub fn run_bench(cfg: &BenchConfig) -> Result<BenchResult, String> {
    let (mut ws, device_tex) = connect_and_probe(cfg)?;
    stream_measure(&mut ws, cfg, device_tex)
}

/// One point of an encoder sweep: the label + the overrides applied to a base
/// [`BenchConfig`].
#[derive(Clone, Copy)]
pub struct SweepPoint {
    pub label: &'static str,
    pub format: Format,
    pub rle: bool,
    pub keyframe_interval: u32,
}

/// Run every sweep point over ONE connection (the effect/texture are fixed; the
/// pixel format rides in each `set_texture`, so no re-provision is needed). The
/// callback fires per point so the caller can stream results live. Returns the
/// collected `(point, result)` pairs.
pub fn run_sweep(
    base: &BenchConfig,
    points: &[SweepPoint],
    mut on_point: impl FnMut(&SweepPoint, &BenchResult),
) -> Result<Vec<(SweepPoint, BenchResult)>, String> {
    let (mut ws, device_tex) = connect_and_probe(base)?;
    let mut out = Vec::with_capacity(points.len());
    for p in points {
        let cfg = BenchConfig {
            format: p.format,
            rle: p.rle,
            keyframe_interval: p.keyframe_interval,
            ..base.clone()
        };
        let r = stream_measure(&mut ws, &cfg, device_tex)?;
        on_point(p, &r);
        out.push((*p, r));
    }
    Ok(out)
}

/// A round-trip barrier: request `effect_uniforms` and read until its reply.
/// Because the device applies queued `set_texture` frames before it reads this
/// request, the reply can't arrive until every prior frame has been applied.
fn barrier(ws: &mut WsClient) -> Result<(), String> {
    query_uniforms(ws).map(|_| ())
}

/// The device's declared `(width, height)` for `tex_index` on the active effect,
/// or `(0, 0)` if it declares no such texture.
fn probe_texture(ws: &mut WsClient, tex_index: u32) -> Result<(u32, u32), String> {
    let e = query_uniforms(ws)?;
    Ok(e
        .and_then(|e| e.textures.into_iter().find(|t| t.index == tex_index))
        .map(|t| (t.width, t.height))
        .unwrap_or((0, 0)))
}

/// Send `get_effect_uniforms` and return the decoded reply (`None` when the
/// device answers with an error, e.g. no active effect).
fn query_uniforms(ws: &mut WsClient) -> Result<Option<EffectUniforms>, String> {
    ws.send_binary(&encode_get_effect_uniforms(None))
        .map_err(|e| format!("get_effect_uniforms: {e}"))?;
    match read_until(
        ws,
        |m| matches!(m, ServerMsg::EffectUniforms(_) | ServerMsg::Error { .. }),
        16,
    ) {
        Some(ServerMsg::EffectUniforms(e)) => Ok(Some(e)),
        Some(ServerMsg::Error { .. }) => Ok(None),
        _ => Err("no effect_uniforms reply".into()),
    }
}

/// Read decoded server frames until one satisfies `pred`, skipping unsolicited
/// frames (status/playback_state) up to `max_frames`.
fn read_until(
    ws: &mut WsClient,
    pred: impl Fn(&ServerMsg) -> bool,
    max_frames: usize,
) -> Option<ServerMsg> {
    for _ in 0..max_frames {
        let raw = ws.recv_message().ok()?;
        if let Some(msg) = decode_server(&raw) {
            if pred(&msg) {
                return Some(msg);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bars_are_vertical_binary_and_sized() {
        // 6x2, bar width 2, phase 0.
        let f = scrolling_bars_rgba(6, 2, 0, 2);
        assert_eq!(f.len(), 6 * 2 * 4);
        // col 0: (0/2)=0 even -> lit; same in both rows (vertical bar).
        assert_eq!(&f[0..4], &[255, 255, 255, 255]);
        assert_eq!(&f[(6 + 0) * 4..(6 + 0) * 4 + 4], &[255, 255, 255, 255]);
        // col 2: (2/2)=1 odd -> dark.
        assert_eq!(&f[2 * 4..2 * 4 + 4], &[0, 0, 0, 255]);
    }

    #[test]
    fn bars_scroll_with_phase() {
        // Phase 2 shifts the pattern two columns: col 0 goes from lit to dark.
        let a = scrolling_bars_rgba(6, 1, 0, 2);
        let b = scrolling_bars_rgba(6, 1, 2, 2);
        assert_eq!(&a[0..4], &[255, 255, 255, 255]);
        assert_eq!(&b[0..4], &[0, 0, 0, 255]);
        // Consecutive phases always differ, so XOR deltas are never all-zero.
        let c = scrolling_bars_rgba(9, 1, 1, 3);
        let d = scrolling_bars_rgba(9, 1, 2, 3);
        assert_ne!(c, d);
    }

    #[test]
    fn fps_and_acceptance() {
        assert_eq!(fps(30, 3.0), 10.0);
        assert_eq!(fps(5, 0.0), 0.0);
        assert!(acceptable(10.0, 10.0));
        assert!(acceptable(12.5, 10.0));
        assert!(!acceptable(9.9, 10.0));
    }

    #[test]
    fn summarize_stats() {
        let j = summarize(vec![10.0, 10.0, 10.0, 10.0]);
        assert_eq!(j.mean_ms, 10.0);
        assert_eq!(j.stddev_ms, 0.0);
        assert_eq!(j.max_ms, 10.0);
        assert_eq!(j.windows, 4);

        let j2 = summarize(vec![10.0, 20.0]);
        assert_eq!(j2.mean_ms, 15.0);
        assert!((j2.stddev_ms - 5.0).abs() < 1e-9);
        assert_eq!(j2.max_ms, 20.0);

        assert_eq!(summarize(vec![]).windows, 0);
    }
}
