//! A non-blocking fixture session.
//!
//! TouchDesigner cooks operators on a real-time thread that must never block on
//! the network. So a [`Session`] owns a background worker thread that holds the
//! WebSocket connection and does all I/O; the operator's `execute()` only ever
//! pushes the latest pixels / uniform values into shared state (coalesced — the
//! worker always sends the most recent) and reads a status snapshot. The worker
//! reconnects on its own and re-fetches the uniform manifest.

use crate::discovery::{DEFAULT_WS_PORT, WS_PATH};
use crate::manifest::{self, UniformPort};
use crate::proto::{
    decode_server, encode_get_effect_uniforms, encode_hello, encode_set_effect,
    encode_set_uniforms, ServerMsg, TexturePort, UniformValue,
};
use crate::texture::{nn_rescale, ChannelOrder, Format, TextureStreamer};
use crate::ws::WsClient;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

/// Static per-session configuration. Changing any field triggers a reconnect.
#[derive(Clone)]
pub struct Config {
    pub addr: String,
    pub tex_index: u32,
    pub format: Format,
    pub order: ChannelOrder,
    pub rle: bool,
    /// Emit a full keyframe every N frames (0 = only the initial one). Guards a
    /// lossy path: a dropped delta frame corrupts the raster only until the next
    /// keyframe. See [`crate::texture::TextureStreamer`].
    pub keyframe_interval: u32,
    /// If set, the effect to activate on connect.
    pub effect_id: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            addr: String::new(),
            tex_index: 0,
            format: Format::Rgb565,
            order: ChannelOrder::Bgra,
            rle: true,
            keyframe_interval: 0,
            effect_id: None,
        }
    }
}

#[derive(Default, Clone)]
pub struct Status {
    pub connected: bool,
    pub name: String,
    pub mac: String,
    pub error: String,
    pub frames_sent: u64,
    /// Declared texture size for the configured `tex_index`, as probed from the
    /// device's active effect. `(0, 0)` when the device advertises none (older
    /// firmware) or the index isn't a declared texture.
    pub device_tex: (u32, u32),
    /// The size the streamer actually rescales frames to before sending:
    /// the probed device size, else the manual fallback, else `(0, 0)` for
    /// pass-through (send the source frame as-is).
    pub target: (u32, u32),
}

#[derive(Default)]
struct Inner {
    cfg: Config,
    generation: u64,
    connected: bool,
    error: String,
    name: String,
    mac: String,
    frames_sent: u64,
    ports: Vec<UniformPort>,
    /// Declared texture inputs of the connected effect (empty on older firmware).
    textures: Vec<TexturePort>,
    /// Manual target size used only when the device advertises no texture for
    /// the configured index (`(0, 0)` = unset). Set out-of-band, no reconnect.
    manual_target: (u32, u32),
    /// Device texture size for the configured index / effective target,
    /// republished by the worker for status readout.
    device_tex: (u32, u32),
    target: (u32, u32),
    pending_pixels: Option<(Vec<u8>, usize, usize)>,
    pending_uniforms: Option<Vec<UniformValue>>,
    last_uniforms: Vec<UniformValue>,
}

pub struct Session {
    inner: Arc<Mutex<Inner>>,
    run: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl Session {
    /// Start a session against `cfg.addr` (worker connects asynchronously).
    pub fn start(cfg: Config) -> Session {
        let inner = Arc::new(Mutex::new(Inner { cfg, generation: 1, ..Default::default() }));
        let run = Arc::new(AtomicBool::new(true));
        let worker = spawn_worker(inner.clone(), run.clone());
        Session { inner, run, worker: Some(worker) }
    }

    /// Replace the configuration (reconnects the worker).
    pub fn reconfigure(&self, cfg: Config) {
        let mut g = self.inner.lock().unwrap();
        g.cfg = cfg;
        g.generation += 1;
    }

    /// Push the most recent frame (4 bytes/pixel). Coalesced: only the latest
    /// frame between worker sends is transmitted. The worker rescales it to the
    /// effective target size (probed device size, else manual fallback) before
    /// encoding, so callers push the source frame at its native resolution.
    pub fn push_texture(&self, pixels: &[u8], w: usize, h: usize) {
        let mut g = self.inner.lock().unwrap();
        g.pending_pixels = Some((pixels.to_vec(), w, h));
    }

    /// Set the manual fallback target size used when the device advertises no
    /// texture for the configured index (`(0, 0)` disables it). Does not
    /// reconnect — it only affects how the next frame is rescaled.
    pub fn set_manual_target(&self, w: u32, h: u32) {
        self.inner.lock().unwrap().manual_target = (w, h);
    }

    /// Map named channel values onto uniform slots via the fixture's manifest
    /// (falling back to `slotN`-style names when the device advertises none) and
    /// push the result. Change-detected like [`Self::push_uniforms`].
    pub fn drive_uniforms(&self, channels: &std::collections::HashMap<String, f32>) {
        let ports = self.inner.lock().unwrap().ports.clone();
        let values = if ports.is_empty() {
            manifest::fallback_map(channels)
        } else {
            manifest::map_channels(&ports, channels)
        };
        self.push_uniforms(values);
    }

    /// Push uniform values. Only transmitted when they differ from the last
    /// values sent (avoids flooding the device at cook rate).
    pub fn push_uniforms(&self, values: Vec<UniformValue>) {
        let mut g = self.inner.lock().unwrap();
        if uniforms_equal(&g.last_uniforms, &values) {
            return;
        }
        g.pending_uniforms = Some(values);
    }

    pub fn status(&self) -> Status {
        let g = self.inner.lock().unwrap();
        Status {
            connected: g.connected,
            name: g.name.clone(),
            mac: g.mac.clone(),
            error: g.error.clone(),
            frames_sent: g.frames_sent,
            device_tex: g.device_tex,
            target: g.target,
        }
    }

    /// The declared texture inputs of the connected effect (empty when the
    /// device advertises none — older firmware).
    pub fn textures(&self) -> Vec<TexturePort> {
        self.inner.lock().unwrap().textures.clone()
    }

    /// The uniform ports advertised by the connected fixture's active effect
    /// (empty when the device embeds no manifest — see [`crate::manifest`]).
    pub fn ports(&self) -> Vec<UniformPort> {
        self.inner.lock().unwrap().ports.clone()
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.run.store(false, Ordering::SeqCst);
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
    }
}

fn uniforms_equal(a: &[UniformValue], b: &[UniformValue]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b).all(|(x, y)| x.slot == y.slot && x.values == y.values)
}

fn spawn_worker(inner: Arc<Mutex<Inner>>, run: Arc<AtomicBool>) -> JoinHandle<()> {
    std::thread::spawn(move || {
        while run.load(Ordering::SeqCst) {
            let (cfg, generation) = {
                let g = inner.lock().unwrap();
                (g.cfg.clone(), g.generation)
            };
            if cfg.addr.trim().is_empty() {
                std::thread::sleep(Duration::from_millis(200));
                continue;
            }
            if let Err(e) = run_connection(&inner, &run, &cfg, generation) {
                let mut g = inner.lock().unwrap();
                g.connected = false;
                g.error = e;
            }
            // Backoff before reconnecting (unless we're shutting down).
            for _ in 0..10 {
                if !run.load(Ordering::SeqCst) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    })
}

/// One connection attempt + steady-state loop. Returns `Err(msg)` to trigger a
/// reconnect; returns `Ok(())` when a config change or shutdown ends the loop.
fn run_connection(
    inner: &Arc<Mutex<Inner>>,
    run: &Arc<AtomicBool>,
    cfg: &Config,
    generation: u64,
) -> Result<(), String> {
    let timeout = Duration::from_millis(1500);
    let (host, _) = split(&cfg.addr);
    let mut ws = WsClient::connect(sockaddr(&cfg.addr), &host, WS_PATH, timeout)
        .map_err(|e| format!("connect: {e}"))?;

    ws.send_binary(&encode_hello("touchdesigner", env!("CARGO_PKG_VERSION")))
        .map_err(|e| format!("hello: {e}"))?;
    ws.set_read_timeout(Some(timeout)).ok();
    let welcome = read_until_welcome(&mut ws)?;

    // Activate the requested effect FIRST, so the manifest/texture query below
    // describes the effect we're about to stream into (not the previous one).
    if let Some(id) = &cfg.effect_id {
        if !id.is_empty() {
            ws.send_binary(&encode_set_effect(id)).ok();
            ws.set_read_timeout(Some(Duration::from_millis(300))).ok();
            let _ = ws.recv_message();
        }
    }

    // Fetch the active effect's uniform manifest + declared textures (best
    // effort; both empty on current firmware).
    ws.send_binary(&encode_get_effect_uniforms(None)).ok();
    let (ports, textures) = read_effect_uniforms(&mut ws, timeout);

    // The declared size of the texture port we stream into (0,0 when the device
    // advertises none — older firmware, or a non-texture index).
    let device_tex = textures
        .iter()
        .find(|t| t.index == cfg.tex_index)
        .map(|t| (t.width, t.height))
        .unwrap_or((0, 0));

    {
        let mut g = inner.lock().unwrap();
        g.connected = true;
        g.error.clear();
        g.name = welcome.1;
        g.mac = welcome.0;
        g.ports = ports;
        g.textures = textures;
        g.device_tex = device_tex;
        g.last_uniforms.clear();
    }

    let mut streamer = TextureStreamer::new(cfg.tex_index, cfg.format, cfg.order, cfg.rle)
        .with_keyframe_interval(cfg.keyframe_interval);

    while run.load(Ordering::SeqCst) {
        // Config changed under us -> reconnect with the new settings.
        if inner.lock().unwrap().generation != generation {
            return Ok(());
        }

        let (pixels, uniforms) = {
            let mut g = inner.lock().unwrap();
            (g.pending_pixels.take(), g.pending_uniforms.take())
        };

        let mut did_work = false;
        if let Some(values) = uniforms {
            ws.send_binary(&encode_set_uniforms(&values)).map_err(|e| format!("set_uniforms: {e}"))?;
            // Consume the playback_state reply (bounded; a timeout is fine).
            ws.set_read_timeout(Some(Duration::from_millis(200))).ok();
            let _ = ws.recv_message();
            inner.lock().unwrap().last_uniforms = values;
            did_work = true;
        }
        if let Some((px, w, h)) = pixels {
            // Resolve the effective target size: the device's declared size
            // wins; else the manual fallback; else pass the frame through at
            // its source size. Republish it for status readout.
            let manual = inner.lock().unwrap().manual_target;
            let target = if device_tex.0 > 0 && device_tex.1 > 0 {
                device_tex
            } else if manual.0 > 0 && manual.1 > 0 {
                manual
            } else {
                (w as u32, h as u32)
            };
            inner.lock().unwrap().target = target;
            let (tw, th) = (target.0 as usize, target.1 as usize);
            let frame = if (tw, th) != (w, h) {
                let scaled = nn_rescale(&px, w, h, tw, th);
                streamer.encode_frame(&scaled, tw, th)
            } else {
                streamer.encode_frame(&px, w, h)
            };
            ws.send_binary(&frame).map_err(|e| format!("set_texture: {e}"))?;
            inner.lock().unwrap().frames_sent += 1;
            did_work = true;
        }
        if !did_work {
            std::thread::sleep(Duration::from_millis(3));
        }
    }
    Ok(())
}

/// Read frames until the `welcome` handshake reply. Returns (mac, name).
fn read_until_welcome(ws: &mut WsClient) -> Result<(String, String), String> {
    for _ in 0..6 {
        let frame = ws.recv_message().map_err(|e| format!("welcome: {e}"))?;
        if let Some(ServerMsg::Welcome(w)) = decode_server(&frame) {
            let name = if w.device_name.is_empty() { "player".to_string() } else { w.device_name };
            return Ok((w.mac, name));
        }
    }
    Err("no welcome received".into())
}

/// Read the `effect_uniforms` reply (if any) and parse its uniform manifest +
/// declared texture ports. Both empty on current firmware / on any error.
fn read_effect_uniforms(
    ws: &mut WsClient,
    timeout: Duration,
) -> (Vec<UniformPort>, Vec<TexturePort>) {
    ws.set_read_timeout(Some(timeout)).ok();
    for _ in 0..4 {
        match ws.recv_message() {
            Ok(frame) => match decode_server(&frame) {
                Some(ServerMsg::EffectUniforms(e)) => {
                    return (manifest::parse(&e.manifest), e.textures);
                }
                Some(ServerMsg::Error { .. }) => return (Vec::new(), Vec::new()),
                _ => continue,
            },
            Err(_) => return (Vec::new(), Vec::new()),
        }
    }
    (Vec::new(), Vec::new())
}

// host:port helpers ---------------------------------------------------------

fn split(addr: &str) -> (String, u16) {
    match addr.rsplit_once(':') {
        Some((h, p)) if p.parse::<u16>().is_ok() && !h.is_empty() => (h.to_string(), p.parse().unwrap()),
        _ => (addr.to_string(), DEFAULT_WS_PORT),
    }
}

fn sockaddr(addr: &str) -> String {
    let (h, p) = split(addr);
    format!("{h}:{p}")
}
