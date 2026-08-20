// Interrupt-driven WS2812 transmit over the ESP32-C6 RMT peripheral (IDF
// driver/rmt_tx.h), 1 or 2 parallel channels. Replaces FastLED's blocking
// clockless driver: the render task snapshots a frame, the transmit task calls
// ws2812_rmt_show() (which blocks only THIS task while the RMT encoders stream
// the bits by interrupt, yielding the core back to render), and the async
// double-buffer contract in main.cpp is unchanged. Single owner: init once, show
// from one task only.
//
// Two channels let a long logical strip split across two GPIOs and clock out in
// PARALLEL (halving the wall-clock push for a given LED count). Channel 0 drives
// the first `count0` LEDs, channel 1 the next `count1` — from ONE contiguous
// buffer. Pass gpio1 < 0 (and count1 == 0) for a single channel.
#ifndef FIRMWARE_PLAYER_APP_WS2812_RMT_H_
#define FIRMWARE_PLAYER_APP_WS2812_RMT_H_

#include <stddef.h>
#include <stdint.h>

// Create the RMT TX channel(s) + WS2812 byte encoder(s) on `gpio0` (and `gpio1`
// if >= 0), sized for up to `max_leds` pixels TOTAL across both channels. Returns
// false on allocation/peripheral failure. Call once.
bool ws2812_rmt_init(int gpio0, int gpio1, uint32_t max_leds);

// Clock out `count0` pixels on channel 0 (from rgb[0..count0)) and `count1` on
// channel 1 (from rgb[count0..count0+count1)), in parallel. `rgb` is
// (count0+count1)*3 bytes in R,G,B memory order (e.g. a CRGB/Rgb array); the
// driver reorders each channel's pixels to its configured wire color order
// (default GRB — see ws2812_rmt_set_color_order) internally. Blocks the calling
// task until BOTH channels finish, then holds the lines low so the >=50 us
// inter-frame gap latches. count1 == 0 (or no channel 1) drives channel 0 only.
//
// `order_override` (default nullptr) applies a single source-index permutation
// (wire byte i = rgb[order_override[i]]) to ALL pixels on both channels instead
// of the per-channel configured order — the color-order counting probe uses this
// to drive its own wire order without disturbing the committed content order.
void ws2812_rmt_show(const uint8_t *rgb, uint32_t count0, uint32_t count1,
                     const uint8_t *order_override = nullptr);

// Set channel `ch`'s wire color order as a SOURCE permutation of the R,G,B input:
// wire byte i is written from rgb[src[i]] (R=0, G=1, B=2). GRB (the WS2812B
// default) is {1, 0, 2}. A no-op for an out-of-range channel. Cheap (three byte
// writes); safe to call from any task — a torn read costs at most one slightly
// mis-ordered frame, which the next frame corrects.
void ws2812_rmt_set_color_order(int ch, uint8_t s0, uint8_t s1, uint8_t s2);

// Re-create the RMT channel(s) on new GPIO(s), keeping the existing max_leds /
// scratch buffer and the configured color orders. Tears down the old channels
// first. MUST be called from the single task that owns ws2812_rmt_show() (the
// transmit task) so it never races an in-flight push. `gpio1 < 0` drops to a
// single channel. Returns false on peripheral/allocation failure (the driver is
// left uninitialized — the caller should treat that as fatal).
bool ws2812_rmt_reconfigure(int gpio0, int gpio1);

// Diagnostics: the number of channels that initialized (1 or 2), and the last
// rmt_transmit() result (esp_err_t as int; 0 == ESP_OK) for channel `ch`.
int ws2812_rmt_channels(void);
int ws2812_rmt_last_error(int ch);

#endif  // FIRMWARE_PLAYER_APP_WS2812_RMT_H_
