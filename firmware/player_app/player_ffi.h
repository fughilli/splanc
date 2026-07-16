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

// Handle one received protocol frame (a binary WebSocket message).
// recv_ms/send_ms are the player clock (millis()) at receive / reply time,
// integer milliseconds. Returns: >0 = reply length written to out; 0 = no
// reply (fire-and-forget arm); -1 = bad arguments; -2 = out_cap too small.
int32_t lm_player_handle(const uint8_t *data, size_t len, int64_t recv_ms,
                         int64_t send_ms, uint8_t *out, size_t out_cap);

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
int32_t lm_led_count(uint32_t channel);
uint32_t lm_map_len(void);
bool lm_map_led(uint32_t index, uint32_t *id, float xyz[3]);

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // FIRMWARE_PLAYER_APP_PLAYER_FFI_H_
