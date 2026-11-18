# Swarm wire format (swarm.v1)

> Copied unchanged from fughilli/indoor_localization `docs/swarm-wire.md` at `5a906e78` as the
> spec of the ported `swarm_net` (see `../PROVENANCE.md`). Paths here are upstream's; the
> Splanc mesh is `docs/design/mesh.md`.

Every structure that crosses a link between swarm nodes, or between a node and the host, or
sits in the staging partition is a protobuf message in `swarm/proto/swarm_wire.proto`
(see [pbview.md](pbview.md) for the policy). One schema, three consumers:

| Consumer            | Where                                       | How                                                                |
| ------------------- | ------------------------------------------- | ------------------------------------------------------------------ |
| C++ (radio, loader) | `apps/common/radio.cpp`, `apps/loader`      | pbview zero-copy views of `LinkFrame`; encoding with `pbv::Writer` |
| Rust (swarm_net)    | `swarm/net`                                 | micropb structs; Summary / Manifest / Fw\* / MeshPacket / settings |
| Python (host tools) | `swarm/tools/swarm_wire.py`, `swarm_ctl.py` | protoc-generated `swarm_wire_pb2`                                  |

## What changed from the packed structs

The old frames were fixed-offset little-endian structs (an 8-byte link header, a 9-byte mesh
header, `count u16 | (key u16, value u32)*` layers, a 108-byte manifest). Protobuf costs bytes
(tags, varint widths), so the budgets below are the contract. They are worst cases (every
varint at maximum width) and are asserted by tests.

- **Signed and tagged things are envelopes** `{body, tag}`: the HMAC (settings) or ECDSA
  signature (manifest) covers the exact `body` bytes as transmitted; nobody re-encodes before
  verifying or re-serving. Protobuf's lack of a canonical encoding therefore does not matter.
- **The manifest has its own link frame type** (`FRAME_TYPE_FW_MANIFEST`) instead of riding a
  mesh packet: a signed manifest is up to 114 bytes, which cannot also carry a mesh header.
- **The magic byte is gone.** `LinkFrame.ver = 1` plus a strict parse (`Parse` validates framing,
  wire types and UTF-8) rejects foreign and legacy frames.
- **Compatibility.** There is none with the packed protocol: every board (loader and main) is
  reflashed once over USB (`swarm_ctl.py flash`); the loader cannot be updated over the air.

## Budgets (bytes)

The DW3000 standard PHR allows 127 bytes, 2 of them FCS: a frame is at most **125**.

| Frame                                 | Link header (worst case)                        | Body                                                | Total  |
| ------------------------------------- | ----------------------------------------------- | --------------------------------------------------- | ------ |
| POLL (to a peer; a beacon has no dst) | ver 2, type 2, src 4, dst 4, seq 3, slot 2 = 17 | advert 2 + 64, summary 2 + 26                       | 111    |
| RESPONSE                              | 2 + 2 + 4 + 4 + 3 = 15                          | advert 2 + 64                                       | 81     |
| REPORT                                | 15                                              | two fixed32: 10                                     | 25     |
| RESULT                                | 15                                              | sint32: 4                                           | 19     |
| MESH (broadcast)                      | 2 + 2 + 4 + payload tag/len 2 = 10              | MeshPacket <= 115 (header <= 24, payload <= **88**) | <= 125 |
| FW_DATA (broadcast)                   | 10                                              | FwData: 110 (pages are 16-bit)                      | 120    |
| FW_REQUEST (unicast)                  | 14                                              | FwRequest <= 19                                     | 33     |
| FW_MANIFEST (broadcast)               | 10                                              | Manifest <= 114                                     | 124    |

## Constants derived from the budgets

| Constant                                        | Old        | New         | Why                                                                                        |
| ----------------------------------------------- | ---------- | ----------- | ------------------------------------------------------------------------------------------ |
| mesh `MAX_PAYLOAD`                              | 108        | 88          | 125 - 10 link - 24 mesh header, 3 bytes slack                                              |
| settings `FRAG_DATA`                            | 100        | 72          | `BundleFragment` overhead 14 inside 88; a bundle is at most ~975 bytes, so <= 14 fragments |
| override `CMD_MAX_ENTRIES`                      | 16         | 7           | 10 bytes per `Setting` plus the envelope inside 88                                         |
| report entries per part                         | 16         | 6           | 12 bytes per entry plus a 16-byte head inside 88                                           |
| `CHUNK` / `PAGE_SIZE`                           | 96 / 4096  | unchanged   |                                                                                            |
| `MAX_KEYS`                                      | 96         | unchanged   |                                                                                            |
| bundle read buffer (`kMaxBlob`) / `TAG_MSG_MAX` | 1024 / 640 | 1024 / 1024 | a full bundle is ~975 bytes                                                                |

These are enforced mechanically. `swarm/proto/swarm_wire_bounds.txt` declares the limits the
schema cannot say (`max_len`, `max_count`, and `max_value` for ids, keys and pages); pbview's
typed encoders enforce them and compute each message's exact worst case, `FooEnc::MAX_ENCODED_LEN`,
which `swarm/net/src/budget.rs` asserts at compile time against the frame budgets above. Changing
the schema or the bounds so that a message no longer fits breaks the build. C++ checks the link
layer in `apps/common/link_test.cc`.

Corrections found while building this (the table above has them): a manifest with a nonzero
`flags` would be 116 bytes and its frame 126, so `ManifestBody.flags` is bounded to 0; FwData
is 110 (16-bit pages), FwRequest 19; the override and report budgets assume registry keys fit
14 bits.

## Staging partition

Sector 0 of the staging partition holds `varint(length) || Manifest` (a length-delimited
message; erased flash reads as "no manifest"). The image starts at offset 4096.

## Not covered (still JSON)

The USB serial protocol between a node and its host (newline-delimited JSON, with binary
payloads as hex) is not a link between embedded systems and is unchanged; its binary payloads
now carry the protobuf messages above.
