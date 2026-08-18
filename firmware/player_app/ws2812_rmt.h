// Interrupt-driven WS2812 transmit over the ESP32-C6 RMT peripheral (IDF
// driver/rmt_tx.h). Replaces FastLED's blocking clockless driver: the render
// task snapshots a frame, the transmit task calls ws2812_rmt_show() (which
// blocks only THIS task while the RMT encoder streams the bits by interrupt,
// yielding the core back to render), and the async double-buffer contract in
// main.cpp (snapshot -> kick -> render next; xmit_done gates the buffer) is
// unchanged. Single owner: call init once and show from one task only.
#ifndef FIRMWARE_PLAYER_APP_WS2812_RMT_H_
#define FIRMWARE_PLAYER_APP_WS2812_RMT_H_

#include <stddef.h>
#include <stdint.h>

// Create the RMT TX channel + WS2812 byte encoder on `gpio`, sized for up to
// `max_leds` pixels. Returns false on allocation/peripheral failure. Call once.
bool ws2812_rmt_init(int gpio, uint32_t max_leds);

// Clock out `n` pixels. `rgb` is n*3 bytes in R,G,B memory order (e.g. a CRGB
// array); the driver reorders to the WS2812 wire order (GRB) internally. Blocks
// the calling task until the frame is fully transmitted, then holds the line low
// so the >=50 us inter-frame gap latches the pixels. No-op if n > max_leds.
void ws2812_rmt_show(const uint8_t *rgb, uint32_t n);

#endif  // FIRMWARE_PLAYER_APP_WS2812_RMT_H_
