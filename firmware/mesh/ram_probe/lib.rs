//! RAM probe (design §10.4, docs/design/ram-budget.md): one `.bss` static per piece of mesh
//! state, sized for the firmware target, so `nm -S` on this crate's object reports each
//! one's bytes on the C6. Not linked into any image (tags = ["manual"]).
//!
//!   bazel build -c opt --platforms=@embedded//platforms:esp32c6 //firmware/mesh:mesh_ram_probe
//!   nm -S --size-sort -C bazel-bin/firmware/mesh/libmesh_ram_probe*.rlib | grep MESH_RAM
#![no_std]
#![allow(non_upper_case_globals, dead_code)]

use core::mem::MaybeUninit;

use splanc_mesh::admin::{AdminGate, GatewaySession, Sessions};
use splanc_mesh::backhaul::{Backhaul, Busy, NodeId, RxMeta};
use splanc_mesh::crypto::{DeviceKey, Entropy, PublicKey};
use splanc_mesh::membership::{MeshState, Membership};
use splanc_mesh::ports::Router;
use splanc_mesh::rekey::{RekeyMember, Rekeyer};
use splanc_mesh::replay::ReplayTable;
use splanc_mesh::security::{MeshSecurity, MEMBERS};
use splanc_mesh::stack::MeshStack;
use swarm_net::net::NetOf;

/// The 802.11 mesh payload (§5.2).
const P: usize = 200;

pub struct NoRadio;
impl Backhaul for NoRadio {
    fn mtu(&self) -> usize {
        250
    }
    fn send(&mut self, _: &[u8], _: Option<NodeId>) -> Result<(), Busy> {
        Err(Busy)
    }
    fn recv(&mut self, _: &mut [u8]) -> Option<RxMeta> {
        None
    }
    fn may_send(&self, _: i64) -> bool {
        false
    }
}
pub struct NoKey;
impl DeviceKey for NoKey {
    fn public_key(&self) -> PublicKey {
        [0; 65]
    }
    fn ecdh(&self, _: &PublicKey) -> Option<[u8; 32]> {
        None
    }
}
pub struct NoRng;
impl Entropy for NoRng {
    fn fill(&mut self, _: &mut [u8]) {}
}

macro_rules! probe {
    ($name:ident, $t:ty) => {
        #[used]
        #[no_mangle]
        pub static mut $name: MaybeUninit<$t> = MaybeUninit::uninit();
    };
}

// The whole device (gateway roster 16, the standalone-C6 size): M1's node (swarm_net at
// P = 200) + everything M2 adds.
probe!(MESH_RAM_stack_total, MeshStack<NoRadio, P, NoKey, NoRng, 16>);
// M1, for the split.
probe!(MESH_RAM_m1_swarm_net, NetOf<P>);
// M2's pieces.
probe!(MESH_RAM_security, MeshSecurity);
probe!(MESH_RAM_replay_members, ReplayTable<MEMBERS>);
probe!(MESH_RAM_membership, Membership);
probe!(MESH_RAM_mesh_state, MeshState);
probe!(MESH_RAM_sessions, Sessions);
probe!(MESH_RAM_gateway_session_16, GatewaySession<16>);
probe!(MESH_RAM_gateway_session_64, GatewaySession<64>);
probe!(MESH_RAM_rekeyer, Rekeyer);
probe!(MESH_RAM_rekey_member, RekeyMember);
probe!(MESH_RAM_router, Router);
probe!(MESH_RAM_admin_gate, AdminGate);
// Open mode (feature `open_mode`, M7b): what it will add.
#[cfg(feature = "open_mode")]
probe!(MESH_RAM_open_guest_table, splanc_mesh::guest::GuestTable<{ splanc_mesh::guest::GUESTS }>);
#[cfg(feature = "open_mode")]
probe!(MESH_RAM_open_follower, splanc_mesh::guest::Follower);
#[cfg(feature = "open_mode")]
probe!(MESH_RAM_open_stack_total, MeshStack<NoRadio, P, NoKey, NoRng, 16>);
