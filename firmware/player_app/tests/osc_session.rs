//! OSC over the WebSocket session (feature "osc") through the C ABI: a
//! ClientMessage.osc is recognized and its packet read in place
//! (lm_osc_session_packet), the packet drives the effect's uniforms through
//! the same mailbox a udp/9000 datagram takes (lm_osc_post / lm_osc_drain),
//! a ClientMessage.osc that reaches lm_player_handle anyway still applies and
//! gets no reply, a module's reply encodes as ServerMessage.osc
//! (lm_osc_build_push), Welcome advertises "osc", and a locked kiosk lets it
//! through like set_uniforms. The module hooks and the UDP-vs-session routing
//! are main.cpp's (osc_route.h, host-tested by :osc_route_test). One test:
//! the FFI state is process-global.

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::kiosk_ffi::{classify, Class};
use ledmapper_player_ffi::{
    lm_osc_build_push, lm_osc_drain, lm_osc_mailbox_bind, lm_osc_mailbox_bytes, lm_osc_post,
    lm_osc_session_packet, lm_player_handle, lm_player_init, ARM_OSC, SMSG_OSC,
};
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

fn encode(msg: CMsg) -> Vec<u8> {
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 131072>::new());
    env.encode(&mut enc).unwrap();
    enc.into_writer().to_vec()
}

fn handle_frame(frame: &[u8]) -> Option<SMsg> {
    let mut out = vec![0u8; 8192];
    let n = unsafe { lm_player_handle(frame.as_ptr(), frame.len(), 0, 0, out.as_mut_ptr(), out.len()) };
    assert!(n >= 0, "handle returned {n}");
    if n == 0 {
        return None;
    }
    let mut reply = pb::ServerMessage::default();
    reply.decode_from_bytes(&out[..n as usize]).expect("reply decodes");
    reply.r#msg
}

fn handle(msg: CMsg) -> Option<SMsg> {
    handle_frame(&encode(msg))
}

/// A raw protobuf LEN field.
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

fn submit(id: &str, src: &str) {
    let fxb = ledmapper_fx_compiler::compile(src).expect("compiles").fxb;
    let mut body = len_field(1, id.as_bytes());
    body.extend(len_field(2, &fxb));
    body.extend([3 << 3, 1, 4 << 3, 0]);
    assert!(matches!(handle_frame(&len_field(21, &body)), Some(SMsg::ResultReady(_))));
}

/// Deck A's value at `slot`.
fn uniform(slot: u32) -> Vec<f32> {
    let m = pb::GetEffectUniforms::default();
    let Some(SMsg::EffectUniforms(eu)) = handle(CMsg::GetEffectUniforms(m)) else {
        panic!("expected effect_uniforms");
    };
    eu.r#current.iter().find(|v| v.r#slot == slot).map(|v| v.r#value.to_vec()).expect("slot reported")
}

fn osc_str(s: &str) -> Vec<u8> {
    let mut v = s.as_bytes().to_vec();
    v.push(0);
    while v.len() % 4 != 0 {
        v.push(0);
    }
    v
}

/// One OSC message of float args.
fn osc(addr: &str, args: &[f32]) -> Vec<u8> {
    let mut v = osc_str(addr);
    v.extend(osc_str(&format!(",{}", "f".repeat(args.len()))));
    for a in args {
        v.extend_from_slice(&a.to_be_bytes());
    }
    v
}

/// ClientMessage{osc{packet}}, as the web page sends it.
fn osc_frame(packet: &[u8]) -> Vec<u8> {
    let mut d = pb::OscDatagram::default();
    d.r#packet = packet.try_into().expect("fits the host profile");
    encode(CMsg::Osc(d))
}

/// lm_osc_session_packet: Some(packet) for a ClientMessage.osc.
fn session_packet(frame: &[u8]) -> Option<Vec<u8>> {
    let mut p: *const u8 = std::ptr::null();
    let mut n = 0usize;
    let hit = unsafe { lm_osc_session_packet(frame.as_ptr(), frame.len(), &mut p, &mut n) };
    if !hit {
        return None;
    }
    if n == 0 {
        return Some(Vec::new());
    }
    // In place: the packet lies inside the frame.
    let (lo, hi) = (frame.as_ptr() as usize, frame.as_ptr() as usize + frame.len());
    assert!(p as usize >= lo && p as usize + n <= hi, "packet points into the frame");
    Some(unsafe { std::slice::from_raw_parts(p, n) }.to_vec())
}

// col = slots 0..2, k = slot 3.
const FX: &str = r#"uniform vec3 col : color = 0.0, 0.0, 0.0;
uniform float k : 0.0 .. 1.0 = 0.5;
void update() {}
vec3 shade(Led led) { return col * k; }"#;

#[test]
fn osc_over_the_session() {
    lm_player_init(1);
    submit("fx", FX);

    // -- recognition: only ClientMessage.osc, its packet read in place ---------
    let pkt = osc("/k", &[0.75]);
    let frame = osc_frame(&pkt);
    assert_eq!(frame[0..2], [0xf2, 0x06], "field 110, LEN");
    assert_eq!(session_packet(&frame).as_deref(), Some(&pkt[..]));
    let hello = encode(CMsg::Hello(pb::Hello::default()));
    assert_eq!(session_packet(&hello), None, "any other arm is not OSC");
    let su = encode(CMsg::SetUniforms(pb::SetUniforms::default()));
    assert_eq!(session_packet(&su), None);
    // An osc arm whose body isn't an OscDatagram: taken (dropped), empty packet.
    assert_eq!(session_packet(&[0xf2, 0x06, 0x02, 0x0a, 0x05]).as_deref(), Some(&[][..]));
    // An empty OscDatagram: taken, empty.
    assert_eq!(session_packet(&[0xf2, 0x06, 0x00]).as_deref(), Some(&[][..]));

    // -- the packet drives the uniforms through the udp/9000 mailbox -----------
    let bytes = lm_osc_mailbox_bytes();
    let mem: &'static mut [u32] = Box::leak(vec![0u32; bytes.div_ceil(4)].into_boxed_slice());
    assert!(unsafe { lm_osc_mailbox_bind(mem.as_mut_ptr() as *mut u8) });
    let p = session_packet(&frame).unwrap();
    assert_eq!(unsafe { lm_osc_post(p.as_ptr(), p.len()) }, 1, "one message stashed");
    assert_eq!(uniform(3), vec![0.5], "not applied before the frame boundary");
    assert_eq!(unsafe { lm_osc_drain() }, 1);
    assert_eq!(uniform(3), vec![0.75], "/k by name, as from udp/9000");
    // A bundle-free multi-float message by name too.
    let p = session_packet(&osc_frame(&osc("/col", &[0.1, 0.2, 0.3]))).unwrap();
    unsafe {
        lm_osc_post(p.as_ptr(), p.len());
        lm_osc_drain();
    }
    assert_eq!(uniform(0), vec![0.1, 0.2, 0.3]);

    // -- a ClientMessage.osc that reaches the player core anyway ---------------
    // (the firmware takes it in lm_ws_dispatch; any other path still applies it)
    assert!(handle_frame(&osc_frame(&osc("/k", &[0.25]))).is_none(), "fire-and-forget: no reply");
    assert_eq!(uniform(3), vec![0.25]);

    // -- a module's reply as ServerMessage.osc ---------------------------------
    let pose = osc("/lh/pose", &[1.0, 0.1, 0.2, 0.3, 1.0, 0.0, 0.0, 0.0]);
    let mut out = vec![0u8; 2048];
    let n = unsafe { lm_osc_build_push(pose.as_ptr(), pose.len(), out.as_mut_ptr(), out.len()) };
    assert!(n > 0);
    let mut reply = pb::ServerMessage::default();
    reply.decode_from_bytes(&out[..n as usize]).expect("push decodes");
    match reply.r#msg {
        Some(SMsg::Osc(d)) => assert_eq!(&d.r#packet[..], &pose[..]),
        other => panic!("expected osc, got {other:?}"),
    }
    // A full-MTU datagram fits the documented push bound (osc_route.h kPushMax).
    let big = vec![b'/'; 1472];
    let n = unsafe { lm_osc_build_push(big.as_ptr(), big.len(), out.as_mut_ptr(), 1472 + 8) };
    assert!(n > 0 && n as usize <= 1472 + 8, "kPushMax holds a 1472 B packet ({n})");
    // Too small a buffer: refused, nothing half-written is claimed.
    assert_eq!(unsafe { lm_osc_build_push(pose.as_ptr(), pose.len(), out.as_mut_ptr(), 8) }, -2);
    assert_eq!(SMSG_OSC, 60);
    assert_eq!(ARM_OSC, 110);

    // -- advertised; a locked kiosk lets it through like set_uniforms ----------
    let Some(SMsg::Welcome(w)) = handle(CMsg::Hello(pb::Hello::default())) else {
        panic!("expected welcome");
    };
    assert!(w.r#features.iter().any(|f| f.as_str() == "osc"), "welcome.features has osc");
    assert_eq!(classify(ARM_OSC, &frame), Class::Play);
}
