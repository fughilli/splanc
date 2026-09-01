// Heapless WiFi transport for the LED Mapper player (the LM_NETSTACK build of main.cpp).
// The player runtime (render task, effects/JIT, upload, persistence, perf, hardware config)
// is shared with the vendor-WiFi build; this module owns ONLY the transport: BLE Improv
// provisioning -> heapless MAC -> WPA2 4-way (HW-AES CCMP) -> DHCP -> TCP -> mbedtls TLS 1.2
// -> RFC6455 WebSocket. It calls back into the app's shared WS dispatch (lm_ws_dispatch).
#ifndef FIRMWARE_PLAYER_APP_NETSTACK_TRANSPORT_H_
#define FIRMWARE_PLAYER_APP_NETSTACK_TRANSPORT_H_

#include <stddef.h>
#include <stdint.h>

// Bring up the transport. Call from setup() AFTER the shared player init + improv_ble_begin
// (BLE must init before we hijack the MAC so our radio config wins). Runs AES self-test +
// the heapless STA RX bring-up + TLS server init.
void netstack_setup(void);

// Service the transport once per loop(): RX drain + on_ip + DHCP + BLE-Improv join + TLS
// handshake + WS pump. Non-blocking. Complete WS messages are handed to lm_ws_dispatch().
void netstack_loop(void);

// Push an unsolicited server frame (e.g. a PerfReport) over the active TLS/WS, best-effort.
// Returns true if a client was connected + it was written.
bool netstack_ws_send(const uint8_t *data, size_t len);
// True when a WS client is upgraded (for gating unsolicited pushes).
bool netstack_ws_open(void);

// Count of AP group-key rekeys serviced this session (surfaced in the status line so a
// rekey is visible even when it scrolls past the serial-log tail).
uint32_t netstack_rekey_count(void);

// PROVIDED BY main.cpp (the shared dispatch seam). Handle one received binary WS message
// (`in`/`len`): upload-chunk streaming OR lm_player_handle + persistence + poll_after_message,
// identical to the vendor ws:81 / wss:443 paths. Writes the reply into the app's tx buffer and
// sets *reply to it; returns the reply length (>0), 0 (no reply), or <0 (drop the connection).
int lm_ws_dispatch(const uint8_t *in, size_t len, const uint8_t **reply);

#endif  // FIRMWARE_PLAYER_APP_NETSTACK_TRANSPORT_H_
