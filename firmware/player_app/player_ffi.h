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
// The per-LED store (map positions, topology cache, mapped bits) is sized at
// boot for the CONFIGURED strip, not the LED cap: lm_led_store_bytes(n) bytes
// (4-aligned, allocated once for the process) bound with lm_led_store_bind
// BEFORE lm_player_init. Returns false on a short / misaligned block.
size_t lm_led_store_bytes(uint32_t leds);
bool lm_led_store_bind(uint8_t *mem, size_t bytes, uint32_t leds);
void lm_player_init(uint32_t default_led_count);
// After lm_player_init: this boot's buffers hold `capacity` LEDs (summed across
// channels) and the heap can buffer at most `max_leds` (reported as
// board.max_leds). A count change past `capacity` (within `max_leds`) is
// persisted and answered reboot_required; lm_take_reboot_request() then reads
// true — restart once the reply has gone out.
void lm_set_led_limits(uint32_t capacity, uint32_t max_leds);
bool lm_take_reboot_request(void);

// Set the player's hardware identity (factory MAC + current display name),
// echoed in every welcome. Call once after lm_player_init.
void lm_player_set_identity(const uint8_t *mac, size_t mac_len,
                            const uint8_t *name, size_t name_len);

// Set the firmware build info (git commit + dirty flag + release version) echoed
// in every welcome. `commit` is the full git hash (UTF-8); `dirty` is true when
// the working tree had uncommitted changes at build time; `version` is the
// release version from the nearest firmware-v* tag (UTF-8). Call once after
// lm_player_init. The firmware owns the stamped build_info.h (LM_GIT_COMMIT /
// LM_GIT_DIRTY / LM_VERSION).
void lm_player_set_build_info(const uint8_t *commit, size_t commit_len, bool dirty,
                              const uint8_t *version, size_t version_len);
// Render the agent discovery manifest (GET /.well-known/splanc.json, schema
// "splanc-agent/1") into out (cap bytes); returns its length, or -2 when it
// doesn't fit. cert_sha256: the TLS certificate's SHA-256, lowercase hex.
// bundle_url / bundle_sha256: the build's agent-bundle stamps (bundle_info.h;
// empty = derive the URL for a release build / no hash).
int32_t lm_agent_manifest(uint8_t *out, size_t cap, const uint8_t *cert_sha256,
                          size_t cert_len, const uint8_t *bundle_url, size_t url_len,
                          const uint8_t *bundle_sha256, size_t sha_len);
// Publish the per-device TLS identity: state "generating" | "ready", the cert's
// SHA-256 (lowercase hex, empty while generating) and whether it is persisted in
// flash. Read by get_tls_info, the manifest's tls block and the mDNS TXT "tls" key.
void lm_set_tls_info(const uint8_t *state, size_t state_len, const uint8_t *sha,
                     size_t sha_len, bool persisted);
// mDNS (_splanc._tcp, firmware/mdns): answer one UDP:5353 datagram from src_port.
// Writes the reply DNS message into out; returns its length (0 = nothing to answer,
// <0 = error). *unicast: reply to the querier's address+port, not 224.0.0.251:5353.
// ip = our IPv4 address (4 bytes).
int32_t lm_mdns_respond(const uint8_t *query, size_t qlen, uint16_t src_port,
                        const uint8_t *ip, uint8_t *out, size_t cap, bool *unicast);
// An unsolicited mDNS announcement of every record (send to 224.0.0.251:5353);
// returns its length or <0.
int32_t lm_mdns_announce(const uint8_t *ip, uint8_t *out, size_t cap);
// Room pose (set_fixture_pose): change generation (poll after each message) and
// whether the last change asked to be persisted (commit, unset = true).
uint32_t lm_fixture_pose_gen(void);
bool lm_fixture_pose_commit(void);
// Shared effect-time epoch (set_time_base), device-clock ms: true + *epoch_ms when
// set. The render loop derives effect time = (now - epoch) / 1000.
bool lm_time_base(int64_t *epoch_ms);
// Whether the set_uniforms just handled asked to be persisted (SetUniforms.commit,
// unset = true). A commit=false update is applied live but not saved.
bool lm_set_uniforms_commit(void);
// FX decks (docs/design/uniform-keypoints.md): the deck the effect arm just
// handled targeted (0 = A, 1 = B). Only deck A's frames are persisted.
uint32_t lm_fx_last_deck(void);
// Uniform keypoints. The fx layer owns the record format; the app hands it a
// littlefs store at boot. `name` is a short file name ("kp_<effect>.<n>"), not
// NUL-terminated. read: bytes read into buf (cap), -1 when missing. write: an
// atomic (power-loss-safe) whole-file write. remove: delete (missing is fine).
typedef int32_t (*lm_kp_read_fn)(const uint8_t *name, size_t name_len, uint8_t *buf, size_t cap);
typedef bool (*lm_kp_write_fn)(const uint8_t *name, size_t name_len, const uint8_t *buf, size_t len);
typedef void (*lm_kp_remove_fn)(const uint8_t *name, size_t name_len);
void lm_kp_set_store(lm_kp_read_fn read, lm_kp_write_fn write, lm_kp_remove_fn remove);
// Whether the blend_keypoints just handled asked to persist its target (deck A),
// and that target encoded as a set_uniforms ClientMessage frame (length, or <0).
bool lm_kp_commit(void);
int32_t lm_kp_commit_frame(uint8_t *out, size_t cap);
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
// 1 = commit the latest color-correction update to flash; 0 = apply from RAM
// only (live preview). Read alongside lm_color_correction_params on a change.
int32_t lm_color_correction_commit(void);

// Global output brightness: a generation counter bumped on every set_brightness,
// and the active scale as an 8-bit value (0..=255, 255 = unattenuated) suitable
// for FastLED nscale8. The app polls the generation after each lm_player_handle
// (like lm_color_correction_gen); on a change it re-reads the scale and applies
// it to every rendered LED just before the strip write. Runtime-only on the
// device (defaults to 255 after a reboot).
uint32_t lm_brightness_gen(void);
uint8_t lm_brightness_u8(void);

// Hardware output config (set_hardware_config: GPIO + wire color order per RMT
// channel). Seed each wired channel once at boot with lm_hw_seed (the GPIO the
// firmware initialized + a color-order name like "GRB"; an unknown name falls
// back to GRB) so the first welcome echoes the real hardware. Then the app polls
// lm_hw_config_gen after each lm_player_handle (like lm_color_correction_gen); on
// a change it re-reads each channel's color-order permutation (into a 3-byte
// buffer via lm_hw_color_order_perm — out[i] is the logical channel R=0/G=1/B=2
// that wire byte i carries) and GPIO (lm_hw_gpio, -1 if unseeded), applies them,
// and — when lm_hw_config_commit is 1 — persists the GPIO + color-order name
// (lm_hw_color_order_name) to NVS.
void lm_hw_seed(uint32_t channel, int32_t gpio, const uint8_t *order,
                size_t order_len);
// Seed a channel's LED count at boot from NVS (0 = not set), like lm_hw_seed.
// set_hardware_config.led_count bumps lm_hw_config_gen; on commit the app
// persists lm_led_count(ch) per channel.
void lm_led_count_seed(uint32_t channel, uint32_t led_count);
// Install this board's static capability descriptor (a serialized
// BoardCapabilities: the board textproto compiled to a binaryproto at build time
// and embedded in the image). Call once at boot; it's echoed in
// hardware_config_state so the app builds its GPIO picker / LED-type list from
// this board. A null/empty/undecodable blob is ignored (app falls back to a
// built-in catalog).
void lm_set_board_caps(const uint8_t *data, size_t len);
uint32_t lm_hw_config_gen(void);
int32_t lm_hw_config_commit(void);
int32_t lm_hw_gpio(uint32_t channel);
int32_t lm_hw_color_order_perm(uint32_t channel, uint8_t *out);
int32_t lm_hw_color_order_name(uint32_t channel, uint8_t *out, size_t cap);

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
// return how many; 0 signals EOF. Not called again after returning 0 until a
// rewind.
typedef size_t (*LmRefill)(void *ctx, uint8_t *buf, size_t cap);

// Rewind callback for lm_decode_upload_stream: reset the source so the next
// refill returns the frame's first byte again. A topology is decoded in two
// passes (count, then exact-size fill) and rewinds once between them.
typedef void (*LmRewind)(void *ctx);

// Decode a reassembled upload frame streamed in block-by-block via `refill`, so
// a whole ~15 KB submit_map is never resident (the player keeps it on flash).
// `arm` selects the decoder (13 = submit_map, 16 = submit_topology);
// `total_len` is the frame's exact length. Populates the stored map/topology
// exactly like the in-RAM path; returns the encoded reply (result_ready/error)
// in out, its length, or -2 if the reply doesn't fit.
int32_t lm_decode_upload_stream(int32_t arm, LmRefill refill, LmRewind rewind,
                                void *ctx, size_t total_len, uint8_t *out,
                                size_t out_cap);

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
// Highest LED the latched counting pattern lights + 1 (0 when none). The frame
// loop transmits exactly this many LEDs for the calibration pattern (no overrun).
uint32_t lm_counting_len(void);
// Wire color order for the counting probe's pixels: writes the 3-byte source-
// index permutation (R=0,G=1,B=2) into `perm`. The probe's OWN order, applied at
// transmit independent of the committed per-channel color order (identity = raw).
void lm_counting_color_order(uint8_t perm[3]);
// Hardware output channel the counting probe paints (0 when none). Its block
// indices (lm_counting_color / lm_counting_len) are relative to that channel's
// strip start; the frame loop routes them to that output and blanks the others.
uint32_t lm_counting_channel(void);
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

// Two decks (A, B) run concurrently and lm_fx_shade blends them by the
// crossfade; the protocol arms address either deck. The functions below that
// load / clear / activate / set uniforms act on DECK A (the persisted deck).
//
// Load (parse + hold) a .fxb onto deck A, copying len bytes into a static
// buffer and resetting VM state. False if it doesn't fit or fails to parse.
// Loading does NOT activate — use lm_fx_set_active (the protocol arms do this).
bool lm_fx_load(const uint8_t *fxb, size_t len);
// Clear deck A's effect (back to idle).
void lm_fx_clear(void);
// True when ANY deck is loaded AND active (the render loop gate).
bool lm_fx_active(void);
// True when deck A has an effect loaded at all (active or parked).
bool lm_fx_loaded(void);

// Memory-mode tracking (docs/design/memory-regions.md), LOG-ONLY: the loop hands the
// network-side facts to lm_mode_observe, which tracks the device through the sysmode model
// and reports each transition the model refuses (to log; nothing is gated yet). Counters
// live in the LM_MODE static (read over JTAG). lm_mode_boot starts tracking after the
// stored map/effect replay; lm_mode_event applies one explicit model event.
typedef struct {
  bool creds;
  bool leased;
  bool ble_connected;
  bool wss;
  bool upload;
} LmNetObserved;
typedef struct {
  uint32_t state;  // sysmode state_code before the transition
  uint32_t event;  // index in sysmode Event::ALL (0xff: a change no event models)
  uint32_t why;    // sysmode refuse code (0xff: unmodeled)
} LmModeRefusal;
// ledmapper_sysmode::observe::Stats (same field order).
typedef struct {
  uint32_t polls;
  uint32_t accepted;
  uint32_t refused;
  uint32_t refused_by_kind[4];
  uint32_t unmodeled;
  uint32_t state;
  uint32_t last_refusal;
} LmModeStats;
extern LmModeStats LM_MODE;
void lm_mode_boot(void);
uint32_t lm_mode_observe(const LmNetObserved *net, int64_t now_ms, LmModeRefusal *out,
                         size_t cap);
int32_t lm_mode_event(uint32_t event);
// Activate (true) / park (false) deck A's effect.
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
// Apply a uniform value (n = its width, 1..4) to deck A's VM.
void lm_fx_set_uniform(uint32_t slot, const float *vals, size_t n);
// Ingest one OSC datagram (from the UDP task) and drive the active effect's
// uniforms from it. Returns the number of uniform writes applied (0 when no
// effect is active, the datagram isn't OSC, or nothing matched). Non-blocking,
// no allocation. Call under the same lock as lm_fx_set_uniform.
uint32_t lm_osc_ingest(const uint8_t *data, size_t len);
// Select OSC addressing: true (default) resolves uniform names via the active
// effect's manifest (unknown names fall back to slot index); false treats every
// address as a raw slot number.
void lm_osc_set_by_name(bool by_name);
// Run update() once for this frame on every active deck, advancing keypoint
// morphs first (clears the deadline flag first, latches the crossfade). False
// when no deck is loaded. A cancelled update still counts (partial state is
// harmless).
bool lm_fx_update(float time_s, float dt_s, uint32_t frame, uint32_t led_count);
// Shade one LED at position (x,y,z) into rgb[3]: each active deck, blended by
// the crossfade (at an endpoint only that deck shades). False when no deck
// produced a colour (nothing loaded, or a bounded-execution guard cancelled it).
bool lm_fx_shade(uint32_t idx, float x, float y, float z, uint8_t rgb[3]);
// Copy deck A's uniform manifest into out (cap bytes). Returns the
// length written, -1 when no effect is loaded, -2 when it doesn't fit cap.
int32_t lm_fx_manifest(uint8_t *out, size_t cap);
// FUG-125 on-device JIT: enable/disable (takes effect on the next lm_fx_load;
// reload to rebuild or tear down the segments) and read how many segments the
// current effect installed (0 = pure interpretation). For the HITL A/B.
void lm_fx_set_jit_enabled(bool enabled);
uint32_t lm_fx_jit_count(void);
void lm_fx_jit_diag(uint32_t *plans, uint32_t *words, uint32_t *alloc_ok);

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
void lm_perf_set_heap(uint32_t free, uint32_t min_free, uint32_t largest_free);
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

// -- Framerate autoscaler (FUG-82; docs/design/perf-monitoring.md) ------------
// Effects run at a CONSISTENT rate picked from a 5-fps ladder (25..80) and
// adapted to each frame's measured cost with >=5% headroom. An effect that can't
// hold even the floor (or an app-pinned rate, set_fps) is NEVER parked: it runs
// as fast as it can ("lagging"), and the app gets an advisory. Call under
// player_mutex.

// Account for one effect frame whose cost (max of update+shade over every
// rendering deck and the strip transmit) was cost_us; returns the ms to sleep
// before the next frame (period - work, >= the minimum yield; after a frame that
// overran its period, >= max(4 ms, 25% of its cost) so the render task takes at
// most 80% of the CPU and the network loop, sensors and TLS stay serviced).
// `wire_leds` LEDs of that frame clocked out one after another (the longest
// channel; the two go out in parallel): their WS2812 wire time (28.8 us per LED
// + the latch) caps the ladder at what the wire can carry. The `leds` it shaded
// set the floor (25 fps up to 512 LEDs, proportionally lower past it, so a long
// strip gets a steady slower rung for a heavy effect).
uint32_t lm_fps_on_frame(uint32_t cost_us, uint32_t wire_leds, uint32_t leds);
// The rate the effect runs at now (the rung, or what it achieves while lagging).
uint32_t lm_fps_current_fps(void);
// Per-frame overrun budget in CPU cycles for the current rung (cpu_hz / fps).
uint32_t lm_fps_budget_cycles(void);
// Whether the lag state changed since last reported (read + update); *lagging
// (may be NULL) gets the new state. loop() then pushes one fps_state advisory.
bool lm_fps_take_lag_notify(bool *lagging);
// Encode the live FpsState into out. Returns the length, -1 bad args, -2
// out_cap too small.
int32_t lm_fps_build_state(uint8_t *out, size_t out_cap);
// -- Sensor core (sensor_ffi.rs, docs/design/sensor-core.md) -------------------
// I2C callbacks the Rust driver calls: 0 = done, 1 = address NACK, 2 = other error.
typedef struct {
  void *ctx;
  int (*write_read)(void *ctx, uint8_t addr, const uint8_t *wr, size_t wn, uint8_t *rd,
                    size_t rn);
  int (*write)(void *ctx, uint8_t addr, const uint8_t *wr, size_t wn);
  uint32_t (*cycles)(void);  // free-running CPU cycle counter (optional)
} LmI2cOps;
// Probe 0x68/0x69 through `ops` (must stay valid). Returns 1 absent, 2 unknown
// device, 3 starting (start the sensor task), 5 fault. `cal` = NVS record or NULL.
uint8_t lm_sensor_begin(const LmI2cOps *ops, int32_t sda, int32_t scl, int32_t int_gpio,
                        uint64_t now_us, const uint8_t *cal, size_t cal_len);
// Report the sensor core as disabled (config off / pin conflict).
void lm_sensor_set_disabled(int32_t sda, int32_t scl, int32_t int_gpio);
// Sensor task step: returns ms to sleep.
uint32_t lm_sensor_poll(uint64_t now_us);
// A changed calibration record to persist (length), 0 if none, -1 cap too small.
int32_t lm_sensor_take_cal_record(uint8_t *out, size_t cap);
// Status for the periodic log: u[6], f[5] (see sensor_ffi.rs).
void lm_sensor_status(uint32_t *u, float *f);
// -- IMU extrinsic + capture profile (sensor-core.md §7) -------------------------
// A NEW map was stored by a live upload: drop the capture profile, mark the IMU
// extrinsic's yaw unresolved.
void lm_map_replaced(void);
void lm_capture_profile_seed(const uint8_t *p, size_t len);
uint32_t lm_capture_profile_gen(void);
size_t lm_capture_profile_get(uint8_t *out, size_t cap);
// Install bus callbacks without probing (the driver VM's lazy bus).
void lm_sensor_set_ops(const LmI2cOps *ops);

// -- Driver VM host (driver_ffi.rs, FUG-107) -------------------------------------
typedef struct {
  void *(*alloc)(size_t size);
  void (*free)(void *p);
  bool (*bus_ensure)(void);
  size_t (*scan)(uint8_t *out, size_t cap);
  uint32_t (*cycles)(void);
} LmDrvHost;
void lm_drv_set_host(const LmDrvHost *host);
// Run the loaded driver's poll() if due (loop task, player mutex held).
void lm_drv_poll(uint64_t now_us);

// -- FX debugger (fxdbg.rs, docs/design/fx-debugger.md) --------------------------
// Boot: the output stage snapshots read back (the `leds` frame buffer of `cap`
// RGB triples, &g_lut, &g_brightness).
void lm_fxdbg_bind_output(const uint8_t *leds, uint32_t cap, const uint8_t *const *lut,
                          const uint8_t *brightness);
// Render task, before the effect branch: true = paused, render nothing.
bool lm_fxdbg_hold(uint32_t now_ms);
// Effect branch, after the frame clock: a pending step overrides time/dt; true =
// this frame is a debugger step (skip the autoscaler).
bool lm_fxdbg_step(float *time_s, float *dt_s);
bool lm_fxdbg_paused(void);
// Loop task: lapse a pause whose client went away (no session open).
void lm_fxdbg_poll(uint32_t now_ms, bool session_open);

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // FIRMWARE_PLAYER_APP_PLAYER_FFI_H_
