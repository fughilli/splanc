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
// driver reorders to the WS2812 wire order (GRB) internally. Blocks the calling
// task until BOTH channels finish, then holds the lines low so the >=50 us
// inter-frame gap latches. count1 == 0 (or no channel 1) drives channel 0 only.
void ws2812_rmt_show(const uint8_t *rgb, uint32_t count0, uint32_t count1);

#endif  // FIRMWARE_PLAYER_APP_WS2812_RMT_H_
