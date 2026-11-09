// The C6 front end's link to the P4 over SDIO (frontend_link.cpp).
#pragma once

#include <stddef.h>
#include <stdint.h>

// Start the SDIO slave. Call early in setup(): the P4 probes for it at its boot.
bool frontend_link_begin();
// Service the link once per loop(): received frames, pushes to the wss session, HELLO.
void frontend_link_poll();
// Whether the P4 has been heard from in the last 350 ms.
bool frontend_p4_up();
// Forward one player message (ClientMessage bytes) from wss/GATT session `session` and
// wait up to `timeout_ms` for the P4's reply, written to `out`. Returns its length, 0 for
// no reply, -1 when the P4 is down or the reply doesn't fit, -2 when the P4 is up but the
// message couldn't be sent (the caller must not answer it itself).
int frontend_forward(uint16_t session, const uint8_t *msg, size_t len, uint8_t *out, size_t cap, int timeout_ms);
// The identity the front end advertises (BLE, mDNS): its MAC string and device name. The
// P4 takes it over (LK_OP_NAME), so its Welcome names the device the app found.
void frontend_link_set_identity(const char *mac, const char *name);
// Forward one OSC datagram (udp/9000) to the P4: its uniforms and modules live there.
// Network task; drops it when the link is down or full (OSC is latest-value-wins).
void frontend_link_osc(const uint8_t *data, size_t len);
// One "[link] ..." status fragment.
int frontend_link_stats(char *buf, size_t cap);
