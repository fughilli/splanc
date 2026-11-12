//! The hand-coded Ethernet codec (src/wire.rs) against the generated host
//! bindings of ledmapper.proto: every field number and wire type, both
//! directions. If someone renumbers an Ethernet arm or field in the .proto,
//! this fails instead of the P4.

use ledmapper_pb::ledmapper_::v1_ as pb;
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;
use splanc_netout::config::{Clock, EthConfig, IpMode, NetOutput, Phy, NET_CHANNELS};
use splanc_netout::wire::{self, Controller, LinkStatus, Request};

fn encode(msg: CMsg) -> Vec<u8> {
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 16384>::new());
    env.encode(&mut enc).unwrap();
    enc.into_writer().to_vec()
}

fn decode_server(b: &[u8]) -> SMsg {
    let mut m = pb::ServerMessage::default();
    m.decode_from_bytes(b)
        .expect("decodes with the generated bindings");
    m.r#msg.expect("an arm")
}

fn ip(a: u8, b: u8, c: u8, d: u8) -> u32 {
    u32::from_be_bytes([a, b, c, d])
}

fn pb_config(c: &EthConfig) -> pb::EthernetConfig {
    let mut p = pb::EthernetConfig::default();
    p.r#enabled = c.enabled;
    p.r#phy.push_str(c.phy.id()).unwrap();
    p.r#phy_addr = c.phy_addr as i32;
    p.r#mdc_gpio = c.mdc as i32;
    p.r#mdio_gpio = c.mdio as i32;
    p.r#phy_reset_gpio = c.reset as i32;
    p.r#clock = pb::RmiiClock(c.clock as i32);
    p.r#clock_gpio = c.clock_gpio as i32;
    p.r#ip_mode = pb::IpMode(c.ip_mode as i32);
    p.r#ip = c.ip;
    p.r#netmask = c.netmask;
    p.r#gateway = c.gateway;
    p
}

fn sample_config() -> EthConfig {
    EthConfig {
        enabled: true,
        phy: Phy::Lan8720,
        phy_addr: -1,
        mdc: 23,
        mdio: 18,
        reset: -1,
        clock: Clock::Out,
        clock_gpio: 32,
        ip_mode: IpMode::Static,
        ip: ip(10, 1, 2, 3),
        netmask: 0xFFFF_0000,
        gateway: ip(10, 1, 0, 1),
    }
}

#[test]
fn set_ethernet_config_decodes() {
    let cfg = sample_config();
    let mut m = pb::SetEthernetConfig::default();
    m.set_config(pb_config(&cfg));
    let f = encode(CMsg::SetEthernetConfig(m.clone()));
    assert_eq!(
        wire::decode_client(&f),
        Ok(Request::SetEthernetConfig {
            config: cfg,
            commit: true
        })
    );
    m.set_commit(false);
    let f = encode(CMsg::SetEthernetConfig(m));
    assert_eq!(
        wire::decode_client(&f),
        Ok(Request::SetEthernetConfig {
            config: cfg,
            commit: false
        })
    );
}

#[test]
fn config_zeros_and_negatives_survive() {
    // proto3 drops zero scalars: GPIO 0 and DHCP client must still read back.
    let cfg = EthConfig {
        mdc: 0,
        mdio: 1,
        reset: -1,
        phy_addr: 0,
        ip_mode: IpMode::DhcpClient,
        ..sample_config()
    };
    let mut m = pb::SetEthernetConfig::default();
    m.set_config(pb_config(&cfg));
    let f = encode(CMsg::SetEthernetConfig(m));
    assert_eq!(
        wire::decode_client(&f),
        Ok(Request::SetEthernetConfig {
            config: cfg,
            commit: true
        })
    );
}

#[test]
fn bad_configs_are_refused_not_ignored() {
    let mut p = pb_config(&sample_config());
    p.r#phy.clear();
    p.r#phy.push_str("w5500").unwrap();
    let mut m = pb::SetEthernetConfig::default();
    m.set_config(p);
    assert_eq!(
        wire::decode_client(&encode(CMsg::SetEthernetConfig(m))),
        Ok(Request::Refused("bad_phy"))
    );

    let mut p = pb_config(&sample_config());
    p.r#mdc_gpio = 300;
    let mut m = pb::SetEthernetConfig::default();
    m.set_config(p);
    assert_eq!(
        wire::decode_client(&encode(CMsg::SetEthernetConfig(m))),
        Ok(Request::Refused("bad_pin"))
    );

    // No config at all.
    let m = pb::SetEthernetConfig::default();
    assert_eq!(
        wire::decode_client(&encode(CMsg::SetEthernetConfig(m))),
        Ok(Request::Refused("bad_message"))
    );
}

#[test]
fn other_requests_decode() {
    let f = encode(CMsg::GetEthernetState(pb::GetEthernetState::default()));
    assert_eq!(wire::decode_client(&f), Ok(Request::GetEthernetState));

    let mut d = pb::DiscoverControllers::default();
    let f = encode(CMsg::DiscoverControllers(d.clone()));
    assert_eq!(
        wire::decode_client(&f),
        Ok(Request::DiscoverControllers { timeout_ms: 600 })
    );
    d.r#timeout_ms = 200;
    let f = encode(CMsg::DiscoverControllers(d.clone()));
    assert_eq!(
        wire::decode_client(&f),
        Ok(Request::DiscoverControllers { timeout_ms: 200 })
    );
    d.r#timeout_ms = 5000;
    let f = encode(CMsg::DiscoverControllers(d));
    assert_eq!(
        wire::decode_client(&f),
        Ok(Request::DiscoverControllers { timeout_ms: 800 })
    );

    let mut o = pb::NetworkOutput::default();
    o.r#channel = 3;
    o.r#ip = ip(192, 168, 50, 107);
    o.r#port = 4049;
    o.r#name.push_str("DISTIRA").unwrap();
    let mut s = pb::SetNetworkOutput::default();
    s.set_output(o);
    s.set_commit(false);
    let f = encode(CMsg::SetNetworkOutput(s));
    assert_eq!(
        wire::decode_client(&f),
        Ok(Request::SetNetworkOutput {
            channel: 3,
            output: NetOutput::new(ip(192, 168, 50, 107), 4049, b"DISTIRA"),
            commit: false
        })
    );

    // Not ours.
    let f = encode(CMsg::GetHardwareConfig(pb::GetHardwareConfig::default()));
    assert_eq!(wire::decode_client(&f), Ok(Request::Other(34)));
}

#[test]
fn ethernet_state_encodes() {
    let cfg = sample_config();
    let mut outputs = [NetOutput::default(); NET_CHANNELS];
    outputs[0] = NetOutput::new(ip(192, 168, 50, 107), 0, b"DISTIRA");
    outputs[4] = NetOutput::new(ip(192, 168, 50, 108), 4049, b"desk");
    let st = LinkStatus {
        link_up: true,
        speed_mbps: 100,
        full_duplex: true,
        ip: ip(10, 1, 2, 3),
        netmask: 0xFFFF_0000,
        gateway: ip(10, 1, 0, 1),
        mac: [1, 2, 3, 4, 5, 6],
        tx_frames: 12345,
        tx_errors: 2,
    };
    let mut buf = [0u8; 2048];
    let n = wire::encode_ethernet_state(&cfg, &outputs, &st, "phy_not_found", &mut buf).unwrap();
    let SMsg::EthernetState(s) = decode_server(&buf[..n]) else {
        panic!("not ethernet_state")
    };
    assert_eq!(s.r#config(), Some(&pb_config(&cfg)));
    assert_eq!(s.r#outputs.len(), 2);
    assert_eq!(s.r#outputs[0].r#channel, 2);
    assert_eq!(s.r#outputs[0].r#ip, ip(192, 168, 50, 107));
    assert_eq!(s.r#outputs[0].r#port, 0);
    assert_eq!(s.r#outputs[0].r#name.as_str(), "DISTIRA");
    assert_eq!(s.r#outputs[1].r#channel, 6);
    assert_eq!(s.r#outputs[1].r#port, 4049);
    assert!(s.r#link_up && s.r#full_duplex);
    assert_eq!(s.r#speed_mbps, 100);
    assert_eq!(s.r#ip, ip(10, 1, 2, 3));
    assert_eq!(s.r#netmask, 0xFFFF_0000);
    assert_eq!(s.r#gateway, ip(10, 1, 0, 1));
    assert_eq!(&s.r#mac[..], &[1, 2, 3, 4, 5, 6]);
    assert_eq!(s.r#error.as_str(), "phy_not_found");
    assert_eq!((s.r#tx_frames, s.r#tx_errors), (12345, 2));
}

#[test]
fn empty_ethernet_state_still_has_its_arm() {
    let cfg = EthConfig::default();
    let mut buf = [0u8; 256];
    let n = wire::encode_ethernet_state(&cfg, &[], &LinkStatus::default(), "", &mut buf).unwrap();
    let SMsg::EthernetState(s) = decode_server(&buf[..n]) else {
        panic!("not ethernet_state")
    };
    assert_eq!(s.r#config().unwrap().r#phy.as_str(), "ip101");
    assert!(!s.r#link_up);
    // Too small a buffer is an error, not a truncated frame.
    assert!(
        wire::encode_ethernet_state(&cfg, &[], &LinkStatus::default(), "", &mut buf[..8]).is_err()
    );
}

#[test]
fn controller_list_encodes() {
    let long = [b'x'; 40];
    let list = [
        Controller {
            name: b"DISTIRA",
            ip: ip(192, 168, 50, 107),
            mac: [0xc0, 0xcd, 0xd6, 0xe9, 0xfb, 0x14],
            led_count: 1680,
            version: b"16.0.1",
            kind: b"wled",
        },
        Controller {
            name: &long,
            ip: ip(192, 168, 50, 9),
            mac: [0; 6],
            led_count: 0,
            version: b"",
            kind: b"wled",
        },
    ];
    let mut buf = [0u8; 2048];
    let n = wire::encode_controller_list(&list, "", &mut buf).unwrap();
    let SMsg::ControllerList(l) = decode_server(&buf[..n]) else {
        panic!("not controller_list")
    };
    assert_eq!(l.r#controllers.len(), 2);
    let c = &l.r#controllers[0];
    assert_eq!(c.r#name.as_str(), "DISTIRA");
    assert_eq!(c.r#ip, ip(192, 168, 50, 107));
    assert_eq!(&c.r#mac[..], &[0xc0, 0xcd, 0xd6, 0xe9, 0xfb, 0x14]);
    assert_eq!(c.r#led_count, 1680);
    assert_eq!(c.r#version.as_str(), "16.0.1");
    assert_eq!(c.r#kind.as_str(), "wled");
    assert_eq!(
        l.r#controllers[1].r#name.len(),
        32,
        "cut to the bindings' capacity"
    );
    assert!(l.r#controllers[1].r#mac.is_empty());

    let n = wire::encode_controller_list(&[], "no_link", &mut buf).unwrap();
    let SMsg::ControllerList(l) = decode_server(&buf[..n]) else {
        panic!("not controller_list")
    };
    assert!(l.r#controllers.is_empty());
    assert_eq!(l.r#error.as_str(), "no_link");
}

#[test]
fn arm_numbers_match_the_proto() {
    // The generated oneof tags, read back from an encoded envelope's first key.
    // Arms 95-98 have two-byte keys.
    let key = |f: Vec<u8>| ((f[0] as u32 & 0x7f) | ((f[1] as u32 & 0x7f) << 7)) >> 3;
    assert_eq!(
        key(encode(CMsg::SetEthernetConfig(Default::default()))),
        wire::CM_SET_ETHERNET_CONFIG
    );
    assert_eq!(
        key(encode(CMsg::GetEthernetState(Default::default()))),
        wire::CM_GET_ETHERNET_STATE
    );
    assert_eq!(
        key(encode(CMsg::DiscoverControllers(Default::default()))),
        wire::CM_DISCOVER_CONTROLLERS
    );
    assert_eq!(
        key(encode(CMsg::SetNetworkOutput(Default::default()))),
        wire::CM_SET_NETWORK_OUTPUT
    );
}

#[test]
fn artnet_outputs_round_trip() {
    use splanc_netout::config::Protocol;
    let mut o = pb::NetworkOutput::default();
    o.r#channel = 4;
    o.r#protocol = pb::NetProtocol(1);
    o.r#ip = ip(192, 168, 50, 9);
    o.r#universe = 3;
    o.r#sync = true;
    let mut s = pb::SetNetworkOutput::default();
    s.set_output(o);
    let f = encode(CMsg::SetNetworkOutput(s));
    let Ok(Request::SetNetworkOutput {
        channel, output, ..
    }) = wire::decode_client(&f)
    else {
        panic!("decodes")
    };
    assert_eq!(channel, 4);
    assert_eq!(output.protocol, Protocol::ArtNet);
    assert_eq!((output.universe, output.sync), (3, true));

    // An unknown protocol is refused, not taken as DDP.
    let mut o = pb::NetworkOutput::default();
    o.r#channel = 4;
    o.r#protocol = pb::NetProtocol(7);
    let mut s = pb::SetNetworkOutput::default();
    s.set_output(o);
    assert_eq!(
        wire::decode_client(&encode(CMsg::SetNetworkOutput(s))),
        Ok(Request::Refused("bad_message"))
    );

    // And it comes back in ethernet_state.
    let mut outputs = [NetOutput::default(); NET_CHANNELS];
    outputs[2] = output;
    let mut buf = [0u8; 1024];
    let n = wire::encode_ethernet_state(
        &EthConfig::default(),
        &outputs,
        &LinkStatus::default(),
        "",
        &mut buf,
    )
    .unwrap();
    let SMsg::EthernetState(st) = decode_server(&buf[..n]) else {
        panic!("ethernet_state")
    };
    let back = &st.r#outputs[0];
    assert_eq!(
        (
            back.r#channel,
            back.r#protocol.0,
            back.r#universe,
            back.r#sync
        ),
        (4, 1, 3, true)
    );
}
