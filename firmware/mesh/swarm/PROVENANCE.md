# Provenance: `firmware/mesh/swarm`

This directory is a port of the swarm network stack from
[fughilli/indoor_localization](https://github.com/fughilli/indoor_localization), read at
`master` `5a906e7823f2d1c13af30dfa2a3b1b887616d0f1` (2026-11-09). It is milestone M1 of the
Splanc mesh (`docs/design/mesh.md` §3.1, §15). From this commit on, Splanc owns its copy; fixes
worth sharing go back to indoor_localization by hand.

## License

`swarm/` and the files below are the owner's own code, so they come in under Splanc's AGPL-3.0.
indoor_localization's root `LICENSE` is GPL-3.0 because of `libs/dw3000` (derived from
CircuitDigest's DW3000 driver), which is **not** ported. Even taken as GPL-3.0, GPL-3.0 §13
allows combining with AGPL-3.0 code.

## What came from where

| Splanc                                        | Upstream (at `5a906e78`)                              |
| --------------------------------------------- | ----------------------------------------------------- |
| `src/{budget,crypto,golden,lib,manifest}.rs`  | `swarm/net/src/` (same names)                         |
| `src/{mesh,net,settings,update,wire}.rs`      | `swarm/net/src/` (same names)                         |
| `//shared/protocol/proto:swarm_wire.proto`    | `swarm/proto/swarm_wire.proto`                        |
| `proto/swarm_wire_bounds.txt`                 | `swarm/proto/swarm_wire_bounds.txt`                   |
| `proto/gen_golden.py`, `proto/testdata/`      | `swarm/proto/gen_golden.py`, `swarm/proto/testdata/`  |
| `swarm_crypto.{cpp,h}`                        | `apps/common/swarm_crypto.{cpp,h}`                    |
| `docs/swarm-network.md`, `docs/swarm-wire.md` | `docs/` (same names), unchanged but for a header note |

Every ported file starts with a comment naming its source. Paths in code comments were
rewritten to this repository's; upstream-only files are named `indoor_localization <path>`.

Not ported: `swarm/net/src/ffi.rs` and its cbindgen header (the C ABI of upstream's node
firmware; Splanc drives the crate from Rust through `//firmware/mesh`, and its firmware C ABI
comes with the first image that links the mesh, M3), `swarm/proto/widget_config.proto` and the
C++ views (no consumer here), and everything outside `swarm/net`, `swarm/proto` and the crypto
shim (UWB radio, TDMA, DS-TWR, fusion).

## What Splanc changed

1. **Protobuf: pbview, as upstream.** The crate reads swarm.v1 with pbview zero-copy views
   and builds it with pbview's typed encoders (`FooEnc`, bounds file, `MAX_ENCODED_LEN`).
   That fits the C6's heap: no by-value message structs on the stack, no allocation (micropb's
   by-value structs are what pbview was written to get away from, #265). Splanc depends on
   [fughilli/pbview](https://github.com/fughilli/pbview) as a Bazel module (`@pbview`,
   pinned in `MODULE.bazel`), and the pin (`b03fbf66`) already includes the typed encoders.
   Changes to pbview land upstream first, then the pin moves.
2. **Payload capacity is a parameter.** `Mesh`, `Packet`, `Event`, `Net` and `AppPacket`
   are now `MeshOf<P>`, `PacketOf<P>`, `EventOf<P>`, `NetOf<P>` and `AppPacketOf<P>`; the old
   names are aliases for `P = 88`, the swarm's UWB payload, so upstream code and tests read as
   before. `Packet.len` is a `u16`. A `MeshOf<P>` also has a run-time `max_payload`
   (`set_max_payload`, clamped to `88..=P`) that a backhaul's MTU sets: it bounds what the
   instance sends and relays (`MeshStats::oversize` counts the rest), while everything up to
   `P` is still delivered. The swarm's own ports (settings, acks, reports) stay within 88
   bytes, so they fit every backhaul. `mesh::max_packet(p)` gives the encoded worst case,
   `NetOf::<P>::MAX_FRAME` the largest `next_tx` frame.
3. **Bounds raised for larger backhauls.** `MeshPacket.payload max_len` 88 → 1400
   (`mesh::PAYLOAD_CAP`, the IP / ESP-NOW-v2-sized frame of design §5.2) and
   `LinkFrame.payload max_len` 115 → 1425. The UWB budget is now asserted on the 88-byte
   instance (`budget.rs`) instead of on `MeshPacketEnc::MAX_ENCODED_LEN`.
4. **`FRAME_TYPE_BEACON = 10`** in swarm_wire.proto: a backhaul without TDMA has no POLL to
   carry the sender's `Summary`, so it sends a BEACON with `summary` set. Later milestones add
   the mesh beacon's own fields (§5.3). Field numbers are otherwise untouched.
5. **Crypto backend.** Host: `splanc_ota::sha256` (Splanc's dependency-free SHA-256), HMAC
   built on it (RFC 2104, with RFC 4231 cases 2 and 6 as tests) and `p256` from the host-only
   `@player_crates` universe (as the OTA signer), instead of RustCrypto `sha2`/`hmac` in a
   separate crate universe: no new dependencies, nothing reaches the firmware graph.
   Firmware: unchanged extern "C" contract, implemented by `swarm_crypto.cpp` on the image's
   MbedTLS (built for the C6, C3 and P4; linked by M3).
6. **Golden vectors**: `link_beacon`, `link_fw_request` and `mesh_packet_200` added to
   `gen_golden.py` and the test data (upstream's vectors are unchanged), and a test that the
   checked-in file is the generator's output.
7. **Clippy.** `Default` for the MbedTLS `Sha256`; scoped `allow`s for the test simulators'
   index loops and `budget.rs`'s constant asserts.

8. **Queues sized for the real traffic.** `RELAY_LEN`, `OUTBOX_LEN`, `EVENTS_LEN` and the
   app queue go from 8 to 4 (docs/design/mesh.md §10.3: one fader stream, beacons, status;
   bulk is pull-based from flash): C6 RAM 12.6 KB → 9.1 KB at P = 200.
9. **Capacity classes (M2, docs/design/mesh.md §10.6).** Run-time queue caps
   (`MeshOf::set_caps`). A full relay queue evicts the oldest relay of the lowest priority
   class below the new one (`MeshConfig::high_ports`, `bulk_from`; acks are always high),
   counted per class (`MeshStats::dropped_by_prio`). A high-capacity node can spill evicted
   bulk/normal relays to a custodian store (`spill`, `take_spilled`, `requeue_relay`;
   feature `custodian_spill`, off on firmware). Bulk relays can be biased earlier or later
   (`bulk_relay_bias`, 0 by default). `Updater::set_preferred` makes page requests prefer
   custodians among equally advanced neighbours. Peak occupancy is recorded (`peak_relays`,
   `peak_outbox`).
10. **The firmware image updater and settings bundles are behind features.** `net.rs`
    drives `update::Updater` only with feature `fw_update`, and swarm settings bundles only
    with feature `swarm_settings`. Both are on in `:swarm_net` and, by desk D-463, in
    `:swarm_net_fw` too (the C6 keeps them for OTA over the mesh, Phase 2).

The Splanc layer on top (backhaul trait, link frame codec, node driver, loopback backhaul)
is `//firmware/mesh`, outside this directory.
