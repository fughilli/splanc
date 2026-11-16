//! Scheduled commands: the seam for a future `apply_at` on control arms
//! (SetUniforms / SetEffect / crossfade / brightness), so a change the bridge
//! sends ahead lands on every fixture at the same instant.
//!
//! Nothing pushes here yet. The flow it is built for:
//!
//! 1. [`crate::server::handle_frame`] (the single entry for client frames) sees
//!    a control frame whose `apply_at` is in the future and, instead of calling
//!    [`crate::server::dispatch`], pushes the frame here with its due time on the
//!    player clock ([`crate::server::now_ms`], the same domain as the time base)
//!    and replies at once (ack now, apply later).
//! 2. The render loop calls [`crate::server::apply_due`] at each frame boundary
//!    (before it reads the effect), with its render time = now + the output
//!    latency offset, so a scheduled change is rendered ahead by the same
//!    offset as the effect clock and lights in step with a C6.
//! 3. `apply_due` runs each due frame through `dispatch` (the same path an
//!    immediate frame takes), dropping its reply.

/// Frames waiting for their apply time, in due order (FIFO among equal times).
pub struct Schedule {
    items: Vec<(i64, Vec<u8>)>,
}

impl Schedule {
    pub const fn new() -> Self {
        Self { items: Vec::new() }
    }

    /// Queue `frame` to apply at `due_ms` (player clock).
    pub fn push(&mut self, due_ms: i64, frame: Vec<u8>) {
        // Insert after every item due at or before it: stable for equal times.
        let at = self.items.partition_point(|(d, _)| *d <= due_ms);
        self.items.insert(at, (due_ms, frame));
    }

    /// Remove and return every frame due at `now_ms`, in due order.
    pub fn take_due(&mut self, now_ms: i64) -> Vec<Vec<u8>> {
        let n = self.items.partition_point(|(d, _)| *d <= now_ms);
        self.items.drain(..n).map(|(_, f)| f).collect()
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

impl Default for Schedule {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn releases_frames_in_due_order() {
        let mut s = Schedule::new();
        s.push(300, b"c".to_vec());
        s.push(100, b"a".to_vec());
        s.push(200, b"b1".to_vec());
        s.push(200, b"b2".to_vec());
        assert!(s.take_due(99).is_empty());
        assert_eq!(s.take_due(200), vec![b"a".to_vec(), b"b1".to_vec(), b"b2".to_vec()]);
        assert_eq!(s.len(), 1);
        assert_eq!(s.take_due(1000), vec![b"c".to_vec()]);
        assert!(s.is_empty());
    }
}
