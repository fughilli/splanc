//! CLI: bridge OSC (UDP) onto a `ledmapper.v1` fixture's live uniforms.
//!
//!   osc_bridge --addr 192.168.1.50:81 --listen 0.0.0.0:9000
//!   osc_bridge --addr ledmapper.local:81 --effect my_fx --prefix /uniform/ -v
//!
//! Point any OSC source at `--listen`; each message's address selects a uniform
//! channel on the device's active effect (see `address_to_channel`) and its
//! first numeric argument sets the value. Runs until interrupted.
//!
//! Exit codes: 2 on a usage/socket-bind error; otherwise it runs indefinitely.

use std::net::UdpSocket;
use std::process::exit;
use std::time::Duration;

use ledmapper_osc_bridge::osc::parse_packet;
use ledmapper_osc_bridge::ChannelMap;
use td_ledmapper::client::{Config, Session};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let val = |k: &str| -> Option<String> {
        args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned()
    };
    let flag = |k: &str| args.iter().any(|a| a == k);

    if flag("--help") || flag("-h") {
        eprint!("{USAGE}");
        return;
    }

    let addr = match val("--addr") {
        Some(a) => a,
        None => {
            eprintln!("error: --addr host:port (the fixture) is required\n\n{USAGE}");
            exit(2);
        }
    };
    let listen = val("--listen").unwrap_or_else(|| "0.0.0.0:9000".into());
    let prefix = val("--prefix").unwrap_or_else(|| "/".into());
    let verbose = flag("--verbose") || flag("-v");

    let sock = match UdpSocket::bind(&listen) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: bind {listen}: {e}");
            exit(2);
        }
    };
    // Wake periodically even with no traffic so connection-status changes print.
    sock.set_read_timeout(Some(Duration::from_millis(500))).ok();

    let cfg = Config { addr: addr.clone(), effect_id: val("--effect"), ..Default::default() };
    let session = Session::start(cfg);

    eprintln!("[osc-bridge] listening for OSC on {listen}, driving {addr}");
    eprintln!("[osc-bridge] address prefix {prefix:?}  (e.g. {prefix}speed, {prefix}tint/x)");

    let mut map = ChannelMap::new();
    let mut last_connected = false;
    let mut buf = [0u8; 65_536];

    loop {
        report_status(&session, &mut last_connected);

        let n = match sock.recv_from(&mut buf) {
            Ok((n, _from)) => n,
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
            Err(e) => {
                eprintln!("[osc-bridge] recv error: {e}");
                continue;
            }
        };

        let Some(messages) = parse_packet(&buf[..n]) else {
            if verbose {
                eprintln!("[osc-bridge] dropped a non-OSC datagram ({n} bytes)");
            }
            continue;
        };

        let mut touched = false;
        for msg in &messages {
            if let Some((chan, v)) = map.apply(msg, &prefix) {
                touched = true;
                if verbose {
                    eprintln!("[osc-bridge] {} -> {chan} = {v}", msg.addr);
                }
            }
        }
        // One coalesced push per datagram; the session change-detects and only
        // transmits when the resulting uniform values actually differ.
        if touched {
            session.drive_uniforms(map.snapshot());
        }
    }
}

/// Print a one-line notice whenever the fixture connection flips up/down.
fn report_status(session: &Session, last_connected: &mut bool) {
    let st = session.status();
    if st.connected != *last_connected {
        *last_connected = st.connected;
        if st.connected {
            let ports = session.ports();
            let names: Vec<String> = ports.iter().flat_map(|p| p.channel_names()).collect();
            eprintln!(
                "[osc-bridge] connected to {} ({}) — {} uniform channel(s): {}",
                if st.name.is_empty() { "fixture" } else { &st.name },
                st.mac,
                names.len(),
                summarize(&names),
            );
        } else {
            let why = if st.error.is_empty() { "disconnected".into() } else { st.error.clone() };
            eprintln!("[osc-bridge] {why}");
        }
    }
}

fn summarize(names: &[String]) -> String {
    if names.is_empty() {
        return "(no manifest — use /slotN)".into();
    }
    names.join(", ")
}

const USAGE: &str = "\
osc_bridge — drive ledmapper.v1 fixture uniforms from OSC

USAGE:
    osc_bridge --addr <host:port> [--listen <ip:port>] [--prefix <p>]
               [--effect <id>] [-v|--verbose]

OPTIONS:
    --addr <host:port>   Fixture WebSocket endpoint (protocol port, e.g. :81). Required.
    --listen <ip:port>   UDP endpoint to receive OSC on. Default 0.0.0.0:9000.
    --prefix <p>         OSC address prefix to strip. Default \"/\".
                         '/tint/x' -> channel 'tint:x'; with --prefix /uniform/,
                         '/uniform/tint/x' -> 'tint:x'.
    --effect <id>        Activate this effect on the fixture before driving it.
    -v, --verbose        Log every applied OSC message and dropped datagram.
";
