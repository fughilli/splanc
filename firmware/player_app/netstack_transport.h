// Heapless WiFi transport for the LED Mapper player (the LM_NETSTACK build of main.cpp).
// The player runtime (render task, effects/JIT, upload, persistence, perf, hardware config)
// is shared with the vendor-WiFi build; this module owns ONLY the transport: BLE Improv
// provisioning -> heapless MAC -> WPA2 4-way (HW-AES CCMP) -> DHCP -> TCP -> mbedtls TLS 1.2
// -> RFC6455 WebSocket. It calls back into the app's shared WS dispatch (lm_ws_dispatch).
#ifndef FIRMWARE_PLAYER_APP_NETSTACK_TRANSPORT_H_
#define FIRMWARE_PLAYER_APP_NETSTACK_TRANSPORT_H_

#include <stddef.h>
#include <stdint.h>

// Before a PLANNED restart (esp_restart for an OTA handoff / install): leave the AP
// cleanly (the factory MAC comes straight back with the same DHCP lease).
void netstack_prepare_restart(void);

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

// Facts for the memory-mode tracker (lm_mode_observe): WiFi credentials committed, and a
// DHCP lease held.
bool netstack_creds_ready(void);
bool netstack_leased(void);

// Commit WiFi credentials restored from the store (main.cpp reads NVS) so the board joins
// on its own after a reboot / firmware update. Call BEFORE netstack_setup(). Invalid or
// empty values (nothing stored) leave the board waiting for Improv / wired PROV.
void netstack_restore_credentials(const char *ssid, const char *pass);

// Count of AP group-key rekeys serviced this session (surfaced in the status line so a
// rekey is visible even when it scrolls past the serial-log tail).
uint32_t netstack_rekey_count(void);

// Diagnostics for the periodic status line: TCP receive/retransmit counters, RX-ring
// high-water / full polls, and the longest gap between two netstack_loop() passes since the
// last call (reset on read). Formats one "[net] ..." fragment into `buf`.
int netstack_net_stats(char *buf, size_t cap);

// PROVIDED BY main.cpp (the shared dispatch seam). Handle one received binary WS message
// (`in`/`len`): upload-chunk streaming OR lm_player_handle + persistence + poll_after_message,
// identical to the vendor ws:81 / wss:443 paths. Writes the reply into the app's tx buffer and
// sets *reply to it (writable, with kWsSendHeadroom bytes before it); returns the reply
// length (>0), 0 (no reply), or <0 (drop the connection).
int lm_ws_dispatch(const uint8_t *in, size_t len, const uint8_t **reply);

// Whether the reply lm_ws_dispatch just returned is a best-effort live-control reply
// (a ControlAck, or a legacy set_uniforms' playback_state) that the transport may drop
// when its send window can't take it, instead of blocking RX behind a full window.
bool lm_ws_reply_droppable(void);

// A UDP datagram for the native OSC port (udp/9000): stash it for the next frame
// (latest value per address). Called on the network task; must not block.
void lm_netstack_osc_rx(const uint8_t *data, size_t len);

// PROVIDED BY main.cpp. Persist the active WiFi credentials (NVS "ssid"/"pass", the keys
// the vendor build uses) — called once a freshly provisioned network has leased. Returns
// whether both writes succeeded.
bool lm_store_wifi_credentials(const char *ssid, const char *pass);

// PROVIDED BY main.cpp. Render the agent discovery manifest (GET
// /.well-known/splanc.json) into the app's tx buffer and set *body to it. `cert_sha256`
// is the TLS certificate's SHA-256 (lowercase hex, NUL-terminated). Returns the JSON
// length (>0), or <0 when it doesn't fit.
int lm_agent_manifest_body(const char *cert_sha256, const uint8_t **body);

// PROVIDED BY main.cpp. Publish the TLS identity's readiness to the player core (under
// the player mutex) so the manifest (tls.state / cert_sha256), the TlsInfo reply (wss +
// BLE) and the mDNS TXT "tls" key report it. `state` is "generating" or "ready";
// `cert_sha256` lowercase hex ("" while generating).
void lm_publish_tls_info(const char *state, const char *cert_sha256, bool persisted);

// PROVIDED BY main.cpp. mDNS (_splanc._tcp, under the player mutex): with `query`, answer
// one UDP:5353 datagram from `src_port` (*unicast: reply to the querier, not the group);
// with query == nullptr, render the unsolicited announcement. `ip` = our IPv4 address.
// Writes the DNS message into `out`; returns its length, 0 = nothing to send, <0 = error.
int lm_mdns_reply(const uint8_t *query, size_t qlen, uint16_t src_port, const uint8_t *ip,
                  uint8_t *out, size_t cap, bool *unicast);

// --- Wi-Fi rejoin policy (docs/design/wifi-rejoin-policy.md) -------------------------
// mode: 0 auto (5 s -> scan_cap_s backoff, decaying to sparse_interval_s after
// decay_after_h hours unseen), 1 fixed (every interval_s), 2 manual (only in a join
// window opened by netstack_wifi_rejoin or a new provision), 3 offline (radio off).
struct NetstackWifiPolicy {
  uint8_t mode;
  uint32_t scan_cap_s;
  uint32_t interval_s;
  uint32_t decay_after_h;
  uint32_t sparse_interval_s;
};
// Apply a policy. Before netstack_setup() it is the boot policy (offline: the radio is
// never started); later it takes effect at once (to offline: silent now, radio off from
// the next boot; from offline: the radio comes up / wakes and rejoins). Never reboots.
void netstack_set_wifi_policy(const NetstackWifiPolicy *p);
// Try to (re)join now: an immediate scan (manual: also a 2 min join window).
void netstack_wifi_rejoin(void);
// A new provision changed the mode itself (offline -> auto); true once per change.
bool netstack_take_policy_change(NetstackWifiPolicy *out);
// Whether a lease is expected right now: the policy lets the board join on its own
// (not offline; manual only inside a join window) AND the network was seen this boot.
// The OTA health check only requires a lease when it is — a fresh update never rolls
// back merely because the AP is gone.
bool netstack_wifi_wants_network(void);
// Whether the data plane is busy: a live wss session on a leased link, with no sweep or
// PMK derivation in flight. The player runs its loop task AT render's priority only
// then (main.cpp loop()), and one below it for everything else (joins, scans, DHCP).
bool netstack_data_plane_active(void);
// Seconds the network had already been unseen before this boot (persisted by the app).
void netstack_set_unseen_base(uint32_t seconds);
// The live link state (WifiLinkState numbering) for the app / agent / console.
struct NetstackWifiStatus {
  uint8_t state;
  bool radio_on;
  bool decayed;
  uint32_t next_scan_s;
  uint32_t scans;
  uint32_t unseen_s;
  char ssid[33];
};
void netstack_wifi_status(NetstackWifiStatus *out);

// PROVIDED BY the app (weak no-op default in the transport, so the OTA loader needn't).
// A console line starting "WIFI " that the transport's own link diagnostics (WIFI SCAN /
// DHCP / GIVEUP) don't handle — the player parses its Wi-Fi policy commands here.
void netstack_console_hook(const char *line, size_t len);

#endif  // FIRMWARE_PLAYER_APP_NETSTACK_TRANSPORT_H_
