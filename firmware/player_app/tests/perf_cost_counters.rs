//! The effect performance model's device-side inputs and budget visibility.
//! fx_bench calibrates the app's cost model against what the device reports in
//! its PerfReport, so those reports must be exact and attributable:
//!
//! * FULL perf reports each frame's VM work — opcodes retired by update() and
//!   across the shade() sweep, plus the operand-stack high-water — exactly as
//!   the VM counts them for that program;
//! * BASIC perf leaves the counting off (the measured program pays no counting
//!   overhead) while still reporting the frame's cycle spans;
//! * every report is pinned to the compiled program that produced it (fxb hash +
//!   effect id), and loading another effect starts a fresh window, so a
//!   measurement can never be attributed to the wrong effect.
//!
//! The FFI state is process-global (one player, as on the device), so every
//! test re-initializes it and the target runs with `--test-threads=1`.

use ledmapper_fx_vm::{Budget, Frame, Led, Program, Vm};
use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::{
    lm_fx_clear, lm_fx_shade, lm_fx_update, lm_perf_instr_shade, lm_perf_instr_update,
    lm_perf_push, lm_perf_stack_max, lm_player_handle, lm_player_init,
};
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

const LEDS: u32 = 16;

/// update() + shade() with data-dependent per-LED work (a loop bounded by the
/// LED index), so the per-frame counts are not a trivial multiple.
const MEASURED: &str = "state float t;\n\
     void update() { t = t + dt; }\n\
     vec3 shade(Led led) {\n\
       float x = 0.0;\n\
       for (int i = 0; i < led.idx; i = i + 1) { x = x + 0.01; }\n\
       return vec3(fract(x + t), 0.0, 0.0);\n\
     }\n";
const OTHER: &str = "vec3 shade(Led led) { return vec3(0.0, 0.0, 1.0); }\n";

fn encode(msg: CMsg) -> Vec<u8> {
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 4096>::new());
    env.encode(&mut enc).unwrap();
    enc.into_writer().to_vec()
}

fn handle(frame: &[u8]) -> Option<SMsg> {
    let mut out = vec![0u8; 4096];
    let n = unsafe { lm_player_handle(frame.as_ptr(), frame.len(), 0, 0, out.as_mut_ptr(), out.len()) };
    assert!(n >= 0, "lm_player_handle returned {n}");
    if n == 0 {
        return None;
    }
    let mut reply = pb::ServerMessage::default();
    reply.decode_from_bytes(&out[..n as usize]).expect("reply decodes");
    reply.r#msg
}

fn varint(mut v: u64, out: &mut Vec<u8>) {
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

fn len_field(field: u32, bytes: &[u8], out: &mut Vec<u8>) {
    varint(u64::from(field << 3 | 2), out);
    varint(bytes.len() as u64, out);
    out.extend_from_slice(bytes);
}

/// Submit (and activate) an effect through the protocol, as the app does.
fn submit(id: &str, fxb: &[u8]) {
    let mut body = Vec::new();
    len_field(1, id.as_bytes(), &mut body);
    len_field(2, fxb, &mut body);
    varint(3 << 3, &mut body);
    varint(1, &mut body);
    let mut frame = Vec::new();
    len_field(21, &body, &mut frame);
    assert!(matches!(handle(&frame), Some(SMsg::ResultReady(_))), "submit_effect accepted");
}

fn compile(src: &str) -> Vec<u8> {
    ledmapper_fx_compiler::compile(src)
        .unwrap_or_else(|d| panic!("effect compiles: {d:?}"))
        .fxb
}

fn set_perf(mode: pb::SetPerf_::Mode) -> pb::PerfReport {
    let sp = pb::SetPerf { r#mode: mode, r#interval_ms: 0 };
    match handle(&encode(CMsg::SetPerf(sp))) {
        Some(SMsg::PerfReport(r)) => r,
        other => panic!("set_perf replies a perf_report, got {other:?}"),
    }
}

fn perf_report() -> pb::PerfReport {
    match handle(&encode(CMsg::GetPerfReport(pb::GetPerfReport::default()))) {
        Some(SMsg::PerfReport(r)) => r,
        other => panic!("perf_report expected, got {other:?}"),
    }
}

/// Render one effect frame the way render_once does and push its perf sample.
fn render_and_push(seq: u32) {
    assert!(unsafe { lm_fx_update(seq as f32 / 30.0, 1.0 / 30.0, seq, LEDS) });
    for i in 0..LEDS {
        let mut rgb = [0u8; 3];
        assert!(unsafe { lm_fx_shade(i, 0.0, 0.0, 0.0, rgb.as_mut_ptr()) });
    }
    unsafe { lm_perf_push(seq, 1_000, 9_000, 10_000, 4_000, LEDS, false) };
}

/// FNV-1a (32-bit) of the program bytes — the identity a PerfReport carries.
fn fnv1a(bytes: &[u8]) -> u32 {
    bytes.iter().fold(0x811c_9dc5u32, |h, &b| (h ^ b as u32).wrapping_mul(0x0100_0193))
}

#[test]
fn full_perf_reports_exactly_the_work_the_vm_did_each_frame() {
    rr::verifies!("PR-27");
    lm_player_init(LEDS);
    unsafe { lm_fx_clear() };
    let fxb = compile(MEASURED);
    // Ground truth: the same program counted directly on the VM.
    let prog = Program::parse(&fxb).expect("parses");
    let mut vm = Vm::new();
    let frame = Frame { time: 0.0, dt: 1.0 / 30.0, frame: 0, led_count: LEDS, ..Default::default() };
    let (_, up) = vm.run_update_counted(&prog, &frame, &Budget::default());
    let (mut shade_instrs, mut stack_max) = (0u32, up.stack_max);
    for i in 0..LEDS {
        let led = Led { idx: i, ..Default::default() };
        let (_, _, c) = vm.run_shade_counted(&prog, &frame, &led, &Budget::default());
        shade_instrs += c.instrs;
        stack_max = stack_max.max(c.stack_max);
    }
    assert!(shade_instrs > 10 * LEDS, "per-LED work varies with the LED ({shade_instrs})");

    set_perf(pb::SetPerf_::Mode::Full);
    submit("measured", &fxb);
    render_and_push(0);
    assert_eq!(unsafe { lm_perf_instr_update() }, up.instrs);
    assert_eq!(unsafe { lm_perf_instr_shade() }, shade_instrs);
    assert_eq!(unsafe { lm_perf_stack_max() }, stack_max as u32);
    let r = perf_report();
    let tick = r.r#ticks.first().expect("the frame's sample is reported");
    assert_eq!(
        (tick.r#instr_update, tick.r#instr_shade, tick.r#stack_max),
        (up.instrs, shade_instrs, stack_max as u32)
    );
    assert_eq!(tick.r#led_count, LEDS);
}

#[test]
fn basic_perf_reports_cycle_spans_without_paying_for_opcode_counting() {
    rr::verifies!("PR-27");
    lm_player_init(LEDS);
    unsafe { lm_fx_clear() };
    set_perf(pb::SetPerf_::Mode::Basic);
    submit("measured", &compile(MEASURED));
    render_and_push(0);
    let r = perf_report();
    let tick = r.r#ticks.first().expect("the frame's sample is reported");
    assert_eq!(tick.r#frame_cycles, 10_000, "the cycle spans are reported");
    assert_eq!(tick.r#shade_cycles, 9_000);
    assert_eq!(
        (tick.r#instr_update, tick.r#instr_shade, tick.r#stack_max),
        (0, 0, 0),
        "BASIC runs the uncounted VM path"
    );
}

#[test]
fn every_report_is_pinned_to_the_program_that_produced_it() {
    rr::verifies!("PR-27");
    lm_player_init(LEDS);
    unsafe { lm_fx_clear() };
    set_perf(pb::SetPerf_::Mode::Basic);
    let a = compile(MEASURED);
    submit("fx-a", &a);
    render_and_push(0);
    render_and_push(1);
    let ra = perf_report();
    assert_eq!(ra.r#effect_id.as_str(), "fx-a");
    assert_eq!(ra.r#fxb_hash, fnv1a(&a), "metrics carry the exact compiled program's identity");
    assert_eq!(ra.r#ticks.len(), 2);
    // Two more frames of A are buffered when the user hot-reloads B...
    render_and_push(2);
    render_and_push(3);
    let b = compile(OTHER);
    submit("fx-b", &b);
    // ...and none of A's measurements leak into B's report.
    let rb = perf_report();
    assert_eq!(rb.r#effect_id.as_str(), "fx-b");
    assert_eq!(rb.r#fxb_hash, fnv1a(&b));
    assert_ne!(rb.r#fxb_hash, ra.r#fxb_hash);
    assert!(rb.r#ticks.is_empty(), "a reload starts a fresh window: {:?}", rb.r#ticks.len());
    assert_eq!(rb.r#frame_cycles_max, 0);
}
