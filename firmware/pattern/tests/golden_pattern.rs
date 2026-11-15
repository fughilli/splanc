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

/// The staggered-pilot goldens, checked against the kernel AND structurally:
/// every LED's own cycle is the pilot letters, then the data symbols of its
/// coded index, and the pilot occurs in that cycle only at the sync position.
fn check_stagger_golden(g: &serde_json::Value) {
    let led_count = g["ledCount"].as_u64().unwrap() as u32;
    let symbols = g["symbols"].as_u64().unwrap() as u8;
    assert_eq!(g["syncPattern"].as_str().unwrap(), "stagger_pilot");
    let spec = pat::CodeSpec::derive_sync(led_count, symbols, true, pat::SyncPattern::StaggerPilot);
    let c = spec.cycle_frames;
    assert_eq!(c as u64, g["cycleFrames"].as_u64().unwrap());
    assert_eq!(spec.bits as u64, g["bits"].as_u64().unwrap());
    assert_eq!(spec.data_bits as u64, g["dataBits"].as_u64().unwrap());
    assert_eq!(pat::stagger_count_valid(&spec) as u64, g["capacity"].as_u64().unwrap());
    let pilot: Vec<u8> = g["pilot"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u8).collect();
    assert_eq!(pat::palette_pilot(symbols), pilot.as_slice());
    let pilot_letters: Vec<char> = g["pilotColors"].as_str().unwrap().chars().collect();
    let l = pilot.len() as u32;
    assert_eq!(spec.sync_frames(), l);
    let step = g["staggerStep"].as_u64().unwrap() as u32;
    assert_eq!(pat::stagger_step(c), step);
    for (i, v) in g["staggerSteps"].as_array().unwrap().iter().enumerate() {
        assert_eq!(pat::stagger_step(i as u32 + 3) as u64, v.as_u64().unwrap(), "S(C={})", i + 3);
    }
    let phases: Vec<u32> = g["phases"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u32).collect();
    let coded: Vec<u32> = g["codedIndex"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u32).collect();
    let plan: Vec<Vec<char>> =
        g["colorPlan"].as_array().unwrap().iter().map(|r| r.as_str().unwrap().chars().collect()).collect();
    assert_eq!(plan.len() as u32, c);
    let palette: Vec<char> = (0..symbols).map(|v| letter(pat::symbol_color(symbols, v).rgb())).collect();
    for id in 0..led_count {
        let ph = phases[id as usize];
        assert_eq!(ph, (id * step) % c);
        assert_eq!(pat::stagger_phase(id, &spec), ph);
        assert_eq!(pat::coded_index(id, &spec), coded[id as usize]);
        assert_eq!(pat::stagger_rank(coded[id as usize], &spec), Some(id));
        // The LED's own cycle, from its sync position.
        let own: Vec<char> = (0..c).map(|j| plan[((j + ph) % c) as usize][id as usize]).collect();
        for j in 0..c {
            let got = letter(pat::color_for_frame(id, (j + ph) % c, &spec));
            assert_eq!(got, own[j as usize], "LED {id} local frame {j}");
            let want = if j < l {
                pilot_letters[j as usize]
            } else {
                palette[pat::symbol_at_coded(coded[id as usize], j - l, &spec) as usize]
            };
            assert_eq!(own[j as usize], want, "LED {id} local frame {j}");
        }
        let hits = (0..c)
            .filter(|&o| (0..l).all(|j| own[((o + j) % c) as usize] == pilot_letters[j as usize]))
            .count();
        assert_eq!(hits, 1, "LED {id}: the pilot is unique in its cycle");
    }
}

#[test]
fn matches_the_two_symbol_stagger_golden() {
    check_stagger_golden(&golden("GOLDEN_STAGGER16"));
}

#[test]
fn matches_the_four_symbol_stagger_golden() {
    check_stagger_golden(&golden("GOLDEN_STAGGER16_SYM4"));
}
