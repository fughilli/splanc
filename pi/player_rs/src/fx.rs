//! The effects layer for the host player (`player_host`): what
//! `firmware/player_app/ffi.rs` does on the ESP32 — take the stored map's LED
//! positions and a compiled effect (`.fxb`), run update() once per frame and
//! shade() per LED on the SAME `ledmapper_fx_vm` the device and the browser
//! preview run — minus what a host doesn't need (fixed-size arenas, the JIT,
//! the per-LED memo cache).
//!
//! It intercepts the protocol arms the shared session core leaves to the
//! platform: submit_map (positions), upload_chunk (the app shards any frame
//! over 4 KB), submit_effect / set_effect / set_uniforms / get_effect_uniforms
//! / list_effects. Everything else still goes to the core.
//!
//! Scope: one deck (A). Deck B, crossfades, keypoints, textures, topology
//! (`led.seg` / `led.s`) and the stored-map dump are not served, and the
//! features advertised in the welcome ([`FEATURES`]) say so, so the app doesn't
//! offer them.

use crate::wire::Rgb;
use ledmapper_fx_vm::{Frame, Led, Program, Vm};
use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player::{upload_malformed, Player};
use ledmapper_view::ledmapper::v1 as pv;
use pb::ServerMessage_::Msg as SMsg;
use pv::client_message::Msg as CArm;
use std::path::PathBuf;

/// The protocol features this player serves (welcome.features).
pub const FEATURES: &[&str] = &["effects", "list_effects", "uniform_commit", "control_ack"];

/// ClientMessage oneof field numbers this layer handles.
const ARM_SUBMIT_MAP: u32 = 13;
const ARM_SUBMIT_EFFECT: u32 = 21;
const ARM_SET_EFFECT: u32 = 22;
const ARM_SET_UNIFORMS: u32 = 23;
const ARM_GET_EFFECT_UNIFORMS: u32 = 24;
const ARM_UPLOAD_CHUNK: u32 = 29;
const ARM_LIST_EFFECTS: u32 = 36;
/// ServerMessage.effect_uniforms (hand-encoded: the manifest is effect-sized).
const SM_EFFECT_UNIFORMS: u32 = 16;

/// Largest frame an upload_chunk sequence may reassemble to.
const MAX_UPLOAD: usize = 4 * 1024 * 1024;

/// What a handled frame produced.
pub enum Handled {
    /// A ServerMessage to encode with `Player::encode_reply` (boxed: the host
    /// profile's message carries its inline storage).
    Reply(Box<pb::ServerMessage>),
    /// An already-encoded ServerMessage.
    Raw(Vec<u8>),
    /// A reassembled frame for the session core (e.g. a sharded submit_topology).
    Forward(Vec<u8>),
}

struct Effect {
    id: String,
    bytes: Vec<u8>,
    active: bool,
    vm: Box<Vm>,
    /// Hidden buffers / textures (Program::arena_bytes), persisting across frames.
    arena: Vec<u8>,
    /// Seconds of effect time at the last frame, and the frame counter.
    last_s: Option<f64>,
    time: f64,
    frame: u32,
}

// SAFETY: `Vm` holds raw pointers only into memory this struct owns (the arena
// bound by `set_arena`, whose heap buffer moves with the Effect, rebound every
// frame) and to JIT tables, which stay null on a host (no JIT here). The Effect
// is only reached under HostFx's Mutex, so it is never shared, only moved.
unsafe impl Send for Effect {}

struct Upload {
    id: u32,
    next_seq: u32,
    data: Vec<u8>,
}

/// The effect engine + stored map. Shared with the render loop behind a Mutex;
/// never hold it while taking the player lock in the render loop (the WS side
/// takes this one, then the player's).
#[derive(Default)]
pub struct HostFx {
    effect: Option<Effect>,
    /// Per-LED positions by LED id (unmapped LEDs interpolated from neighbours).
    positions: Vec<[f32; 3]>,
    upload: Option<Upload>,
    /// Where the map and effect persist (None = memory only).
    state_dir: Option<PathBuf>,
}

impl HostFx {
    pub fn new(state_dir: Option<PathBuf>) -> Self {
        Self { state_dir, ..Default::default() }
    }

    /// Whether this layer handles `frame` (else it goes to the session core).
    pub fn intercepts(frame: &[u8]) -> bool {
        matches!(
            ledmapper_store::envelope_arm(frame),
            Some(
                ARM_SUBMIT_MAP
                    | ARM_SUBMIT_EFFECT
                    | ARM_SET_EFFECT
                    | ARM_SET_UNIFORMS
                    | ARM_GET_EFFECT_UNIFORMS
                    | ARM_UPLOAD_CHUNK
                    | ARM_LIST_EFFECTS
            )
        )
    }

    /// Handle one intercepted frame.
    pub fn handle(&mut self, player: &mut Player, frame: &[u8]) -> Handled {
        match ledmapper_store::envelope_arm(frame) {
            Some(ARM_UPLOAD_CHUNK) => self.handle_chunk(player, frame),
            Some(ARM_SUBMIT_MAP) => reply_h(self.submit_map(player, frame, true)),
            Some(ARM_SUBMIT_EFFECT) => reply_h(self.submit_effect(frame, true)),
            Some(ARM_SET_EFFECT) => reply_h(self.set_effect(player, frame)),
            Some(ARM_SET_UNIFORMS) => reply_h(self.set_uniforms(player, frame)),
            Some(ARM_GET_EFFECT_UNIFORMS) => self.get_effect_uniforms(frame),
            Some(ARM_LIST_EFFECTS) => reply_h(self.list_effects()),
            _ => Handled::Forward(frame.to_vec()),
        }
    }

    /// Replay the persisted map + effect (call once at startup).
    pub fn restore(&mut self, player: &mut Player) {
        if let Some(f) = self.read_state("map.pb") {
            let _ = self.submit_map(player, &f, false);
        }
        if let Some(f) = self.read_state("effect.pb") {
            let _ = self.submit_effect(&f, false);
        }
    }

    /// Whether an effect is rendering.
    pub fn active(&self) -> bool {
        self.effect.as_ref().is_some_and(|e| e.active)
    }

    /// The stored map's LED count (0 = no map).
    pub fn mapped_leds(&self) -> usize {
        self.positions.len()
    }

    /// Render one effect frame for an `n`-LED strip at `now_s` seconds (any
    /// monotonic clock), or None when no effect is active. LEDs past the stored
    /// map shade at the origin.
    pub fn render(&mut self, now_s: f64, n: usize, brightness: f32) -> Option<Vec<Rgb>> {
        let positions = &self.positions;
        let e = self.effect.as_mut().filter(|e| e.active)?;
        let prog = Program::parse(&e.bytes).ok()?;
        let dt = e.last_s.map_or(0.0, |t| (now_s - t).clamp(0.0, 0.25));
        e.last_s = Some(now_s);
        e.time += dt;
        e.frame = e.frame.wrapping_add(1);

        let q16 = |x: f32| (x * 65536.0) as i32;
        let pos = |i: usize| positions.get(i).copied().unwrap_or([0.0; 3]);
        let (mut mn, mut mx) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
        for i in 0..n {
            let p = pos(i);
            for k in 0..3 {
                mn[k] = mn[k].min(p[k]);
                mx[k] = mx[k].max(p[k]);
            }
        }
        if n == 0 {
            (mn, mx) = ([0.0; 3], [0.0; 3]);
        }
        let mut frame = Frame {
            time: e.time as f32,
            dt: dt as f32,
            frame: e.frame,
            led_count: n as u32,
            time_fix: q16(e.time as f32),
            dt_fix: q16(dt as f32),
            ..Default::default()
        };
        // One unposed fixture: the room box is the map's own box (as the device
        // and the preview do), and led.room reads led.pos.
        frame.room_min = mn;
        frame.room_max = mx;
        frame.room_min_fix = mn.map(q16);
        frame.room_max_fix = mx.map(q16);

        let need = prog.arena_bytes(n);
        if e.arena.len() != need {
            e.arena.resize(need, 0);
        }
        e.vm.set_arena(&mut e.arena);
        e.vm.run_update(&prog, &frame);

        let inv = |k: usize| if mx[k] - mn[k] > 1e-6 { 1.0 / (mx[k] - mn[k]) } else { 0.0 };
        let inv = [inv(0), inv(1)];
        let scale = brightness.clamp(0.0, 1.0);
        let out = (0..n)
            .map(|i| {
                let p = pos(i);
                let uv = [
                    ((p[0] - mn[0]) * inv[0]).clamp(0.0, 1.0),
                    ((p[1] - mn[1]) * inv[1]).clamp(0.0, 1.0),
                ];
                let led = Led {
                    pos: p,
                    idx: i as u32,
                    seg: -1,
                    s: 0.0,
                    branch: false,
                    dist: 0.0,
                    uv,
                    pos_fix: p.map(q16),
                    uv_fix: uv.map(q16),
                    s_fix: 0,
                    dist_fix: 0,
                    room: [0.0; 3],
                    room_fix: [0; 3],
                };
                let (r, g, b) = e.vm.run_shade(&prog, &frame, &led);
                let dim = |c: u8| (c as f32 * scale + 0.5) as u8;
                [dim(r), dim(g), dim(b)]
            })
            .collect();
        Some(out)
    }

    fn handle_chunk(&mut self, player: &mut Player, frame: &[u8]) -> Handled {
        let Some(CArm::UploadChunk(m)) = client_arm(frame) else {
            return reply_h(upload_malformed());
        };
        let (id, seq, last) = (m.upload_id(), m.seq(), m.last());
        // A new id (or seq 0) starts over; anything out of order drops the upload.
        if seq == 0 || !matches!(&self.upload, Some(u) if u.id == id) {
            self.upload = Some(Upload { id, next_seq: 0, data: Vec::new() });
        }
        let u = self.upload.as_mut().expect("just set");
        if seq != u.next_seq || u.data.len() + m.payload().len() > MAX_UPLOAD {
            self.upload = None;
            return reply_h(fx_error("bad_chunk", "upload_chunk out of sequence or too large"));
        }
        u.data.extend_from_slice(m.payload());
        u.next_seq += 1;
        if !last {
            return reply_h(reply(SMsg::ChunkAck(pb::ChunkAck { r#upload_id: id, seq })));
        }
        let whole = self.upload.take().expect("just set").data;
        if ledmapper_store::envelope_arm(&whole) == Some(ARM_UPLOAD_CHUNK) {
            return reply_h(upload_malformed());
        }
        self.handle(player, &whole)
    }

    fn submit_map(&mut self, player: &mut Player, frame: &[u8], persist: bool) -> pb::ServerMessage {
        let mut pos: Vec<[f32; 3]> = Vec::new();
        let mut mapped: Vec<bool> = Vec::new();
        let res = ledmapper_store::decode_submit_map_streamed(frame, frame.len(), |_idx, led_count, led| {
            let n = led_count as usize;
            if pos.len() < n {
                pos.resize(n, [0.0; 3]);
                mapped.resize(n, false);
            }
            // Keyed by the LED's id: a sparse map omits unmapped LEDs.
            if led.id < led_count {
                pos[led.id as usize] = led.xyz;
                mapped[led.id as usize] = true;
            }
            Ok(())
        });
        match res {
            Ok((map_id, led_count)) => {
                pos.resize(led_count as usize, [0.0; 3]);
                mapped.resize(led_count as usize, false);
                fill_unmapped(&mut pos, &mapped);
                self.positions = pos;
                if persist {
                    self.write_state("map.pb", frame);
                }
                player.map_stored(map_id.as_str())
            }
            Err(_) => upload_malformed(),
        }
    }

    fn submit_effect(&mut self, frame: &[u8], persist: bool) -> pb::ServerMessage {
        let Some(CArm::SubmitEffect(m)) = client_arm(frame) else {
            return fx_error("bad_fxb", "submit_effect is malformed");
        };
        if m.deck() != 0 {
            return fx_error("unsupported", "this player has one deck (A)");
        }
        if !pbview::has_field(m.as_bytes(), pv::SubmitEffectView::FIELD_FXB) {
            return fx_error("bad_fxb", "submit_effect without fxb");
        }
        let fxb = m.fxb();
        let Ok(prog) = Program::parse(fxb) else {
            return fx_error("bad_fxb", "fxb failed to parse");
        };
        if prog.flags & ledmapper_fx_vm::FLAG_DRIVER != 0 {
            return fx_error("bad_fxb", "a sensor driver is not an effect");
        }
        let mut vm = Box::new(Vm::new());
        // Every uniform starts at its manifest default (as on the device).
        ledmapper_keypoint::for_each_uniform(prog.manifest, |u| {
            if u.n_default > 0 {
                vm.set_uniform(u.slot as usize, &u.default[..u.n_default as usize]);
            }
        });
        let id = if pbview::has_field(m.as_bytes(), pv::SubmitEffectView::FIELD_EFFECT_ID) {
            m.effect_id()
        } else {
            ""
        };
        self.effect = Some(Effect {
            id: id.to_string(),
            bytes: fxb.to_vec(),
            active: m.activate(),
            vm,
            arena: Vec::new(),
            last_s: None,
            time: 0.0,
            frame: 0,
        });
        if persist {
            self.write_state("effect.pb", frame);
        }
        let mut r = pb::ResultReady::default();
        let _ = r.r#map_id.push_str(id);
        reply(SMsg::ResultReady(r))
    }

    fn set_effect(&mut self, player: &mut Player, frame: &[u8]) -> pb::ServerMessage {
        let (id, deck) = match client_arm(frame) {
            Some(CArm::SetEffect(m)) => (m.effect_id(), m.deck()),
            _ => ("", 0),
        };
        if deck == 0 {
            if id.is_empty() || id == "off" {
                self.effect = None;
                self.remove_state("effect.pb");
            } else if let Some(e) = self.effect.as_mut() {
                e.active = true;
            }
        }
        player.playback_reply()
    }

    fn set_uniforms(&mut self, player: &mut Player, frame: &[u8]) -> pb::ServerMessage {
        let Some(CArm::SetUniforms(m)) = client_arm(frame) else {
            return player.playback_reply();
        };
        if m.deck() == 0 {
            if let Some(e) = self.effect.as_mut() {
                for uv in m.values() {
                    let vals: Vec<f32> = uv.value().collect();
                    if !vals.is_empty() {
                        e.vm.set_uniform(uv.slot() as usize, &vals);
                    }
                }
            }
        }
        match m.seq() {
            0 => player.playback_reply(),
            seq => reply(SMsg::ControlAck(pb::ControlAck { seq })),
        }
    }

    fn get_effect_uniforms(&self, frame: &[u8]) -> Handled {
        let deck = match client_arm(frame) {
            Some(CArm::GetEffectUniforms(m)) => m.deck(),
            _ => 0,
        };
        let e = match self.effect.as_ref().filter(|e| e.active && deck == 0) {
            Some(e) => e,
            None => return reply_h(fx_error("no_effect", "no active effect to describe")),
        };
        let Ok(prog) = Program::parse(&e.bytes) else {
            return reply_h(fx_error("no_effect", "no active effect to describe"));
        };
        // EffectUniforms { effect_id = 1, manifest = 2, current = 3 }.
        let mut body = Vec::new();
        if !e.id.is_empty() {
            pb_bytes(&mut body, 1, e.id.as_bytes());
        }
        pb_bytes(&mut body, 2, prog.manifest);
        ledmapper_keypoint::for_each_uniform(prog.manifest, |u| {
            let (slot, width) = (u.slot as usize, u.width.max(1) as usize);
            if let Some(vals) = e.vm.uniforms.get(slot..slot + width) {
                // UniformValue { slot = 1, packed value = 2 }
                let mut uv = Vec::new();
                pb_key(&mut uv, 1, 0);
                pb_varint(&mut uv, slot as u64);
                let floats: Vec<u8> = vals.iter().flat_map(|v| v.to_le_bytes()).collect();
                pb_bytes(&mut uv, 2, &floats);
                pb_bytes(&mut body, 3, &uv);
            }
        });
        let mut out = Vec::new();
        pb_bytes(&mut out, SM_EFFECT_UNIFORMS, &body);
        Handled::Raw(out)
    }

    fn list_effects(&self) -> pb::ServerMessage {
        let mut list = pb::EffectList::default();
        if let Some(e) = &self.effect {
            let mut s = pb::StoredEffect::default();
            let _ = s.r#effect_id.push_str(&e.id);
            s.r#fxb_bytes = e.bytes.len() as u32;
            s.r#active = e.active;
            let _ = list.r#effects.push(s);
        }
        reply(SMsg::EffectList(list))
    }

    fn read_state(&self, name: &str) -> Option<Vec<u8>> {
        std::fs::read(self.state_dir.as_ref()?.join(name)).ok()
    }

    /// Write temp + rename, so a crash mid-write never leaves half a file.
    fn write_state(&self, name: &str, data: &[u8]) {
        let Some(dir) = &self.state_dir else { return };
        let path = dir.join(name);
        let tmp = path.with_extension("tmp");
        let res = std::fs::create_dir_all(dir)
            .and_then(|()| std::fs::write(&tmp, data))
            .and_then(|()| std::fs::rename(&tmp, &path));
        if let Err(e) = res {
            eprintln!("player_host: saving {} failed: {e}", path.display());
        }
    }

    fn remove_state(&self, name: &str) {
        if let Some(dir) = &self.state_dir {
            let _ = std::fs::remove_file(dir.join(name));
        }
    }
}

/// Unmapped LEDs take positions interpolated between their mapped neighbours
/// (or the nearest one at the ends), as the device does, so an effect doesn't
/// pile them all at the origin.
fn fill_unmapped(pos: &mut [[f32; 3]], mapped: &[bool]) {
    let n = pos.len();
    let mut prev: Option<usize> = None;
    let mut i = 0;
    while i < n {
        if mapped[i] {
            prev = Some(i);
            i += 1;
            continue;
        }
        let mut next = i;
        while next < n && !mapped[next] {
            next += 1;
        }
        for j in i..next {
            pos[j] = match (prev, next < n) {
                (Some(a), true) => {
                    let t = (j - a) as f32 / (next - a) as f32;
                    let (pa, pb) = (pos[a], pos[next]);
                    [0, 1, 2].map(|k| pa[k] + (pb[k] - pa[k]) * t)
                }
                (Some(a), false) => pos[a],
                (None, true) => pos[next],
                (None, false) => [0.0; 3],
            };
        }
        i = next;
    }
}

fn client_arm(frame: &[u8]) -> Option<CArm<'_>> {
    pv::ClientMessageView::parse(frame).ok()?.msg()
}

fn reply_h(m: pb::ServerMessage) -> Handled {
    Handled::Reply(Box::new(m))
}

fn reply(msg: SMsg) -> pb::ServerMessage {
    pb::ServerMessage { r#msg: Some(msg) }
}

fn fx_error(code: &str, message: &str) -> pb::ServerMessage {
    let mut e = pb::Error::default();
    let _ = e.r#code.push_str(code);
    let _ = e.r#message.push_str(message);
    reply(SMsg::Error(e))
}

fn pb_varint(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(b);
            return;
        }
        out.push(b | 0x80);
    }
}

fn pb_key(out: &mut Vec<u8>, field: u32, wire: u8) {
    pb_varint(out, (u64::from(field) << 3) | u64::from(wire));
}

fn pb_bytes(out: &mut Vec<u8>, field: u32, data: &[u8]) {
    pb_key(out, field, 2);
    pb_varint(out, data.len() as u64);
    out.extend_from_slice(data);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unmapped_leds_interpolate_between_neighbours() {
        let mut pos = vec![[0.0; 3], [0.0; 3], [0.0; 3], [4.0, 0.0, 0.0], [0.0; 3]];
        let mapped = [false, true, false, true, false];
        pos[1] = [2.0, 0.0, 0.0];
        fill_unmapped(&mut pos, &mapped);
        assert_eq!(pos[0], [2.0, 0.0, 0.0], "leading gap copies the first mapped LED");
        assert_eq!(pos[2], [3.0, 0.0, 0.0], "inner gap interpolates");
        assert_eq!(pos[4], [4.0, 0.0, 0.0], "trailing gap copies the last mapped LED");
    }

    // -- end to end: the frames the app sends, hand-encoded ------------------

    fn envelope(arm: u32, body: &[u8]) -> Vec<u8> {
        let mut f = Vec::new();
        pb_bytes(&mut f, arm, body);
        f
    }

    /// submit_map: OutputMap { map_id, led_count, leds { id, xyz } } (sparse ids).
    fn map_frame(led_count: u32, leds: &[(u32, [f64; 3])]) -> Vec<u8> {
        let mut m = Vec::new();
        pb_bytes(&mut m, 1, b"map-1");
        pb_key(&mut m, 5, 0);
        pb_varint(&mut m, u64::from(led_count));
        for (id, xyz) in leds {
            let mut e = Vec::new();
            pb_key(&mut e, 1, 0);
            pb_varint(&mut e, u64::from(*id));
            let d: Vec<u8> = xyz.iter().flat_map(|v| v.to_le_bytes()).collect();
            pb_bytes(&mut e, 2, &d);
            pb_bytes(&mut m, 6, &e);
        }
        let mut sm = Vec::new();
        pb_bytes(&mut sm, 1, &m);
        envelope(ARM_SUBMIT_MAP, &sm)
    }

    fn effect_frame(id: &str, fxb: &[u8]) -> Vec<u8> {
        let mut b = Vec::new();
        pb_bytes(&mut b, 1, id.as_bytes());
        pb_bytes(&mut b, 2, fxb);
        pb_key(&mut b, 3, 0);
        pb_varint(&mut b, 1); // activate
        envelope(ARM_SUBMIT_EFFECT, &b)
    }

    fn uniforms_frame(slot: u32, v: f32, seq: u32) -> Vec<u8> {
        let mut uv = Vec::new();
        pb_key(&mut uv, 1, 0);
        pb_varint(&mut uv, u64::from(slot));
        pb_bytes(&mut uv, 2, &v.to_le_bytes());
        let mut b = Vec::new();
        pb_bytes(&mut b, 1, &uv);
        if seq > 0 {
            pb_key(&mut b, 4, 0);
            pb_varint(&mut b, u64::from(seq));
        }
        envelope(ARM_SET_UNIFORMS, &b)
    }

    fn chunk_frame(id: u32, seq: u32, last: bool, payload: &[u8]) -> Vec<u8> {
        let mut b = Vec::new();
        pb_key(&mut b, 1, 0);
        pb_varint(&mut b, u64::from(id));
        pb_key(&mut b, 2, 0);
        pb_varint(&mut b, u64::from(seq));
        pb_key(&mut b, 3, 0);
        pb_varint(&mut b, u64::from(last));
        pb_bytes(&mut b, 5, payload);
        envelope(ARM_UPLOAD_CHUNK, &b)
    }

    const SHADER: &str = "uniform float level : 0.0 .. 1.0 = 1.0;\n\
        vec3 shade(Led led) { return vec3(led.pos.x * level, 0.0, 1.0); }\n";

    fn fxb() -> Vec<u8> {
        ledmapper_fx_compiler::compile(SHADER).expect("test shader compiles").fxb
    }

    fn reply_msg(h: Handled) -> SMsg {
        match h {
            Handled::Reply(r) => r.r#msg.expect("a reply"),
            Handled::Raw(_) => panic!("expected a message, got raw bytes"),
            Handled::Forward(_) => panic!("expected a message, got a forward"),
        }
    }

    fn mapped_with_effect(fx: &mut HostFx, player: &mut Player) {
        let map = map_frame(3, &[(0, [0.0, 0.0, 0.0]), (2, [1.0, 0.0, 0.0])]);
        assert!(HostFx::intercepts(&map));
        assert!(matches!(reply_msg(fx.handle(player, &map)), SMsg::ResultReady(_)));
        assert_eq!(fx.mapped_leds(), 3);
        let eff = effect_frame("ramp", &fxb());
        assert!(matches!(reply_msg(fx.handle(player, &eff)), SMsg::ResultReady(_)));
        assert!(fx.active());
    }

    #[test]
    fn renders_the_effect_over_the_map() {
        let mut player = Player::new("host-0001", 3);
        let mut fx = HostFx::new(None);
        assert_eq!(fx.render(0.0, 3, 1.0), None, "no effect yet");
        mapped_with_effect(&mut fx, &mut player);

        let px = fx.render(0.0, 3, 1.0).expect("active effect renders");
        assert_eq!(px[0], [0, 0, 255]);
        assert!((120..=136).contains(&px[1][0]), "LED 1 is unmapped: interpolated to x=0.5, got {:?}", px[1]);
        assert_eq!(px[2], [255, 0, 255]);

        // Output brightness scales the effect.
        let dim = fx.render(0.1, 3, 0.5).unwrap();
        assert_eq!(dim[2], [128, 0, 128]);

        // A live uniform (with a control-ack seq) takes effect on the next frame.
        let set = uniforms_frame(0, 0.0, 7);
        assert!(matches!(reply_msg(fx.handle(&mut player, &set)), SMsg::ControlAck(a) if a.r#seq == 7));
        assert_eq!(fx.render(0.2, 3, 1.0).unwrap()[2], [0, 0, 255]);

        // "off" clears it.
        let off = envelope(ARM_SET_EFFECT, &[]);
        assert!(matches!(reply_msg(fx.handle(&mut player, &off)), SMsg::PlaybackState(_)));
        assert!(!fx.active());
    }

    #[test]
    fn reassembles_chunked_uploads() {
        let mut player = Player::new("host-0001", 3);
        let mut fx = HostFx::new(None);
        let whole = effect_frame("chunked", &fxb());
        let (a, b) = whole.split_at(whole.len() / 2);
        let first = fx.handle(&mut player, &chunk_frame(9, 0, false, a));
        assert!(matches!(reply_msg(first), SMsg::ChunkAck(c) if c.r#upload_id == 9 && c.r#seq == 0));
        let last = fx.handle(&mut player, &chunk_frame(9, 1, true, b));
        assert!(matches!(reply_msg(last), SMsg::ResultReady(_)));
        assert!(fx.active());

        // Out of sequence drops the upload.
        let bad = fx.handle(&mut player, &chunk_frame(10, 3, true, a));
        assert!(matches!(reply_msg(bad), SMsg::Error(_)));
    }

    #[test]
    fn describes_the_effect_uniforms() {
        let mut player = Player::new("host-0001", 3);
        let mut fx = HostFx::new(None);
        mapped_with_effect(&mut fx, &mut player);
        let get = envelope(ARM_GET_EFFECT_UNIFORMS, &[]);
        let Handled::Raw(out) = fx.handle(&mut player, &get) else {
            panic!("get_effect_uniforms is hand-encoded");
        };
        let mut dec = micropb::PbDecoder::new(out.as_slice());
        let mut sm = pb::ServerMessage::default();
        micropb::MessageDecode::decode(&mut sm, &mut dec, out.len()).expect("a valid ServerMessage");
        let Some(SMsg::EffectUniforms(u)) = sm.r#msg else {
            panic!("expected effect_uniforms");
        };
        assert_eq!(u.r#effect_id.as_str(), "ramp");
        assert_eq!(u.r#current.len(), 1);
        assert_eq!(u.r#current[0].r#value.as_slice(), &[1.0], "the manifest default");

        let SMsg::EffectList(list) = reply_msg(fx.handle(&mut player, &envelope(ARM_LIST_EFFECTS, &[]))) else {
            panic!("expected effect_list");
        };
        assert_eq!(list.r#effects.len(), 1);
        assert!(list.r#effects[0].r#active);
    }

    #[test]
    fn restores_the_map_and_effect() {
        let dir = std::env::temp_dir().join(format!("player_host_fx_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        {
            let mut player = Player::new("host-0001", 3);
            let mut fx = HostFx::new(Some(dir.clone()));
            mapped_with_effect(&mut fx, &mut player);
        }
        let mut player = Player::new("host-0001", 3);
        let mut fx = HostFx::new(Some(dir.clone()));
        fx.restore(&mut player);
        assert_eq!(fx.mapped_leds(), 3);
        assert!(fx.active());
        assert_eq!(fx.render(0.0, 3, 1.0).unwrap()[2], [255, 0, 255]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn protobuf_helpers() {
        let mut v = Vec::new();
        pb_varint(&mut v, 300);
        assert_eq!(v, [0xAC, 0x02]);
        let mut b = Vec::new();
        pb_bytes(&mut b, 16, b"hi");
        assert_eq!(b, [0x82, 0x01, 2, b'h', b'i']);
    }
}
