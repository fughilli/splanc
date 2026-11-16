# Kiosk mode

A public, locked-down mode for unattended installs (first use: the Halloween 2026
stoop installs, SpookySplanc1/2). Visitors connect, mostly over BLE, and play with
the effects. They cannot reconfigure the fixture, and nothing they do survives a
reboot or an idle timeout.

Firmware: `firmware/player_app/kiosk_ffi.rs` (state, gate, protocol) and
`main.cpp` (persistence, revert, pushes, console). Protocol:
`shared/protocol/proto/ledmapper.proto` ("Kiosk mode"). HITL gate:
`//pi/hitl/harness:kiosk_netstack`.

## Protocol

| Arm | Number | Reply |
| --- | --- | --- |
| `get_kiosk_status` | ClientMessage 92 | `kiosk_status` |
| `set_kiosk_config{enabled?, idle_timeout_s?, capture_attract_from_current, owner_secret?}` | ClientMessage 93 | `kiosk_status` or `error` |
| `kiosk_unlock{secret}` | ClientMessage 94 | `kiosk_status` or `error kiosk_bad_secret` |
| `kiosk_status` | ServerMessage 52 | reply, and pushed unsolicited (`event`) |

- **Capability:** `welcome.features` contains `"kiosk"`. The app sends `get_kiosk_status` after hello.
- **Refusals:** `Error{code: "kiosk_locked"}`.
- **Errors from `set_kiosk_config`:**
  - `kiosk_secret_required`: enabling with no secret stored or given.
  - `kiosk_no_effect`: capturing with no deck-A effect loaded.
  - `kiosk_bad_config`: a secret that is empty or longer than 32 bytes.

## The gate

`lm_kiosk_gate(src, frame)` runs in `main.cpp` ahead of every handler:

- `lm_ws_dispatch`, which serves wss and the BLE player transport, before the live
  mailbox;
- `ws_compute_reply`;
- the old vendor wss handler.

So it also covers OTA and sharded uploads. The source (`SRC_WSS` / `SRC_BLE`)
selects the unlock that applies.

While the kiosk is **enabled** and the source is not owner-unlocked, each
ClientMessage arm is classified (`kiosk_ffi::classify`):

- **Play** (allowed; counts as activity): `set_playback`, `submit_effect` (either
  deck), `set_effect`, `set_uniforms` (the live channel too), `set_texture`,
  `set_brightness` (no cap), `set_crossfade`, `blend_keypoints`, and an
  `upload_chunk` of kind EFFECT.
- **Read** (allowed; not activity): `hello`, `time_sync_ping`, the get/list
  queries (including `get_stored_map`, the map download), `set_perf` /
  `get_perf_report`, `set_time_base`, `get_ota_status`, `get_kiosk_status`,
  `kiosk_unlock`.
- **Refuse:** everything else:
  - mapping, map/topology/pose uploads, LED count;
  - rename, hardware/colour config, `set_jit`, `set_fps`;
  - keypoint save/delete, sensors/drivers;
  - OTA writes, the FX debugger, Wi-Fi policy;
  - `set_kiosk_config`;
  - any arm not yet classified. A new arm is refused until it is classified.

**Improv Wi-Fi provisioning** is refused while the kiosk is enabled:
`improv_ble_take_credentials` drops the credentials and fails the RPC. Owner
unlock does not re-enable it; disable the kiosk first.

## Persistence

- Nothing a locked message does is persisted. `persist_if_upload` checks
  `lm_kiosk_msg_locked()`, so there are no `/lfs/fx.pb` / `fx_sel.pb` / pose writes.
- An owner-unlocked connection behaves normally and persists.
- **Files.** All are written with the atomic `fs_write_file` (tmp → fsync → rename).
  The snapshot frames are written before the record, so a power cut never leaves a
  record pointing at a torn snapshot.
  - `/lfs/kiosk.cfg`: the 112-byte record. It holds enabled, has_attract, the
    timeout, the attract brightness, the secret and the attract effect id.
  - `/lfs/kiosk_fx.pb`: the attract effect, as a `submit_effect` frame re-encoded
    from deck A, with JIT patches undone.
  - `/lfs/kiosk_un.pb`: its live uniforms, as a `set_uniforms` frame.
- **Boot.** With the kiosk enabled and a snapshot stored, the device replays the two
  snapshot frames instead of `fx.pb` / `fx_sel.pb`. It then parks deck B, sets the
  crossfade to deck A and restores the attract brightness.

## Idle revert

- Every Play op restarts the idle timer. An owner-unlocked connection's Play ops
  count too: what shows is no longer the captured snapshot, so it reverts after the
  owner leaves unless they re-capture.
- After `idle_timeout_s` (default 120, range 10..86400) with no visitor activity,
  `lm_kiosk_tick` asks for a revert. This applies whether or not anyone is
  connected, and only if a visitor changed something since the last revert.
- The revert is the same replay as at boot, under the player mutex. Then the
  device pushes `kiosk_status{event: REVERTED}`.
- While any connection is owner-unlocked, the timer is held.
- **Pushes**, to every open connection, wss and the BLE central, each with its own
  `owner_unlocked`:
  - `REVERTED`;
  - `ACTIVITY`: the first visitor activity after the attract show;
  - `CONFIG`: owner config, or the console `kiosk off`.
- The app counts down locally from `idle_remaining_s` and resets to
  `idle_timeout_s` whenever it sends a Play op.
- There is no maximum session length.

## Owner

- **Unlock:** `kiosk_unlock{secret}` unlocks only the connection that sent it,
  until that connection drops. `lm_kiosk_tick` clears an unlock on any connect or
  disconnect edge of that transport.
- **Wrong secret:** a 2 s lockout on further attempts.
- **The secret** travels in the clear over BLE and is stored in plain text on
  flash. It keeps visitors out; it does not resist an attacker with the board.
- **Recovery:** the USB serial console `kiosk off` disables the kiosk (persisted)
  and drops all unlocks. `kiosk status` (or bare `kiosk`) prints the state.

### Enabling on a fixture

1. Connect while the kiosk is disabled.
2. Deploy the attract effect on deck A, tune its sliders, and set the brightness.
3. Send `set_kiosk_config{enabled: true, owner_secret, idle_timeout_s: 120}`.
   - With no snapshot stored, enabling captures one.
   - Add `capture_attract_from_current: true` to re-capture.
4. To change it later:
   1. `kiosk_unlock{secret}`;
   2. deploy and tune;
   3. `set_kiosk_config{capture_attract_from_current: true}`.

## Notes

- **BLE and Wi-Fi.** On the netstack build, a wss client connecting kicks the BLE
  central (`netstack_transport.cpp`: the vestigial post-provision BLE link is
  dropped on the rising edge of a wss session). That doesn't matter at a no-Wi-Fi
  site, but on a bench with Wi-Fi a BLE visitor is disconnected when a wss client
  connects.
- **BLE frame sizes.** BLE frames are capped at 1536 B and replies are serialized.
  `kiosk_status` is under 120 B.
