# On-device effect store

A player keeps a small library of compiled effects on its own flash, beside the deck-A effect it
resumes on boot. An app (or any client) stores an effect without running it, lists the store, opens
one onto a deck, and deletes one. This is how a fixture carries a set of shows that need no phone
library to replay, for example the tracker demos in `lighthouse/demos/splanc` of
fughilli/indoor_localization (`hot_spots_pose.glsl`, `tracker_demo_pose.glsl`,
`flashlight_pose.glsl`). They are installed by storing them; they aren't built into the firmware.

Firmware: `firmware/player_app/effect_store.rs` (record format, protocol) and `main.cpp` (the
littlefs hooks, the staged load, persistence). Protocol: `shared/protocol/proto/ledmapper.proto`
("effect store"). App: `web/src/net/effectStore.ts`, Device settings → **Stored effects**
(`web/src/ui/screens/storedEffectsSection.ts`), and the effect editor's **Store on device**.

## Protocol

| Arm | Number | Reply |
| --- | --- | --- |
| `submit_effect{effect_id, fxb, store: true, name}` | ClientMessage 21 (fields 5, 6 new) | `result_ready{map_id: effect_id}` or `error` |
| `list_stored_effects` | ClientMessage 95 | `stored_effect_list` |
| `load_stored_effect{effect_id, deck, activate}` | ClientMessage 96 | `result_ready` or `error` |
| `delete_stored_effect{effect_id}` | ClientMessage 97 | `stored_effect_list` (what is left) or `error` |
| `stored_effect_list{effects[], capacity}` | ServerMessage 53 | |

- **Capability:** `welcome.features` contains `"effect_store"`.
- **Storing** reuses `submit_effect`, so an effect too big for one frame goes through the existing
  sharded `upload_chunk{kind: EFFECT}` path unchanged. With `store: true` the decks are not touched:
  `activate` and `deck` are ignored. An effect with the same `effect_id` is replaced in place.
- **Each entry** (`StoredEffectInfo`) carries `effect_id`, `name`, `fxb_bytes`, `uniforms` (the
  uniform names, in manifest order) and `decks` (the decks that have it loaded right now, matched by
  id).
- **Opening** an effect is `load_stored_effect` followed by `get_effect_uniforms`: once the effect is
  loaded it is the deck's running effect, so the existing uniform reads, `set_uniforms`, keypoints
  and OSC all apply. Keypoints are stored per `effect_id` (`uniform-keypoints.md`), so a stored
  effect's saved looks come back with it.
- **Errors:**
  - `store_full`: all slots are in use;
  - `not_found`: no stored effect with that id;
  - `bad_fxb`: an fxb that doesn't parse, a sensor driver, a missing id, or a damaged record;
  - `effect_too_large`: over the player's 4 KiB fxb cap;
  - `no_store`: no filesystem.

## Storage

- **Bounds.** At most 8 records (`MAX_STORED`), each one file `/lfs/fxs.<n>` of at most ~4.4 KB
  (the 4 KiB fxb cap plus a ~200 B header), so at most ~35 KB of the 384 KB littlefs. Ids are up to
  64 bytes, names up to 32, and the uniform-name summary up to 96.
- **Power-loss safety.** Writes go through `fs_write_parts`: `fs_write_file`'s temp file, fsync and
  atomic rename, with the header and the fxb written from their own buffers. A reset mid-store
  leaves the old record or the new one. A damaged record (from a foreign write, say) is refused on
  load with `bad_fxb`, and the decks are left alone.
- **Record.** The record is a header, then a ready-to-replay frame:

  ```text
  "SFX1" | id_len u8 | id | name_len u8 | name | fxb_len u16 LE | summary_len u8 | summary
  ClientMessage{submit_effect{effect_id, activate: true, fxb}}
  ```

  A listing reads only each record's first 201 bytes, into a static header buffer. That buffer is
  the store's only RAM, apart from the stack.
- **Loading** needs the whole record in memory, and the player core has no 4 KiB buffer to spare.
  So `main.cpp` intercepts `load_stored_effect`:
  1. `lm_fxs_find` names the record;
  2. `main.cpp` stages the file on the heap for the call, as for a sharded effect upload
     (`rx_stage_get`);
  3. `lm_fxs_load` loads the frame onto the requested deck through the same code as `submit_effect`
     (`submit_effect_view`). A request that isn't in the store falls through to the player core,
     which answers `not_found`.
- **Boot.** A stored effect loaded onto deck A with `activate` persists like a deck-A
  `submit_effect`: the record's frame is written to `/lfs/fx.pb`, and the old selection
  (`fx_sel.pb`) is dropped, so the device resumes it on boot. A load onto deck B, or a parked one, is
  runtime only. Storing never touches `fx.pb`: `lm_fxs_last_was_store` tells `persist_if_upload` to
  skip it.
- **Independence.** The deck-A effect and the store are separate copies. Deleting a stored effect
  doesn't stop or un-persist what is playing, and it leaves that effect's keypoints in place.

## Kiosk mode

- `list_stored_effects` is a read, and `load_stored_effect` is play, so a locked kiosk's visitors
  can pick from the owner's stored shows. As with any visitor op, nothing they do persists.
- `submit_effect{store: true}` and `delete_stored_effect` write the owner's flash, so they are
  refused (`kiosk_locked`).

## Tests

- `//firmware/player_app:effect_store_test` (through the C ABI, with an in-memory littlefs):
  - store without loading, list with names and uniform names, replace by id;
  - the 8-record bound, and the bad-input codes;
  - load onto either deck, activated or parked, with the boot frame only for deck A activated, and
    the loaded effect's uniforms readable and settable;
  - a damaged record, delete, reuse of a freed slot;
  - the record format, and the kiosk classes.
- `//web:effectStore_test`:
  - the wire arms through the proto boundary;
  - normalization and wording;
  - manifest → uniform controls;
  - the Stored effects section on the fake DOM: list, open with live uniforms that commit once quiet,
    and delete.

## Not yet

- The agent bridge (`agent/`) has no tools for the store yet. `deploy_effect` still installs onto a
  deck.
- No HITL journey: storing, rebooting and opening on a real board has not been run.
- Renaming an entry means storing it again under the same id.
