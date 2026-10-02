//! Expensive effects cannot starve the runtime: the guards the player's C ABI
//! gives main.cpp's render task (render_once) for a user effect, driven exactly
//! as the render loop drives them — lm_fx_update once per frame, lm_fx_shade per
//! LED, then lm_perf_push with the frame's cycle spans.
//!
//! * abort: every update()/shade() runs under a per-invocation instruction
//!   budget, so a runaway script hands control back after a bounded amount of
//!   work (the LED is held black, the frame completes); the budget is a ceiling
//!   the firmware can tighten at runtime; a raised wall-time deadline flag
//!   cancels long shades until the next frame starts;
//! * notify: a cancelled update() is reported (lm_fx_last_update_outcome feeds
//!   the render loop's `[fx] update=budget` log) and frames that blow the 33 ms
//!   frame budget are counted into the PerfReport the app polls / is pushed;
//! * recover: the app can switch a runaway effect off over the protocol.
//!
//! The FFI state is process-global (one player, as on the device), so every
//! test re-initializes it and the target runs with `--test-threads=1`.

use ledmapper_fx_vm::DEFAULT_BUDGET;
use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::{
    lm_fx_active, lm_fx_clear, lm_fx_last_update_outcome, lm_fx_set_budget, lm_fx_set_deadline,
    lm_fx_shade, lm_fx_update, lm_perf_build_report, lm_perf_instr_shade, lm_perf_push,
    lm_player_handle, lm_player_init,
};
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

/// main.cpp's frame budget: 33 ms at the C6's 160 MHz (render_once kBudgetCycles).
const FRAME_BUDGET_CYCLES: u32 = (160_000_000 / 1000) * 33;
/// LEDs per rendered frame in these tests.
const LEDS: u32 = 64;
/// One 30 fps frame.
const DT: f32 = 1.0 / 30.0;

/// A shade() that never finishes on its own (a user script with a runaway loop).
const RUNAWAY_SHADE: &str = "vec3 shade(Led led) {\n\
     float x = 0.0;\n\
     for (int i = 0; i < 2000000000; i = i + 1) { x = x + 1.0; }\n\
     return vec3(fract(x), 0.0, 0.0);\n}\n";
/// A runaway update() in front of a trivially cheap, solid-red shade().
const RUNAWAY_UPDATE: &str = "state float spin;\n\
     void update() { for (int i = 0; i < 2000000000; i = i + 1) { spin = spin + 1.0; } }\n\
     vec3 shade(Led led) { return vec3(1.0, 0.0, 0.0); }\n";
/// Well-behaved effect: a few hundred loop iterations per LED (a few thousand
/// opcodes) — comfortably inside the default budget, well above a tiny one.
const BOUNDED_LOOP: &str = "vec3 shade(Led led) {\n\
     float x = 0.0;\n\
     for (int i = 0; i < 300; i = i + 1) { x = x + 0.001; }\n\
     return vec3(x, 0.0, 1.0);\n}\n";
/// Well-behaved but long-running (~2000 iterations): long enough that the VM
/// polls the wall-time deadline flag while it runs.
const LONG_LOOP: &str = "vec3 shade(Led led) {\n\
     float x = 0.0;\n\
     for (int i = 0; i < 2000; i = i + 1) { x = x + 0.0001; }\n\
     return vec3(x, 1.0, 0.0);\n}\n";
const SOLID_GREEN: &str = "vec3 shade(Led led) { return vec3(0.0, 1.0, 0.0); }\n";

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

/// `ClientMessage{submit_effect{effect_id, fxb, activate}}` as the app puts it on
/// the wire (the generated bindings cap `fxb` far below a real effect, which is
/// why the player hand-walks this arm too).
fn submit_effect_frame(id: &str, fxb: &[u8], activate: bool) -> Vec<u8> {
    let mut body = Vec::new();
    len_field(1, id.as_bytes(), &mut body);
    len_field(2, fxb, &mut body);
    if activate {
        varint(3 << 3, &mut body);
        varint(1, &mut body);
    }
    let mut frame = Vec::new();
    len_field(21, &body, &mut frame);
    frame
}

/// `ClientMessage{set_effect{effect_id}}`.
fn set_effect_frame(id: &str) -> Vec<u8> {
    let mut body = Vec::new();
    len_field(1, id.as_bytes(), &mut body);
    let mut frame = Vec::new();
    len_field(22, &body, &mut frame);
    frame
}

/// Compile `src` and submit it (activated) through the protocol, as the app does.
fn submit_active(id: &str, src: &str) {
    let fxb = ledmapper_fx_compiler::compile(src)
        .unwrap_or_else(|d| panic!("effect compiles: {d:?}"))
        .fxb;
    match handle(&submit_effect_frame(id, &fxb, true)) {
        Some(SMsg::ResultReady(r)) => assert_eq!(r.r#map_id.as_str(), id),
        other => panic!("submit_effect must be accepted, got {other:?}"),
    }
    assert!(unsafe { lm_fx_active() }, "the submitted effect drives the render loop");
}

fn set_perf(mode: pb::SetPerf_::Mode) -> pb::PerfReport {
    let sp = pb::SetPerf { r#mode: mode, r#interval_ms: 0 };
    match handle(&encode(CMsg::SetPerf(sp))) {
        Some(SMsg::PerfReport(r)) => r,
        other => panic!("set_perf replies with a perf_report, got {other:?}"),
    }
}

fn perf_report() -> pb::PerfReport {
    match handle(&encode(CMsg::GetPerfReport(pb::GetPerfReport::default()))) {
        Some(SMsg::PerfReport(r)) => r,
        other => panic!("get_perf_report replies with a perf_report, got {other:?}"),
    }
}

/// A fresh device: player re-initialized, no effect, default budget, perf off.
fn fresh_device() {
    lm_player_init(LEDS);
    unsafe {
        lm_fx_clear();
        lm_fx_set_budget(0);
    }
    lm_fx_set_deadline(false);
    set_perf(pb::SetPerf_::Mode::Off);
}

/// Shade one LED the way render_once does; Some(rgb) when it rendered, None
/// when the bounded-execution guard cancelled it (the render loop paints black).
fn shade(i: u32) -> Option<[u8; 3]> {
    const SENTINEL: [u8; 3] = [7, 7, 7];
    let mut rgb = SENTINEL;
    if unsafe { lm_fx_shade(i, i as f32 * 0.01, 0.0, 0.0, rgb.as_mut_ptr()) } {
        Some(rgb)
    } else {
        assert_eq!(rgb, SENTINEL, "a cancelled shade must not write a colour");
        None
    }
}

/// One full effect frame: update() then shade() over every LED; returns how many
/// LED shades the guard cancelled.
fn render_frame(frame: u32) -> u32 {
    assert!(unsafe { lm_fx_update(frame as f32 * DT, DT, frame, LEDS) }, "an active effect renders");
    (0..LEDS).filter(|&i| shade(i).is_none()).count() as u32
}

#[test]
fn a_runaway_shade_is_cut_off_at_the_instruction_budget_on_every_led() {
    rr::verifies!("PR-28");
    fresh_device();
    // FULL perf so the per-frame opcode count (Tier 1) is latched.
    set_perf(pb::SetPerf_::Mode::Full);
    submit_active("runaway-shade", RUNAWAY_SHADE);
    let cancelled = render_frame(0);
    assert_eq!(cancelled, LEDS, "every LED's runaway shade is cancelled, none hangs the frame");
    // The frame's VM work is capped at exactly budget x LEDs: the render task
    // always gets control back after a bounded, deterministic amount of work.
    assert_eq!(unsafe { lm_perf_instr_shade() }, LEDS * DEFAULT_BUDGET);
    // ...and it is the same bound on every frame (no state that lets it creep).
    assert_eq!(render_frame(1), LEDS);
    assert_eq!(unsafe { lm_perf_instr_shade() }, LEDS * DEFAULT_BUDGET);
}

#[test]
fn a_runaway_update_is_cut_off_and_reported_while_the_frame_still_renders() {
    rr::verifies!("PR-28");
    fresh_device();
    submit_active("runaway-update", RUNAWAY_UPDATE);
    assert_eq!(render_frame(0), 0, "the per-LED shades still render after a cancelled update()");
    // 1 = budget exceeded: what the render loop logs as `[fx] ... update=budget`.
    assert_eq!(unsafe { lm_fx_last_update_outcome() }, 1);
    assert_eq!(shade(3), Some([255, 0, 0]));
    // Replacing it with a well-behaved effect clears the report.
    submit_active("solid", SOLID_GREEN);
    assert_eq!(render_frame(1), 0);
    assert_eq!(unsafe { lm_fx_last_update_outcome() }, 0, "a completed update() reports ok");
}

#[test]
fn the_instruction_budget_is_a_ceiling_the_firmware_can_tighten_at_runtime() {
    rr::verifies!("PR-28");
    fresh_device();
    submit_active("bounded", BOUNDED_LOOP);
    assert_eq!(render_frame(0), 0, "a few thousand opcodes per LED fit the default budget");
    let lit = shade(0).expect("renders under the default budget");
    assert_eq!(lit[2], 255);
    // Tighten the ceiling below the effect's per-LED cost: every shade is cut off.
    unsafe { lm_fx_set_budget(500) };
    assert_eq!(render_frame(1), LEDS, "a tightened budget cancels the now over-budget shades");
    // 0 restores the default ceiling and the effect renders again.
    unsafe { lm_fx_set_budget(0) };
    assert_eq!(render_frame(2), 0);
    assert_eq!(shade(0), Some(lit));
}

#[test]
fn a_raised_frame_deadline_cancels_long_shades_until_the_next_frame_starts() {
    rr::verifies!("PR-28");
    fresh_device();
    submit_active("long", LONG_LOOP);
    assert_eq!(render_frame(0), 0, "within budget and before the deadline: renders");
    let before = shade(1).expect("renders before the deadline");
    // The frame deadline passes mid-sweep: the remaining long shades unwind.
    lm_fx_set_deadline(true);
    assert_eq!(shade(1), None, "a shade running past the frame deadline is cancelled");
    assert_eq!(shade(2), None);
    // The next frame's update() starts with a fresh deadline.
    assert_eq!(render_frame(1), 0);
    assert_eq!(shade(1), Some(before));
}

#[test]
fn frames_over_the_frame_budget_are_counted_once_and_reported_to_the_app() {
    rr::verifies!("PR-28");
    fresh_device();
    set_perf(pb::SetPerf_::Mode::Basic);
    // Five rendered effect frames as render_once pushes them; two overran the
    // 33 ms budget (frame+show cycles above it).
    let over = FRAME_BUDGET_CYCLES + 1;
    let under = FRAME_BUDGET_CYCLES / 2;
    unsafe {
        lm_perf_push(0, 1_000, 2_000, under, 1_000, LEDS, false);
        lm_perf_push(1, 1_000, over, over, 1_000, LEDS, true);
        lm_perf_push(2, 1_000, 2_000, under, 1_000, LEDS, false);
        lm_perf_push(3, 1_000, over, over, 1_000, LEDS, true);
        lm_perf_push(4, 1_000, 2_000, under, 1_000, LEDS, false);
    }
    let r = perf_report();
    assert_eq!(r.r#budget_cycles, FRAME_BUDGET_CYCLES, "the report carries the headroom target");
    assert_eq!(r.r#overruns, 2, "every over-budget frame is reported");
    assert_eq!(r.r#frame_cycles_max, over);
    // Since-drain counters: the next poll does not re-report the same overruns.
    assert_eq!(perf_report().r#overruns, 0);
    // The unsolicited push (main.cpp emit_perf_report_if_due) notifies too.
    unsafe { lm_perf_push(5, 1_000, over, over, 1_000, LEDS, true) };
    let mut buf = vec![0u8; 2048];
    let n = unsafe { lm_perf_build_report(buf.as_mut_ptr(), buf.len()) };
    assert!(n > 0, "a perf mode is active, so a report is pushed ({n})");
    let mut pushed = pb::ServerMessage::default();
    pushed.decode_from_bytes(&buf[..n as usize]).expect("pushed report decodes");
    match pushed.r#msg {
        Some(SMsg::PerfReport(p)) => assert_eq!(p.r#overruns, 1),
        other => panic!("pushed frame is a perf_report, got {other:?}"),
    }
}

#[test]
fn the_app_can_switch_a_runaway_effect_off() {
    rr::verifies!("PR-28");
    fresh_device();
    submit_active("runaway-shade", RUNAWAY_SHADE);
    assert_eq!(render_frame(0), LEDS);
    // The session keeps answering between frames and the user can stop the
    // unsafe workload: set_effect("off") clears it, so the render loop falls back
    // to the built-in playback / idle path.
    match handle(&encode(CMsg::Hello(pb::Hello::default()))) {
        Some(SMsg::Welcome(_)) => {}
        other => panic!("hello still answers, got {other:?}"),
    }
    match handle(&set_effect_frame("off")) {
        Some(SMsg::PlaybackState(_)) => {}
        other => panic!("set_effect replies playback_state, got {other:?}"),
    }
    assert!(!unsafe { lm_fx_active() }, "the runaway effect no longer drives the render loop");
    assert!(!unsafe { lm_fx_update(0.0, DT, 1, LEDS) }, "nothing left to run");
}
