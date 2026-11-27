//! Lamp power (power_ffi.rs, docs/design/lamp-power.md) through the C ABI:
//! set_power / get_power / set_power_config, the boot fade, the render-frame
//! output, a stored transition effect played on deck B, the toggle trigger
//! (a driver export in the uniform pool) and the persisted config record.

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::{
    lm_fx_active, lm_power_build_push, lm_power_cfg_gen, lm_power_cfg_record, lm_power_effect_loaded,
    lm_power_frame, lm_power_poll_trigger, lm_power_push_done, lm_power_push_due, lm_power_seed,
    lm_power_set_loading, lm_power_subscribed, lm_power_take_load, lm_power_take_sim, lm_power_take_store,
    lm_player_handle, lm_player_init,
};
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

extern "C" {
    fn lm_kiosk_gate(src: u8, data: *const u8, len: usize, now_ms: u32, out: *mut u8, cap: usize) -> i32;
    fn lm_pool_publish(name: *const u8, name_len: usize, vals: *const f32, n: usize) -> bool;
}

fn frame_of(msg: CMsg) -> Vec<u8> {
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 8192>::new());
    env.encode(&mut enc).unwrap();
    enc.into_writer().to_vec()
}

fn send(frame: &[u8], now: i64) -> SMsg {
    let mut out = vec![0u8; 4096];
    // As the firmware does ahead of every handler: the connection it came in on
    // (1 = wss), which a power arm subscribes to pushes.
    assert_eq!(unsafe { lm_kiosk_gate(1, frame.as_ptr(), frame.len(), now as u32, out.as_mut_ptr(), out.len()) }, 0);
    let n = unsafe { lm_player_handle(frame.as_ptr(), frame.len(), now, now, out.as_mut_ptr(), out.len()) };
    assert!(n > 0, "handle returned {n}");
    let mut reply = pb::ServerMessage::default();
    reply.decode_from_bytes(&out[..n as usize]).expect("reply decodes");
    reply.r#msg.expect("a reply arm")
}

fn power(msg: CMsg, now: i64) -> pb::PowerState {
    match send(&frame_of(msg), now) {
        SMsg::PowerState(s) => s,
        other => panic!("power_state expected, got {other:?}"),
    }
}

fn set_power(on: bool, now: i64) -> pb::PowerState {
    power(CMsg::SetPower(pb::SetPower { r#on: on, ..Default::default() }), now)
}

fn get_power(now: i64) -> pb::PowerState {
    power(CMsg::GetPower(pb::GetPower::default()), now)
}

/// Render frames from `from` to `to` ms every `step`; returns (render, level, settled) of the last.
fn frames(from: u32, to: u32, step: u32) -> (bool, u16, bool) {
    let mut last = (false, 0, false);
    let mut t = from;
    let mut settled_any = false;
    while t <= to {
        let mut lvl = 0u16;
        let r = unsafe { lm_power_frame(t, &mut lvl) };
        settled_any |= r & 2 != 0;
        last = (r & 1 != 0, lvl, settled_any);
        t += step;
    }
    last
}

/// A submit_effect frame by hand (the .fxb can outgrow the host profile's
/// inline bytes cap): ClientMessage.submit_effect = 21 {1 id, 2 fxb, 4 deck = 1,
/// 7 power_slot}.
fn submit_frame(id: &str, fxb: &[u8], slot: u8) -> Vec<u8> {
    fn varint(o: &mut Vec<u8>, mut v: usize) {
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                o.push(b);
                return;
            }
            o.push(b | 0x80);
        }
    }
    let mut body = vec![0x0a];
    varint(&mut body, id.len());
    body.extend_from_slice(id.as_bytes());
    body.push(0x12);
    varint(&mut body, fxb.len());
    body.extend_from_slice(fxb);
    body.extend_from_slice(&[0x20, 1, 0x38, slot]);
    let mut f = vec![0xaa, 0x01]; // field 21, LEN
    varint(&mut f, body.len());
    f.extend_from_slice(&body);
    f
}

fn transition(style: u32, ms: u32) -> pb::PowerTransition {
    pb::PowerTransition { r#style: style, r#duration_ms: ms, ..Default::default() }
}

fn effect_fxb() -> Vec<u8> {
    let src = "uniform float power : 0..1 = 0.0;\nvec3 shade(Led led) { return vec3(power); }\n";
    ledmapper_fx_compiler::compile(src).expect("compiles").fxb
}

/// One process-global flow (the FFI state is global).
#[test]
fn power_through_the_c_abi() {
    lm_player_init(64);

    // Boot: never saved -> on, fading in from the first frame.
    let on = unsafe { lm_power_seed(core::ptr::null(), 0, -1, false, false) };
    assert!(on);
    let st = get_power(0);
    assert!(st.r#on);
    assert_eq!(st.r#phase, 2, "turning on (boot fade-in)");
    assert_eq!(st.r#source, 0, "boot");
    let mut lvl = 0u16;
    assert_eq!(unsafe { lm_power_frame(10_000, &mut lvl) } & 1, 1);
    assert_eq!(lvl, 0, "the fade starts dark at the first frame");
    let (render, lvl, settled) = frames(10_000, 10_800, 20);
    assert!(render && settled);
    assert_eq!(lvl, 256);
    assert_eq!(get_power(10_800).r#phase, 1);

    // A power arm subscribes this session (wss by default) to pushes.
    assert!(unsafe { lm_power_subscribed(1) });

    // Off with the default fade, then settled dark: the render bit clears.
    let st = set_power(false, 11_000);
    assert!(!st.r#on);
    assert_eq!(st.r#phase, 3);
    assert_eq!(st.r#source, 1);
    assert!(st.r#transition_left_ms > 0);
    assert!(unsafe { lm_power_push_due() });
    let mut out = vec![0u8; 1024];
    let n = unsafe { lm_power_build_push(1, 11_000, out.as_mut_ptr(), out.len()) };
    assert!(n > 0, "a push for the subscribed session");
    assert_eq!(unsafe { lm_power_build_push(2, 11_000, out.as_mut_ptr(), out.len()) }, 0, "BLE never asked");
    unsafe { lm_power_push_done() };
    let mut lvl = 0u16;
    let mid = unsafe { lm_power_frame(11_000 + 450, &mut lvl) };
    assert_eq!(mid & 1, 1);
    assert!(lvl > 0 && lvl < 256, "mid-fade {lvl}");
    let (render, _, settled) = frames(11_500, 12_000, 20);
    assert!(!render && settled, "settled off renders nothing");
    assert_eq!(get_power(12_000).r#phase, 0);

    // Toggle + instant.
    let st = power(CMsg::SetPower(pb::SetPower { r#toggle: true, r#instant: true, ..Default::default() }), 12_100);
    assert_eq!((st.r#on, st.r#phase), (true, 1));

    // Config: boot off, a cut ON, a 300 ms fade OFF, a toggle trigger; echoed and
    // persisted (the gen bumps; the record round-trips through the seed).
    let gen0 = unsafe { lm_power_cfg_gen() };
    let mut cfg = pb::SetPowerConfig::default();
    cfg.set_boot(2);
    cfg.set_on_transition(transition(0, 0));
    cfg.set_off_transition(transition(1, 300));
    cfg.set_toggle_trigger(micropb::heapless::String::try_from("touch_tap").unwrap());
    let st = power(CMsg::SetPowerConfig(cfg), 12_200);
    assert_eq!(st.r#boot, 2);
    assert_eq!(st.on_transition().unwrap().r#style, 0);
    let off_t = st.off_transition().unwrap();
    assert_eq!((off_t.r#style, off_t.r#duration_ms), (1, 300));
    assert_eq!(st.r#toggle_trigger.as_str(), "touch_tap");
    assert_ne!(unsafe { lm_power_cfg_gen() }, gen0);
    let mut rec = vec![0u8; 576];
    let rn = unsafe { lm_power_cfg_record(rec.as_mut_ptr(), rec.len()) };
    assert!(rn > 0);

    // The toggle trigger: first sight adopts the count, each increment toggles.
    let name = b"touch_tap";
    let publish = |v: f32| unsafe { lm_pool_publish(name.as_ptr(), name.len(), &v, 1) };
    assert!(publish(3.0));
    assert!(!unsafe { lm_power_poll_trigger(12_300) }, "first sight: no toggle");
    assert!(publish(4.0));
    assert!(unsafe { lm_power_poll_trigger(12_310) }, "a fire toggles");
    let st = get_power(12_310);
    assert!(!st.r#on, "toggled off");
    assert_eq!(st.r#source, 2, "by the trigger");
    assert_eq!(st.r#trigger_count, 1);
    assert!(!unsafe { lm_power_poll_trigger(12_320) }, "unchanged");
    assert!(publish(0.0));
    assert!(!unsafe { lm_power_poll_trigger(12_330) }, "a reset (driver reload) never toggles");
    frames(12_330, 13_000, 20);

    // The HITL pull simulation is handed to the loop task.
    let mut cfg = pb::SetPowerConfig::default();
    cfg.set_sim_gpio(3);
    cfg.r#sim_pull = 1;
    power(CMsg::SetPowerConfig(cfg), 13_000);
    let (mut pin, mut pull) = (0i32, 0u32);
    assert!(unsafe { lm_power_take_sim(&mut pin, &mut pull) });
    assert_eq!((pin, pull), (3, 1));
    assert!(!unsafe { lm_power_take_sim(&mut pin, &mut pull) });

    // A transition effect: stored (not loaded), then played on deck B.
    let fxb = effect_fxb();
    let store = submit_frame("lib-glow", &fxb, 1);
    match send(&store, 13_100) {
        SMsg::ResultReady(r) => assert_eq!(r.r#map_id.as_str(), "lib-glow"),
        other => panic!("result_ready expected, got {other:?}"),
    }
    assert_eq!(unsafe { lm_power_take_store() }, 1, "the loop task persists the frame");
    assert!(!unsafe { lm_fx_active() }, "stored, not playing");
    let mut cfg = pb::SetPowerConfig::default();
    cfg.set_on_transition(transition(2, 1000));
    let st = power(CMsg::SetPowerConfig(cfg), 13_200);
    let on_t = st.on_transition().unwrap();
    assert_eq!((on_t.r#style, on_t.r#effect_id.as_str()), (2, "lib-glow"));

    // Turn on: the machine asks for the effect; the loop task replays the frame.
    set_power(true, 13_300);
    assert_eq!(unsafe { lm_power_take_load() }, 1);
    unsafe { lm_power_set_loading(true) };
    match send(&store, 13_300) {
        SMsg::ResultReady(_) => {}
        other => panic!("result_ready expected, got {other:?}"),
    }
    unsafe { lm_power_set_loading(false) };
    assert_eq!(unsafe { lm_power_take_store() }, 0, "a replay is not a store");
    unsafe { lm_power_effect_loaded(13_300) };
    assert!(unsafe { lm_fx_active() }, "the transition effect plays on deck B");
    let (render, lvl, _) = frames(13_300, 13_800, 20);
    assert!(render && lvl == 256);
    let (render, _, settled) = frames(13_800, 14_400, 20);
    assert!(render && settled);
    assert!(!unsafe { lm_fx_active() }, "deck B released when the transition settles");
    assert_eq!(get_power(14_400).r#phase, 1);

    // The record seeds a fresh boot: boot = off wins over the saved "on".
    let on = unsafe { lm_power_seed(rec.as_ptr(), rn as usize, 1, true, false) };
    assert!(!on, "boot = always off");
    let st = get_power(20_000);
    assert_eq!((st.r#on, st.r#phase, st.r#boot), (false, 0, 2));
    assert_eq!(st.r#toggle_trigger.as_str(), "touch_tap");
}
