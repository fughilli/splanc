// C ABI of the Rust player stack (ffi.rs — see its docs). Single-threaded:
// call everything from the Arduino loop() task only.
#ifndef FIRMWARE_PLAYER_APP_PLAYER_FFI_H_
#define FIRMWARE_PLAYER_APP_PLAYER_FFI_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Initialize (or reset) the player. default_led_count seeds the code-book
// until the counting handshake / start_mapping override it.
void lm_player_init(uint32_t default_led_count);

// Set the player's hardware identity (factory MAC + current display name),
// echoed in every welcome. Call once after lm_player_init.
void lm_player_set_identity(const uint8_t *mac, size_t mac_len,
                            const uint8_t *name, size_t name_len);
// Copy the player's CURRENT display name into out (cap bytes). Returns the
// length written, or -2 when it doesn't fit. The app polls this after each
// lm_player_handle so a set_device_name is persisted + reflected to BLE.
int32_t lm_device_name(uint8_t *out, size_t cap);

// Color correction: generation counter bumped on every set_color_correction,
// and the active per-channel profile. The app polls the generation after each
// lm_player_handle (like lm_device_name); on a change it reads the six params
// (gamma[0..3] then luminance[0..3], channel order R,G,B) into `out`, rebuilds
// the flash LUTs, and re-persists them. lm_color_correction_params returns 0 on
// success, -1 if out is null.
uint32_t lm_color_correction_gen(void);
int32_t lm_color_correction_params(float *out);

// Handle one received protocol frame (a binary WebSocket message).
// recv_ms/send_ms are the player clock (millis()) at receive / reply time,
// integer milliseconds. Returns: >0 = reply length written to out; 0 = no
// reply (fire-and-forget arm); -1 = bad arguments; -2 = out_cap too small.
int32_t lm_player_handle(const uint8_t *data, size_t len, int64_t recv_ms,
                         int64_t send_ms, uint8_t *out, size_t out_cap);

// The oneof arm (first-tag field number) of a protocol envelope, or -1. Lets
// the app classify a frame without decoding it: a request as submit_map (13) /
// submit_topology (16), a reply as result_ready (8) — used to persist only
// successful uploads to LittleFS.
int32_t lm_envelope_arm(const uint8_t *data, size_t len);

// One window of a sharded submit_map / submit_topology (proto UploadChunk),
// filled by lm_parse_upload_chunk. payload_off/payload_len locate the window's
// bytes within the frame passed to that call.
typedef struct {
  uint32_t upload_id;
  uint32_t seq;
  uint32_t payload_off;
  uint32_t payload_len;
  uint32_t kind;  // 0 = MAP (submit_map), 1 = TOPOLOGY (submit_topology)
  uint8_t last;
} LmUploadChunk;

// Parse a ClientMessage{upload_chunk} frame into *out. Returns: 1 = parsed an
// upload_chunk; 0 = a well-formed frame that is NOT an upload_chunk (handle it
// as a normal message); -1 = bad args; -2 = malformed. The transport copies
// data[out->payload_off .. +payload_len] into its reassembly buffer, then on
// out->last feeds the reassembled frame to lm_player_handle.
int32_t lm_parse_upload_chunk(const uint8_t *data, size_t len,
                              LmUploadChunk *out);

// Encode a ServerMessage{chunk_ack{upload_id, seq}} into out (cap bytes),
// returning its length (-2 if it doesn't fit). Sent after each non-final
// window so the client paces one small TLS record per send.
int32_t lm_encode_chunk_ack(uint32_t upload_id, uint32_t seq, uint8_t *out,
                            size_t out_cap);

// Refill callback for lm_decode_upload_stream: write up to `cap` bytes at `buf`
// from the caller's source (a LittleFS read of the reassembled upload) and
// return how many; 0 signals EOF. Not called again after returning 0.
typedef size_t (*LmRefill)(void *ctx, uint8_t *buf, size_t cap);

// Decode a reassembled upload frame streamed in block-by-block via `refill`, so
// a whole ~15 KB submit_map is never resident (the player keeps it on flash).
// `arm` selects the decoder (13 = submit_map, 16 = submit_topology);
// `total_len` is the frame's exact length. Populates the stored map/topology
// exactly like the in-RAM path; returns the encoded reply (result_ready/error)
// in out, its length, or -2 if the reply doesn't fit.
int32_t lm_decode_upload_stream(int32_t arm, LmRefill refill, void *ctx,
                                size_t total_len, uint8_t *out, size_t out_cap);

// Render-side accessors (pure reads, polled by the LED frame loop). All
// integer so the loop touches no f64 (the C6 RISC-V FPU is single-precision
// only): absolute frame index at player-clock ms `t` is
// ((t - epoch_ms) * 1000) / bit_period_us.
bool lm_pattern_timing(int64_t *epoch_ms, uint32_t *bit_period_us,
                       uint32_t *cycle_frames, uint32_t *led_count);
bool lm_pattern_color(uint32_t led, uint32_t frame_index, uint8_t rgb[3]);
// Record the monotonic-clock time (t_mono_us, raw micros()) at which the frame
// loop pushed absolute mapping-pattern frame `seq` (before the cycle modulo)
// to the LEDs, buffered for the phone to drain via get_frame_timing.
void lm_pattern_frame_shown(uint32_t seq, uint32_t t_mono_us);
bool lm_counting_color(uint32_t led, uint8_t rgb[3]);
// Topology-aware effect playback ("pulse"/"flood"). lm_playback_active() gates
// it (an effect is configured). Once per frame call lm_playback_step(dt_ms) to
// (re)build + advance the stateful sim; it returns whether a renderable sim
// exists (config + a stored topology). Then per LED, lm_playback_color() reads
// the LED's colour from the sim via its stored association.
bool lm_playback_active(void);
bool lm_playback_step(uint32_t dt_ms);
bool lm_playback_color(uint32_t led, uint8_t rgb[3]);
int32_t lm_led_count(uint32_t channel);
uint32_t lm_map_len(void);
bool lm_map_led(uint32_t index, uint32_t *id, float xyz[3]);

// -- Effects VM (fx_vm) -------------------------------------------------------
// A user "effect" (.fxb shader bytecode) executed on-device. The upload/select/
// uniforms arms are handled inside lm_player_handle; these accessors drive the
// render loop and (de)serialize the manifest. Single-threaded like the rest —
// call under the player_mutex.
//
// Bounded execution (docs/design/effects-runtime.md): every update()/shade()
// runs under a per-invocation INSTRUCTION BUDGET (primary guard) plus an
// optional WALL-TIME deadline flag a hardware timer raises (secondary). A
// cancelled shade returns false so the render loop holds last/black for that
// LED instead of hanging.

// Load (parse + hold) a .fxb, copying len bytes into a static buffer and
// resetting VM state. False if it doesn't fit or fails to parse. Loading does
// NOT activate — use lm_fx_set_active (the protocol arms do this).
bool lm_fx_load(const uint8_t *fxb, size_t len);
// Clear the loaded effect (back to built-in playback/idle).
void lm_fx_clear(void);
// True when an effect is loaded AND active (the render loop gate).
bool lm_fx_active(void);
// True when an effect is loaded at all (active or parked) — for persistence.
bool lm_fx_loaded(void);
// Activate (true) / park (false) the loaded effect.
void lm_fx_set_active(bool active);
// Per-invocation instruction cap for update()/shade() (0 = default).
void lm_fx_set_budget(uint32_t instructions);
// Raise/lower the wall-time deadline flag (the hardware-timer callback raises
// it at the frame deadline; the render loop clears it each frame). TODO(hw):
// arm an esp_timer/systimer one-shot per frame to call this at the deadline.
void lm_fx_set_deadline(bool hit);
// Last update() bounded-exec outcome: 0=Ok, 1=budget exceeded, 2=wall-time
// timeout. For the rate-limited [fx] diagnostic log.
uint32_t lm_fx_last_update_outcome(void);
// Apply a uniform value (n = its width, 1..4) to the active VM.
void lm_fx_set_uniform(uint32_t slot, const float *vals, size_t n);
// Run update() once for this frame (clears the deadline flag first). False when
// no effect is loaded. A cancelled update still returns true (partial state is
// harmless).
bool lm_fx_update(float time_s, float dt_s, uint32_t frame, uint32_t led_count);
// Shade one LED at position (x,y,z) into rgb[3]. False when no effect is loaded
// or the invocation was cancelled by a bounded-execution guard.
bool lm_fx_shade(uint32_t idx, float x, float y, float z, uint8_t rgb[3]);
// Copy the active effect's uniform manifest into out (cap bytes). Returns the
// length written, -1 when no effect is loaded, -2 when it doesn't fit cap.
int32_t lm_fx_manifest(uint8_t *out, size_t cap);

// -- Perf monitoring (docs/design/perf-monitoring.md) -------------------------
// The set_perf / get_perf_report protocol arms are handled inside
// lm_player_handle (store mode+interval, roll up + drain the perf ring). These
// accessors let the render loop feed the ring and let loop() pace the
// unsolicited push. Single-threaded like the rest — call under player_mutex.
//
// Tier 0 (BASIC): the render loop times update()/shade()/show() with
// esp_cpu_get_cycle_count() deltas and pushes them via lm_perf_push; heap +
// overrun/drop counters ride along. Tier 1 (FULL): lm_fx_update/lm_fx_shade
// additionally count VM opcodes + stack high-water (gated on FULL, near-zero
// overhead in BASIC), read back via lm_perf_instr_* / lm_perf_stack_max.

// Current perf tier: 0 OFF, 1 BASIC, 2 FULL. The render loop samples only when
// != OFF; loop() pushes an unsolicited report only when != OFF.
uint32_t lm_perf_mode(void);
// Unsolicited-push interval in ms (0 = poll-only); loop() coalesces at this
// cadence, like the playback-save quiet timer.
uint32_t lm_perf_interval_ms(void);
// The just-rendered frame's latched Tier-1 counts (0 unless FULL): opcodes
// retired in update() / across the shade sweep, and the stack high-water.
uint32_t lm_perf_instr_update(void);
uint32_t lm_perf_instr_shade(void);
uint32_t lm_perf_stack_max(void);
// Refresh the heap figures carried in the next PerfReport (call before push).
void lm_perf_set_heap(uint32_t free, uint32_t min_free);
// Push one rendered effect frame's Tier-0 cycle spans (+ latched Tier-1 counts)
// into the perf ring. `overran` marks a frame whose frame+show cycles exceeded
// the ~33 ms budget (counted since the last report drain).
void lm_perf_push(uint32_t seq, uint32_t update_cycles, uint32_t shade_cycles,
                  uint32_t frame_cycles, uint32_t show_cycles,
                  uint32_t led_count, bool overran);
// Record that the render task skipped a scheduled frame (fell behind).
void lm_perf_note_dropped(void);
// Build an unsolicited PerfReport frame (rolls up + drains the ring, same as
// the get_perf_report reply) into out. Returns the encoded length, 0 when perf
// is OFF (nothing to send), -1 bad args, -2 out_cap too small. loop() ships it
// at lm_perf_interval_ms() cadence over the active socket.
int32_t lm_perf_build_report(uint8_t *out, size_t out_cap);

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // FIRMWARE_PLAYER_APP_PLAYER_FFI_H_
