//! fx_replay — the FX debugger's host replay as a command-line tool
//! (docs/design/fx-debugger.md). Restores a device snapshot onto the SAME VM the
//! firmware runs and replays one frame, so a script (the HITL gate
//! //pi/hitl/harness:fx_debug_netstack) can diff it against the device byte for
//! byte without a browser or node. One deck, no crossfade (the app / agent
//! replay in web/src/fx/fxDebug.ts covers both decks).
//!
//! Inputs, all in `--dir` (the get_fx_snapshot sections, raw):
//!   program.fxb       SECTION_PROGRAM
//!   uniforms.bin      SECTION_UNIFORMS (of the replayed frame)
//!   state.bin         SECTION_STATE (BEFORE the frame)
//!   arena.bin         SECTION_ARENA (BEFORE the frame)
//!   graph.bin         SECTION_GRAPH
//!   frame_ctx.bin     fx_debug.state.frame_ctx (FX_FRAME_V1, of the replayed frame)
//!   led_context.bin   SECTION_LED_CONTEXT (FX_LED_V1 records, LED 0 first)
//!   lut.bin           SECTION_LUT (optional; absent / empty = none)
//! Outputs, written to the same dir:
//!   raw.bin           per LED, the effect's RGB (3 B)
//!   output.bin        per LED, through the LUT + `--brightness` (main.cpp cc_apply)
//!   state_out.bin     the state after the frame (SECTION_STATE layout)
//!   arena_out.bin     the buffers after the frame
//!   led<N>.bin        for each `--led N`: the debug_fx_led re-run (isolated, zeroed
//!                     scratch) as rgb (3 B) + MAX_LOCALS f32 locals
//!
//! Usage: fx_replay --dir DIR [--brightness 0..255] [--budget N] [--led N]...

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use ledmapper_fx_vm::{dbg, Budget, Program, Vm, DEFAULT_BUDGET, MAX_LOCALS, MAX_STATE};

fn read(dir: &Path, name: &str) -> Result<Vec<u8>, String> {
    fs::read(dir.join(name)).map_err(|e| format!("{name}: {e}"))
}

fn words(b: &[u8]) -> Vec<u32> {
    b.chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

/// main.cpp cc_apply: the LUT, then nscale8 unless 255.
fn output_stage(rgb: [u8; 3], lut: &[u8], brightness: u8) -> [u8; 3] {
    let mut c = rgb;
    if lut.len() >= 768 {
        for (k, v) in c.iter_mut().enumerate() {
            *v = lut[k * 256 + *v as usize];
        }
    }
    if brightness < 255 {
        for v in &mut c {
            *v = ((*v as u16 * brightness as u16) >> 8) as u8;
        }
    }
    c
}

fn run() -> Result<(), String> {
    let mut dir: Option<PathBuf> = None;
    let mut brightness: u8 = 255;
    let mut budget = DEFAULT_BUDGET;
    let mut leds: Vec<usize> = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let mut val = || args.next().ok_or(format!("{a} needs a value"));
        match a.as_str() {
            "--dir" => dir = Some(PathBuf::from(val()?)),
            "--brightness" => brightness = val()?.parse().map_err(|e| format!("--brightness: {e}"))?,
            "--budget" => budget = val()?.parse().map_err(|e| format!("--budget: {e}"))?,
            "--led" => leds.push(val()?.parse().map_err(|e| format!("--led: {e}"))?),
            _ => return Err(format!("unknown argument {a}")),
        }
    }
    let dir = dir.ok_or("--dir is required")?;
    let fxb = read(&dir, "program.fxb")?;
    let prog = Program::parse(&fxb).map_err(|e| format!("program.fxb: {e:?}"))?;
    let frame = dbg::frame_from_ctx(&read(&dir, "frame_ctx.bin")?).ok_or("frame_ctx.bin: too short")?;
    let ctx = read(&dir, "led_context.bin")?;
    let lut = read(&dir, "lut.bin").unwrap_or_default();
    let budget = Budget::instructions(if budget == 0 { DEFAULT_BUDGET } else { budget });

    let mut vm = Vm::new();
    for (dst, w) in vm.uniforms.iter_mut().zip(words(&read(&dir, "uniforms.bin")?)) {
        *dst = f32::from_bits(w);
    }
    let st = words(&read(&dir, "state.bin")?);
    for (dst, w) in vm.state.iter_mut().zip(&st) {
        *dst = f32::from_bits(*w);
    }
    vm.set_flood_words(st.get(MAX_STATE..).unwrap_or(&[]));
    let g = words(&read(&dir, "graph.bin")?);
    let n_seg = (g.first().copied().unwrap_or(0) as usize).min(g.len().saturating_sub(1) / 3);
    let seg = |k: usize, j: usize| g[1 + 3 * k + j];
    let len: Vec<f32> = (0..n_seg).map(|k| f32::from_bits(seg(k, 0))).collect();
    let a: Vec<i32> = (0..n_seg).map(|k| seg(k, 1) as i32).collect();
    let b: Vec<i32> = (0..n_seg).map(|k| seg(k, 2) as i32).collect();
    vm.set_graph(&len, &a, &b);
    let mut arena = read(&dir, "arena.bin")?;
    vm.set_arena(&mut arena);

    vm.run_update_bounded(&prog, &frame, &budget);
    let n = ctx.len() / dbg::LED_CTX_BYTES;
    let mut raw = vec![0u8; n * 3];
    let mut out = vec![0u8; n * 3];
    for i in 0..n {
        let rec = &ctx[i * dbg::LED_CTX_BYTES..(i + 1) * dbg::LED_CTX_BYTES];
        let Some(led) = dbg::led_from_record(rec, i as u32) else { continue };
        let ((r, gg, bb), oc, _) = vm.run_shade_counted(&prog, &frame, &led, &budget);
        let c = if oc.timed_out() { [0, 0, 0] } else { [r, gg, bb] };
        raw[i * 3..i * 3 + 3].copy_from_slice(&c);
        out[i * 3..i * 3 + 3].copy_from_slice(&output_stage(c, &lut, brightness));
    }
    let mut state_out = Vec::new();
    for v in vm.state.iter() {
        state_out.extend(v.to_bits().to_le_bytes());
    }
    for k in 0..Vm::FLOOD_WORDS {
        state_out.extend(vm.flood_word(k).to_le_bytes());
    }
    let w = |name: &str, b: &[u8]| fs::write(dir.join(name), b).map_err(|e| format!("{name}: {e}"));
    w("raw.bin", &raw)?;
    w("output.bin", &out)?;
    w("state_out.bin", &state_out)?;
    w("arena_out.bin", &arena)?;

    // debug_fx_led re-runs, as the device does them: from the LED's post-frame
    // buffer elements (restored after), on zeroed scratch.
    for i in leds {
        let rec = ctx.get(i * dbg::LED_CTX_BYTES..(i + 1) * dbg::LED_CTX_BYTES).ok_or(format!("--led {i}: no such LED"))?;
        let led = dbg::led_from_record(rec, i as u32).ok_or(format!("--led {i}: no map entry"))?;
        let mut saved = Vec::new();
        dbg::led_elem_ranges(&prog, frame.led_count as usize, i, |o, l| {
            if let Some(b) = arena.get(o..o + l) {
                saved.push((o, b.to_vec()));
            }
        });
        vm.clear_scratch();
        let ((r, gg, bb), _, _) = vm.run_shade_counted(&prog, &frame, &led, &budget);
        for (o, b) in &saved {
            arena[*o..*o + b.len()].copy_from_slice(b);
        }
        let mut rec_out = vec![r, gg, bb];
        for v in &vm.locals()[..MAX_LOCALS] {
            rec_out.extend(v.to_bits().to_le_bytes());
        }
        w(&format!("led{i}.bin"), &rec_out)?;
    }
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("fx_replay: {e}");
            ExitCode::FAILURE
        }
    }
}
