# FX decks, crossfade and uniform keypoints

Status: implemented (supersedes PR #82, FUG-110). Builds on the effects runtime
(effects-runtime.md) and the memory-region model (memory-regions.md).

## What the user gets

- **Two decks.** The player runs two effects at once, deck A (0) and deck B (1).
  An output **crossfader** blends their per-LED colours, in linear RGB or HSV
  (shortest hue path). Show Mode (`/show` in the app) drives both, and every
  control can be MIDI-mapped.
- **Keypoints.** A keypoint is a named set of uniform values for one effect: a
  known-good position in that effect's parameter space ("dawn", "storm"). Keypoints
  are stored ON THE DEVICE, so the app, Show Mode and agents (MCP) all see the same
  set.
- **Morphing.** The device moves a deck's uniforms between keypoints itself, at
  frame rate. You can recall one keypoint over N seconds, or blend several with
  weights. A fader, a MIDI CC or an agent sends the weights, so you move
  smoothly between known-good looks instead of dragging every slider.

## Wire (ledmapper.v1, additive)

| Message | Field / arm | Notes |
|---|---|---|
| `SubmitEffect.deck` | 4 | 0 = A (default), 1 = B |
| `SetEffect.deck` | 2 | `""` parks that deck only |
| `SetUniforms.deck` | 3 | (2 is `commit`) |
| `GetEffectUniforms.deck` | 2 | |
| `EffectUniforms.deck` | 5 | |
| `StoredEffect.deck` | 4 | `list_effects` lists both decks |
| `ClientMessage.set_crossfade` | **39** | `{position, mode}`; reply `welcome` |
| `ClientMessage.save_keypoint` | **40** | reply `keypoint_list` |
| `ClientMessage.delete_keypoint` | **41** | reply `keypoint_list` |
| `ClientMessage.list_keypoints` | **42** | reply `keypoint_list` |
| `ClientMessage.get_keypoint` | **43** | reply `keypoint` |
| `ClientMessage.blend_keypoints` | **44** | reply `playback_state` |
| `ServerMessage.keypoint_list` | **22** | names + index + stale + capacity |
| `ServerMessage.keypoint` | **23** | one keypoint's values |
| `Welcome.crossfade` / `crossfade_mode` | 14 / 15 | runtime-only |
| `Welcome.features` | | adds `decks`, `crossfade`, `keypoints` |

All of these are numbered after the in-flight agent-discovery arms
(`list_effects` = 36, `set_fixture_pose` = 37, `set_time_base` = 38,
`effect_list` = 21). The `deck`/`mode` fields are plain `uint32`, not enums, like
`SetTexture.format`.

## Keypoints

**Identity.** Keypoints belong to an *effect id*, the `effect_id` of the
`submit_effect` that loaded the deck. They survive switching effects: re-upload
the effect under the same id and its keypoints come back. Values are stored **by
uniform name**, not by slot, so a recompiled effect whose slots moved still
recalls correctly. Each record also carries the manifest hash (FNV-1a of the
manifest JSON) at save time. `stale = true` in the list means the effect has
changed since the save. Uniforms the keypoint doesn't name keep their live value.

**Bounds.**
- At most 16 keypoints per effect, names of at most 32 bytes.
- At most 32 uniforms and 64 floats per keypoint. The scalar/vector widths are
  read from the manifest; uniforms past the bound are not keypointed (they keep
  their live value on recall).
- A 17th keypoint fails with `keypoint_full`.

**Storage.**
- One small littlefs file per keypoint: `/lfs/kp/<fnv32(effect_id)>.<n>`, where
  `n` = 0..15 is the stable index.
- Files are written power-loss-safe: temp file + fsync + atomic rename, the same
  as `fs_write_file`. Opens are unbuffered (#273).
- A record is at most about 1.5 KB; a typical one is about 200 B, which littlefs
  inlines in metadata. A full effect's set is a handful of small files, not one
  big read-modify-write.
- Rust owns the format (`firmware/keypoint`). C++ only provides
  read/write/remove hooks (`lm_kp_set_store`), so the host tests run against an
  in-memory store.

**Save.**
- `values` empty saves the deck's current live uniforms. Explicit `values`
  (slot-addressed, as `set_uniforms`) are resolved to names through the deck's
  manifest.
- Saving under an existing name overwrites it in place, keeping its index.
- Saving a blended position is explicit: blending never writes a keypoint.

**Blend.** `blend_keypoints { deck, weights: [{name, weight}], seconds,
color_mode, commit }`:

- Weights are normalised: one weight of 1 = recall. At most 4 keypoints per
  blend.
- `seconds > 0` starts a **morph**. The device snapshots the deck's live values
  as an extra source and eases the weights from "all live" to the requested ones
  (smoothstep), advancing inside `lm_fx_update` once per frame.
  - A new blend mid-morph snapshots the in-between values, so there is no jump.
  - A `set_uniforms` on the deck cancels the morph (the slider wins).
- `seconds == 0` applies the blend at once. This is the fader/MIDI path. While
  the set of keypoint names is unchanged, no flash is read: the sources stay
  cached, so a fader sweep is pure arithmetic.

Per-uniform rules come from the manifest's `ui` kind:

| kind | rule |
|---|---|
| `slider` | weighted sum, snapped to `step` (from `min`), clamped to `[min, max]` |
| `color` | `color_mode` 0: per-channel weighted sum (linear RGB); 1: HSV, with hue on the shortest arc (blended pairwise in weight order) and S/V summed |
| `toggle`, `dropdown` | the value of the heaviest-weighted source (nearest; no in-between states) |
| other / unknown | weighted sum, clamped |

**Commit.** A blend is live-only by default. With `commit = true`, the device
encodes the blend's *target* values as a deck-A `set_uniforms` frame and persists
it through the existing coalesced effect-selection save, so the look survives a
reboot. Deck B is runtime-only (below), so committing a deck-B blend is a no-op.

## Decks: RAM

Measured against the post-#262 image, with the TLS region (#272) reserved.

**Deck B.** Deck B needs its own VM (`FxVm` 5,120 B) and `.fxb` buffer
(4,096 B). Deck B and the **video-texture delta buffer** (`FX_TEX_PREV`, 8,192 B)
are made mutually exclusive in one explicit union, `FX_AUX: enum { Free,
Video(prev), DeckB(..) }`:

- Loading deck B evicts a video stream: the next `set_texture` is dropped while
  deck B is loaded.
- `set_texture` re-claims the region only when deck B is clear.
- The union costs max(8,192, deck B + its morph state) instead of the sum.

**Shared arena.** The fx buffer arena stays one 24 KB static. Deck A binds it
from the front and deck B from the back, sized by its own need at the LED cap.
Loading deck B is refused (`effect_too_large`) when the two decks' needs don't
fit together. Clearing deck B gives deck A the whole arena back.

**Per-deck state.**
- Morph state: a live snapshot + 4 cached sources × 64 floats + 32 rules, about
  2.1 KB per deck. Deck A's is resident; deck B's lives in the union.
- The keypoint record buffer `KP_IO`: 1,130 B (one record, the largest file).
- Net: +6.5 KB of static RAM over the single-deck image (DECK_A 11,436 for
  FX_BYTES+FX_VM+morph, FX_AUX 8,192 → 11,436, KP_IO 1,130).
- The sysmode cost table carries `fx_aux` (the union) and `keypoints`. The
  reachability test pins the new state count and worst case.

**Deck B scope.**
- Deck B is interpreted: the JIT (FUG-125) and OSC (FUG-121) stay deck-A only.
- Deck B is not persisted: boot resumes deck A, and the crossfade starts at 0.
  The app re-cues deck B when Show Mode opens.

**Frame cost.** At either crossfade endpoint only one deck shades. In between,
both do, so the frame cost is the sum of the two effects; perf reports carry it.
