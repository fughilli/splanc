// The P4 player's Ethernet + network LED outputs (docs/design/p4-ethernet-ddp.md),
// glued to main.cpp: the protocol arms 95-98, the NVS copy of the settings, and
// applying them to eth_p4 / net_output / the player core. main.cpp calls these
// only in builds with LM_NETOUT (the P4 images).
#ifndef FIRMWARE_PLAYER_APP_NETOUT_APP_H_
#define FIRMWARE_PLAYER_APP_NETOUT_APP_H_

#include <stddef.h>
#include <stdint.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "net_output.h"

// Boot: load the settings from NVS, start the sender task (for up to `max_leds`
// network LEDs) and bring Ethernet up if it is enabled. After lm_set_board_caps
// and hardware_config_begin; before the render task starts. `core_mutex` is
// main.cpp's player_mutex, held around calls into the player core.
void netout_app_begin(uint32_t max_leds, SemaphoreHandle_t core_mutex);

// Answer an Ethernet request (arms 95-98) into out[0..cap). `led_gpio0/1` are the
// strips' data pins, which Ethernet may not take. Returns the reply length, or 0
// if `msg` isn't an Ethernet request (the player core answers it).
int netout_app_dispatch(const uint8_t *msg, size_t len, uint8_t *out, size_t cap, int led_gpio0,
                        int led_gpio1);

// LEDs on network channel i (LED channel 2 + i), from the player core.
void netout_app_counts(uint32_t counts[NET_OUTPUT_CHANNELS]);

#endif  // FIRMWARE_PLAYER_APP_NETOUT_APP_H_
