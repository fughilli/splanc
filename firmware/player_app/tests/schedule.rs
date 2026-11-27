//! Wall-clock schedules (sched_ffi.rs, docs/design/schedule.md) through the C
//! ABI, playing main.cpp's part (the rules file, the stored-effect record, the
//! render task's frame starts): set / get / delete with the file, the boot
//! reconcile (D-566), ahead-of-time fires queued for their frame, the
//! brightness ramp, the staged stored-effect load + timed crossfade onto the
//! hidden deck, a trigger, the live-show skip (D-567), and the location.
//!
//! One flow test: the player, the clock and the schedule are process-global.

use std::collections::HashMap;
use std::sync::Mutex;

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::clock_ffi::{
    lm_clock_mesh, lm_clock_mesh_clear, lm_clock_mesh_zone, lm_clock_test_set_mono_us,
    lm_clock_tick,
};
use ledmapper_player_ffi::effect_store::lm_fxs_set_store;
use ledmapper_player_ffi::sched_ffi::{
    lm_sched_boot, lm_sched_effect_slot, lm_sched_handle, lm_sched_load, lm_sched_loc_record,
    lm_sched_ramping, lm_sched_resolve, lm_sched_status_line, lm_sched_tick, FILE_CAP,
    TICK_NEED_FILE,
};
use ledmapper_player_ffi::{lm_brightness_u8, lm_player_handle, lm_player_init, lm_sched_apply};
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

static FS: Mutex<Option<HashMap<String, Vec<u8>>>> = Mutex::new(None);

fn file_name(p: *const u8, n: usize) -> String {
    String::from_utf8(unsafe { std::slice::from_raw_parts(p, n) }.to_vec()).unwrap()
}

unsafe extern "C" fn fs_read(name: *const u8, nl: usize, buf: *mut u8, cap: usize) -> i32 {
    let g = FS.lock().unwrap();
    match g.as_ref().unwrap().get(&file_name(name, nl)) {
        Some(v) if !v.is_empty() => {
            let n = v.len().min(cap);
            std::ptr::copy_nonoverlapping(v.as_ptr(), buf, n);
            n as i32
        }
        _ => -1,
    }
}

unsafe extern "C" fn fs_write(
    name: *const u8,
    nl: usize,
    a: *const u8,
    al: usize,
    b: *const u8,
    bl: usize,
) -> i32 {
    let mut v = std::slice::from_raw_parts(a, al).to_vec();
    v.extend_from_slice(std::slice::from_raw_parts(b, bl));
    FS.lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .insert(file_name(name, nl), v);
    0
}

unsafe extern "C" fn fs_remove(name: *const u8, nl: usize) {
    FS.lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .remove(&file_name(name, nl));
}

fn encode(msg: CMsg) -> Vec<u8> {
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 8192>::new());
    env.encode(&mut enc).unwrap();
    enc.into_writer().to_vec()
}

fn decode(out: &[u8]) -> Option<SMsg> {
    let mut reply = pb::ServerMessage::default();
    reply.decode_from_bytes(out).expect("reply decodes");
    reply.r#msg
}

fn handle_frame(frame: &[u8], now_ms: i64) -> Option<SMsg> {
    unsafe { lm_clock_test_set_mono_us(now_ms * 1000) };
    let mut out = vec![0u8; 4096];
    let n = unsafe {
        lm_player_handle(
            frame.as_ptr(),
            frame.len(),
            now_ms,
            now_ms,
            out.as_mut_ptr(),
            out.len(),
        )
    };
    assert!(n >= 0, "handle returned {n}");
    (n > 0).then(|| decode(&out[..n as usize])).flatten()
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

/// submit_effect (deck, activate, store), hand-encoded (the fxb field is capped
/// in the generated host type).
fn submit(id: &str, src: &str, store: bool) -> Option<SMsg> {
    let fxb = ledmapper_fx_compiler::compile(src).expect("compiles").fxb;
    let mut body = len_field(1, id.as_bytes());
    body.extend(len_field(2, &fxb));
    body.extend([3 << 3, 1]);
    if store {
        body.extend([5 << 3, 1]);
    }
    handle_frame(&len_field(21, &body), 0)
}

/// The rules file main.cpp keeps.
static RULES: Mutex<Vec<u8>> = Mutex::new(Vec::new());

/// A schedule arm, as main.cpp's schedule_message: with the file, writing back a change.
fn sched(msg: CMsg, now_ms: i64) -> pb::ScheduleState {
    unsafe { lm_clock_test_set_mono_us(now_ms * 1000) };
    let frame = encode(msg);
    let file = RULES.lock().unwrap().clone();
    let mut next = vec![0u8; FILE_CAP];
    let mut nlen = 0usize;
    let mut out = vec![0u8; 2048];
    let n = unsafe {
        lm_sched_handle(
            frame.as_ptr(),
            frame.len(),
            file.as_ptr(),
            file.len(),
            next.as_mut_ptr(),
            next.len(),
            &mut nlen,
            out.as_mut_ptr(),
            out.len(),
        )
    };
    assert!(n > 0, "lm_sched_handle returned {n}");
    if nlen != usize::MAX {
        *RULES.lock().unwrap() = next[..nlen].to_vec();
    }
    match decode(&out[..n as usize]) {
        Some(SMsg::ScheduleState(s)) => s,
        other => panic!("schedule_state expected, got {other:?}"),
    }
}

fn local_rule(id: u32, minute: u32, action: pb::ScheduleRule_::Action) -> pb::ScheduleRule {
    pb::ScheduleRule {
        id,
        minute_of_day: minute,
        action: Some(action),
        ..Default::default()
    }
}

fn set_rules(rules: Vec<pb::ScheduleRule>, now_ms: i64) -> pb::ScheduleState {
    let mut m = pb::SetSchedule::default();
    for r in rules {
        m.r#rules.push(r).unwrap();
    }
    sched(CMsg::SetSchedule(m), now_ms)
}

/// main.cpp's poll_schedule: tick, then (with the mutex released in between) the
/// file and the stored effect's record. Returns the log lines.
fn poll(now_ms: i64) -> Vec<String> {
    unsafe { lm_clock_test_set_mono_us(now_ms * 1000) };
    unsafe { lm_clock_tick(core::ptr::null_mut()) };
    let bits = unsafe { lm_sched_tick(now_ms) };
    if bits & TICK_NEED_FILE != 0 {
        let file = RULES.lock().unwrap().clone();
        loop {
            let mut id = [0u8; 64];
            let k =
                unsafe { lm_sched_resolve(file.as_ptr(), file.len(), id.as_mut_ptr(), id.len()) };
            if k <= 0 {
                break;
            }
            let slot = unsafe { lm_sched_effect_slot(id.as_ptr(), k as usize) };
            assert!(slot >= 0);
            let rec = FS
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .get(&format!("fxs.{slot}"))
                .cloned()
                .unwrap();
            let (mut off, mut plen) = (0usize, 0usize);
            assert!(unsafe { lm_sched_load(rec.as_ptr(), rec.len(), &mut off, &mut plen) });
        }
    }
    lines(now_ms)
}

fn lines(now_ms: i64) -> Vec<String> {
    let mut v = Vec::new();
    loop {
        let mut b = [0u8; 160];
        let n = unsafe { lm_sched_status_line(now_ms, b.as_mut_ptr(), b.len()) };
        if n == 0 {
            return v;
        }
        v.push(String::from_utf8_lossy(&b[..n]).into_owned());
    }
}

/// The render task's frame start at device ms `now_ms`.
fn frame(now_ms: i64) {
    unsafe { lm_clock_test_set_mono_us(now_ms * 1000) };
    unsafe { lm_sched_apply(now_ms) };
}

fn crossfade(now_ms: i64) -> f64 {
    match handle_frame(&encode(CMsg::Hello(pb::Hello::default())), now_ms) {
        Some(SMsg::Welcome(w)) => w.crossfade().copied().unwrap_or(0.0),
        other => panic!("welcome expected, got {other:?}"),
    }
}

fn decks(now_ms: i64) -> Vec<(String, u32, bool)> {
    match handle_frame(
        &encode(CMsg::ListEffects(pb::ListEffects::default())),
        now_ms,
    ) {
        Some(SMsg::EffectList(l)) => l
            .r#effects
            .iter()
            .map(|e| (e.r#effect_id.as_str().to_string(), e.r#deck, e.r#active))
            .collect(),
        other => panic!("effect_list expected, got {other:?}"),
    }
}

const GREEN: &str = "void update() {}\nvec3 shade(Led led) { return vec3(0.0, 1.0, 0.0); }";
const BLUE: &str = "void update() {}\nvec3 shade(Led led) { return vec3(0.0, 0.0, 1.0); }";

/// Wednesday 2026-11-25 06:59:00Z, ms.
const T0_MS: i64 = 1_795_589_940_000;

fn s(v: &str) -> micropb::heapless::String<64> {
    micropb::heapless::String::try_from(v).unwrap()
}

#[test]
fn schedules_end_to_end() {
    use pb::ScheduleRule_::Action as A;
    *FS.lock().unwrap() = Some(HashMap::new());
    lm_player_init(16);
    unsafe { lm_fxs_set_store(Some(fs_read), Some(fs_write), Some(fs_remove)) };
    assert!(matches!(
        submit("day", GREEN, false),
        Some(SMsg::ResultReady(_))
    ));
    assert!(matches!(
        submit("night", BLUE, true),
        Some(SMsg::ResultReady(_))
    ));
    assert_eq!(
        unsafe { lm_sched_boot(core::ptr::null(), 0, core::ptr::null(), 0) },
        0
    );

    // The clock: UTC, 06:59:00 at device ms 1000.
    let mut wc = pb::SetWallClock {
        unix_ms: T0_MS,
        err_ms: 5,
        r#pushed_by: pb::WallClockPusher::App,
        ..Default::default()
    };
    wc.set_at_device_ms(1000);
    handle_frame(&encode(CMsg::SetWallClock(wc)), 1000);

    // -- set: four rules at 07:00 / 07:01 -----------------------------------------
    let st = set_rules(
        vec![
            local_rule(
                1,
                420,
                A::Brightness(pb::ScheduleBrightness {
                    level: 0.5,
                    ramp_ms: 1000,
                }),
            ),
            local_rule(
                2,
                420,
                A::Effect(pb::ScheduleEffect {
                    effect_id: s("night"),
                    crossfade_ms: 2000,
                }),
            ),
            local_rule(3, 420, A::Trigger(pb::ScheduleTrigger { name: s("chime") })),
            local_rule(
                4,
                421,
                A::Power(pb::SchedulePower {
                    on: true,
                    duration_ms: 0,
                }),
            ),
        ],
        1000,
    );
    assert_eq!(st.r#result, pb::ScheduleResult::Ok);
    assert_eq!((st.r#count, st.r#capacity, st.r#rules.len()), (4, 24, 4));
    assert!(st.r#clock_valid);
    // The file is exactly the rules: what lm_sched_boot reads back.
    let file = RULES.lock().unwrap().clone();
    assert_eq!(
        unsafe { lm_sched_boot(file.as_ptr(), file.len(), core::ptr::null(), 0) },
        4
    );

    // A bad rule is refused whole, nothing changes.
    let st = set_rules(
        vec![local_rule(
            9,
            1440,
            A::Power(pb::SchedulePower {
                on: true,
                duration_ms: 0,
            }),
        )],
        1000,
    );
    assert_eq!(st.r#result, pb::ScheduleResult::BadRule);
    assert_eq!(st.r#count, 4);

    // -- boot reconcile (D-566): last Wednesday's state applies now -------------------
    let log = poll(1000);
    assert!(
        log.iter()
            .any(|l| l.starts_with("[sched] fire id=1 in_ms=0")),
        "{log:?}"
    );
    assert!(
        !log.iter().any(|l| l.contains("id=3")),
        "triggers are not replayed: {log:?}"
    );
    frame(1016);
    assert!(
        (127..=128).contains(&unsafe { lm_brightness_u8() }),
        "a catch-up brightness lands at once"
    );
    // The stored effect loaded onto the hidden deck B, then crossfades in over 2 s.
    assert!(
        decks(1016).contains(&("night".to_string(), 1, true)),
        "{:?}",
        decks(1016)
    );
    frame(1032);
    frame(2032);
    assert!((crossfade(2032) - 0.5).abs() < 0.02, "{}", crossfade(2032));
    frame(3100);
    assert_eq!(crossfade(3100), 1.0);
    let log = lines(3100);
    assert!(
        log.iter()
            .filter(|l| l.starts_with("[sched] applied"))
            .count()
            >= 2,
        "{log:?}"
    );

    // -- the normal path: handed out 2 s ahead, applied on its frame ------------------
    assert!(poll(57_000).is_empty()); // 06:59:56
    let log = poll(58_000); // 06:59:57: 07:00 is 3 s out
    assert!(log.is_empty(), "{log:?}");
    let log = poll(59_000); // 06:59:58
    assert!(
        log.iter().any(|l| l == "[sched] fire id=1 in_ms=2000"),
        "{log:?}"
    );
    // The effect is already showing (deck B): nothing to load; the trigger is queued.
    frame(60_984);
    assert!(lines(60_984).is_empty(), "not before its frame");
    frame(61_000);
    let log = lines(61_000);
    assert!(
        log.iter()
            .any(|l| l.contains("applied id=1 at_ms=61000 due_ms=61000 late_ms=0")),
        "{log:?}"
    );
    assert!(log.iter().any(|l| l.contains("applied id=3 ")), "{log:?}");
    // The ramp from 0.5 to 0.5: done at once; ramp a real change via an edit.
    let st = set_rules(
        vec![local_rule(
            1,
            422,
            A::Brightness(pb::ScheduleBrightness {
                level: 0.0,
                ramp_ms: 1000,
            }),
        )],
        61_000,
    );
    assert_eq!(st.r#count, 4);
    for t in (61_250..=183_000).step_by(250) {
        poll(t);
        frame(t);
    }
    // 07:01 power (already on), then 07:02 the brightness ramp ran to 0 over 1 s.
    assert_eq!(unsafe { lm_brightness_u8() }, 0);
    assert!(!lm_sched_ramping());

    // -- a live show holds the lamp (D-567) ---------------------------------------------
    let mut hold = pb::SetSchedule::default();
    hold.r#hold_s = 120;
    let st = sched(CMsg::SetSchedule(hold), 183_000);
    assert!(st.r#hold_s >= 119 && st.r#count == 4, "{st:?}");
    set_rules(
        vec![local_rule(
            4,
            423,
            A::Power(pb::SchedulePower {
                on: false,
                duration_ms: 0,
            }),
        )],
        183_000,
    );
    for t in (183_250..=242_000).step_by(250) {
        poll(t);
        frame(t);
    }
    let st = sched(CMsg::GetSchedule(pb::GetSchedule::default()), 242_000);
    assert_eq!(
        (st.r#skipped, st.r#last_skipped_id, st.r#last_skip),
        (1, 4, pb::ScheduleSkip::Live)
    );
    assert!(st.r#fired >= 4);
    assert_eq!(st.r#last_fired_id, 1);

    // -- delete, paging ---------------------------------------------------------------
    let st = sched(
        CMsg::DeleteSchedule(pb::DeleteSchedule { id: 3, all: false }),
        242_000,
    );
    assert_eq!((st.r#result, st.r#count), (pb::ScheduleResult::Ok, 3));
    let st = sched(
        CMsg::DeleteSchedule(pb::DeleteSchedule { id: 3, all: false }),
        242_000,
    );
    assert_eq!(st.r#result, pb::ScheduleResult::NotFound);
    let ids: Vec<u32> = sched(CMsg::GetSchedule(pb::GetSchedule::default()), 242_000)
        .r#rules
        .iter()
        .map(|r| r.r#id)
        .collect();
    assert_eq!(
        ids,
        [2, 1, 4],
        "edits replace in the file's order: kept first, then the new"
    );

    // -- on a mesh (RTC PR-8): rules fire at the mesh record's instant -------------------
    // The lamp is a member: the gateway's record maps wall time 7 ms ahead of its own clock.
    // Mesh = local + 5.000123 s.
    let own_wml: i64 = T0_MS * 1000 - 1_000_000;
    let mml: i64 = 5_000_123;
    let wml = own_wml + 7_000;
    let wmm = wml - mml;
    let link = |t: i64, epoch: i64| unsafe {
        lm_clock_test_set_mono_us(t * 1000);
        lm_clock_mesh(wml, wmm, epoch, 2_000, 1, 0x1001, false)
    };
    assert_eq!(link(242_000, i64::MIN), 1, "a member offers the mesh's time to its clock");
    match handle_frame(&encode(CMsg::GetClock(pb::GetClock::default())), 242_000) {
        Some(SMsg::ClockState(c)) => assert_eq!(c.r#source, pb::ClockSource::Mesh),
        other => panic!("clock_state expected, got {other:?}"),
    }
    assert_eq!(link(242_100, i64::MIN), 0, "the same record is not offered again at once");
    set_rules(
        vec![local_rule(
            5,
            425,
            A::Brightness(pb::ScheduleBrightness {
                level: 0.25,
                ramp_ms: 0,
            }),
        )],
        242_000,
    );
    // 07:05:00 is device ms 361_000 on the lamp's own clock, 360_993 through the record.
    let mut fired = Vec::new();
    for t in (242_250..=360_000).step_by(250) {
        link(t, i64::MIN);
        fired.extend(poll(t));
        frame(t);
    }
    assert!(
        fired.iter().any(|l| l == "[sched] fire id=5 in_ms=1993"),
        "{fired:?}"
    );
    assert!(
        fired.iter().any(|l| l == "[sched] mesh id=5 k=-1"),
        "{fired:?}"
    );
    frame(360_992);
    assert!(lines(360_992).is_empty(), "not before the mesh instant");
    frame(360_993);
    let log = lines(360_993);
    assert!(
        log.iter().any(|l| l.contains("applied id=5 at_ms=360993 due_ms=360993")),
        "{log:?}"
    );
    assert!((63..=64).contains(&unsafe { lm_brightness_u8() }));
    // With frames on the show epoch's grid: the rule goes half a frame ahead of grid frame
    // k = ceil((M - epoch) / period), so every member's queue releases it on that frame.
    // Epoch = the rule's mesh instant: k = 0.
    let fire6_unix = (T0_MS + 420_000) * 1000; // 07:06
    let epoch = fire6_unix - wmm;
    set_rules(
        vec![local_rule(
            6,
            426,
            A::Brightness(pb::ScheduleBrightness {
                level: 0.5,
                ramp_ms: 0,
            }),
        )],
        361_000,
    );
    let mut fired = Vec::new();
    for t in (361_250..=420_000).step_by(250) {
        link(t, epoch);
        fired.extend(poll(t));
        frame(t);
    }
    assert!(
        fired.iter().any(|l| l == "[sched] mesh id=6 k=0"),
        "{fired:?}"
    );
    let in_ms: i64 = fired
        .iter()
        .find_map(|l| l.strip_prefix("[sched] fire id=6 in_ms="))
        .expect("fired")
        .parse()
        .unwrap();
    // Half a frame (8-25 ms at 20-60 fps) before 420_993.
    assert!((1993 - 30..1993).contains(&in_ms), "{in_ms}");
    let due = 419_000 + in_ms;
    frame(due - 1);
    assert!(lines(due - 1).is_empty());
    frame(due);
    assert!(
        lines(due).iter().any(|l| l.contains("applied id=6 ")),
        "applied at its due"
    );
    // Off the mesh: back to the lamp's own clock. A member adopts the record's zone.
    unsafe { lm_clock_mesh_clear() };
    let rule = b"CET-1CEST,M3.5.0,M10.5.0/3";
    let name = b"Europe/Berlin";
    assert_eq!(
        unsafe { lm_clock_mesh_zone(rule.as_ptr(), rule.len() as u32, name.as_ptr(), name.len() as u32) },
        1
    );
    assert_eq!(
        unsafe { lm_clock_mesh_zone(rule.as_ptr(), rule.len() as u32, name.as_ptr(), name.len() as u32) },
        0,
        "unchanged"
    );
    match handle_frame(&encode(CMsg::GetClock(pb::GetClock::default())), 420_000) {
        Some(SMsg::ClockState(c)) => assert_eq!(c.r#tz.as_str(), "CET-1CEST,M3.5.0,M10.5.0/3"),
        other => panic!("clock_state expected, got {other:?}"),
    }

    // -- the location (set_clock_config) -------------------------------------------------
    let mut cc = pb::SetClockConfig::default();
    cc.set_lat_e4(515_000);
    cc.set_lon_e4(-1_000);
    match handle_frame(&encode(CMsg::SetClockConfig(cc)), 420_000) {
        Some(SMsg::ClockState(c)) => {
            assert!(c.r#has_location && c.r#lat_e4 == 515_000 && c.r#lon_e4 == -1_000)
        }
        other => panic!("clock_state expected, got {other:?}"),
    }
    let mut rec = [0u8; 8];
    assert_eq!(unsafe { lm_sched_loc_record(rec.as_mut_ptr()) }, 8);
    assert!(sched(CMsg::GetSchedule(pb::GetSchedule::default()), 420_000).r#has_location);

    // Without main.cpp (no filesystem), changes are refused.
    match handle_frame(
        &encode(CMsg::DeleteSchedule(pb::DeleteSchedule {
            id: 0,
            all: true,
        })),
        420_000,
    ) {
        Some(SMsg::ScheduleState(s)) => assert_eq!(s.r#result, pb::ScheduleResult::Storage),
        other => panic!("{other:?}"),
    }
}
