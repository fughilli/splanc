// The C6 front end's link to the P4 over SDIO (frontend_link.cpp).
#pragma once

#include <stddef.h>
#include <stdint.h>

// Start the SDIO slave. Call early in setup(): the P4 probes for it at its boot.
bool frontend_link_begin();
// Service the link once per loop(): received frames, pushes to the wss session, HELLO.
void frontend_link_poll();
// Whether the P4 has been heard from in the last 350 ms.
bool frontend_p4_up();
// Forward one player message (ClientMessage bytes) from wss/GATT session `session` and
// wait up to `timeout_ms` for the P4's reply, written to `out`. Returns its length, 0 for
// no reply, -1 when the P4 is down or the reply doesn't fit, -2 when the P4 is up but the
// message couldn't be sent (the caller must not answer it itself).
int frontend_forward(uint16_t session, const uint8_t *msg, size_t len, uint8_t *out, size_t cap, int timeout_ms);
// The identity the front end advertises (BLE, mDNS): its MAC string and device name. The
// P4 takes it over (LK_OP_NAME), so its Welcome names the device the app found.
void frontend_link_set_identity(const char *mac, const char *name);
// Forward one OSC datagram (udp/9000) to the P4: its uniforms and modules live there.
// Network task; drops it when the link is down or full (OSC is latest-value-wins).
void frontend_link_osc(const uint8_t *data, size_t len);
// One line (newline-terminated) for the P4's console, which prints it as "[c6] ...".
void frontend_link_log(const char *line);
// The LK_FE_* features this front end serves (link_codec.h), sent in every HELLO: the P4's
// Welcome names them (LK_FE_MESH: "mesh"). Call before frontend_link_begin.
void frontend_link_set_features(uint8_t bits);
// Relay one ClientMessage the mesh addressed to this fixture to the P4 (LK_MESH) and wait up
// to `timeout_ms` for its result: 0 = ok, else failed with *code (the P4's, or one of the
// kMesh* codes below when it never answered).
int frontend_forward_mesh(const uint8_t *msg, size_t len, uint32_t *code, int timeout_ms);
// The codes frontend_forward_mesh reports when the P4 gave none: down, not sent, no answer.
enum : uint32_t { kMeshP4Down = 0xfff0, kMeshP4Unsent = 0xfff1, kMeshP4Silent = 0xfff2 };
// The P4's latest player status from its HEARTBEAT (fps, brightness, firmware). False while
// the P4 is down or its image sends none.
bool frontend_p4_status(uint32_t *fps, uint32_t *brightness, uint32_t *firmware);
// Whether the P4 last said its kiosk mode is on (LK_ST_KIOSK; kept while the P4 is down).
bool frontend_p4_kiosk();
// A session (wss, or LK_SESSION_BLE) ended here: the P4 hears it (LK_OP_RESET, sent before
// anything else of that session's), and its kiosk unlock counts as gone at once.
void frontend_link_session_closed(uint16_t session);
// Whether the P4 says session `session` is kiosk-unlocked by its owner (LK_ST_UNLOCKED_*):
// the mesh arms answered here pass a kiosk on such a session only. False while the P4 is down.
bool frontend_p4_unlocked(uint16_t session);
// Mesh time on the P4's clock (link_mesh.h): main.cpp lm_mesh_tb's contract, in this chip's
// clock, mirrored onto the P4. -1 (busy) until the P4's state is in and the offset known.
int32_t frontend_mesh_tb(int32_t op, int64_t *epoch_ms, int64_t shift_ms);
// Effect sharing (mesh M6) on the P4: stage `frame` (LK_MQ_STAGE, id ours) and its result
// (*r: 1 staged, 0 late, -1 refused; *replaced_id: an earlier one it replaced, 0 none); 0 ok,
// -1 when the link gave no answer. Forget what is staged. The persisted deck-A frame into
// `out` (its length, 0 none, -1 no answer or too big). The P4's LK_OP_STAGED reports, in order.
int frontend_mesh_stage(uint32_t id, uint32_t apply_at_ms, const uint8_t *frame, size_t len, int8_t *r,
                        uint32_t *replaced_id);
void frontend_mesh_cancel();
int frontend_mesh_effect_file(uint8_t *out, size_t cap);
bool frontend_take_staged(uint32_t *id, uint8_t *r);
// How many times the P4 has come up (a new value: it restarted, and lost what it staged).
uint32_t frontend_p4_ups();
// The P4's count of /lfs/fx.pb writes (its HEARTBEAT). False while down or unknown.
bool frontend_p4_fx_gen(uint32_t *gen);
// One "[link] mt ..." line: the clock offset and the time-base mirror.
int frontend_mesh_time_stats(char *buf, size_t cap);
// One "[link] ..." status fragment.
int frontend_link_stats(char *buf, size_t cap);
