//! The FX debugger through the C ABI (docs/design/fx-debugger.md): pause holds
//! the frame clock, steps render at an exact time / dt, the lease lapses on a
//! timeout or a closed session, snapshot sections reassemble from any chunk size,
//! and — the point of it all — a host replay of the paused frame from the
//! snapshot (the same .fxb, uniforms, state, buffers, graph, frame context and
//! per-LED inputs on a fresh VM) reproduces the device's output, state and
//! buffers BIT-EXACTLY, and one LED's re-run locals match the host's.
//! One test: the FFI state is process-global.

use ledmapper_fx_vm::{dbg, Frame, Led, Program, Vm, MAX_LOCALS, MAX_STATE, MAX_UNIFORM_SLOTS};
use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::{
    lm_fx_active, lm_fx_shade, lm_fx_update, lm_fxdbg_bind_output, lm_fxdbg_hold, lm_fxdbg_paused,
    lm_fxdbg_poll, lm_fxdbg_step, lm_hw_seed, lm_led_count_seed, lm_map_led, lm_player_handle,
    lm_player_init, FEATURES, FRAME_CTX_BYTES, LED_CTX_BYTES, SECTION_ARENA, SECTION_GRAPH,
    SECTION_LED_CONTEXT, SECTION_LUT, SECTION_OUTPUT, SECTION_PROGRAM, SECTION_RAW, SECTION_STATE,
    SECTION_UNIFORMS, SECTION_WIRE,
};
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::FxDebugReply_::Reply;
use pb::ServerMessage_::Msg as SMsg;

const LEDS: usize = 24;
const CH0: u32 = 16;
const CH1: u32 = 8;

fn led_pos(i: usize) -> [f32; 3] {
    let a = i as f32 * 0.37;
    [
        0.31 * a.cos() + 0.013 * i as f32,
        0.05 * i as f32 - 0.4,
        0.27 * a.sin(),
    ]
}

fn encode(msg: CMsg) -> Vec<u8> {
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 131072>::new());
    env.encode(&mut enc).unwrap();
    enc.into_writer().to_vec()
}

fn handle_at(msg: CMsg, now: i64) -> Option<SMsg> {
    let frame = encode(msg);
    let mut out = vec![0u8; 4096];
    let n = unsafe {
        lm_player_handle(
            frame.as_ptr(),
            frame.len(),
            now,
            now,
            out.as_mut_ptr(),
            out.len(),
        )
    };
    assert!(n >= 0, "handle returned {n}");
    if n == 0 {
        return None;
    }
    let mut reply = pb::ServerMessage::default();
    reply
        .decode_from_bytes(&out[..n as usize])
        .expect("reply decodes");
    reply.r#msg
}

fn len_field(f: u32, b: &[u8]) -> Vec<u8> {
    let mut v = Vec::new();
    let mut put = |mut n: usize| {
        while n >= 0x80 {
            v.push((n as u8) | 0x80);
            n >>= 7;
        }
        v.push(n as u8);
    };
    put(((f << 3) | 2) as usize);
    put(b.len());
    v.extend_from_slice(b);
    v
}

fn submit(deck: u32, id: &str, fxb: &[u8]) {
    let mut body = len_field(1, id.as_bytes());
    body.extend(len_field(2, fxb));
    body.extend([3 << 3, 1, 4 << 3, deck as u8]);
    let frame = len_field(21, &body);
    let mut out = vec![0u8; 4096];
    let n = unsafe {
        lm_player_handle(
            frame.as_ptr(),
            frame.len(),
            0,
            0,
            out.as_mut_ptr(),
            out.len(),
        )
    };
    assert!(n > 0);
    let mut reply = pb::ServerMessage::default();
    reply.decode_from_bytes(&out[..n as usize]).unwrap();
    assert!(
        matches!(reply.r#msg, Some(SMsg::ResultReady(_))),
        "submit: {:?}",
        reply.r#msg
    );
}

fn submit_map() {
    let mut map = Box::new(pb::OutputMap::default());
    map.r#map_id = "m-dbg".parse().unwrap();
    map.r#led_count = LEDS as i32;
    // LED 5 is left unmapped (its position is interpolated on the device).
    for i in (0..LEDS).filter(|&i| i != 5) {
        let mut led = pb::LedEntry {
            r#id: i as i32,
            ..Default::default()
        };
        let p = led_pos(i);
        led.r#xyz
            .extend_from_slice(&[p[0] as f64, p[1] as f64, p[2] as f64])
            .unwrap();
        map.r#leds.push(led).unwrap();
    }
    let mut submit = pb::SubmitMap::default();
    submit.set_map(*map);
    assert!(matches!(
        handle_at(CMsg::SubmitMap(submit), 0),
        Some(SMsg::ResultReady(_))
    ));
}

/// The firmware's render loop (main.cpp render_once, effect branch), minus the
/// strip: hold while paused, the frame clock (+ a debugger step's override),
/// update + per-LED shade + the output stage (LUT + brightness) into `leds`.
struct Render {
    frame: u32,
    t: f32,
    leds: Vec<u8>,
    lut: Option<Box<[[u8; 256]; 3]>>,
    bright: u8,
}

impl Render {
    /// One render-task tick at `now` ms. True when a frame rendered.
    fn tick(&mut self, now: u32) -> bool {
        unsafe {
            if !lm_fx_active() || lm_fxdbg_hold(now) {
                return false;
            }
            let mut dt = 0.033f32;
            self.t += dt;
            lm_fxdbg_step(&mut self.t, &mut dt);
            let seq = self.frame;
            self.frame += 1;
            assert!(lm_fx_update(self.t, dt, seq, LEDS as u32));
            for i in 0..LEDS {
                let (mut id, mut xyz, mut rgb) = (0u32, [0f32; 3], [0u8; 3]);
                let c = if lm_map_led(i as u32, &mut id, xyz.as_mut_ptr())
                    && lm_fx_shade(i as u32, xyz[0], xyz[1], xyz[2], rgb.as_mut_ptr())
                {
                    cc(&self.lut, self.bright, rgb)
                } else {
                    [0; 3]
                };
                self.leds[i * 3..i * 3 + 3].copy_from_slice(&c);
            }
        }
        true
    }
}

/// main.cpp cc_apply: LUT, then nscale8 unless 255.
fn cc(lut: &Option<Box<[[u8; 256]; 3]>>, bright: u8, rgb: [u8; 3]) -> [u8; 3] {
    let mut c = match lut {
        Some(l) => [
            l[0][rgb[0] as usize],
            l[1][rgb[1] as usize],
            l[2][rgb[2] as usize],
        ],
        None => rgb,
    };
    if bright < 255 {
        for v in &mut c {
            *v = ((*v as u16 * bright as u16) >> 8) as u8;
        }
    }
    c
}

fn control(action: i32, now: i64, f: impl FnOnce(&mut pb::FxDebugControl)) -> pb::FxDebugState {
    let mut m = pb::FxDebugControl {
        r#action: action.into(),
        ..Default::default()
    };
    f(&mut m);
    match fx_reply(handle_at(CMsg::FxDebugControl(m), now)) {
        Reply::State(s) => s,
        other => panic!("expected fx_debug.state, got {other:?}"),
    }
}

/// The FxDebugReply arm of a reply.
fn fx_reply(r: Option<SMsg>) -> Reply {
    match r {
        Some(SMsg::FxDebug(d)) => d.r#reply.expect("fx_debug carries a reply"),
        other => panic!("expected fx_debug, got {other:?}"),
    }
}

fn chunk(
    section: i32,
    deck: u32,
    offset: u32,
    max_len: u32,
    now: i64,
) -> Result<pb::FxSnapshotChunk, String> {
    let m = pb::GetFxSnapshot {
        r#section: section.into(),
        r#deck: deck,
        r#offset: offset,
        r#max_len: max_len,
    };
    match handle_at(CMsg::GetFxSnapshot(m), now) {
        Some(SMsg::Error(e)) => Err(e.r#code.as_str().to_string()),
        other => match fx_reply(other) {
            Reply::Chunk(c) => Ok(c),
            other => panic!("expected fx_debug.chunk, got {other:?}"),
        },
    }
}

/// A whole section, pulled `step` bytes at a time.
fn section(section: i32, deck: u32, step: u32) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let c = chunk(section, deck, out.len() as u32, step, 1000).unwrap();
        assert_eq!(c.r#offset as usize, out.len());
        out.extend_from_slice(&c.r#data);
        if out.len() >= c.r#total_len as usize {
            assert_eq!(out.len(), c.r#total_len as usize);
            return out;
        }
        assert!(!c.r#data.is_empty(), "no progress");
    }
}

fn f32s(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes(c.try_into().unwrap()))
        .collect()
}
fn u32s(b: &[u8]) -> Vec<u32> {
    b.chunks_exact(4)
        .map(|c| u32::from_le_bytes(c.try_into().unwrap()))
        .collect()
}

fn frame_from(ctx: &[u8]) -> Frame {
    assert_eq!(ctx.len(), FRAME_CTX_BYTES);
    let w = u32s(ctx);
    let f = |k: usize| f32::from_bits(w[k]);
    let i = |k: usize| w[k] as i32;
    Frame {
        time: f(0),
        dt: f(1),
        frame: w[2],
        led_count: w[3],
        imu_accel: [f(4), f(5), f(6)],
        imu_gyro: [f(7), f(8), f(9)],
        time_fix: i(10),
        dt_fix: i(11),
        imu_accel_fix: [i(12), i(13), i(14)],
        imu_gyro_fix: [i(15), i(16), i(17)],
        room_posed: w[18] != 0,
        room_min: [f(19), f(20), f(21)],
        room_max: [f(22), f(23), f(24)],
        room_min_fix: [i(25), i(26), i(27)],
        room_max_fix: [i(28), i(29), i(30)],
    }
}

/// FX_LED_V1 -> the Led shade() saw (fixed mirrors recomputed like the device).
fn led_from(rec: &[u8], idx: u32) -> Option<Led> {
    assert_eq!(rec.len(), LED_CTX_BYTES);
    if rec[43] & 1 == 0 {
        return None;
    }
    let v = f32s(&rec[..40]);
    let q = |x: f32| (x * 65536.0) as i32;
    Some(Led {
        pos: [v[0], v[1], v[2]],
        idx,
        seg: i16::from_le_bytes([rec[40], rec[41]]) as i32,
        s: v[3],
        branch: rec[42] != 0,
        dist: v[4],
        uv: [v[5], v[6]],
        pos_fix: [q(v[0]), q(v[1]), q(v[2])],
        uv_fix: [q(v[5]), q(v[6])],
        s_fix: q(v[3]),
        dist_fix: q(v[4]),
        room: [v[7], v[8], v[9]],
        room_fix: [q(v[7]), q(v[8]), q(v[9])],
    })
}

/// Everything a host replay needs from one paused snapshot of deck 0.
struct Snap {
    program: Vec<u8>,
    uniforms: Vec<u8>,
    state: Vec<u8>,
    arena: Vec<u8>,
    graph: Vec<u8>,
    ledctx: Vec<u8>,
    output: Vec<u8>,
    frame_ctx: Vec<u8>,
}

fn snap(step: u32) -> Snap {
    let st = control(0, 1000, |_| {});
    Snap {
        program: section(SECTION_PROGRAM, 0, step),
        uniforms: section(SECTION_UNIFORMS, 0, step),
        state: section(SECTION_STATE, 0, step),
        arena: section(SECTION_ARENA, 0, step),
        graph: section(SECTION_GRAPH, 0, step),
        ledctx: section(SECTION_LED_CONTEXT, 0, step),
        output: section(SECTION_OUTPUT, 0, step),
        frame_ctx: st.r#frame_ctx.to_vec(),
    }
}

/// A replayed frame. `vm` keeps pointing into `arena` (its heap buffer), so the
/// two live and die together.
struct Replay {
    out: Vec<u8>,
    raw: Vec<u8>,
    state: Vec<u8>,
    arena: Vec<u8>,
    vm: Vm,
}

/// Host replay of ONE frame: state/buffers from `before`, inputs from `after`.
fn replay(before: &Snap, after: &Snap, lut: &Option<Box<[[u8; 256]; 3]>>, bright: u8) -> Replay {
    let prog = Program::parse(&after.program).expect("program parses");
    let mut vm = Vm::new();
    let u = f32s(&after.uniforms);
    assert_eq!(u.len(), MAX_UNIFORM_SLOTS);
    vm.uniforms.copy_from_slice(&u);
    let s = u32s(&before.state);
    for k in 0..MAX_STATE {
        vm.state[k] = f32::from_bits(s[k]);
    }
    vm.set_flood_words(&s[MAX_STATE..]);
    let g = u32s(&after.graph);
    let n_seg = g[0] as usize;
    let (mut sl, mut sa, mut sb) = (vec![], vec![], vec![]);
    for k in 0..n_seg {
        sl.push(f32::from_bits(g[1 + 3 * k]));
        sa.push(g[2 + 3 * k] as i32);
        sb.push(g[3 + 3 * k] as i32);
    }
    vm.set_graph(&sl, &sa, &sb);
    let mut arena = before.arena.clone();
    vm.set_arena(&mut arena);
    let f = frame_from(&after.frame_ctx);
    vm.run_update(&prog, &f);
    let mut out = vec![0u8; LEDS * 3];
    let mut raw = vec![0u8; LEDS * 3];
    for i in 0..LEDS {
        let rec = &after.ledctx[i * LED_CTX_BYTES..(i + 1) * LED_CTX_BYTES];
        if let Some(led) = led_from(rec, i as u32) {
            let (r, g, b) = vm.run_shade(&prog, &f, &led);
            raw[i * 3..i * 3 + 3].copy_from_slice(&[r, g, b]);
            out[i * 3..i * 3 + 3].copy_from_slice(&cc(lut, bright, [r, g, b]));
        }
    }
    let mut state = Vec::new();
    for k in 0..MAX_STATE {
        state.extend(vm.state[k].to_bits().to_le_bytes());
    }
    for k in 0..Vm::FLOOD_WORDS {
        state.extend(vm.flood_word(k).to_le_bytes());
    }
    Replay {
        out,
        raw,
        state,
        arena,
        vm,
    }
}

const TRAILS: &str = r#"
uniform float speed : 0.0 .. 4.0 = 1.3;
uniform vec3 tint : color = vec3(1.0, 0.6, 0.2);
state float phase;
state float acc[4];
buffer vec3 trail;
void update() {
  phase = fract(phase + dt * speed);
  acc[0] = fract(acc[0] + dt);
  acc[1] = acc[0] * 0.5;
  acc[3] = phase * 0.25;
}
vec3 shade(Led led) {
  float h = fract(led.uv.x * 0.7 + phase + led.pos.y);
  float w = smoothstep(0.0, 1.0, fract(led.s + time * 0.25));
  vec3 c = hsv2rgb(h, 0.8, 0.4 + 0.6 * w) * tint;
  vec3 t = mix(trail[led.idx], c, 0.3 + acc[1] * 0.5 + acc[3]);
  trail[led.idx] = t;
  return t;
}
"#;

const FIXED: &str = r#"
state fixed ph;
void update() { ph = fract(ph + fixed(0.0625)); }
vec3 shade(Led led) {
  fixed v = fract(fixed(led.idx) * fixed(0.125) + ph);
  return vec3(v, fixed(0.5), fixed(1.0) - v);
}
"#;

#[test]
fn fx_debugger() {
    lm_player_init(LEDS as u32);
    assert!(FEATURES.contains(&"fx_debug"));
    unsafe {
        lm_hw_seed(0, 4, b"GRB".as_ptr(), 3);
        lm_hw_seed(1, 5, b"BRG".as_ptr(), 3);
        lm_led_count_seed(0, CH0);
        lm_led_count_seed(1, CH1);
    }
    submit_map();

    // Nothing rendering: pause is refused, status works.
    let mut m = pb::FxDebugControl {
        r#action: 1.into(),
        ..Default::default()
    };
    m.r#hold_ms = 0;
    assert!(
        matches!(handle_at(CMsg::FxDebugControl(m), 0), Some(SMsg::Error(e)) if e.r#code.as_str() == "no_effect")
    );

    let trails = ledmapper_fx_compiler::compile(TRAILS)
        .expect("compiles")
        .fxb;
    submit(0, "trails", &trails);
    let mut r = Render {
        frame: 0,
        t: 0.0,
        leds: vec![0; LEDS * 3],
        lut: None,
        bright: 255,
    };
    unsafe {
        lm_fxdbg_bind_output(r.leds.as_ptr(), LEDS as u32, core::ptr::null(), &r.bright);
    }
    for k in 0..5 {
        assert!(r.tick(k * 33));
    }

    // -- pause holds the frame clock; status reports the engine --------------------
    let st = control(1, 200, |m| m.r#hold_ms = 10_000);
    assert!(st.r#paused && unsafe { lm_fxdbg_paused() });
    assert_eq!(st.r#frame, 4);
    assert_eq!(st.r#led_count, LEDS as u32);
    assert_eq!(st.r#decks.len(), 1);
    let d0 = &st.r#decks[0];
    assert_eq!(d0.r#effect_id.as_str(), "trails");
    assert_eq!(d0.r#fxb_bytes as usize, trails.len());
    assert!(d0.r#renders && d0.r#arena_bytes > 0);
    assert_eq!(&st.r#color_order[..], &[1, 0, 2, 2, 0, 1]);
    assert_eq!((st.r#channel0_leds, st.r#channel1_leds), (CH0, CH1));
    assert_eq!(st.r#frame_ctx.len(), FRAME_CTX_BYTES);
    assert_eq!(st.r#layout_version, 1);
    let t_paused = st.r#time;
    for k in 0..10 {
        assert!(!r.tick(300 + k * 33), "paused: nothing renders");
    }
    assert_eq!(
        control(0, 700, |_| {}).r#time,
        t_paused,
        "time stops while paused"
    );

    // -- the program comes back as uploaded; chunking is size-independent -----------
    let a = snap(97);
    assert_eq!(a.program, trails);
    let b = snap(1024);
    assert_eq!(
        (&a.uniforms, &a.state, &a.arena, &a.ledctx),
        (&b.uniforms, &b.state, &b.arena, &b.ledctx)
    );
    assert_eq!(a.output, r.leds);
    // Wire bytes: channel 0 (LEDs 0..16) GRB, channel 1 BRG.
    let wire = section(SECTION_WIRE, 0, 50);
    for i in 0..LEDS {
        let o = &r.leds[i * 3..i * 3 + 3];
        let p = if i < CH0 as usize {
            [1, 0, 2]
        } else {
            [2, 0, 1]
        };
        assert_eq!(
            &wire[i * 3..i * 3 + 3],
            &[o[p[0]], o[p[1]], o[p[2]]],
            "wire LED {i}"
        );
    }
    assert_eq!(section(SECTION_LUT, 0, 500), Vec::<u8>::new());
    // The unmapped LED (5) has a map entry (interpolated) but isn't measured.
    assert_eq!(a.ledctx[5 * LED_CTX_BYTES + 43], 1);
    assert_eq!(a.ledctx[4 * LED_CTX_BYTES + 43], 3);

    // -- step to an exact time, then replay it on the host bit-exactly --------------
    let st = control(3, 800, |m| {
        m.set_to_time(t_paused + 0.25);
    });
    assert_eq!(st.r#steps_pending, 1);
    assert!(r.tick(820));
    assert!(!r.tick(840), "back to holding after the step");
    let after = snap(300);
    let st = control(0, 850, |_| {});
    assert_eq!(st.r#steps_pending, 0);
    assert_eq!(st.r#time, t_paused + 0.25);
    assert!((st.r#dt - 0.25).abs() < 1e-6);
    let Replay {
        out,
        raw,
        state,
        mut arena,
        mut vm,
    } = replay(&a, &after, &None, 255);
    assert_eq!(out, after.output, "host replay == device output");
    assert_eq!(state, after.state, "host replay == device state");
    assert_eq!(arena, after.arena, "host replay == device buffers");

    // RAW recomputes the effect colour at the paused frame (pre-LUT); this effect
    // feeds back through a buffer, so RAW is a SECOND blend step — compare the
    // structural part only (it is LED-count long and black where unmapped).
    assert_eq!(section(SECTION_RAW, 0, 64).len(), LEDS * 3);
    let _ = raw;

    // -- one LED's locals: the device's re-run == the host's identical re-run -------
    let prog = Program::parse(&after.program).unwrap();
    let f = frame_from(&after.frame_ctx);
    for led_i in [0usize, 7, 23] {
        let req = pb::DebugFxLed {
            r#led: led_i as u32,
            r#deck: 0,
            r#max_locals: 0,
        };
        let Reply::Led(dbg) = fx_reply(handle_at(CMsg::DebugFxLed(req), 900)) else {
            panic!("expected fx_debug.led");
        };
        assert_eq!(
            &dbg.r#led_context[..],
            &after.ledctx[led_i * LED_CTX_BYTES..(led_i + 1) * LED_CTX_BYTES],
            "LED_CONTEXT record == the Led the deck's own shade used"
        );
        assert_eq!(dbg.r#locals.len(), MAX_LOCALS);
        assert_eq!(&dbg.r#output[..], &after.output[led_i * 3..led_i * 3 + 3]);
        // Host: the same two runs (the normal one, then the zeroed interpreted
        // one), each from the LED's paused buffer elements, restored after.
        let led = led_from(&dbg.r#led_context, led_i as u32).unwrap();
        let mut saved = Vec::new();
        dbg::led_elem_ranges(&prog, LEDS, led_i, |o, l| saved.push((o, arena[o..o + l].to_vec())));
        let restore = |arena: &mut Vec<u8>| {
            for (o, b) in &saved {
                arena[*o..*o + b.len()].copy_from_slice(b);
            }
        };
        let (r1, g1, b1) = vm.run_shade(&prog, &f, &led);
        assert_eq!(&dbg.r#rgb_jit[..], &[r1, g1, b1]);
        restore(&mut arena);
        vm.clear_scratch();
        let (r2, g2, b2) = vm.run_shade(&prog, &f, &led);
        restore(&mut arena);
        assert_eq!(&dbg.r#rgb[..], &[r2, g2, b2]);
        assert_eq!(&dbg.r#rgb[..], &dbg.r#rgb_jit[..], "both runs see the same buffers");
        let host: Vec<u32> = vm.locals().iter().map(|v| v.to_bits()).collect();
        let dev: Vec<u32> = dbg.r#locals.iter().map(|v| v.to_bits()).collect();
        assert_eq!(dev, host, "LED {led_i} locals");
        assert!(dbg.r#instructions > 0);
    }
    // The re-runs left the paused state as it was.
    assert_eq!(section(SECTION_ARENA, 0, 512), after.arena, "debug_fx_led restores the LED's buffers");

    // -- steps at a fixed dt; output stage with a LUT + brightness ------------------
    let mut lut = Box::new([[0u8; 256]; 3]);
    for (c, t) in lut.iter_mut().enumerate() {
        for (v, o) in t.iter_mut().enumerate() {
            *o = ((v * v) / 255) as u8 ^ c as u8;
        }
    }
    r.lut = Some(lut);
    r.bright = 200;
    let lut_ptr: *const u8 = r.lut.as_ref().unwrap().as_ptr() as *const u8;
    let lut_cell = Box::new(lut_ptr);
    unsafe {
        lm_fxdbg_bind_output(r.leds.as_ptr(), LEDS as u32, &*lut_cell, &r.bright);
    }
    let before = snap(512);
    control(3, 1000, |m| {
        m.r#frames = 3;
        m.set_dt(0.02);
    });
    let mut stepped = 0;
    for k in 0..6 {
        stepped += r.tick(1000 + k) as u32;
    }
    assert_eq!(stepped, 3);
    let mid = control(0, 1010, |_| {});
    assert!((mid.r#dt - 0.02).abs() < 1e-7 && mid.r#steps_pending == 0);
    // One more step, replayed with the device's LUT + brightness.
    let before = {
        let _ = before;
        snap(512)
    };
    control(3, 1020, |m| m.r#frames = 1);
    assert!(r.tick(1021));
    let after = snap(512);
    let lut_back = section(SECTION_LUT, 0, 100);
    assert_eq!(lut_back.len(), 768);
    assert_eq!(&lut_back[..], &r.lut.as_ref().unwrap().concat()[..]);
    let st = control(0, 1030, |_| {});
    assert_eq!(st.r#brightness, 200);
    assert!(st.r#lut);
    let rp = replay(&before, &after, &r.lut, 200);
    assert_eq!(rp.out, after.output, "replay through the LUT + brightness");
    assert_eq!(rp.state, after.state);

    // -- the lease: a closed session lapses the pause; so does the hold -------------
    control(1, 2000, |m| m.r#hold_ms = 60_000);
    unsafe { lm_fxdbg_poll(4000, false) };
    assert!(unsafe { lm_fxdbg_paused() }, "within the orphan grace");
    unsafe { lm_fxdbg_poll(6000, true) };
    assert!(
        unsafe { lm_fxdbg_paused() },
        "a session is open: the hold lease rules"
    );
    unsafe { lm_fxdbg_poll(7100, false) };
    assert!(
        !unsafe { lm_fxdbg_paused() },
        "no session for >5 s: resumed"
    );
    assert_eq!(
        control(0, 7200, |_| {}).r#resume_reason.as_str(),
        "disconnect"
    );
    control(1, 8000, |m| m.r#hold_ms = 1000);
    assert!(!r.tick(8500));
    assert!(r.tick(9001), "the hold lapsed: rendering again");
    assert_eq!(control(0, 9002, |_| {}).r#resume_reason.as_str(), "timeout");
    control(1, 9100, |_| {});
    control(2, 9200, |_| {});
    assert!(r.tick(9300), "resume renders");

    // -- RAW and debug_fx_led need a paused engine ------------------------------------
    assert_eq!(chunk(SECTION_RAW, 0, 0, 0, 9400).unwrap_err(), "not_paused");

    // -- a fixed-point program replays bit-exactly too (no buffers) --------------------
    let fixed = ledmapper_fx_compiler::compile(FIXED).expect("compiles").fxb;
    submit(0, "fixed", &fixed);
    r.lut = None;
    r.bright = 255;
    unsafe { lm_fxdbg_bind_output(r.leds.as_ptr(), LEDS as u32, core::ptr::null(), &r.bright) };
    for k in 0..3 {
        r.tick(10_000 + k * 33);
    }
    control(1, 10_200, |_| {});
    let before = snap(700);
    control(3, 10_210, |m| m.r#frames = 1);
    assert!(r.tick(10_220));
    let after = snap(700);
    let rp = replay(&before, &after, &None, 255);
    assert_eq!(rp.out, after.output);
    assert_eq!(rp.state, after.state);
    // No buffers: RAW (recomputed) is the effect output itself.
    assert_eq!(section(SECTION_RAW, 0, 33), rp.raw);
    control(2, 10_300, |_| {});
}
