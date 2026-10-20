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

// Bytes a WS server frame header can take (2 + 8-byte extended length). Payloads handed to
// the WS layer must be preceded by this much writable headroom: the header is written in
// place there so header + payload leave as one TLS record without a 2.5 KB staging copy
// (all C6 SRAM is DMA-capable and the netstack build is short of it).
constexpr size_t kWsSendHeadroom = 10;

// Push an unsolicited server frame (e.g. a PerfReport) over the active TLS/WS, best-effort.
// `data` must have kWsSendHeadroom writable bytes before it (the app's tx buffer does).
// Returns true if a client was connected + it was written.
bool netstack_ws_send(uint8_t *data, size_t len);
// True when a WS client is upgraded (for gating unsolicited pushes).
bool netstack_ws_open(void);

// Count of AP group-key rekeys serviced this session (surfaced in the status line so a
// rekey is visible even when it scrolls past the serial-log tail).
uint32_t netstack_rekey_count(void);

// PROVIDED BY main.cpp (the shared dispatch seam). Handle one received binary WS message
// (`in`/`len`): upload-chunk streaming OR lm_player_handle + persistence + poll_after_message,
// identical to the vendor ws:81 / wss:443 paths. Writes the reply into the app's tx buffer and
// sets *reply to it (writable, with kWsSendHeadroom bytes before it); returns the reply
// length (>0), 0 (no reply), or <0 (drop the connection).
int lm_ws_dispatch(const uint8_t *in, size_t len, const uint8_t **reply);

// PROVIDED BY main.cpp. Render the agent discovery manifest (GET
// /.well-known/splanc.json) into the app's tx buffer and set *body to it. `cert_sha256`
// is the TLS certificate's SHA-256 (lowercase hex, NUL-terminated). Returns the JSON
// length (>0), or <0 when it doesn't fit.
int lm_agent_manifest_body(const char *cert_sha256, const uint8_t **body);

// PROVIDED BY main.cpp. mDNS (_splanc._tcp, under the player mutex): with `query`, answer
// one UDP:5353 datagram from `src_port` (*unicast: reply to the querier, not the group);
// with query == nullptr, render the unsolicited announcement. `ip` = our IPv4 address.
// Writes the DNS message into `out`; returns its length, 0 = nothing to send, <0 = error.
int lm_mdns_reply(const uint8_t *query, size_t qlen, uint16_t src_port, const uint8_t *ip,
                  uint8_t *out, size_t cap, bool *unicast);

#endif  // FIRMWARE_PLAYER_APP_NETSTACK_TRANSPORT_H_
