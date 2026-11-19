//! The backhaul seam (docs/design/mesh.md §3.2): one radio or link that carries mesh frames.
//!
//! The swarm (`swarm_net`, //firmware/mesh/swarm) has no radio seam: upstream's UWB radio task
//! drove it from its TDMA schedule. A backhaul owns framing below the mesh (802.11 action
//! frames, UDP datagrams, UWB frames), the channel, the rate and pacing; the mesh layer hands
//! it opaque frames and gets opaque frames back, with their metadata. [`crate::Node`] drives
//! `swarm_net` from these calls.

/// A mesh node id (u16, derived from the factory MAC; design §3.3). `0xFFFF` is broadcast.
pub type NodeId = u16;

/// Which of a node's backhauls a frame came in on (a node with two relays across them).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct BackhaulId(pub u8);

/// What a frame is for, so a backhaul can pick how to carry it (M3, design §4.1/§4.3): on
/// 802.11, discovery (beacons, adverts, joins) always goes out as one broadcast, where a lost
/// frame costs nothing (the next one comes within a second); data can go as unicasts with
/// MAC ACKs and retries to each neighbour instead (`wifi_p2p::GroupPolicy`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TxClass {
    /// Beacons, adverts, join traffic: periodic, loss tolerated.
    Discovery,
    /// Mesh packets (floods, relays, page protocol): must arrive.
    #[default]
    Data,
    /// A time beacon (M4, [`crate::meshtime`]): one broadcast, never retried (a retry would
    /// carry the first attempt's stamp), whose completion the backhaul stamps
    /// ([`Backhaul::take_tx_stamp`]).
    Time,
}

/// When a frame went out on this node's clock (µs): armed, and done (the midpoint of the
/// bracket between the last poll that saw it in flight and the one that saw it done; the
/// bracket's half-width is `err_us`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TxStamp {
    pub armed_us: i64,
    pub done_us: i64,
    pub err_us: i64,
}

/// Back-pressure: the backhaul cannot queue the frame now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Busy;

/// What the backhaul knows about a received frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RxMeta {
    /// Frame length in the caller's buffer.
    pub len: usize,
    pub rssi_dbm: i8,
    /// Hardware RX timestamp, on this node's clock (µs).
    pub rx_us: i64,
    /// Link address of the sender, for unicast replies (backhauls without MACs make one up).
    pub src_mac: [u8; 6],
    pub backhaul: BackhaulId,
}

/// One radio (or link) that carries mesh frames. Implementations own framing, channel, rate
/// and pacing; the mesh layer sees opaque frames.
pub trait Backhaul {
    /// Largest mesh frame (after the security envelope, from M2) this backhaul carries. The
    /// mesh layer sizes its packets from it ([`crate::link::mesh_payload_for_mtu`]).
    fn mtu(&self) -> usize;
    /// Queue a frame. `dst = None` broadcasts; `Some(id)` is a link-layer unicast to that node
    /// (the backhaul maps ids to link addresses). Never blocks; `Busy` is back-pressure. A
    /// backhaul reports a full queue through [`Backhaul::may_send`] first, so `Busy` is a race
    /// and the frame is dropped (the flood's redundancy and want-ack retries cover it).
    fn send(&mut self, frame: &[u8], dst: Option<NodeId>) -> Result<(), Busy>;
    /// [`Backhaul::send`] with what the frame is for. Backhauls that carry every frame the
    /// same way keep this default.
    fn send_class(&mut self, frame: &[u8], dst: Option<NodeId>, class: TxClass) -> Result<(), Busy> {
        let _ = class;
        self.send(frame, dst)
    }
    /// The completion of the last [`TxClass::Time`] frame (taken once), for the two-step
    /// stamp. Backhauls that cannot tell when a frame went out keep the default.
    fn take_tx_stamp(&mut self) -> Option<TxStamp> {
        None
    }
    /// Next received frame, copied into `buf` (at least `mtu()` bytes), with its metadata.
    fn recv(&mut self, buf: &mut [u8]) -> Option<RxMeta>;
    /// Whether this node may transmit now (its TDMA slot on UWB; on 802.11 whenever the TX
    /// queue has room).
    fn may_send(&self, now_us: i64) -> bool;
}
