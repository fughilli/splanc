// Network LED outputs (docs/design/p4-ethernet-ddp.md): LED channels 2..7 whose
// pixels go to controllers on the Ethernet network (WLED boards) over DDP.
//
// The render task hands each frame's network pixels over with
// net_output_submit(); a sender task of its own does the UDP sends. The hand-off
// is a triple buffer, so render never waits on the network: if the sender is
// still busy when the next frame is ready, the older unsent frame is replaced.
// With nothing new to send, the sender repeats the last frame every second so
// WLED stays in realtime mode (it falls back to its own effects after ~2.5 s).
#ifndef FIRMWARE_PLAYER_APP_NET_OUTPUT_H_
#define FIRMWARE_PLAYER_APP_NET_OUTPUT_H_

#include <stdint.h>

#include "firmware/netout/netout_ffi.h"

#define NET_OUTPUT_CHANNELS 6  // LED channels 2..7 (netout_channels())

// Allocate the frame buffers (for up to `max_leds` network LEDs, in PSRAM when
// there is some) and start the sender task. Call once from setup().
bool net_output_begin(uint32_t max_leds);

// Install the targets (loop task, after a netout change). `targets[i]` is LED
// channel 2 + i; ip == 0 means off.
void net_output_set_targets(const NetoutTarget targets[NET_OUTPUT_CHANNELS]);

// True when any target is set (render skips the copy otherwise).
bool net_output_active(void);

// Render task: hand over one frame. `rgb` is the whole frame (R,G,B per LED) in
// the global LED order; the network channels start at LED `net_base` (the GPIO
// strips' total) and take `counts[i]` LEDs each, in channel order. LEDs at or
// past `rendered` weren't drawn this frame and go out black.
void net_output_submit(const uint8_t *rgb, uint32_t net_base,
                       const uint32_t counts[NET_OUTPUT_CHANNELS], uint32_t rendered);

// Frames sent (one per frame with at least one target reached) and send errors.
void net_output_counters(uint32_t *frames, uint32_t *errors);

#endif  // FIRMWARE_PLAYER_APP_NET_OUTPUT_H_
