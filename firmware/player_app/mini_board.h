#pragma once
#include <stddef.h>
#include <stdint.h>
void mini_board_init();
// Called on the sole transmit task before each frame. RGB byte order.
void mini_limit_frame(uint8_t *rgb, uint32_t count0, uint32_t count1);
