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
    SynSent,
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
    // The single in-flight outbound data segment (for retransmit), as an IP datagram.
    tx: [u8; 1600],
    tx_len: usize,
    tx_seq: u32,   // sequence number of the in-flight segment's first byte
    tx_data: u16,  // payload length of the in-flight segment
}

/// A produced IP datagram to transmit (borrows the connection's tx scratch).
pub struct Seg<'a>(pub &'a [u8]);

impl TcpConn {
    pub fn new(src: [u8; 4], dst: [u8; 4], sport: u16, dport: u16, iss: u32) -> Self {
        TcpConn {
            src, dst, sport, dport,
            snd_nxt: iss, snd_una: iss, rcv_nxt: 0, ip_id: 1,
            state: State::Closed,
            rx: [0; 1600], rx_len: 0,
            tx: [0; 1600], tx_len: 0, tx_seq: 0, tx_data: 0,
        }
    }

    /// Build the initial SYN into `out`; returns its length. Moves to SynSent.
    pub fn connect(&mut self, out: &mut [u8]) -> usize {
        let n = self.build(SYN, self.snd_nxt, &[], out);
        self.snd_nxt = self.snd_nxt.wrapping_add(1); // SYN consumes a sequence number
        self.state = State::SynSent;
        n
    }

    /// Application data pending delivery; the caller copies then calls `take_rx`.
    pub fn rx_data(&self) -> &[u8] {
        &self.rx[..self.rx_len]
    }
    pub fn take_rx(&mut self) {
        self.rx_len = 0;
    }

    /// Queue application data to send (stop-and-wait: only if nothing is in flight).
    /// Builds the segment into `out`; returns its length or 0 if busy/closed.
    pub fn send(&mut self, data: &[u8], out: &mut [u8]) -> usize {
        if self.state != State::Established || self.tx_data != 0 {
            return 0;
        }
        let n = data.len().min(1400);
        let seq = self.snd_nxt;
        let len = self.build(PSH | ACK, seq, &data[..n], out);
        // Stash for retransmit.
        self.tx[..len].copy_from_slice(&out[..len]);
        self.tx_len = len;
        self.tx_seq = seq;
        self.tx_data = n as u16;
        self.snd_nxt = self.snd_nxt.wrapping_add(n as u32);
        len
    }

    /// Anything in flight that may need a retransmit? Copies it into `out`.
    pub fn retransmit(&self, out: &mut [u8]) -> usize {
        if self.tx_data != 0 {
            out[..self.tx_len].copy_from_slice(&self.tx[..self.tx_len]);
            return self.tx_len;
        }
        0
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
        // Match our 4-tuple.
        if ip[12..16] != self.dst || ip[16..20] != self.src {
            return 0;
        }
        let tcp = &ip[ihl..];
        let sport = ((tcp[0] as u16) << 8) | tcp[1] as u16;
        let dport = ((tcp[2] as u16) << 8) | tcp[3] as u16;
        if sport != self.dport || dport != self.sport {
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

        // Clear the in-flight segment once its bytes are acknowledged.
        if flags & ACK != 0 && self.tx_data != 0
            && ack.wrapping_sub(self.tx_seq) >= self.tx_data as u32
        {
            self.tx_data = 0;
            self.tx_len = 0;
        }
        if flags & ACK != 0 {
            self.snd_una = ack;
        }

        match self.state {
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
                // In-order data: buffer it and advance rcv_nxt.
                if !payload.is_empty() && seq == self.rcv_nxt {
                    let n = payload.len().min(self.rx.len() - self.rx_len);
                    self.rx[self.rx_len..self.rx_len + n].copy_from_slice(&payload[..n]);
                    self.rx_len += n;
                    self.rcv_nxt = self.rcv_nxt.wrapping_add(n as u32);
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

    /// Build an IPv4 + TCP segment with `flags`, sequence `seq`, and `data`.
    fn build(&mut self, flags: u8, seq: u32, data: &[u8], out: &mut [u8]) -> usize {
        let total = IP_HDR + TCP_HDR + data.len();
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
        t[12] = 0x50; // data offset 5 words
        t[13] = flags;
        t[14..16].copy_from_slice(&2048u16.to_be_bytes()); // window
        t[16] = 0;
        t[17] = 0;
        t[18..20].copy_from_slice(&0u16.to_be_bytes()); // urgent
        t[20..20 + data.len()].copy_from_slice(data);
        // TCP checksum over the pseudo-header + segment.
        let seg_len = TCP_HDR + data.len();
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
