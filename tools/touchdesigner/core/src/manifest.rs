//! Parser for the effect uniform manifest — the JSON `fx_compiler` emits and
//! the device echoes back in `effect_uniforms` (see
//! `docs/design/effects-compiler.md`). Shape:
//!
//! ```json
//! [{"name":"speed","slot":0,"width":1,
//!   "ui":{"kind":"slider","min":0,"max":5,"step":0},"default":[1.0]}]
//! ```
//!
//! The CHOP operator uses this to map its input channels onto uniform slots and
//! to pick a native type (float / bool / vecN) per the issue's requirement.

use crate::proto::UniformValue;
use serde_json::Value;
use std::collections::HashMap;

/// How a uniform is driven from TouchDesigner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UniformKind {
    /// Single float (slider / dropdown / plain float).
    Float,
    /// Boolean toggle (sent as 0.0 / 1.0).
    Bool,
    /// Vector of `width` floats (2..4), e.g. a colour (`vec3`) or `vec2/4`.
    Vec(u8),
}

/// One driveable uniform port.
#[derive(Debug, Clone)]
pub struct UniformPort {
    pub name: String,
    pub slot: u32,
    pub width: u8,
    pub kind: UniformKind,
    pub default: Vec<f32>,
}

impl UniformPort {
    /// The channel names this port exposes to a CHOP. A scalar uses the bare
    /// uniform name; a vecN fans out to `name:x/y/z/w`.
    pub fn channel_names(&self) -> Vec<String> {
        match self.kind {
            UniformKind::Vec(w) => {
                const AXES: [&str; 4] = ["x", "y", "z", "w"];
                (0..w as usize).map(|i| format!("{}:{}", self.name, AXES[i])).collect()
            }
            _ => vec![self.name.clone()],
        }
    }
}

/// Parse a manifest JSON blob into typed ports. Returns an empty vec for an
/// empty/blank manifest (current firmware embeds no manifest) or on any parse
/// error — callers then fall back to explicit parameters.
pub fn parse(bytes: &[u8]) -> Vec<UniformPort> {
    if bytes.iter().all(|b| b.is_ascii_whitespace()) {
        return Vec::new();
    }
    let Ok(Value::Array(items)) = serde_json::from_slice::<Value>(bytes) else {
        return Vec::new();
    };
    items.iter().filter_map(parse_one).collect()
}

fn parse_one(v: &Value) -> Option<UniformPort> {
    let name = v.get("name")?.as_str()?.to_string();
    let slot = v.get("slot")?.as_u64()? as u32;
    let width = v.get("width").and_then(Value::as_u64).unwrap_or(1).clamp(1, 4) as u8;
    let ui_kind = v
        .get("ui")
        .and_then(|u| u.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let kind = if ui_kind == "toggle" {
        UniformKind::Bool
    } else if width > 1 {
        UniformKind::Vec(width)
    } else {
        UniformKind::Float
    };
    let default = v
        .get("default")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.as_f64().map(|f| f as f32)).collect())
        .unwrap_or_default();
    Some(UniformPort { name, slot, width, kind, default })
}

/// Map a set of named channel values onto uniform-slot writes using a fixture's
/// manifest. A scalar/bool port consumes the channel named exactly after the
/// uniform; a vecN port consumes `name:x`, `name:y`, ... A port is emitted only
/// when *all* of its channels are present, so partially-driven vectors are left
/// untouched. Booleans are thresholded at 0.5 to a clean 0.0/1.0.
pub fn map_channels(ports: &[UniformPort], values: &HashMap<String, f32>) -> Vec<UniformValue> {
    let mut out = Vec::new();
    for port in ports {
        let names = port.channel_names();
        let mut vals = Vec::with_capacity(names.len());
        let mut all_present = true;
        for n in &names {
            match values.get(n) {
                Some(v) => vals.push(*v),
                None => {
                    all_present = false;
                    break;
                }
            }
        }
        if !all_present {
            continue;
        }
        if port.kind == UniformKind::Bool {
            vals = vals.iter().map(|v| if *v >= 0.5 { 1.0 } else { 0.0 }).collect();
        }
        out.push(UniformValue { slot: port.slot, values: vals });
    }
    out
}

/// Fallback mapping used when the device advertises no manifest (current
/// firmware): a channel named `slotN`, `sN` or a bare integer `N` drives scalar
/// uniform slot `N` directly.
pub fn fallback_map(values: &HashMap<String, f32>) -> Vec<UniformValue> {
    let mut out = Vec::new();
    for (name, v) in values {
        let digits = name
            .strip_prefix("slot")
            .or_else(|| name.strip_prefix('s'))
            .unwrap_or(name);
        if let Ok(slot) = digits.parse::<u32>() {
            out.push(UniformValue { slot, values: vec![*v] });
        }
    }
    out.sort_by_key(|u| u.slot);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"[
        {"name":"speed","slot":0,"width":1,"ui":{"kind":"slider","min":0,"max":5,"step":0},"default":[1.0]},
        {"name":"tint","slot":1,"width":3,"ui":{"kind":"color"},"default":[1,0,0]},
        {"name":"mirror","slot":2,"width":1,"ui":{"kind":"toggle"},"default":[0]}
    ]"#;

    #[test]
    fn parses_kinds_and_slots() {
        let ports = parse(SAMPLE.as_bytes());
        assert_eq!(ports.len(), 3);
        assert_eq!(ports[0].kind, UniformKind::Float);
        assert_eq!(ports[0].slot, 0);
        assert_eq!(ports[1].kind, UniformKind::Vec(3));
        assert_eq!(ports[2].kind, UniformKind::Bool);
    }

    #[test]
    fn vec_fans_out_channel_names() {
        let ports = parse(SAMPLE.as_bytes());
        assert_eq!(ports[1].channel_names(), vec!["tint:x", "tint:y", "tint:z"]);
        assert_eq!(ports[0].channel_names(), vec!["speed"]);
    }

    #[test]
    fn empty_manifest_is_empty() {
        assert!(parse(b"").is_empty());
        assert!(parse(b"   ").is_empty());
        assert!(parse(b"not json").is_empty());
    }

    #[test]
    fn maps_scalar_bool_and_vec_channels() {
        let ports = parse(SAMPLE.as_bytes());
        let mut vals = HashMap::new();
        vals.insert("speed".to_string(), 2.5);
        vals.insert("tint:x".to_string(), 1.0);
        vals.insert("tint:y".to_string(), 0.0);
        vals.insert("tint:z".to_string(), 0.5);
        vals.insert("mirror".to_string(), 0.9); // -> bool 1.0
        let uvs = map_channels(&ports, &vals);
        assert_eq!(uvs.len(), 3);
        let by_slot = |s: u32| uvs.iter().find(|u| u.slot == s).unwrap();
        assert_eq!(by_slot(0).values, vec![2.5]);
        assert_eq!(by_slot(1).values, vec![1.0, 0.0, 0.5]);
        assert_eq!(by_slot(2).values, vec![1.0]);
    }

    #[test]
    fn partial_vec_is_skipped() {
        let ports = parse(SAMPLE.as_bytes());
        let mut vals = HashMap::new();
        vals.insert("tint:x".to_string(), 1.0); // missing y,z
        assert!(map_channels(&ports, &vals).iter().all(|u| u.slot != 1));
    }

    #[test]
    fn fallback_parses_slot_names() {
        let mut vals = HashMap::new();
        vals.insert("slot0".to_string(), 1.0);
        vals.insert("s2".to_string(), 3.0);
        vals.insert("5".to_string(), 9.0);
        vals.insert("speed".to_string(), 7.0); // no numeric slot -> ignored
        let uvs = fallback_map(&vals);
        assert_eq!(uvs.len(), 3);
        assert_eq!(uvs[0].slot, 0);
        assert_eq!(uvs[1].slot, 2);
        assert_eq!(uvs[2].slot, 5);
    }
}
