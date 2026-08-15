//! `ledmapper_osc_bridge` — receive OSC and drive shader uniforms on a
//! `ledmapper.v1` fixture.
//!
//! An OSC source (TouchDesigner, Ableton, TouchOSC, Max/MSP, a python script…)
//! sends control messages over UDP; this bridge maps each message's address to
//! one of the active effect's named uniform channels and forwards the values to
//! the device using the existing protocol client
//! ([`td_ledmapper::client::Session`]). The device's own uniform manifest does
//! the slot resolution — colours/vectors, toggles and sliders all work with no
//! per-effect configuration here.
//!
//! This crate holds the pure, unit-tested pieces:
//! - [`osc`] — the OSC datagram parser.
//! - [`address_to_channel`] — OSC address → manifest channel-name mapping.
//! - [`ChannelMap`] — the persistent last-value table fed to
//!   [`td_ledmapper::client::Session::drive_uniforms`].
//!
//! The socket loop and CLI live in `main.rs`.

pub mod osc;

use osc::OscMessage;
use std::collections::HashMap;

/// Map an OSC address pattern to a fixture uniform channel name, or `None` if it
/// doesn't live under `prefix`.
///
/// The device manifest names a scalar uniform by its bare name (`speed`) and a
/// vecN's components as `name:x` / `name:y` / `name:z` / `name:w` (see
/// [`td_ledmapper::manifest`]). OSC addresses are slash-separated, so we strip
/// the configured `prefix` and translate the remaining `/` separators to `:`:
///
/// - `--prefix /`         : `/speed` → `speed`, `/tint/x` → `tint:x`
/// - `--prefix /uniform/` : `/uniform/speed` → `speed`
///
/// When the firmware advertises no manifest, the session falls back to
/// `slotN`-style names, so `/slot0` (or `/s0`) addresses a raw slot directly.
pub fn address_to_channel(addr: &str, prefix: &str) -> Option<String> {
    let rest = addr.strip_prefix(prefix)?;
    let rest = rest.trim_matches('/');
    if rest.is_empty() {
        return None;
    }
    Some(rest.replace('/', ":"))
}

/// The persistent table of last-seen channel values.
///
/// OSC controllers send components independently and sparsely (a mixer moves one
/// fader at a time), and the manifest mapping only emits a vecN once *all* of its
/// components are known. So the bridge remembers every channel's most recent
/// value and hands the whole table to the device on each update — a lone
/// `/tint/y` message still completes the `tint` colour using the `x`/`z` values
/// seen earlier.
#[derive(Debug, Default)]
pub struct ChannelMap {
    values: HashMap<String, f32>,
}

impl ChannelMap {
    pub fn new() -> Self {
        Self::default()
    }

    /// Apply one decoded OSC message. Returns the `(channel, value)` it set, or
    /// `None` if the address is outside `prefix` or the message carries no
    /// numeric/boolean argument. Only the first numeric argument is used —
    /// one address, one value, matching the one-knob-one-uniform model.
    pub fn apply(&mut self, msg: &OscMessage, prefix: &str) -> Option<(String, f32)> {
        let channel = address_to_channel(&msg.addr, prefix)?;
        let value = msg.args.iter().find_map(|a| a.as_f32())?;
        self.values.insert(channel.clone(), value);
        Some((channel, value))
    }

    /// The full last-value table, as [`Session::drive_uniforms`] expects.
    ///
    /// [`Session::drive_uniforms`]: td_ledmapper::client::Session::drive_uniforms
    pub fn snapshot(&self) -> &HashMap<String, f32> {
        &self.values
    }

    pub fn len(&self) -> usize {
        self.values.len()
    }

    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use osc::OscArg;

    fn m(addr: &str, v: f32) -> OscMessage {
        OscMessage { addr: addr.to_string(), args: vec![OscArg::Float(v)] }
    }

    #[test]
    fn strips_prefix_and_maps_axes() {
        assert_eq!(address_to_channel("/speed", "/"), Some("speed".into()));
        assert_eq!(address_to_channel("/tint/x", "/"), Some("tint:x".into()));
        assert_eq!(address_to_channel("/uniform/speed", "/uniform/"), Some("speed".into()));
        assert_eq!(address_to_channel("/uniform/tint/z", "/uniform/"), Some("tint:z".into()));
    }

    #[test]
    fn rejects_addresses_outside_prefix() {
        assert_eq!(address_to_channel("/other/speed", "/uniform/"), None);
        assert_eq!(address_to_channel("/", "/"), None);
        assert_eq!(address_to_channel("/uniform/", "/uniform/"), None);
    }

    #[test]
    fn accumulates_vec_components_across_messages() {
        let mut map = ChannelMap::new();
        assert_eq!(map.apply(&m("/tint/x", 1.0), "/"), Some(("tint:x".into(), 1.0)));
        map.apply(&m("/tint/y", 0.5), "/");
        map.apply(&m("/tint/z", 0.25), "/");
        let snap = map.snapshot();
        assert_eq!(snap.get("tint:x"), Some(&1.0));
        assert_eq!(snap.get("tint:y"), Some(&0.5));
        assert_eq!(snap.get("tint:z"), Some(&0.25));
        assert_eq!(map.len(), 3);
    }

    #[test]
    fn later_value_overwrites() {
        let mut map = ChannelMap::new();
        map.apply(&m("/speed", 1.0), "/");
        map.apply(&m("/speed", 3.0), "/");
        assert_eq!(map.snapshot().get("speed"), Some(&3.0));
        assert_eq!(map.len(), 1);
    }

    #[test]
    fn ignores_out_of_prefix_and_argless_messages() {
        let mut map = ChannelMap::new();
        assert_eq!(map.apply(&m("/nope", 1.0), "/uniform/"), None);
        let argless = OscMessage { addr: "/speed".into(), args: vec![] };
        assert_eq!(map.apply(&argless, "/"), None);
        assert!(map.is_empty());
    }

    #[test]
    fn bool_argument_drives_zero_or_one() {
        let mut map = ChannelMap::new();
        let on = OscMessage { addr: "/mirror".into(), args: vec![OscArg::Bool(true)] };
        assert_eq!(map.apply(&on, "/"), Some(("mirror".into(), 1.0)));
    }
}
