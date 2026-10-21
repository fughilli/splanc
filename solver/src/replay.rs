//! Replay a capture reproduction bundle (web/src/solver/captureBundle.ts)
//! through the exact solve paths the phone ran: every recorded interim solve
//! (the live preview — the capture's first `recordCount` detections and
//! `imuCount` IMU samples, the interim options) and the final solve (the
//! recorded problem verbatim, warm start included).
//!
//! The solver is deterministic (no randomness, no threads), so a replay in
//! the same build reproduces the recorded maps exactly — provided it parses
//! the very same input text: serde_json's float parsing is deterministic but
//! best-effort (not always the nearest double), so the inputs are sliced out
//! of the bundle's raw text (the phone serialized the same numbers the same
//! way) rather than re-serialized from parsed values. Natively the libm
//! transcendental functions can still differ from wasm's in the last bit,
//! which an unconverged solve amplifies, so a native replay of a phone bundle
//! is close but not always identical; the wasm replay
//! (solver/replay_bundle.mjs) is bit-for-bit.

use serde::Serialize;
use serde_json::Value;

use crate::types::{OutputMap, Problem};

/// Replay a parsed bundle (re-serialized; prefer `replay_bundle_text` when
/// the original text is at hand — see the module docs).
pub fn replay_bundle(bundle: &Value, opts: &ReplayOptions) -> Result<ReplayReport, String> {
    replay_bundle_text(&bundle.to_string(), opts)
}

#[derive(Serialize, Debug, Clone)]
pub struct ReplayCase {
    /// "interim-<i>" or "final".
    pub label: String,
    pub records: usize,
    /// The replayed solve's error, if it failed.
    pub error: Option<String>,
    /// The recorded solve's error, if it failed on the phone.
    #[serde(rename = "recordedError")]
    pub recorded_error: Option<String>,
    /// Replayed map identical (every number) to the recorded one.
    pub identical: Option<bool>,
    /// Largest |Δ| between replayed and recorded LED coordinates, meters.
    #[serde(rename = "maxLedDeltaM")]
    pub max_led_delta_m: Option<f64>,
    pub assessment: Option<crate::diag::Assessment>,
    pub start: Option<String>,
    pub trace: Vec<crate::pipeline::StageTrace>,
}

#[derive(Serialize, Debug, Clone)]
pub struct ReplayReport {
    pub cases: Vec<ReplayCase>,
}

pub struct ReplayOptions {
    pub interims: bool,
    /// Replay the final solve without its warm start (what a cold-only
    /// solver — the app before warm starts — would have produced).
    pub drop_warm_start: bool,
}

fn led_delta(a: &OutputMap, b: &OutputMap) -> (bool, Option<f64>) {
    let same_ids =
        a.leds.len() == b.leds.len() && a.leds.iter().zip(&b.leds).all(|(x, y)| x.id == y.id);
    if !same_ids {
        return (false, None);
    }
    let mut max: f64 = 0.0;
    let mut identical = a.stats.rms_reproj_px_global.to_bits()
        == b.stats.rms_reproj_px_global.to_bits()
        && a.unmapped == b.unmapped;
    for (x, y) in a.leds.iter().zip(&b.leds) {
        for k in 0..3 {
            max = max.max((x.xyz[k] - y.xyz[k]).abs());
            identical &= x.xyz[k].to_bits() == y.xyz[k].to_bits();
        }
        identical &= x.n_views == y.n_views && x.confidence.to_bits() == y.confidence.to_bits();
    }
    (identical, Some(max))
}

fn run_case(label: String, problem_text: &str, recorded: Option<&Value>) -> ReplayCase {
    let records = raw::member(problem_text, "detections")
        .map(|d| raw::elements(d).len())
        .unwrap_or(0);
    let recorded_map: Option<OutputMap> = recorded
        .and_then(|r| r.get("map"))
        .filter(|m| !m.is_null())
        .and_then(|m| serde_json::from_value(m.clone()).ok());
    let recorded_error = recorded
        .and_then(|r| r.get("error"))
        .and_then(|e| e.as_str())
        .map(str::to_string);
    let mut case = ReplayCase {
        label,
        records,
        error: None,
        recorded_error,
        identical: None,
        max_led_delta_m: None,
        assessment: None,
        start: None,
        trace: Vec::new(),
    };
    let problem: Problem = match serde_json::from_str(problem_text) {
        Ok(p) => p,
        Err(e) => {
            case.error = Some(format!("bad problem: {e}"));
            return case;
        }
    };
    match crate::pipeline::reconstruct_vio_diag(&problem, None) {
        Ok((map, diag)) => {
            // Round-trip through JSON like the carriers do, so the comparison
            // sees exactly what the phone stored.
            let map: OutputMap = serde_json::to_string(&map)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or(map);
            if let Some(rec) = &recorded_map {
                let (identical, delta) = led_delta(&map, rec);
                case.identical = Some(identical);
                case.max_led_delta_m = delta;
            }
            case.assessment = Some(diag.assessment);
            case.start = Some(diag.start);
            case.trace = diag.trace;
        }
        Err(e) => {
            case.error = Some(e);
            if case.recorded_error.is_some() {
                case.identical = Some(case.error == case.recorded_error);
            }
        }
    }
    case
}

/// The prefix problem text an interim solve saw: the capture's first
/// `recordCount` detections and `imuCount` IMU samples (raw, as recorded)
/// plus the interim's own ledCount/mapId/createdAt/options.
pub fn interim_problem(problem_text: &str, interim: &Value) -> Result<String, String> {
    let take = |key: &str, n: usize| -> Result<String, String> {
        let arr = raw::member(problem_text, key).ok_or(format!("problem has no {key}"))?;
        let el = raw::elements(arr);
        if n > el.len() {
            return Err(format!(
                "interim needs {n} {key} but the capture has {}",
                el.len()
            ));
        }
        Ok(format!("[{}]", el[..n].join(",")))
    };
    let n_det = interim["recordCount"].as_u64().unwrap_or(0) as usize;
    let n_imu = interim["imuCount"].as_u64().unwrap_or(0) as usize;
    let field = |k: &str| -> String {
        interim
            .get(k)
            .filter(|v| !v.is_null())
            .map(|v| v.to_string())
            .or_else(|| raw::member(problem_text, k).map(str::to_string))
            .unwrap_or_else(|| "null".into())
    };
    let mut out = format!(
        "{{\"detections\":{},\"imu\":{},\"ledCount\":{},\"mapId\":{},\"createdAt\":{}",
        take("detections", n_det)?,
        take("imu", n_imu)?,
        field("ledCount"),
        field("mapId"),
        field("createdAt"),
    );
    if let Some(o) = interim.get("options").filter(|o| !o.is_null()) {
        out.push_str(&format!(",\"options\":{o}"));
    }
    out.push('}');
    Ok(out)
}

/// Replay a bundle from its JSON text.
pub fn replay_bundle_text(text: &str, opts: &ReplayOptions) -> Result<ReplayReport, String> {
    let bundle: Value = serde_json::from_str(text).map_err(|e| format!("bad bundle JSON: {e}"))?;
    if bundle["format"].as_str() != Some("splanc-capture-bundle") {
        return Err("not a splanc capture bundle (format != splanc-capture-bundle)".into());
    }
    let problem_text = raw::member(text, "problem")
        .filter(|p| *p != "null")
        .ok_or("bundle has no final problem")?;
    let mut cases = Vec::new();
    if opts.interims {
        for (i, it) in bundle["interims"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .enumerate()
        {
            if it["source"].as_str() == Some("host") {
                continue; // a host solver's live map: not this solver's path
            }
            let label = format!(
                "interim-{i}{}",
                if it["best"].as_bool() == Some(true) {
                    " (best)"
                } else {
                    ""
                }
            );
            match interim_problem(problem_text, it) {
                Ok(p) => cases.push(run_case(label, &p, Some(it))),
                Err(e) => cases.push(ReplayCase {
                    label,
                    records: 0,
                    error: Some(e),
                    recorded_error: None,
                    identical: None,
                    max_led_delta_m: None,
                    assessment: None,
                    start: None,
                    trace: Vec::new(),
                }),
            }
        }
    }
    let recorded_final = bundle.get("final").filter(|f| !f.is_null());
    if opts.drop_warm_start {
        let mut problem: Value = serde_json::from_str(problem_text).map_err(|e| e.to_string())?;
        if let Some(o) = problem.get_mut("options").and_then(|o| o.as_object_mut()) {
            o.remove("warmStart");
        }
        cases.push(run_case(
            "final (cold only)".into(),
            &problem.to_string(),
            None,
        ));
    } else {
        cases.push(run_case("final".into(), problem_text, recorded_final));
    }
    Ok(ReplayReport { cases })
}

/// Minimal raw-JSON slicing: spans of members/elements as they appear in
/// the text, so replays parse exactly what the phone serialized.
pub mod raw {
    fn skip_ws(b: &[u8], mut i: usize) -> usize {
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        i
    }

    /// End (exclusive) of the JSON value starting at `i`.
    fn value_end(b: &[u8], i: usize) -> usize {
        let mut i = i;
        match b.get(i) {
            Some(b'"') => {
                i += 1;
                while i < b.len() {
                    match b[i] {
                        b'\\' => i += 2,
                        b'"' => return i + 1,
                        _ => i += 1,
                    }
                }
                b.len()
            }
            Some(b'{') | Some(b'[') => {
                let mut depth = 0usize;
                while i < b.len() {
                    match b[i] {
                        b'"' => {
                            i = value_end(b, i);
                            continue;
                        }
                        b'{' | b'[' => depth += 1,
                        b'}' | b']' => {
                            depth -= 1;
                            if depth == 0 {
                                return i + 1;
                            }
                        }
                        _ => {}
                    }
                    i += 1;
                }
                b.len()
            }
            _ => {
                while i < b.len()
                    && !matches!(b[i], b',' | b'}' | b']')
                    && !b[i].is_ascii_whitespace()
                {
                    i += 1;
                }
                i
            }
        }
    }

    /// Top-level members of the object `text` as (raw key, raw value).
    pub fn members(text: &str) -> Vec<(&str, &str)> {
        let b = text.as_bytes();
        let mut out = Vec::new();
        let mut i = skip_ws(b, 0);
        if b.get(i) != Some(&b'{') {
            return out;
        }
        i += 1;
        loop {
            i = skip_ws(b, i);
            if i >= b.len() || b[i] == b'}' {
                return out;
            }
            let k_end = value_end(b, i);
            let key = &text[i..k_end];
            i = skip_ws(b, k_end);
            if b.get(i) != Some(&b':') {
                return out;
            }
            i = skip_ws(b, i + 1);
            let v_end = value_end(b, i);
            out.push((key, &text[i..v_end]));
            i = skip_ws(b, v_end);
            if b.get(i) == Some(&b',') {
                i += 1;
            }
        }
    }

    /// The raw value of top-level member `key` of the object `text`.
    pub fn member<'a>(text: &'a str, key: &str) -> Option<&'a str> {
        let quoted = format!("\"{key}\"");
        members(text)
            .into_iter()
            .find(|(k, _)| *k == quoted)
            .map(|(_, v)| v)
    }

    /// Raw elements of the array `text`.
    pub fn elements(text: &str) -> Vec<&str> {
        let b = text.as_bytes();
        let mut out = Vec::new();
        let mut i = skip_ws(b, 0);
        if b.get(i) != Some(&b'[') {
            return out;
        }
        i += 1;
        loop {
            i = skip_ws(b, i);
            if i >= b.len() || b[i] == b']' {
                return out;
            }
            let end = value_end(b, i);
            out.push(&text[i..end]);
            i = skip_ws(b, end);
            if b.get(i) == Some(&b',') {
                i += 1;
            }
        }
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn slices_members_and_elements_verbatim() {
            let t = r#" {"a": [1, {"x": "]}\"", "y": [2,3]}, 1e-7 ], "b" : "s,}" , "c":true}"#;
            assert_eq!(super::member(t, "b"), Some(r#""s,}""#));
            assert_eq!(super::member(t, "c"), Some("true"));
            let el = super::elements(super::member(t, "a").unwrap());
            assert_eq!(el, vec!["1", r#"{"x": "]}\"", "y": [2,3]}"#, "1e-7"]);
            assert_eq!(super::member(t, "zz"), None);
        }
    }
}

/// One line per case, for the CLI.
pub fn format_report(r: &ReplayReport) -> String {
    let mut out = String::new();
    for c in &r.cases {
        let verdict = match (&c.error, &c.assessment) {
            (Some(e), _) => format!("ERROR {e}"),
            (None, Some(a)) if a.degenerate => format!("DEGENERATE [{}]", a.reasons.join(", ")),
            (None, Some(_)) => "ok".to_string(),
            _ => "?".to_string(),
        };
        let a = c.assessment.as_ref();
        out.push_str(&format!(
            "{:<20} records {:>6}  {:<40} leds {:>4}/{:<4} rms {:>7.2}px spread {:>7.4}m cam {:>6}m start {:<4} replay {}\n",
            c.label,
            c.records,
            verdict,
            a.map(|a| a.measured).unwrap_or(0),
            a.map(|a| a.observable).unwrap_or(0),
            a.map(|a| a.rms_px).unwrap_or(f64::NAN),
            a.map(|a| a.geometry.spread_m).unwrap_or(f64::NAN),
            a.and_then(|a| a.geometry.median_camera_dist_m)
                .map(|d| format!("{d:.3}"))
                .unwrap_or_else(|| "-".into()),
            c.start.as_deref().unwrap_or("-"),
            match (c.identical, c.max_led_delta_m) {
                (Some(true), _) => "IDENTICAL".to_string(),
                (Some(false), Some(d)) => format!("differs (max |Δ| {d:.3e} m)"),
                (Some(false), None) => "differs (LED sets differ)".to_string(),
                (None, _) => "(no recording)".to_string(),
            }
        ));
        if let Some(e) = &c.recorded_error {
            out.push_str(&format!("{:<20} recorded error: {e}\n", ""));
        }
        for t in &c.trace {
            out.push_str(&format!(
                "{:<22}{:<24} frames {:>4} obs {:>6} solved {:>4}/{:<4} rms {:>7.2}px reanchor ×{:.3}{}{}{}\n",
                "",
                t.stage,
                t.frames,
                t.observations,
                t.solved,
                t.leds,
                t.rms_px,
                t.reanchor_scale,
                t.init_scale
                    .map(|s| format!(" init-scale {s:.3}"))
                    .unwrap_or_default(),
                if t.init_scale_fallback { " (FALLBACK)" } else { "" },
                if t.degenerate.is_empty() {
                    String::new()
                } else {
                    format!(" degenerate [{}]", t.degenerate.join(", "))
                }
            ));
        }
    }
    out
}
