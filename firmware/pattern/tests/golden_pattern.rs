//! The kernel vs its pinned fixtures (`testdata/golden_{secded,stagger}16{,_sym4}.json`,
//! emitted by `:gen_golden` and diff-tested by `:goldens`). The fixtures are a
//! regression pin on the wire: what every player emits and the phone (running
//! this same kernel as wasm) decodes.

use ledmapper_pattern as pat;

fn golden(path_env: &str) -> serde_json::Value {
    let path = std::env::var(path_env).unwrap_or_else(|_| panic!("{path_env} not set"));
    serde_json::from_str(&std::fs::read_to_string(&path).expect("read golden"))
        .expect("golden is valid JSON")
}

fn letter(color: pat::Rgb) -> char {
    match color {
        pat::WHITE => 'W',
        pat::GREEN => 'G',
        pat::RED => 'R',
        pat::BLUE => 'B',
        pat::MAGENTA => 'M',
        pat::YELLOW => 'Y',
        other => panic!("color {other:?} is not in the palette"),
    }
}

fn check_against_golden(g: &serde_json::Value) {
    let led_count = g["ledCount"].as_u64().unwrap() as u32;
    let symbols = g["symbols"].as_u64().unwrap() as u8;
    let secded = g["fec"].as_str().unwrap() == "secded";

    // The code-book derivation reproduces the golden's header.
    let spec = pat::CodeSpec::derive(led_count, symbols, secded);
    assert_eq!(pat::data_bits(led_count) as u64, g["dataBits"].as_u64().unwrap());
    assert_eq!(spec.bits as u64, g["bits"].as_u64().unwrap());
    assert_eq!(spec.cycle_frames as u64, g["cycleFrames"].as_u64().unwrap());

    // Gray table.
    for (i, v) in g["gray"].as_array().unwrap().iter().enumerate() {
        assert_eq!(pat::gray(i as u32) as u64, v.as_u64().unwrap(), "gray({i})");
        assert_eq!(pat::decode_gray(pat::gray(i as u32)), i as u32);
    }

    // Codewords (SEC-DED around gray(id+1)).
    for (id, v) in g["codewords"].as_array().unwrap().iter().enumerate() {
        assert_eq!(
            pat::codeword(id as u32, &spec) as u64,
            v.as_u64().unwrap(),
            "codeword for LED {id}"
        );
    }

    // Per-frame symbol values.
    for (id, frames) in g["symbolValues"].as_array().unwrap().iter().enumerate() {
        for (f, v) in frames.as_array().unwrap().iter().enumerate() {
            assert_eq!(
                pat::symbol_at(id as u32, f as u32, &spec) as u64,
                v.as_u64().unwrap(),
                "symbol for LED {id} data frame {f}"
            );
        }
    }

    // The full color plan, letter for letter.
    let plan = g["colorPlan"].as_array().unwrap();
    assert_eq!(plan.len() as u32, spec.cycle_frames);
    for (f, row) in plan.iter().enumerate() {
        let row = row.as_str().unwrap();
        assert_eq!(row.len() as u32, led_count);
        for (id, expected) in row.chars().enumerate() {
            let got = letter(pat::color_for_frame(id as u32, f as u32, &spec));
            assert_eq!(got, expected, "frame {f}, LED {id}");
        }
    }
}

#[test]
fn matches_the_two_symbol_golden() {
    check_against_golden(&golden("GOLDEN_SECDED16"));
}

#[test]
fn matches_the_four_symbol_golden() {
    check_against_golden(&golden("GOLDEN_SECDED16_SYM4"));
}

#[test]
fn secded_corrects_single_and_rejects_double_errors() {
    let k = pat::data_bits(16); // 5 data bits, the golden's geometry
    let total = pat::secded_total_bits(k);
    for id in 0..16u32 {
        let word = pat::secded_encode(pat::gray(id + 1), k);
        // Clean word decodes uncorrected.
        assert_eq!(pat::secded_decode(word, k), (Some(pat::gray(id + 1)), false));
        // Every single-bit flip is corrected back.
        for b in 0..total {
            let (data, corrected) = pat::secded_decode(word ^ (1 << b), k);
            assert_eq!(data, Some(pat::gray(id + 1)), "flip bit {b} of LED {id}");
            assert!(corrected);
        }
        // Every double flip is detected, never miscorrected.
        for b1 in 0..total {
            for b2 in (b1 + 1)..total {
                let (data, _) = pat::secded_decode(word ^ (1 << b1) ^ (1 << b2), k);
                assert_eq!(data, None, "double flip {b1},{b2} of LED {id}");
            }
        }
    }
}

/// The staggered-pilot goldens, checked against the kernel AND against the v1
/// golden of the same code-book: stagger frame f of LED id is v1 frame
/// (f - phase) mod C, with the pilot G, M in place of v1's W, G.
fn check_stagger_golden(g: &serde_json::Value, v1: &serde_json::Value) {
    let led_count = g["ledCount"].as_u64().unwrap() as u32;
    let symbols = g["symbols"].as_u64().unwrap() as u8;
    assert_eq!(g["syncPattern"].as_str().unwrap(), "stagger_pilot");
    let spec = pat::CodeSpec::derive(led_count, symbols, true).with_sync(pat::SyncPattern::StaggerPilot);
    let c = spec.cycle_frames;
    assert_eq!(c as u64, g["cycleFrames"].as_u64().unwrap());
    let step = g["staggerStep"].as_u64().unwrap() as u32;
    assert_eq!(pat::stagger_step(c), step);
    for (i, v) in g["staggerSteps"].as_array().unwrap().iter().enumerate() {
        assert_eq!(pat::stagger_step(i as u32 + 3) as u64, v.as_u64().unwrap(), "S(C={})", i + 3);
    }
    let phases: Vec<u32> = g["phases"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u32).collect();
    let v1_plan: Vec<Vec<char>> =
        v1["colorPlan"].as_array().unwrap().iter().map(|r| r.as_str().unwrap().chars().collect()).collect();
    let plan = g["colorPlan"].as_array().unwrap();
    assert_eq!(plan.len() as u32, c);
    for (f, row) in plan.iter().enumerate() {
        for (id, expected) in row.as_str().unwrap().chars().enumerate() {
            let ph = phases[id];
            assert_eq!(ph, (id as u32 * step) % c);
            assert_eq!(pat::stagger_phase(id as u32, &spec), ph);
            let got = letter(pat::color_for_frame(id as u32, f as u32, &spec));
            assert_eq!(got, expected, "frame {f}, LED {id}");
            let j = ((f as u32 + c - ph) % c) as usize;
            let from_v1 = match j {
                0 => 'G',
                1 => 'M',
                _ => v1_plan[j][id],
            };
            assert_eq!(expected, from_v1, "frame {f}, LED {id} vs the v1 golden");
        }
    }
}

#[test]
fn matches_the_two_symbol_stagger_golden() {
    check_stagger_golden(&golden("GOLDEN_STAGGER16"), &golden("GOLDEN_SECDED16"));
}

#[test]
fn matches_the_four_symbol_stagger_golden() {
    check_stagger_golden(&golden("GOLDEN_STAGGER16_SYM4"), &golden("GOLDEN_SECDED16_SYM4"));
}
