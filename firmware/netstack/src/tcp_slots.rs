//! A fixed table of `N` TCP connections behind one listening port: the server side of
//! several concurrent wss clients (docs/design/p4-c6-split.md §4.3.1). Each slot is an
//! ordinary [`TcpConn`]; this module only decides which slot an inbound datagram belongs
//! to. Demux is by the peer's (address, port): our side of the 4-tuple is the same for
//! every slot (one IP, one port), and each `TcpConn` still checks it itself.
//!
//! The rules, in order:
//!
//! 1. A slot already bound to the segment's peer (any state but `Listen`) takes it.
//! 2. Otherwise the first `Listen` slot takes it: a SYN latches that slot, anything
//!    else is answered with a RST there, exactly as the single listener does.
//! 3. Otherwise every slot is busy. A slot that is NOT a live, serving session takes
//!    the segment, so a new SYN is silently dropped (the client retries in ~1 s, by
//!    which time a closing slot has re-listened). Only when every slot is live and
//!    serving does slot 0 take it, and a new SYN gets the RST|ACK refusal of
//!    [`TcpConn::set_serving_live`] (the client backs off instead of hanging).
//!
//! With `N == 1` every datagram goes to slot 0, so the single-connection behaviour is
//! unchanged: the busy-slot drop and the serving-live RST are the `TcpConn`'s own.

use crate::tcp::{State, TcpConn};

pub struct TcpSlots<const N: usize> {
    pub slots: [Option<TcpConn>; N],
}

impl<const N: usize> TcpSlots<N> {
    pub const fn new() -> Self {
        TcpSlots { slots: [const { None }; N] }
    }

    /// The slot that `ip` (an inbound IPv4 datagram) belongs to, by the rules above.
    /// `None` only when no slot holds a connection yet.
    pub fn route(&self, ip: &[u8]) -> Option<usize> {
        let first = self.slots.iter().position(|c| c.is_some())?;
        if N == 1 || ip.len() < 20 {
            return Some(first);
        }
        let ihl = ((ip[0] & 0x0f) as usize) * 4;
        if ip.len() < ihl + 20 {
            return Some(first);
        }
        let mut addr = [0u8; 4];
        addr.copy_from_slice(&ip[12..16]);
        let port = ((ip[ihl] as u16) << 8) | ip[ihl + 1] as u16;
        let bound = self.slots.iter().position(|c| {
            c.as_ref().is_some_and(|c| c.state != State::Listen && c.peer() == (addr, port))
        });
        if bound.is_some() {
            return bound;
        }
        let listening = self.slots.iter().position(|c| c.as_ref().is_some_and(|c| c.state == State::Listen));
        if listening.is_some() {
            return listening;
        }
        let quiet = self.slots.iter().position(|c| {
            c.as_ref().is_some_and(|c| !(c.state == State::Established && c.serving_live()))
        });
        Some(quiet.unwrap_or(first))
    }

    /// Feed an inbound datagram to the slot it belongs to; returns the reply's length in
    /// `out` (0 = nothing to send), as [`TcpConn::on_ip`].
    pub fn on_ip(&mut self, now_ms: u32, ip: &[u8], out: &mut [u8]) -> usize {
        match self.route(ip) {
            Some(i) => self.slots[i].as_mut().map_or(0, |c| c.on_ip(now_ms, ip, out)),
            None => 0,
        }
    }

    /// Slots holding a connection that is mid-accept or established (SynRcvd /
    /// Established / FinWait): the sessions the app is serving or about to.
    pub fn busy(&self) -> usize {
        self.slots
            .iter()
            .filter(|c| {
                c.as_ref()
                    .is_some_and(|c| matches!(c.state, State::SynRcvd | State::Established | State::FinWait))
            })
            .count()
    }
}

impl<const N: usize> Default for TcpSlots<N> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SRV: [u8; 4] = [10, 0, 0, 2];
    const PORT: u16 = 443;

    fn listening<const N: usize>() -> TcpSlots<N> {
        let mut t = TcpSlots::<N>::new();
        for (i, s) in t.slots.iter_mut().enumerate() {
            *s = Some(TcpConn::listen(SRV, PORT, 0x3000 + 0x10_0000 * i as u32));
        }
        t
    }

    fn state<const N: usize>(t: &TcpSlots<N>, i: usize) -> State {
        t.slots[i].as_ref().unwrap().state
    }

    fn is_rst(seg: &[u8]) -> bool {
        let ihl = ((seg[0] & 0x0f) as usize) * 4;
        seg[ihl + 13] & 0x04 != 0
    }

    /// A client driven against the table: SYN, the SYN-ACK back, the final ACK.
    fn connect<const N: usize>(t: &mut TcpSlots<N>, ip: [u8; 4], port: u16, iss: u32) -> TcpConn {
        let mut cli = TcpConn::new(ip, SRV, port, PORT, iss);
        let mut a = [0u8; 1600];
        let mut b = [0u8; 1600];
        let n = cli.connect(&mut a);
        let r = t.on_ip(1, &a[..n], &mut b);
        assert!(r > 0, "the SYN is answered");
        let n = cli.on_ip(1, &b[..r], &mut a);
        assert_eq!(cli.state, State::Established);
        let _ = t.on_ip(1, &a[..n], &mut b);
        cli
    }

    fn slot_of<const N: usize>(t: &TcpSlots<N>, ip: [u8; 4], port: u16) -> Option<usize> {
        t.slots.iter().position(|c| c.as_ref().is_some_and(|c| c.peer() == (ip, port)))
    }

    #[test]
    fn empty_table_routes_nowhere() {
        let t = TcpSlots::<4>::new();
        assert_eq!(t.route(&[0x45; 40]), None);
        let mut t = t;
        let mut out = [0u8; 64];
        assert_eq!(t.on_ip(1, &[0x45; 40], &mut out), 0);
    }

    #[test]
    fn single_slot_routes_everything_to_slot_0() {
        let mut t = listening::<1>();
        let _a = connect(&mut t, [10, 0, 0, 1], 5000, 1000);
        assert_eq!(state(&t, 0), State::Established);
        // A different peer's SYN, a stray ACK, garbage: all slot 0 (its own rules apply).
        let mut other = TcpConn::new([10, 0, 0, 3], SRV, 6000, PORT, 2000);
        let mut a = [0u8; 1600];
        let n = other.connect(&mut a);
        assert_eq!(t.route(&a[..n]), Some(0));
        assert_eq!(t.route(&[0u8; 8]), Some(0));
    }

    #[test]
    fn single_slot_keeps_the_busy_slot_rules() {
        // The N == 1 table must behave exactly as the bare TcpConn did: a second peer's
        // SYN is dropped while the slot isn't serving, and RST-refused once it is.
        let mut t = listening::<1>();
        let _a = connect(&mut t, [10, 0, 0, 1], 5000, 1000);
        let mut b_cli = TcpConn::new([10, 0, 0, 3], SRV, 6000, PORT, 2000);
        let mut a = [0u8; 1600];
        let mut b = [0u8; 1600];
        let n = b_cli.connect(&mut a);
        assert_eq!(t.on_ip(1, &a[..n], &mut b), 0, "not serving yet: dropped");
        t.slots[0].as_mut().unwrap().set_serving_live(true);
        let r = t.on_ip(2, &a[..n], &mut b);
        assert!(r > 0 && is_rst(&b[..r]), "serving: refused with a RST");
        assert_eq!(state(&t, 0), State::Established);
        assert_eq!(t.slots[0].as_ref().unwrap().peer(), ([10, 0, 0, 1], 5000));
    }

    #[test]
    fn several_peers_get_their_own_slots() {
        let mut t = listening::<4>();
        let peers = [([10, 0, 0, 1], 5000), ([10, 0, 0, 3], 5000), ([10, 0, 0, 1], 5001)];
        let mut clis: [Option<TcpConn>; 3] = [const { None }; 3];
        for (k, &(ip, port)) in peers.iter().enumerate() {
            clis[k] = Some(connect(&mut t, ip, port, 1000 + k as u32 * 100));
        }
        for (k, &(ip, port)) in peers.iter().enumerate() {
            assert_eq!(slot_of(&t, ip, port), Some(k), "first free slot, in arrival order");
            assert_eq!(state(&t, k), State::Established);
        }
        assert_eq!(state(&t, 3), State::Listen);
        assert_eq!(t.busy(), 3);

        // Data from each peer lands in its own slot only.
        let mut a = [0u8; 1600];
        let mut b = [0u8; 1600];
        for (k, cli) in clis.iter_mut().enumerate() {
            let cli = cli.as_mut().unwrap();
            let msg = [b'a' + k as u8; 10];
            cli.enqueue(&msg);
            let n = cli.pump_tx(10, &mut a);
            let r = t.on_ip(10, &a[..n], &mut b);
            assert!(r > 0, "data is ACKed");
        }
        for k in 0..3 {
            assert_eq!(t.slots[k].as_ref().unwrap().rx_data(), &[b'a' + k as u8; 10]);
        }
        assert!(t.slots[3].as_ref().unwrap().rx_data().is_empty());
    }

    #[test]
    fn a_retransmitted_syn_stays_on_its_slot() {
        let mut t = listening::<2>();
        let mut cli = TcpConn::new([10, 0, 0, 1], SRV, 5000, PORT, 1000);
        let mut a = [0u8; 1600];
        let mut b = [0u8; 1600];
        let n = cli.connect(&mut a);
        let _ = t.on_ip(1, &a[..n], &mut b);
        assert_eq!(state(&t, 0), State::SynRcvd);
        // The same SYN again (our SYN-ACK was lost): slot 0 again, not a second slot.
        assert_eq!(t.route(&a[..n]), Some(0));
        let _ = t.on_ip(2, &a[..n], &mut b);
        assert_eq!(state(&t, 1), State::Listen);
    }

    #[test]
    fn full_table_drops_a_new_syn_until_every_slot_serves() {
        let mut t = listening::<2>();
        let _a = connect(&mut t, [10, 0, 0, 1], 5000, 1000);
        let _b = connect(&mut t, [10, 0, 0, 3], 5000, 2000);
        let mut c = TcpConn::new([10, 0, 0, 4], SRV, 7000, PORT, 3000);
        let mut a = [0u8; 1600];
        let mut b = [0u8; 1600];
        let n = c.connect(&mut a);

        // Slot 1 is still pre-WS: the SYN is dropped there (it may free up soon).
        t.slots[0].as_mut().unwrap().set_serving_live(true);
        assert_eq!(t.route(&a[..n]), Some(1));
        assert_eq!(t.on_ip(1, &a[..n], &mut b), 0);

        // Every slot live and serving: refused with a RST, and nothing moves.
        t.slots[1].as_mut().unwrap().set_serving_live(true);
        let r = t.on_ip(2, &a[..n], &mut b);
        assert!(r > 0 && is_rst(&b[..r]));
        assert_eq!(&b[16..20], &[10, 0, 0, 4], "the RST goes to the refused client");
        assert_eq!((state(&t, 0), state(&t, 1)), (State::Established, State::Established));
        assert_eq!(slot_of(&t, [10, 0, 0, 4], 7000), None);
    }

    #[test]
    fn a_closing_slot_never_refuses() {
        // A slot that is closing (the app disarmed serving_live) must not RST the closing
        // client's own reconnect: with the other slot serving, the SYN lands on the closing
        // slot and is dropped, so the client retries onto the re-listened slot.
        let mut t = listening::<2>();
        let _a = connect(&mut t, [10, 0, 0, 1], 5000, 1000);
        let _b = connect(&mut t, [10, 0, 0, 3], 5000, 2000);
        t.slots[0].as_mut().unwrap().set_serving_live(true);
        t.slots[1].as_mut().unwrap().set_serving_live(false); // closing
        let mut again = TcpConn::new([10, 0, 0, 3], SRV, 5001, PORT, 4000);
        let mut a = [0u8; 1600];
        let mut b = [0u8; 1600];
        let n = again.connect(&mut a);
        assert_eq!(t.on_ip(1, &a[..n], &mut b), 0);

        // The app re-listens slot 1; the retried SYN latches it.
        t.slots[1] = Some(TcpConn::listen(SRV, PORT, 0x5000));
        let r = t.on_ip(2, &a[..n], &mut b);
        assert!(r > 0 && !is_rst(&b[..r]));
        assert_eq!(slot_of(&t, [10, 0, 0, 3], 5001), Some(1));
        assert_eq!(state(&t, 1), State::SynRcvd);
    }

    #[test]
    fn a_freed_slot_is_reused_and_a_stale_peer_gets_a_rst() {
        let mut t = listening::<2>();
        let mut a_cli = connect(&mut t, [10, 0, 0, 1], 5000, 1000);
        let _b_cli = connect(&mut t, [10, 0, 0, 3], 5000, 2000);
        // The app reclaims slot 0 (peer-gone): a fresh listener there.
        t.slots[0] = Some(TcpConn::listen(SRV, PORT, 0x6000));
        // The old peer's late data finds no bound slot: the listener RSTs it.
        let mut a = [0u8; 1600];
        let mut b = [0u8; 1600];
        a_cli.enqueue(b"late");
        let n = a_cli.pump_tx(5, &mut a);
        assert_eq!(t.route(&a[..n]), Some(0));
        let r = t.on_ip(5, &a[..n], &mut b);
        assert!(r > 0 && is_rst(&b[..r]));
        assert_eq!(state(&t, 0), State::Listen);
        // A new client takes the freed slot; slot 1 is untouched.
        let _c = connect(&mut t, [10, 0, 0, 4], 7000, 3000);
        assert_eq!(slot_of(&t, [10, 0, 0, 4], 7000), Some(0));
        assert_eq!(slot_of(&t, [10, 0, 0, 3], 5000), Some(1));
    }

    #[test]
    fn a_reset_closes_only_its_own_slot() {
        let mut t = listening::<3>();
        let mut a_cli = connect(&mut t, [10, 0, 0, 1], 5000, 1000);
        let _b_cli = connect(&mut t, [10, 0, 0, 3], 5000, 2000);
        let mut a = [0u8; 1600];
        let mut b = [0u8; 1600];
        let n = a_cli.close(&mut a); // FIN from peer A
        let _ = t.on_ip(3, &a[..n], &mut b);
        assert_ne!(state(&t, 0), State::Established);
        assert_eq!(state(&t, 1), State::Established);
        assert_eq!(state(&t, 2), State::Listen);
    }

    #[test]
    fn same_address_different_ports_are_different_sessions() {
        // A browser opens the wss and the cert-trust GET from one host on two ports.
        let mut t = listening::<2>();
        let _ws = connect(&mut t, [10, 0, 0, 1], 5000, 1000);
        let _get = connect(&mut t, [10, 0, 0, 1], 5002, 1500);
        assert_eq!(slot_of(&t, [10, 0, 0, 1], 5000), Some(0));
        assert_eq!(slot_of(&t, [10, 0, 0, 1], 5002), Some(1));
    }
}
