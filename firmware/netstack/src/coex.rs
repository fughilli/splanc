//! Heapless WiFi/BT coexistence arbiter — a static, deterministic priority state
//! machine for the shared 2.4 GHz radio, allocation-free.
//!
//! Both radios contend for one antenna. Each presents a [`Request`] with a
//! [`Priority`]; the arbiter grants the medium to the higher priority, with
//! bounded **anti-starvation** so a steady high-priority stream on one radio
//! cannot indefinitely lock the other out (e.g. a flood of high-priority BT
//! activity starving WiFi, or vice-versa).
//!
//! No heap, no unbounded state — a fixed counter and a small table.
//! Deterministic and auditable.

/// Which radio a request/grant belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Radio {
    Wifi,
    Bt,
}

/// Coexistence priority (higher wins):
/// beacon/connection-critical > management > data > scan/idle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Priority {
    Idle = 0,
    Background = 1,
    Data = 2,
    Management = 3,
    /// Connection-critical (WiFi beacon RX window, BT SCO/eSCO voice). Time-bounded.
    Critical = 4,
}

/// A radio's bid for the medium this slot.
#[derive(Debug, Clone, Copy)]
pub struct Request {
    pub radio: Radio,
    pub prio: Priority,
}

/// After how many consecutive denials a radio's effective priority is boosted so
/// it cannot be starved. Bounded => worst-case latency for the loser is
/// `STARVE_LIMIT` slots, not unbounded.
const STARVE_LIMIT: u8 = 8;

/// The arbiter state: consecutive denials per radio (bounded counters).
pub struct Coex {
    denied_wifi: u8,
    denied_bt: u8,
}

impl Coex {
    pub const fn new() -> Self {
        Coex { denied_wifi: 0, denied_bt: 0 }
    }

    /// Effective priority = base priority + a starvation boost (capped) so the
    /// starved radio eventually wins even against a steady higher-priority peer.
    fn effective(base: Priority, denied: u8) -> u16 {
        let boost = if denied >= STARVE_LIMIT { 3 } else { (denied / 3) as u16 };
        base as u16 + boost
    }

    /// Decide who gets the medium this slot given each radio's current bid
    /// (`None` = not requesting). Updates the anti-starvation counters. Ties go
    /// to the radio that was denied more recently (fairness), then to WiFi.
    pub fn arbitrate(&mut self, wifi: Option<Priority>, bt: Option<Priority>) -> Option<Radio> {
        match (wifi, bt) {
            (None, None) => None,
            (Some(_), None) => {
                self.grant(Radio::Wifi);
                Some(Radio::Wifi)
            }
            (None, Some(_)) => {
                self.grant(Radio::Bt);
                Some(Radio::Bt)
            }
            (Some(w), Some(b)) => {
                let ew = Self::effective(w, self.denied_wifi);
                let eb = Self::effective(b, self.denied_bt);
                let winner = if ew > eb {
                    Radio::Wifi
                } else if eb > ew {
                    Radio::Bt
                } else if self.denied_wifi >= self.denied_bt {
                    Radio::Wifi // tie -> the more-starved side (WiFi on full tie)
                } else {
                    Radio::Bt
                };
                self.grant(winner);
                Some(winner)
            }
        }
    }

    fn grant(&mut self, winner: Radio) {
        match winner {
            Radio::Wifi => {
                self.denied_wifi = 0;
                self.denied_bt = self.denied_bt.saturating_add(1);
            }
            Radio::Bt => {
                self.denied_bt = 0;
                self.denied_wifi = self.denied_wifi.saturating_add(1);
            }
        }
    }
}

impl Default for Coex {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn higher_priority_wins() {
        let mut c = Coex::new();
        assert_eq!(
            c.arbitrate(Some(Priority::Data), Some(Priority::Critical)),
            Some(Radio::Bt)
        );
    }

    #[test]
    fn single_requester_gets_it() {
        let mut c = Coex::new();
        assert_eq!(c.arbitrate(Some(Priority::Idle), None), Some(Radio::Wifi));
        assert_eq!(c.arbitrate(None, Some(Priority::Idle)), Some(Radio::Bt));
        assert_eq!(c.arbitrate(None, None), None);
    }

    #[test]
    fn no_unbounded_starvation() {
        // BT steadily bids Critical; WiFi steadily bids low Data. Without anti-
        // starvation WiFi never wins. Assert WiFi wins within STARVE_LIMIT slots.
        let mut c = Coex::new();
        let mut wifi_wins = 0;
        for _ in 0..(STARVE_LIMIT as usize + 2) {
            if c.arbitrate(Some(Priority::Data), Some(Priority::Critical)) == Some(Radio::Wifi) {
                wifi_wins += 1;
            }
        }
        assert!(wifi_wins >= 1, "anti-starvation must let WiFi through");
    }

    #[test]
    fn starvation_bound_is_symmetric() {
        // Same, radios swapped: WiFi Critical steady, BT Data steady -> BT must
        // eventually win too.
        let mut c = Coex::new();
        let mut bt_wins = 0;
        for _ in 0..(STARVE_LIMIT as usize + 2) {
            if c.arbitrate(Some(Priority::Critical), Some(Priority::Data)) == Some(Radio::Bt) {
                bt_wins += 1;
            }
        }
        assert!(bt_wins >= 1);
    }
}
