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
//! reflects the device actually applying every frame, and `frames / elapsed` is
//! the real applied-frame rate — not just how fast the host filled socket buffers.

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

/// Static configuration for one streaming run.
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
    /// How long to stream before reporting.
    pub seconds: f64,
    /// Issue a barrier round-trip after every this-many frames (bounds how many
    /// frames sit in flight, so `elapsed` tracks device application).
    pub sync_every: u32,
}

/// The outcome of a streaming run.
pub struct BenchResult {
    pub frames: u64,
    pub elapsed_s: f64,
    pub fps: f64,
    /// The device's declared texture size for `tex_index` (proves we streamed
    /// into a real port — the device silently drops mismatched frames).
    pub device_tex: (u32, u32),
    pub bytes_sent: u64,
}

/// Connect, activate/confirm the texture effect, stream scrolling bars for
/// `cfg.seconds`, and return the measured applied-frame rate. `Err` is a setup
/// failure (couldn't connect, or the active effect has no matching texture so
/// nothing would be measured) — distinct from a low-but-real FPS, which is a
/// valid `Ok` the caller judges against a threshold.
pub fn run_bench(cfg: &BenchConfig) -> Result<BenchResult, String> {
    let timeout = Duration::from_millis(3000);
    let mut ws = WsClient::connect(cfg.addr.as_str(), &cfg.host_header, WS_PATH, timeout)
        .map_err(|e| format!("connect {}: {e}", cfg.addr))?;
    ws.set_read_timeout(Some(timeout)).ok();

    ws.send_binary(&encode_hello("hitl_video_stream", env!("CARGO_PKG_VERSION")))
        .map_err(|e| format!("hello: {e}"))?;
    read_until(&mut ws, |m| matches!(m, ServerMsg::Welcome(_)), 8).ok_or("no welcome received")?;

    let want = (cfg.width as u32, cfg.height as u32);

    // Probe the already-active effect first; only (re)activate ours if it isn't
    // the one carrying the texture we mean to stream into. Streaming into a port
    // the device didn't declare at exactly this size is silently dropped, so we
    // fail loudly here rather than "measure" zero applied frames.
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

    let mut streamer =
        TextureStreamer::new(cfg.tex_index, cfg.format, ChannelOrder::Rgba, cfg.rle);

    // Warm up: send the keyframe + a few deltas and barrier once, so the timed
    // window measures steady-state streaming, not the one-off keyframe.
    for phase in 0..4 {
        let px = scrolling_bars_rgba(cfg.width, cfg.height, phase, cfg.bar_w);
        let frame = streamer.encode_frame(&px, cfg.width, cfg.height);
        ws.send_binary(&frame).map_err(|e| format!("warmup set_texture: {e}"))?;
    }
    barrier(&mut ws)?;

    let sync_every = cfg.sync_every.max(1) as u64;
    let deadline = Duration::from_secs_f64(cfg.seconds.max(0.1));
    let mut frames: u64 = 0;
    let mut bytes_sent: u64 = 0;
    let mut phase: usize = 4;
    let start = Instant::now();
    loop {
        let px = scrolling_bars_rgba(cfg.width, cfg.height, phase, cfg.bar_w);
        let frame = streamer.encode_frame(&px, cfg.width, cfg.height);
        ws.send_binary(&frame).map_err(|e| format!("set_texture: {e}"))?;
        bytes_sent += frame.len() as u64;
        frames += 1;
        phase = phase.wrapping_add(1);
        if frames % sync_every == 0 {
            barrier(&mut ws)?;
        }
        if start.elapsed() >= deadline {
            break;
        }
    }
    // Final barrier so `elapsed` covers the application of every frame sent.
    barrier(&mut ws)?;
    let elapsed_s = start.elapsed().as_secs_f64();

    Ok(BenchResult {
        frames,
        elapsed_s,
        fps: fps(frames, elapsed_s),
        device_tex,
        bytes_sent,
    })
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
}
