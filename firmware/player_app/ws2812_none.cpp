// The C6 front end's WS2812 "backend" (docs/design/p4-c6-split.md §2.1): it renders
// nothing and owns no pins. The LED pins of the netstack build (GPIO20, GPIO21) are the
// SDIO link's D0 / D1 on the P4 boards, so the front end must never drive them.
#include "firmware/player_app/ws2812.h"

bool ws2812_init(int, int, uint32_t) { return true; }
void ws2812_stage(const uint8_t *, uint32_t, uint32_t, const uint8_t *) {}
void ws2812_send(void) {}
void ws2812_show(const uint8_t *, uint32_t, uint32_t, const uint8_t *) {}
void ws2812_set_color_order(int, uint8_t, uint8_t, uint8_t) {}
bool ws2812_reconfigure(int, int) { return true; }
size_t ws2812_buffer_bytes(uint32_t) { return 0; }
int ws2812_channels(void) { return 0; }
int ws2812_last_error(int) { return 0; }
const char *ws2812_backend(void) { return "none (front end)"; }
