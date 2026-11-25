//! `mesh_admin_tool`: the admin side of a Splanc mesh (docs/design/mesh.md §7.9, mesh M7) on
//! the host, for the HITL harness and for people at a terminal until the app signs (M8).
//!
//! It holds what fixtures never do: the admin secret (16 bytes) and the signing key derived
//! from it and the mesh id. Every command prints one JSON object on stdout.
//!
//!   mesh_admin_tool new                                   fresh mesh id, site secret, admin secret
//!   mesh_admin_tool pubkey  <admin hex> <mesh id hex>     the admin public key (65 B SEC1)
//!   mesh_admin_tool grant   <admin hex> <mesh id hex> <session> <gateway node hex>
//!                           <gateway public key hex> <not_after mesh s>
//!                                                         a signed session grant (mesh_unlock)
//!   mesh_admin_tool rekey   <admin hex> <mesh id hex> <epoch> <rev version> [<key hash hex>...]
//!                                                         a signed rotation order + new keys
//!   mesh_admin_tool keyhash <public key hex>              SHA-256(key)[..8]
//!
//! Secrets are read from the command line here because the harness generates throwaway
//! ones per run; never pass a real site's admin secret on a shared machine's command line.

use std::io::Read;

use splanc_mesh::admin::SessionMsg;
use splanc_mesh::crypto::key_hash;
use splanc_mesh::host_keys::AdminSigner;
use splanc_mesh::rekey::RekeyOrder;

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Vec<u8> {
    let s = s.trim();
    assert!(s.len() % 2 == 0, "odd hex length: {s}");
    (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex")).collect()
}

fn arr<const N: usize>(s: &str) -> [u8; N] {
    let v = unhex(s);
    v.as_slice().try_into().unwrap_or_else(|_| panic!("want {N} bytes, got {}", v.len()))
}

fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).expect("urandom");
    b
}

fn u32_hex(s: &str) -> u32 {
    u32::from_str_radix(s.trim_start_matches("0x"), 16).expect("hex u32")
}

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let cmd = a.first().map(String::as_str).unwrap_or("");
    match cmd {
        "new" => {
            let mut id = u32::from_be_bytes(random::<4>());
            if id == 0 {
                id = 1;
            }
            let admin: [u8; 16] = random();
            let site: [u8; 32] = random();
            let pk = AdminSigner::from_secret(&admin, id).public();
            println!(r#"{{"mesh_id":"{id:08x}","site_secret":"{}","admin_secret":"{}","admin_key":"{}"}}"#, hex(&site), hex(&admin), hex(&pk));
        }
        "pubkey" if a.len() == 3 => {
            let s = AdminSigner::from_secret(&arr::<16>(&a[1]), u32_hex(&a[2]));
            println!(r#"{{"admin_key":"{}"}}"#, hex(&s.public()));
        }
        "grant" if a.len() == 7 => {
            let mesh_id = u32_hex(&a[2]);
            let s = AdminSigner::from_secret(&arr::<16>(&a[1]), mesh_id);
            let session: u32 = a[3].parse().expect("session");
            let gw = u16::from_str_radix(a[4].trim_start_matches("0x"), 16).expect("node");
            let g = s.grant(mesh_id, session, gw, arr::<65>(&a[5]), a[6].parse().expect("not_after"));
            let mut b = [0u8; 200];
            let n = SessionMsg::Grant(g).encode(&mut b).expect("encode");
            println!(r#"{{"grant":"{}","session":{session},"not_after":{}}}"#, hex(&b[..n]), g.not_after);
        }
        "rekey" if a.len() >= 5 => {
            let mesh_id = u32_hex(&a[2]);
            let s = AdminSigner::from_secret(&arr::<16>(&a[1]), mesh_id);
            let epoch: u8 = a[3].parse().expect("epoch");
            let rev: u16 = a[4].parse().expect("rev version");
            let revoked: Vec<[u8; 8]> = a[5..].iter().map(|h| arr::<8>(h)).collect();
            let mk: [u8; 16] = random();
            let ss: [u8; 32] = random();
            let o = RekeyOrder::sign(&s, mesh_id, epoch, &mk, &ss, rev, &revoked);
            let mut b = [0u8; RekeyOrder::LEN];
            let n = o.encode(&mut b).expect("encode");
            println!(r#"{{"order":"{}","mesh_key":"{}","site_secret":"{}","epoch":{epoch}}}"#, hex(&b[..n]), hex(&mk), hex(&ss));
        }
        "keyhash" if a.len() == 2 => println!(r#"{{"key_hash":"{}"}}"#, hex(&key_hash(&arr::<65>(&a[1])))),
        _ => {
            eprintln!("usage: mesh_admin_tool new | pubkey | grant | rekey | keyhash (see the source header)");
            std::process::exit(2);
        }
    }
}
