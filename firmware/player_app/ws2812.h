// WS2812 transmit, 1 or 2 parallel channels. Two backends implement this API:
//   * ws2812_parlio.cpp (ESP32-C6): the PARLIO peripheral clocks a whole frame
//     out of RAM by GDMA. No CPU work while the bits are on the wire, so ISR
//     latency (WiFi, TLS, flash ops masking non-IRAM interrupts) cannot stretch
//     or repeat bits mid-frame.
//   * ws2812_rmt.cpp (ESP32-C3, or --//firmware/player_app:ws2812_rmt on the
//     C6): the RMT peripheral, refilled by interrupt from a 48-symbol ring. A
//     late refill retransmits a stale block (seen on the C6 wire as +2 LED
//     frames roughly once a second) or gaps long enough to latch early.
// The render task stages a frame (encoding it into the driver's buffer, which
// is the snapshot), the transmit task calls ws2812_send() (which blocks only
// THIS task while the hardware streams the bits, yielding the core back to
// render). Stage and send alternate under main.cpp's xmit_done gate; init once.
//
// Two channels let a long logical strip split across two GPIOs and clock out in
// PARALLEL (halving the wall-clock push for a given LED count). Channel 0 drives
// the first `count0` LEDs, channel 1 the next `count1` — from ONE contiguous
// buffer. Pass gpio1 < 0 (and count1 == 0) for a single channel.
#ifndef FIRMWARE_PLAYER_APP_WS2812_H_
#define FIRMWARE_PLAYER_APP_WS2812_H_

#include <stddef.h>
#include <stdint.h>

// Bring up the output on `gpio0` (and `gpio1` if >= 0), sized for up to
// `max_leds` pixels TOTAL across both channels. Returns false on
// allocation/peripheral failure. Call once.
bool ws2812_init(int gpio0, int gpio1, uint32_t max_leds);

// Encode `count0` pixels for channel 0 (from rgb[0..count0)) and `count1` for
// channel 1 (from rgb[count0..count0+count1)) into the driver's own transmit
// buffer, which is the frame SNAPSHOT: `rgb` may be overwritten as soon as this
// returns. `rgb` is (count0+count1)*3 bytes in R,G,B memory order (e.g. a
// CRGB/Rgb array); each channel's pixels are reordered to its configured wire
// color order (default GRB — see ws2812_set_color_order). count1 == 0 (or no
// channel 1) drives channel 0 only. Must not overlap an in-flight ws2812_send().
//
// `order_override` (default nullptr) applies a single source-index permutation
// (wire byte i = rgb[order_override[i]]) to ALL pixels on both channels instead
// of the per-channel configured order — the color-order counting probe uses this
// to drive its own wire order without disturbing the committed content order.
void ws2812_stage(const uint8_t *rgb, uint32_t count0, uint32_t count1,
                  const uint8_t *order_override = nullptr);

// Clock out the staged frame on both channels in parallel. Blocks the calling
// task until BOTH channels finish, then holds the lines low so the >=50 us
// inter-frame gap latches. A no-op if nothing is staged.
void ws2812_send(void);

// ws2812_stage() + ws2812_send(), for synchronous callers (boot, pre-task).
void ws2812_show(const uint8_t *rgb, uint32_t count0, uint32_t count1,
                 const uint8_t *order_override = nullptr);

// Set channel `ch`'s wire color order as a SOURCE permutation of the R,G,B input:
// wire byte i is written from rgb[src[i]] (R=0, G=1, B=2). GRB (the WS2812B
// default) is {1, 0, 2}. A no-op for an out-of-range channel. Cheap (three byte
// writes); safe to call from any task — a torn read costs at most one slightly
// mis-ordered frame, which the next frame corrects.
void ws2812_set_color_order(int ch, uint8_t s0, uint8_t s1, uint8_t s2);

// Re-create the output on new GPIO(s), keeping the existing max_leds / staging
// buffer (a staged frame survives) and the configured color orders. Tears down the old channels
// first. MUST be called from the single task that owns ws2812_show() (the
// transmit task) so it never races an in-flight push. `gpio1 < 0` drops to a
// single channel. Returns false on peripheral/allocation failure (the driver is
// left uninitialized — the caller should treat that as fatal).
bool ws2812_reconfigure(int gpio0, int gpio1);

// Diagnostics: the number of channels that initialized (1 or 2), the last
// transmit result (esp_err_t as int; 0 == ESP_OK) for channel `ch`, and the
// backend name ("parlio" / "rmt") for the boot log.
int ws2812_channels(void);
int ws2812_last_error(int ch);
const char *ws2812_backend(void);

#endif  // FIRMWARE_PLAYER_APP_WS2812_H_
