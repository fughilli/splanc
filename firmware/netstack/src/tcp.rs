//! Minimal heapless TCP/IPv4 client — enough to carry a TLS handshake + a small
//! request/response over the software CCMP data path. One connection, stop-and-wait
//! (a single unacknowledged data segment in flight), fixed buffers, no allocation.
//!
//! The caller frames L2/CCMP/802.11; this module produces and consumes IPv4 packets
//! (IP header + TCP). `Seg` output buffers are the full IP datagram ready for the
//! LLC/SNAP + CCMP encap the driver applies.

const IP_HDR: usize = 20;
const TCP_HDR: usize = 20;

/// TCP flags.
const FIN: u8 = 0x01;
const SYN: u8 = 0x02;
const RST: u8 = 0x04;
const PSH: u8 = 0x08;
const ACK: u8 = 0x10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Closed,
    Listen,   // passive open: waiting for an inbound SYN (server)
    SynSent,  // active open: SYN sent, awaiting SYN-ACK (client)
    SynRcvd,  // passive open: SYN-ACK sent, awaiting the final ACK (server)
    Established,
    FinWait,
    Done,
}

/// One's-complement Internet checksum over `data` seeded with `sum`.
fn csum(data: &[u8], mut sum: u32) -> u16 {
    let mut i = 0;
    while i + 1 < data.len() {
        sum += ((data[i] as u32) << 8) | data[i + 1] as u32;
        i += 2;
    }
    if i < data.len() {
        sum += (data[i] as u32) << 8;
    }
    while sum >> 16 != 0 {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    !sum as u16
}

pub struct TcpConn {
    src: [u8; 4],
    dst: [u8; 4],
    sport: u16,
    dport: u16,
    snd_nxt: u32, // next sequence we'll send
    snd_una: u32, // oldest unacked sequence
    rcv_nxt: u32, // next sequence we expect
    ip_id: u16,
    pub state: State,
    // Received application bytes, delivered to the caller via `take_rx`.
    rx: [u8; 1600],
    rx_len: usize,
    // Largest window we've advertised since the peer last filled us. On a big inbound
    // transfer (a 4096B upload window) rx fills, we advertise window=0, and — because we only
    // ACK on receive — the peer would stall forever. `window_ack()` emits a bare update once
    // the app drains rx and the window re-opens, so the transfer resumes. (Keeps rx small so
    // BLE GATT still has DMA-capable heap under the full-runtime drop-in.)
    last_adv_wnd: u32,
    // True once we've advertised a zero window and the peer hasn't delivered data since.
    // The peer then zero-window-probes with bare segments; we must re-advertise the open
    // window on EVERY probe until data flows again, so a single lost window-update ACK
    // can't wedge a large transfer on a lossy link. Cleared only on data receipt.
    window_closed: bool,
    // Outbound SEND WINDOW (replaces the old stop-and-wait single segment). `snd_buf`
    // holds unacknowledged application bytes; `snd_buf[0]` is sequence `snd_una`. Bytes
    // [0..sent) are in flight (transmitted, unacked); [sent..len) are buffered but not yet
    // on air. Segments stream out up to the peer's advertised window, so replies/streams
    // pipeline (many segments in flight) instead of one-per-RTT — the difference between
    // ~1 msg/RTT and line rate for a 1000-message uniform blast or an LED stream.
    snd_buf: [u8; SND_BUF],
    snd_len: usize,  // buffered unacked bytes
    sent: usize,     // how many of them have been transmitted (in flight)
    peer_wnd: u32,   // peer's advertised receive window, from inbound ACKs (wscale 0)
    // Retransmit timeout for the oldest in-flight data. The stack owns its own RTO; on
    // expiry it goes back-N (rewinds `sent` to 0) so the whole window is resent.
    tx_at_ms: u32,   // clock when the RTO was armed (0 = nothing in flight / disarmed)
    rto_ms: u32,     // current retransmit timeout, doubled on each expiry (capped)
}

const RTO_INITIAL_MS: u32 = 300;
const RTO_MAX_MS: u32 = 2000;
/// Outbound window buffer: bytes we may have in flight + queued at once. Bounds RAM and
/// the reply/stream burst we can pipeline before an ACK must free space. Kept close to the
/// old single-segment size on purpose — this struct is a static, and every extra byte here
/// is a byte off the contiguous heap that mbedtls's ~8.5KB record buffer must fit into on
/// each new connection (the C6's tight, un-growable Arduino-mbedtls budget). 2KB still lets
/// many small replies coalesce + pipeline (the uniform-blast / LED-stream win) vs stop-and-wait.
const SND_BUF: usize = 2048;
/// Max TCP payload per segment (matches the MSS we advertise on SYN).
const SND_MSS: usize = 1400;

/// A produced IP datagram to transmit (borrows the connection's tx scratch).
pub struct Seg<'a>(pub &'a [u8]);

impl TcpConn {
    pub fn new(src: [u8; 4], dst: [u8; 4], sport: u16, dport: u16, iss: u32) -> Self {
        TcpConn {
            src, dst, sport, dport,
            snd_nxt: iss, snd_una: iss, rcv_nxt: 0, ip_id: 1,
            state: State::Closed,
            rx: [0; 1600], rx_len: 0,
            last_adv_wnd: 0,
            window_closed: false,
            snd_buf: [0; SND_BUF], snd_len: 0, sent: 0, peer_wnd: 0,
            tx_at_ms: 0, rto_ms: RTO_INITIAL_MS,
        }
    }

    /// Build the initial SYN into `out`; returns its length. Moves to SynSent.
    pub fn connect(&mut self, out: &mut [u8]) -> usize {
        let n = self.build(SYN, self.snd_nxt, &[], out);
        self.snd_nxt = self.snd_nxt.wrapping_add(1); // SYN consumes a sequence number
        self.state = State::SynSent;
        n
    }

    /// A passive-open listener bound to our `src`/`sport`. The peer (`dst`/`dport`) is
    /// latched from the first inbound SYN; `iss` is our initial send sequence. Drive it
    /// with `on_ip`: an inbound SYN produces a SYN-ACK reply and moves to SynRcvd; the
    /// final ACK moves to Established. Enables the app to be a WSS/TLS server.
    pub fn listen(src: [u8; 4], sport: u16, iss: u32) -> Self {
        let mut c = TcpConn::new(src, [0; 4], sport, 0, iss);
        c.state = State::Listen;
        c
    }

    /// Application data pending delivery; the caller copies then calls `take_rx`.
    pub fn rx_data(&self) -> &[u8] {
        &self.rx[..self.rx_len]
    }
    pub fn take_rx(&mut self) {
        self.rx_len = 0;
    }
    /// Consume only the first `n` received bytes, keeping the rest (TLS/mbedtls reads the
    /// stream incrementally — record header, then body — so a full drain would lose data).
    pub fn take_rx_n(&mut self, n: usize) {
        let n = n.min(self.rx_len);
        self.rx.copy_within(n..self.rx_len, 0);
        self.rx_len -= n;
    }

    /// Queue application data into the send window. Copies what fits (bounded by the
    /// free space in `snd_buf`) and returns how many bytes were accepted — the caller
    /// (mbedtls BIO) advances by that, and retries the rest once ACKs free space. Emits
    /// nothing itself; call `pump_tx` to put segments on air.
    pub fn enqueue(&mut self, data: &[u8]) -> usize {
        if self.state != State::Established {
            return 0;
        }
        let room = SND_BUF - self.snd_len;
        let n = data.len().min(room);
        self.snd_buf[self.snd_len..self.snd_len + n].copy_from_slice(&data[..n]);
        self.snd_len += n;
        n
    }

    /// Free space in the send window (bytes a subsequent `enqueue` would accept).
    pub fn tx_room(&self) -> usize {
        SND_BUF - self.snd_len
    }

    /// Put the next in-flight segment on air if the peer's window allows, building it into
    /// `out`. Returns its length, or 0 if nothing to send / the window is full. Call
    /// repeatedly (each loop and after `enqueue`) to stream the window out; arms the RTO
    /// on the first segment of a burst.
    pub fn pump_tx(&mut self, now_ms: u32, out: &mut [u8]) -> usize {
        if self.state != State::Established || self.sent >= self.snd_len {
            return 0; // nothing buffered-but-unsent
        }
        // Don't put more than the peer said it can hold in flight at once. Treat a
        // never-seen window (0 before the first ACK) as one segment to get started.
        let wnd = if self.peer_wnd == 0 { SND_MSS as u32 } else { self.peer_wnd };
        if self.sent as u32 >= wnd {
            return 0; // in-flight bytes already fill the peer's window
        }
        let avail = (wnd as usize - self.sent).min(self.snd_len - self.sent);
        let n = avail.min(SND_MSS);
        if n == 0 {
            return 0;
        }
        let seq = self.snd_una.wrapping_add(self.sent as u32);
        let start = self.sent;
        // Copy the payload out of snd_buf first (build borrows `out`, not self.snd_buf).
        let mut seg = [0u8; SND_MSS];
        seg[..n].copy_from_slice(&self.snd_buf[start..start + n]);
        let len = self.build(PSH | ACK, seq, &seg[..n], out);
        self.sent += n;
        self.snd_nxt = self.snd_una.wrapping_add(self.sent as u32);
        if self.tx_at_ms == 0 {
            self.tx_at_ms = now_ms.max(1); // arm the RTO on the first segment in flight
        }
        len
    }

    /// Emit a bare window-update ACK when the receive window has re-opened since our last
    /// advertisement (the app drained rx). We only ACK on receive, so on a big inbound
    /// transfer that filled rx to window=0 the peer would stall forever waiting for space to
    /// free up. Call this after draining rx (take_rx*). Returns the ACK length, or 0 if there's
    /// nothing worth announcing. Cheap: one bare segment only when the window actually grew.
    pub fn window_ack(&mut self, out: &mut [u8]) -> usize {
        if self.state != State::Established {
            return 0;
        }
        let wnd = (self.rx.len() - self.rx_len) as u32;
        // Announce only a meaningful re-open (avoids an ACK per drained byte).
        if wnd > self.last_adv_wnd && wnd - self.last_adv_wnd >= (self.rx.len() as u32) / 2 {
            let seq = self.snd_nxt;
            return self.build(ACK, seq, &[], out); // build() refreshes last_adv_wnd
        }
        0
    }

    /// Advance the retransmit clock. The stack owns its own RTO: when the single in-flight
    /// segment's timer expires (armed on the first tick after `send`), copy it into `out`
    /// for retransmit and back off (exponential, capped). Returns the segment length, else 0.
    /// The caller drives this once per poll with a millisecond clock — the app never decides
    /// *whether* to retransmit, only supplies the time and carries the bytes.
    pub fn tick(&mut self, now_ms: u32, out: &mut [u8]) -> usize {
        if self.sent == 0 {
            return 0; // nothing in flight
        }
        if self.tx_at_ms == 0 {
            self.tx_at_ms = now_ms.max(1); // arm on the first tick after a segment went out
            return 0;
        }
        if now_ms.wrapping_sub(self.tx_at_ms) < self.rto_ms {
            return 0;
        }
        // RTO fired: go back N — rewind the window and resend from the oldest unacked
        // byte. `pump_tx` re-arms the timer as the first resent segment goes out.
        self.rto_ms = (self.rto_ms.saturating_mul(2)).min(RTO_MAX_MS);
        self.sent = 0;
        self.snd_nxt = self.snd_una;
        self.tx_at_ms = 0;
        self.pump_tx(now_ms, out)
    }

    /// Begin an active close: send FIN|ACK. Returns its length.
    pub fn close(&mut self, out: &mut [u8]) -> usize {
        if self.state != State::Established {
            return 0;
        }
        let n = self.build(FIN | ACK, self.snd_nxt, &[], out);
        self.snd_nxt = self.snd_nxt.wrapping_add(1);
        self.state = State::FinWait;
        n
    }

    /// Process an inbound IPv4 datagram. Returns the length of any reply to send in
    /// `out` (an ACK, or nothing = 0). Updates state and buffers received data.
    pub fn on_ip(&mut self, ip: &[u8], out: &mut [u8]) -> usize {
        if ip.len() < IP_HDR + TCP_HDR || ip[9] != 6 {
            return 0; // not TCP
        }
        let ihl = ((ip[0] & 0x0f) as usize) * 4;
        // Must be addressed to us on our port.
        if ip[16..20] != self.src {
            return 0;
        }
        let tcp = &ip[ihl..];
        let sport = ((tcp[0] as u16) << 8) | tcp[1] as u16;
        let dport = ((tcp[2] as u16) << 8) | tcp[3] as u16;
        if dport != self.sport {
            return 0;
        }
        // A Listener latches its peer from the first SYN; every other state requires the
        // already-bound peer to match.
        if self.state != State::Listen && (ip[12..16] != self.dst || sport != self.dport) {
            return 0;
        }
        let seq = u32::from_be_bytes([tcp[4], tcp[5], tcp[6], tcp[7]]);
        let ack = u32::from_be_bytes([tcp[8], tcp[9], tcp[10], tcp[11]]);
        let flags = tcp[13];
        let data_off = ((tcp[12] >> 4) as usize) * 4;
        let payload = &tcp[data_off..];

        if flags & RST != 0 {
            self.state = State::Done;
            return 0;
        }

        // Process an ACK against the send window: free acknowledged bytes from snd_buf,
        // advance snd_una, refresh the peer's advertised receive window, and reset the RTO
        // (a fresh timer for whatever remains in flight). SYN/FIN consume a sequence but
        // aren't in snd_buf; snd_len is 0 then, so no data bytes are removed.
        if flags & ACK != 0 {
            let acked = ack.wrapping_sub(self.snd_una);
            let unacked = self.snd_nxt.wrapping_sub(self.snd_una);
            if acked > 0 && acked <= unacked {
                let data_acked = (acked as usize).min(self.snd_len);
                if data_acked > 0 {
                    self.snd_buf.copy_within(data_acked..self.snd_len, 0);
                    self.snd_len -= data_acked;
                    self.sent = self.sent.saturating_sub(data_acked);
                }
                self.snd_una = ack;
                self.rto_ms = RTO_INITIAL_MS;
                self.tx_at_ms = 0; // re-armed by pump_tx/tick if data is still in flight
            }
            // Peer's advertised receive window (we send window-scale 0, so it's unscaled).
            self.peer_wnd = ((tcp[14] as u32) << 8) | tcp[15] as u32;
        }

        match self.state {
            State::Listen => {
                // Passive open: an inbound SYN latches the peer and gets a SYN-ACK.
                if flags & SYN != 0 && flags & ACK == 0 {
                    self.dst.copy_from_slice(&ip[12..16]);
                    self.dport = sport;
                    self.rcv_nxt = seq.wrapping_add(1);
                    let n = self.build(SYN | ACK, self.snd_nxt, &[], out);
                    self.snd_nxt = self.snd_nxt.wrapping_add(1); // SYN-ACK's SYN consumes a seq
                    self.state = State::SynRcvd;
                    return n;
                }
                0
            }
            State::SynRcvd => {
                // A retransmitted SYN (our SYN-ACK was lost) → resend the SYN-ACK.
                if flags & SYN != 0 && flags & ACK == 0 {
                    return self.build(SYN | ACK, self.snd_nxt.wrapping_sub(1), &[], out);
                }
                // The final ACK completes the 3-way handshake.
                if flags & ACK != 0 && ack == self.snd_nxt {
                    self.state = State::Established;
                }
                // The client often piggybacks its first data (e.g. TLS ClientHello) here.
                if !payload.is_empty() && seq == self.rcv_nxt {
                    let n = payload.len().min(self.rx.len() - self.rx_len);
                    self.rx[self.rx_len..self.rx_len + n].copy_from_slice(&payload[..n]);
                    self.rx_len += n;
                    self.rcv_nxt = self.rcv_nxt.wrapping_add(n as u32);
                    return self.build(ACK, self.snd_nxt, &[], out);
                }
                0
            }
            State::SynSent => {
                if flags & SYN != 0 && flags & ACK != 0 {
                    self.rcv_nxt = seq.wrapping_add(1); // SYN consumes a sequence
                    self.state = State::Established;
                    return self.build(ACK, self.snd_nxt, &[], out);
                }
                0
            }
            State::Established | State::FinWait => {
                let mut reply = 0;
                if !payload.is_empty() {
                    // In-order data: buffer what fits (partial accept when the window is
                    // tight) and advance rcv_nxt.
                    if seq == self.rcv_nxt {
                        let n = payload.len().min(self.rx.len() - self.rx_len);
                        self.rx[self.rx_len..self.rx_len + n].copy_from_slice(&payload[..n]);
                        self.rx_len += n;
                        self.rcv_nxt = self.rcv_nxt.wrapping_add(n as u32);
                        // The peer delivered data, so it has acted on our advertised window —
                        // it's no longer blocked/probing on a zero window.
                        self.window_closed = false;
                    }
                    // ALWAYS ACK a data segment — whether we accepted it, dropped it at a
                    // zero window, or it's a pure duplicate/retransmit of bytes we already
                    // took. A peer retransmits precisely because our earlier ACK was lost;
                    // on a lossy link the old "ACK only in-order data once" wedges forever
                    // (a single dropped ACK => the peer resends that segment for good, and
                    // we never re-ACK it because rcv_nxt has moved past it). Re-ACKing our
                    // true rcv_nxt on every retransmit lets the peer resync and advance.
                    // (Observed stalling a multi-record upload mid-first-chunk on silicon.)
                    reply = self.build(ACK, self.snd_nxt, &[], out);
                } else if self.window_closed && self.rx.len() - self.rx_len > 0 {
                    // A bare zero-window probe, and our window has since re-opened (the app
                    // drained rx). Re-advertise it. We keep answering probes until the peer
                    // sends data (which clears window_closed), so a lost window-update ACK
                    // can't deadlock the transfer.
                    reply = self.build(ACK, self.snd_nxt, &[], out);
                }
                if flags & FIN != 0 && seq.wrapping_add(payload.len() as u32) == self.rcv_nxt {
                    self.rcv_nxt = self.rcv_nxt.wrapping_add(1); // FIN consumes a seq
                    reply = self.build(ACK, self.snd_nxt, &[], out);
                    self.state = State::Done;
                }
                reply
            }
            _ => 0,
        }
    }

    /// Build an IPv4 + TCP segment with `flags`, sequence `seq`, and `data`. SYN-bearing
    /// segments (SYN, SYN-ACK) carry a 4-byte MSS option — a bare optionless SYN-ACK is
    /// rejected/undeliverable by some peers and middleboxes, stalling the data phase.
    fn build(&mut self, flags: u8, seq: u32, data: &[u8], out: &mut [u8]) -> usize {
        let opt_len = if flags & SYN != 0 { 12 } else { 0 };
        let total = IP_HDR + TCP_HDR + opt_len + data.len();
        // IPv4 header.
        out[0] = 0x45;
        out[1] = 0;
        out[2..4].copy_from_slice(&(total as u16).to_be_bytes());
        out[4..6].copy_from_slice(&self.ip_id.to_be_bytes());
        self.ip_id = self.ip_id.wrapping_add(1);
        out[6] = 0x40; // DF
        out[7] = 0;
        out[8] = 64; // TTL
        out[9] = 6; // TCP
        out[10] = 0;
        out[11] = 0;
        out[12..16].copy_from_slice(&self.src);
        out[16..20].copy_from_slice(&self.dst);
        let ipc = csum(&out[..IP_HDR], 0);
        out[10..12].copy_from_slice(&ipc.to_be_bytes());
        // TCP header.
        let t = &mut out[IP_HDR..];
        t[0..2].copy_from_slice(&self.sport.to_be_bytes());
        t[2..4].copy_from_slice(&self.dport.to_be_bytes());
        t[4..8].copy_from_slice(&seq.to_be_bytes());
        t[8..12].copy_from_slice(&self.rcv_nxt.to_be_bytes());
        t[12] = (((TCP_HDR + opt_len) / 4) as u8) << 4; // data offset (5 words, or 6 w/ MSS)
        t[13] = flags;
        // Advertise the free receive-buffer space (never more than we can hold).
        let win = (self.rx.len() - self.rx_len).min(0xffff) as u16;
        self.last_adv_wnd = win as u32;  // remember it so window_ack() can spot a re-open
        if win == 0 {
            self.window_closed = true; // peer will zero-window-probe until we re-advertise
        }
        t[14..16].copy_from_slice(&win.to_be_bytes());
        t[16] = 0;
        t[17] = 0;
        t[18..20].copy_from_slice(&0u16.to_be_bytes()); // urgent
        if opt_len == 12 {
            // A standard SYN/SYN-ACK option set so the rig's conntrack doesn't mark our
            // data INVALID: MSS(1400) + SACK-permitted + window-scale(0) + NOP padding.
            let o = &mut t[20..32];
            o[0] = 2; o[1] = 4; o[2..4].copy_from_slice(&1400u16.to_be_bytes()); // MSS
            o[4] = 4; o[5] = 2; // SACK-permitted
            o[6] = 3; o[7] = 3; o[8] = 0; // window scale, shift 0
            o[9] = 1; o[10] = 1; o[11] = 1; // NOP padding to 4-byte boundary
        }
        t[TCP_HDR + opt_len..TCP_HDR + opt_len + data.len()].copy_from_slice(data);
        // TCP checksum over the pseudo-header + segment.
        let seg_len = TCP_HDR + opt_len + data.len();
        let mut pseudo = [0u8; 12];
        pseudo[0..4].copy_from_slice(&self.src);
        pseudo[4..8].copy_from_slice(&self.dst);
        pseudo[8] = 0;
        pseudo[9] = 6;
        pseudo[10..12].copy_from_slice(&(seg_len as u16).to_be_bytes());
        let mut sum = 0u32;
        let mut i = 0;
        while i + 1 < pseudo.len() {
            sum += ((pseudo[i] as u32) << 8) | pseudo[i + 1] as u32;
            i += 2;
        }
        let tc = csum(&out[IP_HDR..IP_HDR + seg_len], sum);
        out[IP_HDR + 16..IP_HDR + 18].copy_from_slice(&tc.to_be_bytes());
        total
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Loopback two TcpConns through each other to exercise the handshake + data.
    #[test]
    fn handshake_and_echo() {
        let a_ip = [10, 0, 0, 1];
        let b_ip = [10, 0, 0, 2];
        let mut a = TcpConn::new(a_ip, b_ip, 5000, 80, 1000);
        let mut b = TcpConn::new(b_ip, a_ip, 80, 5000, 9000);
        // B behaves as a passive peer we drive by hand via on_ip.
        let mut buf = [0u8; 1600];
        let mut buf2 = [0u8; 1600];

        // A: SYN -> B
        let n = a.connect(&mut buf);
        // B is Closed; simulate a server: craft SYN-ACK by hand isn't trivial, so
        // instead just verify A builds a valid SYN and transitions.
        assert_eq!(a.state, State::SynSent);
        assert!(n >= IP_HDR + TCP_HDR);
        // Feed a synthetic SYN-ACK back to A.
        let synack = b.synack_for(&buf[..n], &mut buf2);
        let r = a.on_ip(&buf2[..synack], &mut buf);
        assert_eq!(a.state, State::Established);
        assert!(r >= IP_HDR + TCP_HDR); // A ACKs
    }

    // Full passive-open: a listener completes the 3-way handshake with an active client
    // and exchanges data (the server path the WSS/TLS endpoint needs).
    #[test]
    fn passive_open_and_data() {
        let cli_ip = [10, 0, 0, 1];
        let srv_ip = [10, 0, 0, 2];
        let mut cli = TcpConn::new(cli_ip, srv_ip, 5000, 443, 1000);
        let mut srv = TcpConn::listen(srv_ip, 443, 9000);
        let mut a = [0u8; 1600];
        let mut b = [0u8; 1600];

        let n = cli.connect(&mut a); // client SYN
        let r = srv.on_ip(&a[..n], &mut b); // server latches peer + SYN-ACK
        assert_eq!(srv.state, State::SynRcvd);
        assert_eq!(srv.dst, cli_ip);
        assert_eq!(srv.dport, 5000);
        assert!(r > 0);
        let n = cli.on_ip(&b[..r], &mut a); // client -> Established, sends ACK
        assert_eq!(cli.state, State::Established);
        assert!(n > 0);
        let _ = srv.on_ip(&a[..n], &mut b); // server -> Established on the final ACK
        assert_eq!(srv.state, State::Established);

        // Client -> server data; server buffers + ACKs; client's send window drains on ACK.
        cli.enqueue(b"GET / HTTP/1.1");
        let n = cli.pump_tx(1000, &mut a);
        let r = srv.on_ip(&a[..n], &mut b);
        assert_eq!(srv.rx_data(), b"GET / HTTP/1.1");
        assert!(r > 0);
        let _ = cli.on_ip(&b[..r], &mut a);
        assert_eq!(cli.snd_len, 0);

        // Server -> client data (a TLS record flight would be several of these).
        srv.take_rx();
        srv.enqueue(b"HTTP/1.1 101\r\n\r\n");
        let n = srv.pump_tx(1000, &mut b);
        let _ = cli.on_ip(&b[..n], &mut a);
        assert_eq!(cli.rx_data(), b"HTTP/1.1 101\r\n\r\n");
    }

    #[test]
    fn send_window_pipelines_multiple_segments() {
        // Establish a connection, then prove the send window puts SEVERAL segments in
        // flight before any ACK (the whole point vs stop-and-wait), bounded by the peer's
        // advertised window, and that a cumulative ACK frees the buffer.
        let (cli_ip, srv_ip) = ([10, 0, 0, 1], [10, 0, 0, 2]);
        let mut cli = TcpConn::new(cli_ip, srv_ip, 5000, 443, 1000);
        let mut srv = TcpConn::listen(srv_ip, 443, 9000);
        let (mut a, mut b) = ([0u8; 1600], [0u8; 1600]);
        let n = cli.connect(&mut a);
        let r = srv.on_ip(&a[..n], &mut b);
        let n = cli.on_ip(&b[..r], &mut a);
        let _ = srv.on_ip(&a[..n], &mut b); // both Established; peer_wnd learned from the handshake
        assert!(srv.peer_wnd >= 1500);

        // Pipelining: enqueue 2000 bytes (fits the send buffer), then pump TWICE with no ACK
        // in between — a second segment must go out before the first is acknowledged
        // (stop-and-wait would emit exactly one).
        const N: usize = 2000;
        let payload = [0x5au8; N];
        assert_eq!(srv.enqueue(&payload), N);
        let s1 = srv.pump_tx(1000, &mut b);
        let mut a2 = [0u8; 1600];
        let s2 = srv.pump_tx(1000, &mut a2);
        assert!(s1 > 0 && s2 > 0, "two segments in flight before any ACK: {s1},{s2}");
        assert_eq!(srv.sent, 1600, "in-flight capped at the peer's 1600-byte window");

        // Deliver everything: the client buffers + ACKs each segment and drains so its window
        // reopens; the server streams the rest. All 2000 bytes arrive, in order.
        let mut delivered = 0usize;
        // The first two segments (s1 in `b`, s2 in `a2`) went out before any ACK.
        let r = cli.on_ip(&b[..s1], &mut a);
        delivered += cli.rx_len;
        cli.take_rx();
        if r > 0 {
            let _ = srv.on_ip(&a[..r], &mut b);
        }
        let r = cli.on_ip(&a2[..s2], &mut a);
        delivered += cli.rx_len;
        cli.take_rx();
        if r > 0 {
            let _ = srv.on_ip(&a[..r], &mut b);
        }
        for _ in 0..60 {
            if srv.snd_len == 0 {
                break;
            }
            let m = srv.pump_tx(1000, &mut b);
            if m > 0 {
                let r = cli.on_ip(&b[..m], &mut a);
                delivered += cli.rx_len;
                cli.take_rx();
                if r > 0 {
                    let _ = srv.on_ip(&a[..r], &mut b);
                }
            } else {
                let mut w = [0u8; 80];
                let wn = cli.window_ack(&mut w);
                if wn > 0 {
                    let _ = srv.on_ip(&w[..wn], &mut b);
                }
            }
        }
        assert_eq!(delivered, N, "all bytes delivered in order");
        assert_eq!(srv.snd_len, 0, "send buffer fully acknowledged");
    }

    impl TcpConn {
        // Test helper: given A's SYN, produce a SYN-ACK from B.
        fn synack_for(&mut self, syn_ip: &[u8], out: &mut [u8]) -> usize {
            let ihl = ((syn_ip[0] & 0x0f) as usize) * 4;
            let tcp = &syn_ip[ihl..];
            let seq = u32::from_be_bytes([tcp[4], tcp[5], tcp[6], tcp[7]]);
            self.rcv_nxt = seq.wrapping_add(1);
            self.state = State::Established;
            self.build(SYN | ACK, self.snd_nxt, &[], out)
        }
    }
}
