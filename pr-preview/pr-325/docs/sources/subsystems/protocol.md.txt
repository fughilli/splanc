# The wire protocol (`shared/protocol/`)

The single source of truth for every cross-module message. JSON schemas plus a
protobuf definition (`proto/ledmapper.proto`) describe the WebSocket control
messages, detection records, the output map, and the code-book parameters.
Codegen produces **TypeScript** types (consumed by the PWA) and **Python**
Pydantic models (consumed by the Pi server, reconstruction, and simulator), so
both halves of the system agree by construction.

## Key files

- `shared/protocol/schemas/*.json` — the authoritative JSON schemas.
- `shared/protocol/proto/ledmapper.proto` — the binary protocol.
- `shared/protocol/codegen.py` — regenerates the TS + Python bindings.
- `shared/protocol/python/ledmapper_protocol/_generated.py` — the generated
  Pydantic models (`OutputMap`, `LedEntry`, detection records, …).

## Rust bindings: two decoders

The Rust side (`shared/protocol/rust/`) builds `ledmapper.proto` two ways:

- **`ledmapper_pb` / `ledmapper_pb_fw`** — micropb structs. The `_fw` profile
  is the firmware's capacity profile, which caps the repeated fields and skips
  the fat arms. These are used for encoding replies and on the host.
- **`ledmapper_view`** — zero-copy [pbview](https://github.com/fughilli/splanc/tree/main/oss/pbview)
  views (`oss/pbview`, `pbview_library`). A view is a borrowed two-word handle
  with lazy accessors over the wire bytes. `parse` validates once, and there is
  no allocation, no `unsafe` and no panic on any input. The firmware decodes
  **every** `ClientMessage` in place from the RX frame
  (`Player::handle_frame` → `ClientMessageView`). That way no by-value envelope,
  sized by its largest arm, lands on a task stack.

Fat reply arms the firmware profile drops are spliced into the reply
already encoded (`Player::encode_reply`). Examples are the board-capabilities
catalog, `Welcome.features` and the fixture pose. `envelope_size_test` pins
the by-value sizes (`ServerMessage` 656 B on the firmware).

`oss/pbview` is self-contained (its own README, Cargo workspace and tests,
including fuzzing) so it can be published separately.

## Versioning and feature detection

The protocol only grows additively (new optional fields and new oneof arms),
and clients feature-detect instead of comparing versions. `Welcome.features`
lists what the firmware serves, for example `effects`, `uniform_commit`,
`list_effects`, `fixture_pose`, `time_base`, `decks`, `crossfade`,
`keypoints`, `fps` and `ramps`. `Welcome.fxb_format` is the `.fxb` version the VM accepts. The
agent bridge and the app both read them; see {doc}`agent`.

Recent arms, with their field numbers (`ledmapper.v1`, all additive):

| Arm                                                    | `ClientMessage` | Reply (`ServerMessage`) | PR    |
| ------------------------------------------------------ | --------------: | ----------------------- | ----- |
| `list_effects`                                         |              36 | `effect_list` (21)      | #276  |
| `set_fixture_pose`                                     |              37 | `welcome`               | #280  |
| `set_time_base`                                        |              38 | `welcome`               | #280  |
| `set_crossfade`                                        |              39 | `welcome`               | #285  |
| `save_keypoint` / `delete_keypoint` / `list_keypoints` |    40 / 41 / 42 | `keypoint_list` (22)    | #285  |
| `get_keypoint`                                         |              43 | `keypoint` (23)         | #285  |
| `blend_keypoints`                                      |              44 | `playback_state`        | #285  |
| `set_fps`                                              |              46 | `fps_state` (25)        | #55   |
| `ramp_uniforms` / `ramp_crossfade`                     |         60 / 61 | `ramp_state` (40)       | ramps |
| `cancel_ramp`                                          |              62 | `ramp_state` (40)       | ramps |

PR #285 also adds a `deck` field (0 = A, 1 = B) to `SubmitEffect` (4), `SetEffect`

(2), `SetUniforms` (3; 2 is `commit`), `GetEffectUniforms` (2),
`EffectUniforms` (5) and `StoredEffect` (4), and echoes the crossfade in
`Welcome` (14, 15). Deck, mode and colour-mode fields are plain `uint32`, not
enums. Details: {doc}`../docs/design/uniform-keypoints`.

The canned-ramp arms (feature `ramps`) also add `ease` (6), `start_at_ms` (7)
and `id` (8) to `BlendKeypoints`. `ramp_state` is both the STARTED reply and the
DONE / CANCELLED push. `start_at_ms` is in the device clock, like
`set_time_base`. Details:
{doc}`../docs/design/ramps`.

## Freshness gate

The generated bindings are byte-pinned. A freshness check fails the build if they
drift from the schemas, so the protocol can't silently diverge from its codegen:

```sh
bazel test //shared/protocol:codegen_freshness
```

Adding a message or field means editing the schema / `.proto`, regenerating, and
committing the generated bindings together. Adding a new protocol _arm_ (an
optional accessor and the exhaustive matches that consume it) is a small,
well-worn change — see {doc}`../DEVELOPERS` for the build wiring.
