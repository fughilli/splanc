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
    encode_set_uniforms, ServerMsg, UniformValue,
};
use crate::texture::{ChannelOrder, Format, TextureStreamer};
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
    /// frame between worker sends is transmitted.
    pub fn push_texture(&self, pixels: &[u8], w: usize, h: usize) {
        let mut g = self.inner.lock().unwrap();
        g.pending_pixels = Some((pixels.to_vec(), w, h));
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
        }
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

    // Fetch the uniform manifest (best effort; empty on current firmware).
    ws.send_binary(&encode_get_effect_uniforms(None)).ok();
    let ports = read_manifest(&mut ws, timeout);

    // Optionally activate an effect.
    if let Some(id) = &cfg.effect_id {
        if !id.is_empty() {
            ws.send_binary(&encode_set_effect(id)).ok();
            ws.set_read_timeout(Some(Duration::from_millis(300))).ok();
            let _ = ws.recv_message();
        }
    }

    {
        let mut g = inner.lock().unwrap();
        g.connected = true;
        g.error.clear();
        g.name = welcome.1;
        g.mac = welcome.0;
        g.ports = ports;
        g.last_uniforms.clear();
    }

    let mut streamer = TextureStreamer::new(cfg.tex_index, cfg.format, cfg.order, cfg.rle);

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
            let frame = streamer.encode_frame(&px, w, h);
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

/// Read the `effect_uniforms` reply (if any) and parse its manifest.
fn read_manifest(ws: &mut WsClient, timeout: Duration) -> Vec<UniformPort> {
    ws.set_read_timeout(Some(timeout)).ok();
    for _ in 0..4 {
        match ws.recv_message() {
            Ok(frame) => match decode_server(&frame) {
                Some(ServerMsg::EffectUniforms(e)) => return manifest::parse(&e.manifest),
                Some(ServerMsg::Error { .. }) => return Vec::new(),
                _ => continue,
            },
            Err(_) => return Vec::new(),
        }
    }
    Vec::new()
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
