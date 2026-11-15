//! `player_host` — the Splanc player on a desktop host (macOS or Linux), driving
//! LEDs through network controllers instead of a Pi's SPI bus.
//!
//! The same player as `//pi/player_rs:player` — the shared session core behind
//! the WSS server, so the app maps and controls it like any fixture — with two
//! host pieces: the effects layer (`fx.rs`, the device's fx_vm) and swappable
//! output drivers (`output.rs`: DDP, Art-Net, null). The controllers are treated
//! as dumb pixel sinks (e.g. WLED in realtime mode); every mapping pattern and
//! effect frame is computed here.
//!
//! ```text
//! player_host --output ddp://wled-desk.local --leds 300 --name "Desk"
//! player_host --output artnet://10.0.0.40?universe=1 --output ddp://10.0.0.41#150 --leds 450
//! ```
//!
//! Flags:
//!   --output SPEC     a driver (repeatable; see output.rs). Default: null.
//!   --leds N          strip length. Default: the outputs' `#N` counts summed.
//!   --fps F           output frame rate (default 40).
//!   --name NAME       the device name the app shows (default "Splanc Host").
//!   --serve-port P    WSS port (default 8443).
//!   --state-dir DIR   where the map + effect persist ("" = memory only).
//!   --start N         self-drive an N-LED mapping pattern at boot (bring-up).

use ledmapper_player::{color_order_index, Player};
use ledmapper_player_rs::fx::{self, HostFx};
use ledmapper_player_rs::output::{self, Outputs};
use ledmapper_player_rs::render::render_colors;
use ledmapper_player_rs::server::{self, SharedPlayer};
use ledmapper_player_rs::session;
use ledmapper_player_rs::wire::to_wire;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Stack for every thread that runs `Player::handle` (see main.rs: the host
/// protobuf profile's handler frame alone is ~8 MiB).
const HANDLER_STACK: usize = 32 * 1024 * 1024;

fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    std::thread::Builder::new()
        .name("main".into())
        .stack_size(HANDLER_STACK)
        .spawn(real_main)?
        .join()
        .map_err(|_| "player main thread panicked")?
}

fn usage(msg: &str) -> ! {
    eprintln!("player_host: {msg}");
    eprintln!(
        "usage: player_host --output ddp://HOST[:PORT][#N] | artnet://HOST[:PORT][?universe=U&sync=1][#N] | null \
         [--output ...] [--leds N] [--fps F] [--name NAME] [--serve-port P] [--state-dir DIR] [--start N]"
    );
    std::process::exit(2);
}

fn default_state_dir(port: u16) -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    let base = if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Splanc/player_host")
    } else {
        home.join(".local/state/splanc/player_host")
    };
    Some(base.join(port.to_string()))
}

/// A stable, locally administered MAC-like id from the device name, for the
/// welcome's `mac` (the app de-duplicates devices on it).
fn pseudo_mac(name: &str, port: u16) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in name.bytes().chain(port.to_le_bytes()) {
        h = (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3);
    }
    let b = h.to_be_bytes();
    format!("02:{:02X}:{:02X}:{:02X}:{:02X}:{:02X}", b[0], b[1], b[2], b[3], b[4])
}

fn real_main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut specs = Vec::new();
    let mut flags = std::collections::HashMap::new();
    let mut it = argv.iter();
    while let Some(a) = it.next() {
        let Some(v) = it.next() else { usage(&format!("{a} needs a value")) };
        match a.as_str() {
            "--output" => specs.push(output::parse_spec(v).unwrap_or_else(|e| usage(&e))),
            "--leds" | "--fps" | "--name" | "--serve-port" | "--state-dir" | "--start" => {
                flags.insert(a.as_str(), v.clone());
            }
            _ => usage(&format!("unknown flag {a}")),
        }
    }
    let num = |k: &str, def: &str| -> f64 {
        let v = flags.get(k).map_or(def, String::as_str);
        v.parse().unwrap_or_else(|_| usage(&format!("{k}: not a number: {v}")))
    };
    if specs.is_empty() {
        specs.push((output::Spec::Null, None));
    }
    let counted: usize = specs.iter().filter_map(|(_, n)| *n).sum();
    let leds = match flags.get("--leds") {
        Some(_) => num("--leds", "0") as usize,
        None => counted,
    };
    if leds == 0 {
        usage("give --leds N (or a #N pixel count on each --output)");
    }
    let fps = num("--fps", "40").clamp(1.0, 240.0);
    let port = num("--serve-port", "8443") as u16;
    let start_leds = num("--start", "0") as u32;
    let name = flags.get("--name").cloned().unwrap_or_else(|| "Splanc Host".into());
    let state_dir = match flags.get("--state-dir") {
        Some(d) if d.is_empty() => None,
        Some(d) => Some(PathBuf::from(d)),
        None => default_state_dir(port),
    };

    let ranges = output::layout(&specs.iter().map(|(_, n)| *n).collect::<Vec<_>>(), leds);
    let mut outs = Vec::new();
    for ((spec, _), r) in specs.iter().zip(ranges) {
        outs.push((output::open(spec)?, r));
    }
    let mut outputs = Outputs::new(outs);
    for d in outputs.describe() {
        eprintln!("player_host: output {d}");
    }

    let epoch = Instant::now();
    let mut core = Player::new("host-player-0001", leds as u32);
    core.set_identity(&pseudo_mac(&name, port), &name);
    core.set_features(fx::FEATURES, u32::from(ledmapper_fx_vm::FORMAT_VERSION));
    // One logical channel carrying the whole strip; the controllers do their
    // own colour order, so the default here is RGB (pass-through).
    core.set_output_caps(1, leds.max(8192) as u32);
    core.seed_led_count(0, leds as u32);
    core.set_hw_defaults(0, -1, color_order_index("RGB").unwrap_or(0));
    let player: SharedPlayer = Arc::new(Mutex::new(core));

    let fx = Arc::new(Mutex::new(HostFx::new(state_dir.clone())));
    fx.lock().unwrap().restore(&mut player.lock().unwrap());
    let _ = server::HOST_FX.set(fx.clone());
    match &state_dir {
        Some(d) => eprintln!("player_host: state in {}", d.display()),
        None => eprintln!("player_host: no state dir; map + effect are memory-only"),
    }

    if start_leds > 0 {
        session::start_mapping(&mut player.lock().unwrap(), start_leds, 1000.0 / fps, 1.0, 0)
            .ok_or("core rejected start_mapping")?;
    }

    // Render on its own OS thread, paced to absolute deadlines. The player lock
    // is held only to compute the mapping/counting frame; the effects lock only
    // to shade (never both: see fx.rs).
    {
        let player = player.clone();
        let period = Duration::from_secs_f64(1.0 / fps);
        std::thread::Builder::new()
            .name("render".into())
            .stack_size(4 * 1024 * 1024)
            .spawn(move || {
                eprintln!("player_host: rendering {leds} LEDs @ {fps} fps");
                let mut next = Instant::now();
                let mut err_logged = false;
                loop {
                    let now = epoch.elapsed();
                    let now_us = now.as_micros() as i64;
                    let (pattern, n, order, brightness) = {
                        let mut p = player.lock().unwrap();
                        let pattern = render_colors(&p, now_us);
                        if let Some((_, Some(seq))) = &pattern {
                            p.record_frame_shown(*seq, now_us as u32);
                        }
                        let n = p.led_count(0).map_or(leds, |c| c as usize).min(leds);
                        (pattern, n, p.hw_color_order_perm(0), p.output_brightness())
                    };
                    let frame = match pattern {
                        Some((px, _)) => px,
                        None => match fx.lock().unwrap().render(now.as_secs_f64(), n, brightness) {
                            Some(px) => px.into_iter().map(|c| to_wire(c, order)).collect(),
                            None => Vec::new(), // idle: dark
                        },
                    };
                    match outputs.send(&frame) {
                        Ok(()) => err_logged = false,
                        Err(e) if !err_logged => {
                            err_logged = true;
                            eprintln!("player_host: output send failed ({e}); retrying each frame");
                        }
                        Err(_) => {}
                    }
                    next += period;
                    let now = Instant::now();
                    if next > now {
                        std::thread::sleep(next - now);
                    } else {
                        next = now; // fell behind: don't burst to catch up
                    }
                }
            })?;
    }

    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    let config = server::self_signed_config()?;
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_stack_size(HANDLER_STACK)
        .build()?;
    eprintln!("player_host: \"{name}\" — add it in the app at wss://<this host>:{port}");
    rt.block_on(server::serve(player, addr, config, epoch))?;
    Ok(())
}
