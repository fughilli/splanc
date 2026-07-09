//! Phone-side carrier: wasm-bindgen exports over the solver crate.
//!
//! `solve_json` takes the same problem JSON as the native CLI and returns
//! the OutputMap JSON; `progress` (optional JS function) receives
//! solve_status-shaped snapshot objects, throttled to ~4 Hz via the JS
//! clock (wasm32-unknown-unknown has no clock of its own).
//!
//! `benchmark` runs the canned placement-benchmark solve — the CALLER times
//! it (performance.now() around the call) and compares against the host's
//! `solver_cli --benchmark` score from the welcome message.

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn version() -> String {
    ledmapper_solver::version().to_string()
}

#[wasm_bindgen]
pub fn benchmark() -> f64 {
    ledmapper_solver::run_benchmark()
}

#[wasm_bindgen]
pub fn solve_json(input: &str, progress: Option<js_sys::Function>) -> Result<String, JsError> {
    let mut last_report = 0.0f64;
    let mut cb = |snap: &ledmapper_solver::types::ProgressSnapshot| {
        let now = js_sys::Date::now();
        if now - last_report < 250.0 {
            return;
        }
        last_report = now;
        if let Some(f) = progress.as_ref() {
            if let Ok(json) = serde_json::to_string(snap) {
                // Hand the snapshot over as a JSON string; the JS side
                // parses it (structured clone via serde-wasm-bindgen would
                // add a dependency for no measurable win at 4 Hz).
                let _ = f.call1(&JsValue::NULL, &JsValue::from_str(&json));
            }
        }
    };
    ledmapper_solver::solve_json(input, Some(&mut cb)).map_err(|e| JsError::new(&e))
}
