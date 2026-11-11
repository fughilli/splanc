//! Config validation, the flash blob and DDP packets.

use splanc_netout::config::{
    net_index, netmask_ok, Clock, EthConfig, IpMode, NetOutput, NetSettings, Phy, Refusal, BLOB_LEN,
    NET_CHANNELS,
};
use splanc_netout::ddp;

fn ip(a: u8, b: u8, c: u8, d: u8) -> u32 {
    u32::from_be_bytes([a, b, c, d])
}

#[test]
fn default_config_is_valid_and_off() {
    let c = EthConfig::default();
    assert!(!c.enabled);
    assert_eq!(c.validate(&[]), Ok(()));
    assert_eq!(c.ip, ip(192, 168, 50, 1));
}

#[test]
fn pins_are_checked() {
    let mut c = EthConfig { enabled: true, ..Default::default() };
    assert_eq!(c.validate(&[]), Ok(()));
    // MDC on an RMII data pin.
    c.mdc = 34;
    assert_eq!(c.validate(&[]), Err(Refusal::BadPin));
    c.mdc = 31;
    // MDC == MDIO.
    c.mdio = 31;
    assert_eq!(c.validate(&[]), Err(Refusal::BadPin));
    c.mdio = 52;
    // Out of range.
    c.reset = 55;
    assert_eq!(c.validate(&[]), Err(Refusal::BadPin));
    c.reset = -1;
    assert_eq!(c.validate(&[]), Ok(()));
    // Clock out needs a real pin that nothing else uses.
    c.clock = Clock::Out;
    c.clock_gpio = -1;
    assert_eq!(c.validate(&[]), Err(Refusal::BadPin));
    c.clock_gpio = 31;
    assert_eq!(c.validate(&[]), Err(Refusal::BadPin));
    c.clock_gpio = 32;
    assert_eq!(c.validate(&[]), Ok(()));
}

#[test]
fn led_pins_block_an_enabled_config_only() {
    // GPIO 28 is an RMII pin and a recommended LED pin on the Waveshare P4-WIFI6.
    let mut c = EthConfig::default();
    assert_eq!(c.validate(&[28, 20]), Ok(()), "disabled: stored as is");
    c.enabled = true;
    assert_eq!(c.validate(&[28, 20]), Err(Refusal::PinInUse));
    assert_eq!(c.validate(&[20, 21]), Ok(()));
    // MDC / MDIO / reset count too.
    assert_eq!(c.validate(&[31]), Err(Refusal::PinInUse));
    assert_eq!(c.validate(&[51]), Err(Refusal::PinInUse));
}

#[test]
fn addresses_are_checked() {
    assert!(netmask_ok(0xFFFF_FF00));
    assert!(netmask_ok(0xFFFF_FFFC));
    assert!(!netmask_ok(0));
    assert!(!netmask_ok(0xFF00_FF00));

    let mut c = EthConfig { ip_mode: IpMode::Static, ..Default::default() };
    assert_eq!(c.validate(&[]), Ok(()));
    for bad in [ip(192, 168, 50, 0), ip(192, 168, 50, 255), ip(127, 0, 0, 1), ip(224, 0, 0, 1), 0] {
        c.ip = bad;
        assert_eq!(c.validate(&[]), Err(Refusal::BadAddress), "{bad:08x}");
    }
    c.ip = ip(10, 0, 0, 2);
    c.netmask = 0xFF00_0000;
    c.gateway = ip(10, 0, 0, 1);
    assert_eq!(c.validate(&[]), Ok(()));
    c.gateway = ip(192, 168, 1, 1);
    assert_eq!(c.validate(&[]), Err(Refusal::BadAddress), "gateway off the subnet");
    c.netmask = 0x00FF_FFFF;
    assert_eq!(c.validate(&[]), Err(Refusal::BadAddress));
    // DHCP client ignores the static fields.
    c.ip_mode = IpMode::DhcpClient;
    assert_eq!(c.validate(&[]), Ok(()));
}

#[test]
fn outputs() {
    assert_eq!(net_index(1), None);
    assert_eq!(net_index(2), Some(0));
    assert_eq!(net_index(7), Some(5));
    assert_eq!(net_index(8), None);
    assert_eq!(net_index(-1), None);

    let o = NetOutput::new(ip(192, 168, 50, 107), 0, b"DISTIRA");
    assert!(o.active());
    assert_eq!(o.port_or_default(), 4048);
    assert_eq!(o.name(), b"DISTIRA");
    assert_eq!(o.validate(), Ok(()));
    assert_eq!(NetOutput::new(ip(239, 0, 0, 1), 0, b"").validate(), Err(Refusal::BadAddress));
    assert_eq!(NetOutput::new(ip(192, 168, 50, 255), 0, b"").validate(), Ok(()), "broadcast is allowed");
    assert_eq!(NetOutput::default().validate(), Ok(()), "clearing");
    // Names are cut to 32 bytes at a character boundary.
    let long = "é".repeat(20); // 40 bytes
    let o = NetOutput::new(1, 0, long.as_bytes());
    assert_eq!(o.name().len(), 32);
    assert!(core::str::from_utf8(o.name()).is_ok());
}

#[test]
fn blob_round_trips() {
    let mut s = NetSettings::default();
    s.eth = EthConfig {
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
    };
    s.outputs[0] = NetOutput::new(ip(192, 168, 50, 107), 0, b"DISTIRA");
    s.outputs[5] = NetOutput::new(ip(192, 168, 50, 108), 4049, b"desk");
    let mut b = [0u8; BLOB_LEN];
    s.to_blob(&mut b);
    assert_eq!(NetSettings::from_blob(&b), Some(s));
}

#[test]
fn bad_blobs_keep_the_defaults() {
    let mut b = [0u8; BLOB_LEN];
    NetSettings::default().to_blob(&mut b);
    assert!(NetSettings::from_blob(&b[..BLOB_LEN - 1]).is_none(), "short");
    let mut v = b;
    v[0] = 99;
    assert!(NetSettings::from_blob(&v).is_none(), "unknown version");
    let mut p = b;
    p[2 + 1] = 0; // phy 0
    assert!(NetSettings::from_blob(&p).is_none(), "unknown phy");
    let mut m = b;
    m[2 + 3] = m[2 + 4]; // MDC == MDIO
    assert!(NetSettings::from_blob(&m).is_none(), "invalid config");
    // A bad output is dropped, the rest kept.
    let mut s = NetSettings::default();
    s.outputs[1] = NetOutput::new(ip(192, 168, 50, 9), 0, b"ok");
    s.to_blob(&mut b);
    let at = 2 + 22; // output 0
    b[at..at + 4].copy_from_slice(&ip(127, 0, 0, 1).to_be_bytes());
    let r = NetSettings::from_blob(&b).unwrap();
    assert!(!r.outputs[0].active());
    assert_eq!(r.outputs[1].name(), b"ok");
    assert_eq!(r.outputs.len(), NET_CHANNELS);
}

#[test]
fn ddp_matches_the_host_player() {
    // 1680 LEDs, the bench WLED board: 5040 bytes, 4 packets (3 x 1440 + 720).
    let data: Vec<u8> = (0..1680 * 3).map(|i| (i % 251) as u8).collect();
    assert_eq!(ddp::packet_count(data.len()), 4);
    assert_eq!(ddp::packet_count(0), 0);
    assert_eq!(ddp::packet_count(1440), 1);
    assert_eq!(ddp::packet_count(1441), 2);
    let mut out = [0u8; ddp::MAX_PACKET];
    let mut rebuilt = vec![0u8; data.len()];
    for i in 0..4 {
        let n = ddp::packet(&data, i, 7, &mut out).unwrap();
        let p = &out[..n];
        let last = i == 3;
        assert_eq!(p[0], 0x40 | if last { 0x01 } else { 0 }, "ver1, PUSH on the last");
        assert_eq!(p[1], 7);
        assert_eq!(p[2], 0x0B, "RGB8");
        assert_eq!(p[3], 0x01, "display");
        let off = u32::from_be_bytes([p[4], p[5], p[6], p[7]]) as usize;
        let len = u16::from_be_bytes([p[8], p[9]]) as usize;
        assert_eq!(off, i * 1440);
        assert_eq!(len, if last { 720 } else { 1440 });
        assert_eq!(n, 10 + len);
        rebuilt[off..off + len].copy_from_slice(&p[10..]);
    }
    assert_eq!(rebuilt, data);
    assert_eq!(ddp::packet(&data, 4, 7, &mut out), None, "past the frame");
    assert_eq!(ddp::packet(&data, 0, 7, &mut out[..100]), None, "short buffer");
}

#[test]
fn ddp_sequence_skips_zero() {
    let mut s = 0u8;
    let mut seen = vec![];
    for _ in 0..30 {
        s = ddp::next_seq(s);
        seen.push(s);
    }
    assert!(seen.iter().all(|&x| (1..=15).contains(&x)));
    assert_eq!(&seen[..16], &[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 1]);
}

#[test]
fn wled_info_parses() {
    use splanc_netout::wled::parse_info;
    // The shape of WLED 16's GET /json/info (hand-written from the bench board's
    // values: firmware/netout/testdata/wled_info.json).
    let json = include_bytes!("../testdata/wled_info.json");
    let i = parse_info(json).expect("a WLED reply");
    assert_eq!(i.name(), b"DISTIRA");
    assert_eq!(i.version(), b"16.0.1");
    assert_eq!(i.mac, [0xc0, 0xcd, 0xd6, 0xe9, 0xfb, 0x14]);
    assert_eq!(i.led_count, 1680);
}

#[test]
fn wled_info_takes_only_top_level_keys() {
    use splanc_netout::wled::parse_info;
    // A nested "name" / "count" must not win over the top-level ones.
    let j = br#"{"wifi":{"name":"nested","count":3},"leds":{"seg":{"count":9},"count":300},"name":"Desk \"A\"","ver":"0.15.0"}"#;
    let i = parse_info(j).unwrap();
    assert_eq!(i.name(), br#"Desk "A""#);
    assert_eq!(i.led_count, 300);
    assert_eq!(i.mac, [0; 6]);
}

#[test]
fn not_wled_is_none() {
    use splanc_netout::wled::parse_info;
    assert!(parse_info(b"").is_none());
    assert!(parse_info(b"<html>").is_none());
    assert!(parse_info(br#"{"name":"router"}"#).is_none(), "no leds.count");
    assert!(parse_info(br#"{"leds":{"count":5}"#).is_some(), "a truncated tail still has the count");
    assert!(parse_info(br#"{"name":"x"#).is_none(), "unterminated string");
    assert!(parse_info(br#"}}}"#).is_none());
}

#[test]
fn wled_long_names_cut_cleanly() {
    use splanc_netout::wled::parse_info;
    let name = "ü".repeat(20); // 40 bytes
    let j = format!(r#"{{"name":"{name}","leds":{{"count":1}}}}"#);
    let i = parse_info(j.as_bytes()).unwrap();
    assert_eq!(i.name().len(), 32);
    assert!(core::str::from_utf8(i.name()).is_ok());
    let j = format!(r#"{{"name":"a{name}","leds":{{"count":1}}}}"#); // odd split
    let i = parse_info(j.as_bytes()).unwrap();
    assert_eq!(i.name().len(), 31);
    assert!(core::str::from_utf8(i.name()).is_ok());
}
