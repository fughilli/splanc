// main_netstack — the LED Mapper player over the fully HEAPLESS WiFi netstack (the
// esp32c6_netstack build variant). Same session core / BLE Improv / board caps as the
// vendor-WiFi player_app, but the entire transport is ours from the PHY blob up:
// BLE Improv provisioning -> heapless MAC (own RX ring, no promiscuous) -> WPA2 4-way
// (HW-AES CCMP) -> DHCP -> TCP -> mbedtls TLS 1.2 -> RFC6455 WebSocket -> lm_player_handle.
// Proven end to end against the full //pi/hitl/harness:e2e_netstack (BLE provisioning incl.).
//
// STA RX bring-up (reversed vendor path): via the ieee80211_ioctl marshal in the WiFi-task
// context we run wifi_hw_stop -> wifi_hw_start -> ic_set_vif(STA) -> pm_disconnected_stop ->
// pm_go_to_wake (force the MAC awake so RX is continuous), then install our own RX ring and
// pull frames directly. Real STA vif (crypto-capable), deterministic 4-way, HW auto-ACK via
// the own-MAC/g_bssid registers. TX + auth/assoc + WPA2 4-way + CCMP are all ours. Software
// CCMP drives the data plane; the standalone AES-128 accelerator does the block cipher.

#include <Arduino.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <esp_timer.h>  // high-frequency coex tick (coex_timer_cb) — finer than the netstack loop
#include <esp_event.h>
#include <esp_heap_caps.h>
#include <esp_random.h>
#include <stdlib.h>  // strtoul (console WIFI SCANMISS)
#include <string.h>
#include <mbedtls/ssl.h>
#include <mbedtls/x509_crt.h>
#include <mbedtls/pk.h>
#include <mbedtls/sha256.h>
#include "ws_codec.h"        // RFC6455 server codec
#include "improv_ble.h"      // BLE Improv onboarding (advertise + creds)
#include "improv_codec.h"    // IMPROV_STATE_* constants
#include "netstack_transport.h"  // our public API + the shared lm_ws_dispatch seam
#include "tls_region.h"         // mbedtls's own memory region
#include "device_cert.h"        // this device's own TLS key + cert (first-boot generated)
#include "dhcp_reply.h"
#include "icmp_echo.h"
#include "wifi_creds.h"     // persisted WiFi credentials: restore / persist decisions
#include "wifi_scan.h"      // in-place background rescan (never a reboot)
#include "esp_system.h"     // esp_get_free_heap_size
#include "esp_log.h"        // esp_log_level_set: silence the vendor "wifi" tag after the hijack
#include "esp_mac.h"        // esp_read_mac: the factory STA MAC
#include "sta_mac.h"        // stable (factory) vs opt-in random station MAC
#include "join_guard.h"     // per-boot 802.11 sequence numbers + the unanswered-auth guard
#include "serial_log.h"     // Console(): the ordered, lossless log ring (identity lines)

extern "C" {
void ns_mac_rx_install();
void ns_mac_rx_stats(uint32_t *out);  // [ring high-water, full-ring polls] (high-water resets)
void ns_tcp_stats(uint32_t *out);     // [segs, ooo, dup, trunc, zero_wnd, rto, fast_rexmit]
uint32_t ns_aes_selftest(uint8_t *out); // FIPS-197 AES-128: bit0=enc ok, bit1=dec ok; out=ciphertext
uint32_t ns_mac_recv(uint8_t *out, uint32_t cap);
uint32_t ns_mac_rx_pending(void);
uint32_t ns_mac_send(const uint8_t *frame, uint32_t len, uint32_t queue);
uint32_t ns_mac_send_sec(const uint8_t *frame, uint32_t len, uint32_t queue); // HW CCMP encrypt
uint32_t ns_tx_desc_word0(uint32_t idx); // read back TX descriptor word0 (secure-TX diagnostic)
void ns_wpa_init(const uint8_t *ssid, uint32_t ssid_len, const uint8_t *pass, uint32_t pass_len,
                 const uint8_t *ap, const uint8_t *self_mac, const uint8_t *snonce);
uint32_t ns_wpa_on_eapol(const uint8_t *eapol, uint32_t len, uint8_t *out, uint32_t cap);
uint32_t ns_wpa_diag(const uint8_t *eapol, uint32_t len);
// Incremental PMK derivation (PBKDF2 c=4096 ~1.8s) — spread off the hot path so the BLE link
// survives the join. begin when creds are known, step() each loop, then ns_wpa_init uses it.
void ns_pmk_begin(const uint8_t *ssid, uint32_t ssid_len, const uint8_t *pass, uint32_t pass_len);
uint32_t ns_pmk_step(uint32_t chunk);
uint32_t ns_pmk_ready(void);
uint32_t ns_sta_encrypt(const uint8_t *hdr, uint32_t hdr_len, const uint8_t *payload,
                        uint32_t payload_len, uint8_t *out, uint32_t cap);
uint32_t ns_sta_decrypt(const uint8_t *frame, uint32_t frame_len, uint8_t *out, uint32_t cap);
uint32_t ns_sta_get_tk(uint8_t *out);
// Vendor HAL (libpp): program a hardware crypto key slot. Reversed signature:
// (cipher, enable, flag, peer_mac[6], slot, key, key_len, mgmt). cipher 4 = CCMP.
void wDev_Insert_KeyEntry(uint32_t cipher, uint32_t enable, uint32_t flag,
                          const uint8_t *mac, uint32_t slot, const uint8_t *key,
                          uint32_t key_len, uint32_t mgmt);
// Vendor crypto-engine enable (hal_crypto.o). Reversed args: (iface, cipher, arg2, flag).
// cipher 4 = CCMP. Sets up the per-iface + global CCMP engine state (0x4800/0x4804/0x4810)
// as an atomic sequence — may leave internal state our raw register pokes don't reproduce.
void hal_crypto_enable(uint32_t iface, uint32_t cipher, uint32_t arg2, uint32_t flag);
// Vendor TX submitter path (libpp) — bridge our heaplessly-built protected frame through
// the vendor esf_buf/ppTxPkt so the MAC's inline CCMP engine encrypts it (the engine only
// runs for frames on this path). ic_get_trc(0,0) returns the default TRC (no association
// needed). See firmware/netstack/hw-crypto-tx-seam.md for the full reversed ABI.
void *esf_buf_alloc(const void *src, int type, uint32_t len);
int ppTxPkt(void *eb, int do_arm);
void *ic_get_trc(uint32_t iface, uint32_t index);
uint32_t ns_tcp_connect(const uint8_t *src, const uint8_t *dst, uint16_t sport, uint16_t dport,
                        uint32_t iss, uint8_t *out, uint32_t cap);
uint32_t ns_tcp_on_ip(uint32_t now_ms, const uint8_t *ip, uint32_t len, uint8_t *out, uint32_t cap);
uint32_t ns_tcp_enqueue(const uint8_t *data, uint32_t len);          // buffer into the send window
uint32_t ns_tcp_pump_tx(uint32_t now_ms, uint8_t *out, uint32_t cap); // emit next windowed segment
uint32_t ns_tcp_tx_room(void);                                       // free send-window bytes
uint32_t ns_tcp_tick(uint32_t now_ms, uint8_t *out, uint32_t cap); // stack RTO: emits a retransmit when it fires
uint32_t ns_tcp_tx_pending(void);  // send side holds queued/unacked data (RTO + window live)
uint32_t ns_tcp_window_ack(uint8_t *out, uint32_t cap); // window-update ACK after draining rx
uint32_t ns_tcp_recv(uint8_t *out, uint32_t cap);
void ns_tcp_listen(const uint8_t *src, uint16_t sport, uint32_t iss); // passive open (server)
uint32_t ns_tcp_state();
uint32_t ns_tcp_snd_una(); // oldest unacked seq — advances on peer ACK (TX forward progress)
uint32_t ns_tcp_rcv_nxt(); // next expected seq — advances on peer data (RX forward progress)
void ns_tcp_set_serving_live(uint32_t live); // arm graceful RST load-shedding (live WS session)
// Vendor lower-MAC RX filter surface (libpp) — set a real STA accept policy so the
// hardware crypto engine does per-address CCMP decrypt instead of promiscuous accept-all.
void ic_set_rx_policy(uint32_t vif, uint32_t a1, uint32_t a2, uint32_t a3);
void ic_rx_enable_bssid_check(uint32_t vif);
void ic_set_mac(uint32_t slot, const uint8_t *mac);
void ic_set_bssid(uint32_t slot, const uint8_t *bssid);
// Continuous STA RX bring-up (no promiscuous), so HW crypto stays inline. Run via the
// ieee80211_ioctl marshal in the WiFi-task context.
void wifi_hw_start(uint32_t vif);
void wifi_hw_stop(uint32_t vif);
uint32_t ic_set_vif(uint32_t vif, uint32_t mode, const uint8_t *mac, uint32_t a3, uint32_t a4);
void pm_disconnected_stop();
void pm_go_to_wake();
int ieee80211_ioctl(void *req);
}
// NB: the on-device effects JIT trampoline (lm_jit_region_ptr/words/arm/sync_icache) is
// provided by main.cpp — building this transport INTO the player gives us the REAL JIT
// (no stub), so fx_bench_jit / jit_soak / led_capture_jit exercise it for real.

// ioctl handler: bring up continuous STA RX in the WiFi-task context.
const uint8_t *g_our_mac_ptr = nullptr;
extern "C" void sta_rx_start_handler(void *req) {
  (void)req;
  wifi_hw_stop(0);
  wifi_hw_start(0);
  ic_set_vif(0, 0, g_our_mac_ptr, 0, 0);
  pm_disconnected_stop();
  pm_go_to_wake();  // force the MAC awake so RX is continuous (not duty-cycled)
}

// No-op promiscuous sink: keeps the RX hardware + all-frames filter enabled but
// stops the vendor from processing/delivering packets, so our ring owns RX.
void IRAM_ATTR sink(void *, wifi_promiscuous_pkt_type_t) {}

NsRxStamps g_ns_rx_stamps = {};
void (*g_ns_reply_hook)(int outcome) = nullptr;
// The stamps are written only by the LM_CTRL_TRACE measurement build (the
// :netstack_transport_ctrltrace library): the shipping image runs none of these timer
// reads on the loop task's RX path.
#if defined(LM_CTRL_TRACE)
#define NS_TRACE(stmt) \
  do {                 \
    stmt;              \
  } while (0)
static inline uint32_t ns_now_us() { return (uint32_t)esp_timer_get_time(); }
#else
#define NS_TRACE(stmt) \
  do {                 \
  } while (0)
#endif

namespace {
constexpr uintptr_t WIFI_MAC_INTR_MAP = 0x60010000;
// No WiFi credentials are baked into the image: they arrive at runtime, over either BLE
// Improv or the wired serial console (the "PROV <ssid> <pass>" command in netstack_loop).
// A WiFi scan (scan_latch_ap) fills the real BSSID/channel once the provisioned SSID is
// known — these are just pre-scan placeholders (a Pi-OUI BSSID), overwritten before auth.
uint8_t g_bssid[6] = {0xb8, 0x27, 0xeb, 0xbb, 0x8d, 0xf8};
uint8_t g_chan = 6;
uint8_t OUR_MAC[6];
// 802.11 sequence numbers for every frame we build (seeded randomly each boot) and the
// unanswered-Authentication guard: see join_guard.h for why both matter with a stable MAC.
lm_join::SeqCounter g_seq;
lm_join::AuthWatch g_authw;
bool g_mac_fallback = false;  // this boot gave up on the factory MAC (last resort)
static inline void put_seq(uint8_t *hdr) {
  uint16_t sc = g_seq.next();
  hdr[22] = (uint8_t)(sc & 0xff);
  hdr[23] = (uint8_t)(sc >> 8);
}
// Active WiFi credentials for the WPA2 PMK, committed at runtime from BLE Improv, the
// wired serial "PROV" command, or — at boot — the NVS store (netstack_restore_credentials,
// written by main.cpp once a provision has leased: see wifi_creds.h). Never baked into the
// image. We only START associating once these are "committed" — see g_creds_ready.
char g_ssid[33];
char g_pass[65];
bool g_creds_ready = false;  // creds committed (BLE Improv, wired PROV, or restored at boot)
bool g_restore_pending = false;  // restored at boot; the PMK derivation starts on the first loop
bool g_using_stored = false;     // the active creds are the stored ones (not a fresh provision)
bool g_scan_matched = false;     // the last scan (boot or background) saw the active SSID
bool g_latch_known = false;      // g_bssid/g_chan are THIS SSID's (scan cache or a sweep),
                                 // even if the last sweep missed it
lm_wifi::Persist g_persist;      // whether/when the active creds still need writing to NVS
lm_wifi::ImprovJoin g_improv_join;  // the last Improv fresh join (re-send coalescing)

// DHCP lease state (DORA).
uint8_t g_offer_ip[4] = {0}, g_server_id[4] = {0};
bool g_have_offer = false, g_leased = false;
// Lease lifetime (option 51) + when it was (re)acquired, for T1 renewal. A commercial
// AP hands short leases and DROPS a client whose lease lapses without renewing — the
// heapless netstack acquired the lease once and never renewed, so it went unreachable
// a lease-time after provisioning (the CoolerKids "works briefly, then dead" symptom).
uint32_t g_lease_secs = 0, g_lease_ms = 0, g_last_renew_ms = 0;
const uint8_t GATEWAY[4] = {10, 42, 0, 1};
bool g_pinged = false;
bool g_hwkey = false;
uint32_t g_rekey_serviced = 0; // count of AP group-key rekeys we ACKed (see handle_l3)
void *g_trc = nullptr; // default TRC (ic_get_trc(0,0)) for the ppTxPkt HW-encrypt bridge
bool g_tcp_started = false, g_tcp_requested = false;
// Set by the DHCP handler when our IP changes under a live listener; consumed at the bind
// site to clear the stale TLS/WS session on the re-arm (see the drift-fork note at both sites).
bool g_relisten_new_ip = false;
// A DHCP renewal ACK arrived: re-announce mDNS once (an IP change already restarts the
// full 3-announcement burst), so a browser's cache never outlives our lease.
bool g_mdns_renewed = false;
// The IP the TCP listener is currently bound to (frozen at the ns_tcp_listen bind site). The
// drift-fork check compares the committed lease IP against THIS, not g_offer_ip (which the
// OFFER handler advances to the new IP before the ACK).
uint8_t g_listen_ip[4] = {0};
// De-risk the WSS server path: after the lease, LISTEN on :4433 and echo, instead of the
// outbound TCP-client test. Validates the inbound TCP path (SYN->SYN-ACK->data->ACK) on
// silicon before layering mbedtls TLS on top.
constexpr bool TCP_SERVER = true;
constexpr uint16_t SERVER_PORT = 443;  // the LED Mapper wss:443 the HITL e2e connects to

inline void wreg(uintptr_t a, uint32_t v) { *reinterpret_cast<volatile uint32_t *>(a) = v; }

// Dump the queue-0 TX status block so we can compare a SUCCESSFUL non-secure send with a
// dropped secure send and find the real error-code word/bit (the RE says completion status
// is 0x600A_54E8+qid*0x74, dispatch on (s>>12)&0xf, low byte 0xC0 = TxSecKidErr).
inline void dump_txstat(const char *tag) {
  auto rd = [](uintptr_t a) { return *reinterpret_cast<volatile uint32_t *>(a); };
  Serial.printf("TXSTAT[%s] E0=%08x E4=%08x E8=%08x EC=%08x F0=%08x F4=%08x B8=%08x BC=%08x\n",
                tag, rd(0x600A54E0), rd(0x600A54E4), rd(0x600A54E8), rd(0x600A54EC),
                rd(0x600A54F0), rd(0x600A54F4), rd(0x600A54B8), rd(0x600A54BC));
}

// Own-address slot 0 (0x600a405c/60, valid 0x10000) enables hardware auto-ACK for
// our MAC; g_bssid slot 0 (0x600a4000/04, valid 0x80000000) marks our BSS.
void mac_own_bssid() {
  uint32_t lo = OUR_MAC[0] | (OUR_MAC[1] << 8) | (OUR_MAC[2] << 16) | ((uint32_t)OUR_MAC[3] << 24);
  wreg(0x600A405C, lo);
  wreg(0x600A4060, (uint32_t)(OUR_MAC[4] | (OUR_MAC[5] << 8)) | 0x10000);
  uint32_t blo = g_bssid[0] | (g_bssid[1] << 8) | (g_bssid[2] << 16) | ((uint32_t)g_bssid[3] << 24);
  wreg(0x600A4000, blo);
  volatile uint32_t *b = reinterpret_cast<volatile uint32_t *>(0x600A4004);
  *b = (*b & 0xffff0000) | (g_bssid[4] | (g_bssid[5] << 8)) | 0x80000000;
}

// --- WiFi scan: discover the provisioned AP's BSSID + channel (rig-agnostic) ---------
// The baked g_bssid/g_chan only match rig-3. To run on ANY rig, cache every AP the vendor
// scan sees at setup (while its RX path is still intact, before we hijack the MAC), then
// once the provisioner tells us the SSID, latch that AP's real BSSID + channel.
struct ApRec {
  char ssid[33];
  uint8_t bssid[6];
  uint8_t chan;
};
ApRec g_scan[24];
uint8_t g_scan_n = 0;
bool g_ap_latched = false;

// Run one blocking vendor scan and cache the results. Called once in setup() before the
// MAC hijack — the vendor WiFi RX is still live there, so its scan machinery works; after
// the hijack we own the ring and the vendor can't scan.
void wifi_scan_cache() {
  wifi_scan_config_t cfg = {};
  cfg.scan_type = WIFI_SCAN_TYPE_ACTIVE;
  esp_err_t e = esp_wifi_scan_start(&cfg, true);  // blocking
  uint16_t n = 0;
  esp_wifi_scan_get_ap_num(&n);
  if (n > 24) n = 24;
  // The full vendor records (~2.2KB for 24) are needed only for this copy-out, so
  // borrow them from the heap at setup instead of pinning them in BSS — all C6
  // SRAM is DMA-capable and the running netstack is short of it (see g_ws_rx).
  auto *recs = static_cast<wifi_ap_record_t *>(calloc(n ? n : 1, sizeof(wifi_ap_record_t)));
  if (recs) {
    esp_wifi_scan_get_ap_records(&n, recs);
  } else {
    esp_wifi_clear_ap_list();  // still release the driver's scan list
    n = 0;
  }
  g_scan_n = 0;
  for (uint16_t i = 0; i < n && g_scan_n < 24; i++) {
    memcpy(g_scan[g_scan_n].ssid, recs[i].ssid, 32);
    g_scan[g_scan_n].ssid[32] = 0;
    memcpy(g_scan[g_scan_n].bssid, recs[i].bssid, 6);
    g_scan[g_scan_n].chan = recs[i].primary;
    g_scan_n++;
  }
  free(recs);
  esp_wifi_clear_ap_list();  // and any list the driver still holds (a no-op if none)
  Serial.printf("[scan] err=%d found=%u AP(s)\n", (int)e, (unsigned)g_scan_n);
  for (uint8_t i = 0; i < g_scan_n; i++)
    Serial.printf("[scan]   ssid=\"%s\" bssid=%02x:%02x:%02x:%02x:%02x:%02x ch=%u\n", g_scan[i].ssid,
                  g_scan[i].bssid[0], g_scan[i].bssid[1], g_scan[i].bssid[2], g_scan[i].bssid[3],
                  g_scan[i].bssid[4], g_scan[i].bssid[5], g_scan[i].chan);
}

// Once g_ssid is known, find its cached AP and latch the real BSSID + channel + reprogram
// the hardware. Without a match nothing is latched and the join waits for the background
// rescan (below) to find the AP. Returns whether a scan match was applied.
void mark_seen();  // the rejoin-policy clock (below): the network was just seen

bool scan_latch_ap() {
  for (uint8_t i = 0; i < g_scan_n; i++) {
    if (strncmp(g_scan[i].ssid, g_ssid, 32) == 0) {
      memcpy(g_bssid, g_scan[i].bssid, 6);
      g_chan = g_scan[i].chan;
      esp_wifi_set_channel(g_chan, WIFI_SECOND_CHAN_NONE);
      mac_own_bssid();  // re-program the hardware BSSID register for the scanned AP
      Serial.printf("[t=%lu] [scan] latched \"%s\" -> bssid=%02x:%02x:%02x:%02x:%02x:%02x ch=%u\n", (unsigned long)millis(), g_ssid,
                    g_bssid[0], g_bssid[1], g_bssid[2], g_bssid[3], g_bssid[4], g_bssid[5], g_chan);
      g_scan_matched = true;
      g_latch_known = true;
      mark_seen();
      return true;
    }
  }
  Serial.printf("[scan] no scan match for \"%s\" — not joining until the background rescan "
                "finds it\n", g_ssid);
  g_scan_matched = false;
  g_latch_known = false;  // g_bssid is whatever the previous network left there
  return false;
}

// --- Background rescan: find the AP again IN PLACE, never by rebooting (wifi_scan.h) ----
// The vendor scan above only works before the MAC hijack, so it used to be repeated by
// esp_restart() — killing the running effect every 20 s while a stored network was absent.
// Now the netstack sweeps the channels itself from the loop (we already receive every
// frame in all-frames mode), one non-blocking hop per pass, while render keeps going.
lm_wifi_scan::ScanSchedule g_scan_sched;
lm_wifi_scan::ImprovScanReport g_improv_scan;  // Improv: report an SSID no sweep can see
lm_wifi_scan::ChannelHop g_hop;
bool g_force_sweep = false;   // console WIFI SCAN: one sweep now
bool g_sweep_forced = false;  // the running sweep was forced (not scheduled)
bool g_force_giveup = false;  // console WIFI GIVEUP: take the random-MAC fallback now
uint32_t g_scan_blind = 0;    // console WIFI SCANMISS n: the next n sweeps hear nothing (HITL)

// --- Rejoin policy (wifi_scan.h Policy; set by the app via netstack_set_wifi_policy) ----
lm_wifi_scan::Policy g_policy;
bool g_radio_up = false;         // esp_wifi started + MAC hijacked (never, in offline mode)
bool g_silent = false;           // offline at runtime: radio initialised but no TX, MAC asleep
uint32_t g_window_until = 0;     // manual mode: a commanded / provisioned join window (ms)
bool g_policy_changed = false;   // a provision changed the mode itself (the app persists it)
bool g_scan_decayed = false;     // auto: the sparse period is in force
bool g_link_reset_pending = false;  // going offline: drop the join state on the next loop
bool g_authenticating = true;    // mirror of the loop's join state (st == AUTH), for status
// Network last seen (a scan match or a lease), as seconds of uptime; unseen time carried
// over from previous boots (main.cpp persists it, so a nightly power cycle doesn't reset
// the decay clock).
uint32_t g_seen_at_s = 0;
uint32_t g_unseen_base_s = 0;

uint32_t uptime_s() { return (uint32_t)(millis() / 1000u); }
uint32_t unseen_s() { return g_unseen_base_s + (uptime_s() - g_seen_at_s); }
bool g_seen_this_boot = false;   // a scan matched / a lease came this boot
void mark_seen() {
  g_seen_this_boot = true;
  g_unseen_base_s = 0;
  g_seen_at_s = uptime_s();
}
// Whether the board may scan / join on its own right now.
bool autonomous(uint32_t now_ms) {
  if (!g_radio_up || g_silent) return false;
  switch (g_policy.mode) {
    case lm_wifi_scan::kModeAuto:
    case lm_wifi_scan::kModeFixed:
      return true;
    case lm_wifi_scan::kModeManual:
      return g_window_until != 0 && lm_wifi_scan::at_or_after(g_window_until, now_ms);
    default:
      return false;
  }
}

// Tune to `ch` and ask for the wanted SSID there (a hidden AP answers a directed probe).
void bgscan_tune(uint8_t ch) {
  esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE);
  uint8_t f[80];
  size_t n = lm_wifi_scan::build_probe_req(f, sizeof f, OUR_MAC, g_ssid, g_seq.next());
  if (n) ns_mac_send(f, (uint32_t)n, 0);
}

// A frame from the RX drain: while a sweep runs, note a beacon / probe response for our SSID.
void bgscan_on_frame(const uint8_t *rx, uint32_t n) {
  if (!g_hop.active() || n < 36 || (rx[0] != 0x80 && rx[0] != 0x50)) return;
  if (g_scan_blind) return;  // HITL: simulate a sweep that can't hear the AP (coex, range)
  uint8_t bssid[6], ch = 0;
  if (lm_wifi_scan::bss_for_ssid(rx, n, g_ssid, g_hop.channel(), bssid, &ch)) g_hop.on_match(bssid, ch);
}

// Remember a background-scan result in the scan cache (so a later re-latch of the same
// SSID — a repeated PROV / Improv — finds it too).
void scan_cache_put(const char *ssid, const uint8_t bssid[6], uint8_t ch) {
  uint8_t i = 0;
  while (i < g_scan_n && strncmp(g_scan[i].ssid, ssid, 32) != 0) i++;
  if (i == g_scan_n) {
    if (g_scan_n < sizeof g_scan / sizeof g_scan[0]) {
      g_scan_n++;
    } else {
      i = g_scan_n - 1;  // full: the newest result replaces the last entry
    }
  }
  strncpy(g_scan[i].ssid, ssid, 32);
  g_scan[i].ssid[32] = 0;
  memcpy(g_scan[i].bssid, bssid, 6);
  g_scan[i].chan = ch;
}

// Stop a sweep (new credentials, or it finished without a match): back on the join channel.
void bgscan_cancel() {
  if (!g_hop.active()) return;
  g_hop.cancel();
  esp_wifi_set_channel(g_chan, WIFI_SECOND_CHAN_NONE);
}

int mgmt_hdr(uint8_t *f, uint8_t fc) {
  int n = 0;
  f[n++] = fc; f[n++] = 0x00;
  f[n++] = 0x00; f[n++] = 0x00;
  memcpy(f + n, g_bssid, 6); n += 6;
  memcpy(f + n, OUR_MAC, 6); n += 6;
  memcpy(f + n, g_bssid, 6); n += 6;
  put_seq(f); n += 2;
  return n;
}
int build_auth(uint8_t *f) {
  int n = mgmt_hdr(f, 0xb0);
  f[n++] = 0x00; f[n++] = 0x00; f[n++] = 0x01; f[n++] = 0x00; f[n++] = 0x00; f[n++] = 0x00;
  return n;
}
// Deauthentication (reason 3: STA leaving). Sent once before the first auth of a boot:
// with a stable (factory) MAC the AP may still hold the previous boot's association
// for us; an explicit deauth clears it so the fresh auth/assoc/4-way starts clean (we
// don't negotiate PMF, so the AP accepts this unprotected frame).
int build_deauth(uint8_t *f) {
  int n = mgmt_hdr(f, 0xc0);
  f[n++] = 0x03; f[n++] = 0x00;
  return n;
}
// Disassociation (reason 8: STA leaving the BSS) — sent with the deauth, since some APs
// tear a station down on one but not the other.
int build_disassoc(uint8_t *f) {
  int n = mgmt_hdr(f, 0xa0);
  f[n++] = 0x08; f[n++] = 0x00;
  return n;
}
int build_assoc(uint8_t *f) {
  int n = mgmt_hdr(f, 0x00);
  f[n++] = 0x31; f[n++] = 0x04; f[n++] = 0x0a; f[n++] = 0x00;
  // SSID element MUST be the ACTIVE (provisioned) SSID, not the baked default: the AP
  // rejects an Association Request whose SSID element doesn't match its own with status 38
  // (INVALID_PARAMETERS). Using the baked SSID silently "worked" only on the rig whose name
  // happened to equal the default (rig-3); on any other rig assoc was declined. g_ssid is
  // committed (fallback or BLE) before we ever reach ASSOC, so it's always populated here.
  int sl = strlen(g_ssid); f[n++] = 0x00; f[n++] = (uint8_t)sl;
  memcpy(f + n, g_ssid, sl); n += sl;
  const uint8_t r[] = {0x01, 0x08, 0x82, 0x84, 0x8b, 0x96, 0x12, 0x24, 0x48, 0x6c};
  memcpy(f + n, r, sizeof(r)); n += sizeof(r);
  // RSN IE: group=CCMP, pairwise=CCMP, AKM=PSK, caps=0 (no PMF). The group cipher
  // (bytes 00-0f-ac-04) MUST be one this stack actually implements — it is CCMP-only,
  // no TKIP — and match a modern WPA2/WPA3 AP, which uses CCMP/AES for the group key.
  // It was 00-0f-ac-02 (TKIP): the rig AP tolerated that, but a real home AP rejects
  // the Association Request with status 41 (INVALID_GROUP_CIPHER) — exactly the
  // "assoc status=41" seen against a home network.
  const uint8_t rsn[] = {0x30, 0x14, 0x01, 0x00, 0x00, 0x0f, 0xac, 0x04, 0x01, 0x00, 0x00,
                         0x0f, 0xac, 0x04, 0x01, 0x00, 0x00, 0x0f, 0xac, 0x02, 0x00, 0x00};
  memcpy(f + n, rsn, sizeof(rsn)); n += sizeof(rsn);
  // WMM Information Element (WFA OUI 00-50-f2, OUI-type 2, subtype 0, version 1, QoS
  // Info 0). Without it the AP admits us as a legacy non-QoS STA; with it we're a QoS
  // STA, which is what lets us send QoS Data frames the AP will bridge (real clients
  // are all QoS — confirmed over-the-air; our non-QoS uplink was silently dropped).
  const uint8_t wmm[] = {0xdd, 0x07, 0x00, 0x50, 0xf2, 0x02, 0x00, 0x01, 0x00};
  memcpy(f + n, wmm, sizeof(wmm)); n += sizeof(wmm);
  return n;
}
int build_eapol_data(uint8_t *f, const uint8_t *e, int el) {
  int n = 0;
  f[n++] = 0x08; f[n++] = 0x01; f[n++] = 0x00; f[n++] = 0x00;
  memcpy(f + n, g_bssid, 6); n += 6;
  memcpy(f + n, OUR_MAC, 6); n += 6;
  memcpy(f + n, g_bssid, 6); n += 6;
  f[n++] = 0x00; f[n++] = 0x00;
  const uint8_t llc[] = {0xaa, 0xaa, 0x03, 0x00, 0x00, 0x00, 0x88, 0x8e};
  memcpy(f + n, llc, sizeof(llc)); n += sizeof(llc);
  memcpy(f + n, e, el); n += el;
  return n;
}

uint16_t ip_csum(const uint8_t *d, int len) {
  uint32_t s = 0;
  for (int i = 0; i + 1 < len; i += 2) s += (d[i] << 8) | d[i + 1];
  if (len & 1) s += d[len - 1] << 8;
  while (s >> 16) s = (s & 0xffff) + (s >> 16);
  return ~s & 0xffff;
}

// Build a DHCP message (DISCOVER=1 or REQUEST=3) as an L2 payload: LLC/SNAP + IPv4 +
// UDP + BOOTP/DHCP. For REQUEST, `req_ip`/`server_id` (4 bytes each, else nullptr)
// add the Requested-IP (50) and Server-Id (54) options. Returns the payload length.
int build_dhcp(uint8_t *p, const uint8_t *mac, uint32_t xid, uint8_t msg_type,
               const uint8_t *req_ip, const uint8_t *server_id) {
  int n = 0;
  const uint8_t llc[] = {0xaa, 0xaa, 0x03, 0x00, 0x00, 0x00, 0x08, 0x00};
  memcpy(p + n, llc, 8); n += 8;           // LLC/SNAP, EtherType IPv4
  int ip_off = n;
  // DHCP body: 236 fixed + magic(4) + options
  uint8_t dhcp[300]; int d = 0;
  dhcp[d++] = 1; dhcp[d++] = 1; dhcp[d++] = 6; dhcp[d++] = 0; // op/htype/hlen/hops
  dhcp[d++] = xid >> 24; dhcp[d++] = xid >> 16; dhcp[d++] = xid >> 8; dhcp[d++] = xid;
  dhcp[d++] = 0; dhcp[d++] = 0;             // secs
  // flags: request a BROADCAST reply (0x8000). Unleased, we have no configured IP, so a
  // server that honors a unicast-reply request (RFC 2131 §4.1) would ARP for the offered
  // yiaddr and unicast the OFFER — which we can't answer ARP for yet, so it never arrives
  // (our ARP responder only knows g_offer_ip, still 0 at DISCOVER). Broadcast comes back
  // group-addressed and is decrypted via the GTK path. lenient servers (dnsmasq) broadcast
  // regardless, which is why unicast "worked" on the rig.
  dhcp[d++] = 0x80; dhcp[d++] = 0x00;       // flags: broadcast reply
  memset(dhcp + d, 0, 16); d += 16;         // ciaddr/yiaddr/siaddr/giaddr
  memcpy(dhcp + d, mac, 6); memset(dhcp + d + 6, 0, 10); d += 16; // chaddr
  memset(dhcp + d, 0, 64 + 128); d += 192;  // sname + file
  dhcp[d++] = 0x63; dhcp[d++] = 0x82; dhcp[d++] = 0x53; dhcp[d++] = 0x63; // magic cookie
  dhcp[d++] = 53; dhcp[d++] = 1; dhcp[d++] = msg_type; // DHCP message type
  if (req_ip) { dhcp[d++] = 50; dhcp[d++] = 4; memcpy(dhcp + d, req_ip, 4); d += 4; } // requested IP
  if (server_id) { dhcp[d++] = 54; dhcp[d++] = 4; memcpy(dhcp + d, server_id, 4); d += 4; } // server id
  dhcp[d++] = 55; dhcp[d++] = 4; dhcp[d++] = 1; dhcp[d++] = 3; dhcp[d++] = 6; dhcp[d++] = 51; // param req
  dhcp[d++] = 255;                          // end
  int udp_len = 8 + d;
  int ip_len = 20 + udp_len;
  // IPv4 header
  uint8_t *ip = p + ip_off;
  ip[0] = 0x45; ip[1] = 0x00; ip[2] = ip_len >> 8; ip[3] = ip_len & 0xff;
  ip[4] = 0; ip[5] = 0; ip[6] = 0x00; ip[7] = 0x00; // id, flags/frag
  ip[8] = 64; ip[9] = 17;                    // TTL, proto=UDP
  ip[10] = 0; ip[11] = 0;                    // checksum (fill below)
  memset(ip + 12, 0, 4);                     // src 0.0.0.0
  memset(ip + 16, 0xff, 4);                  // dst 255.255.255.255
  uint16_t c = ip_csum(ip, 20); ip[10] = c >> 8; ip[11] = c & 0xff;
  n += 20;
  // UDP header + DHCP body (UDP checksum 0 = disabled for IPv4)
  uint8_t *udp = p + n;
  udp[0] = 0; udp[1] = 68; udp[2] = 0; udp[3] = 67; // src 68 -> dst 67
  udp[4] = udp_len >> 8; udp[5] = udp_len & 0xff; udp[6] = 0; udp[7] = 0;
  n += 8;
  memcpy(p + n, dhcp, d); n += d;
  return n;
}

// Build an ICMP echo-request as an L2 payload: LLC/SNAP + IPv4 + ICMP.
// src/dst are 4-byte IPv4 addresses. Returns the payload length.
int build_ping(uint8_t *p, const uint8_t *src, const uint8_t *dst, uint16_t seq) {
  int n = 0;
  const uint8_t llc[] = {0xaa, 0xaa, 0x03, 0x00, 0x00, 0x00, 0x08, 0x00};
  memcpy(p + n, llc, 8); n += 8;
  uint8_t icmp[16];
  icmp[0] = 8; icmp[1] = 0; icmp[2] = 0; icmp[3] = 0; // echo request, csum later
  icmp[4] = 0x12; icmp[5] = 0x34;                     // id
  icmp[6] = seq >> 8; icmp[7] = seq & 0xff;           // seq
  const char *pl = "heapless"; memcpy(icmp + 8, pl, 8); // 8 bytes payload
  uint16_t ic = ip_csum(icmp, 16); icmp[2] = ic >> 8; icmp[3] = ic & 0xff;
  int ip_len = 20 + 16;
  uint8_t *ip = p + n;
  ip[0] = 0x45; ip[1] = 0; ip[2] = ip_len >> 8; ip[3] = ip_len & 0xff;
  ip[4] = 0x56; ip[5] = 0x78; ip[6] = 0x40; ip[7] = 0x00; // id, DF
  ip[8] = 64; ip[9] = 1;                                   // TTL, proto=ICMP
  ip[10] = 0; ip[11] = 0;
  memcpy(ip + 12, src, 4); memcpy(ip + 16, dst, 4);
  uint16_t c = ip_csum(ip, 20); ip[10] = c >> 8; ip[11] = c & 0xff;
  n += 20;
  memcpy(p + n, icmp, 16); n += 16;
  return n;
}

// HARDWARE CCMP encrypt via the vendor ppTxPkt bridge. `frame` is a bare protected QoS
// data MPDU: [26-byte 802.11 QoS header, FC Protected bit set, addr1=g_bssid][LLC/SNAP + L3
// CLEARTEXT] — NO CCMP header (the HW inserts the 8-byte IV after the header, encrypts the
// payload, and appends the 8-byte MIC). All magic numbers are decomp-verified; the two
// hang risks (txdesc.word4[11:8]=cipher, word4[7:4]=qclass) are set to CCMP=3 / TID0=2.
// See hw-crypto-tx-seam.md.
bool tx_hw_encrypt(const uint8_t *frame, int frame_len) {
  if (!g_trc) return false;
  // `frame` is [8-byte HW-TX-header pad][26-byte QoS 802.11 hdr][LLC + L3 cleartext]; the
  // 8-byte pad is where ppProcTxSecFrame's secure branch writes the HW header (it does NOT
  // do its own reservation when the 0x2000 flag is pre-set). +16 room for CCMP IV(8)+MIC(8).
  void *eb = esf_buf_alloc(frame, 1, frame_len + 16);
  if (!eb) return false; // pool full -> bounded back-pressure
  uint8_t *e = static_cast<uint8_t *>(eb);
  *reinterpret_cast<uint16_t *>(e + 0x14) = 0x1a + 8; // hdrlen incl the pre-reserved 8-byte HW hdr
  *reinterpret_cast<uint16_t *>(e + 0x24) |= 0x2000;  // "8-byte HW hdr already reserved" -> secure
                                                       // branch uses frame_ptr+8 as the 802.11 hdr
  *reinterpret_cast<void **>(e + 0x2c) = g_trc;     // default TRC (rate sched + gate byte +0x86=1)
  uint8_t *td = *reinterpret_cast<uint8_t **>(e + 0x34); // txdesc (= eb+0x48)
  td[4] = 0x20;                                      // word1 byte0: (qclass 2 << 4) | tid 0
  // word0: bit18 (0x40000) -> ppProcTxSecFrame SECURE branch (sets the 0x20000000 HW-encrypt
  // flag); bit0 HW-crypto request; bit3 QoS-data.
  *reinterpret_cast<uint32_t *>(td + 0x00) |= 0x40000u | 0x1u | 0x8u;
  *reinterpret_cast<uint32_t *>(td + 0x10) = 0x320; // word4: cipher(CCMP)=3, qclass=2, if0, queue=0
  td[0x2a] = 1; td[0x2e] = 1;                        // descriptor valid/ready bytes
  uint32_t w0_before = *reinterpret_cast<uint32_t *>(td + 0x00);
  int ret = ppTxPkt(eb, 1);                          // 1 = arm/transmit now
  static int dbg = 0;
  if (dbg++ < 3) {
    // After ppTxPkt: word0 bit29(0x20000000)=secure-branch-encrypt, bit30(0x40000000)=else
    // branch; word4[23:20]=HW queue (set by ppMapTxQueue, nonzero = mapped).
    auto rd = [](uintptr_t a) { return *reinterpret_cast<volatile uint32_t *>(a); };
    Serial.printf("PPTX ret=%d w0 %08x->%08x w4=%08x hdrlen=%u qos24=%04x | hdrdesc0=%08x 54E8=%08x plcp[0..2]=%08x %08x %08x\n",
                  ret, w0_before, *reinterpret_cast<uint32_t *>(td + 0x00),
                  *reinterpret_cast<uint32_t *>(td + 0x10), *reinterpret_cast<uint16_t *>(e + 0x14),
                  *reinterpret_cast<uint16_t *>(e + 0x24), *reinterpret_cast<uint32_t *>(e + 0x3c),
                  rd(0x600A54E8), rd(0x600A4D6C), rd(0x600A4D5C), rd(0x600A4D4C));
  }
  return true;
}

// The ONE outbound frame, built in place down the stack (zero-copy): TCP writes its
// segment straight into the IP slot (tx_ip_slot), send_ip prepends the LLC/SNAP header in
// front of it, and tx_l2 the QoS 802.11 header + the 8-byte HW-TX pad in front of that.
// Replaces a 1.6-1.7 KB buffer per layer (two on the stack of every TLS write, five static
// per-call-site segment buffers). loopTask-only, and every fill is transmitted before the
// next one can start (the vendor TX path copies the frame), so one buffer suffices.
constexpr int kTxPad = 8;                     // HW-TX header pad (ppTxPkt's secure branch)
constexpr int kTxL2 = kTxPad + 26;            // payload offset: after the QoS 802.11 header
constexpr int kTxIp = kTxL2 + 8;              // IP packet offset: after LLC/SNAP
constexpr uint32_t kTxIpCap = 1600;
uint8_t g_txf[kTxIp + kTxIpCap];
uint8_t *tx_ip_slot() { return g_txf + kTxIp; }

// Build + CCMP-encrypt + transmit a DHCP message (DISCOVER/REQUEST) to the AP.
// Transmit an L2 frame: `hdr` is the 24-byte 802.11 header (Protected bit set), `payload`
// is LLC/SNAP + L3 — ideally already in place at g_txf + kTxL2 (send_ip's path); any other
// buffer is copied there first. With HW crypto active (g_hwkey) hand a plaintext QoS MPDU to
// the vendor ppTxPkt bridge and let the MAC insert the CCMP header + encrypt; otherwise
// software-encrypt. Returns the enc'd length or the plaintext length. `label` is logged.
// TX pacing. The direct-submission MAC path gives no completion we can read (the
// descriptor OWN bit never clears, PLCP0's enable bit never clears, and the queue status
// block does not reliably change for a large frame), and arming queue 0 while its previous
// frame is still on air loses that frame: a 1400 + 177 B TCP reply lost its first segment
// nearly every time, and the RTO's resend of the same pair lost it again (the #358
// "DEVICE SILENT" trace-dump stall). So never arm before the previous frame's worst-case
// airtime has passed: 6 Mb/s legacy OFDM (4/3 us per byte) plus preamble, SIFS and the
// AP's ACK. Bounded at 4 ms; a frame sent after an idle gap pays nothing.
static uint32_t g_tx_busy_until_us = 0;
static void tx_pace_before() {
  const uint32_t now = (uint32_t)esp_timer_get_time();
  int32_t left = (int32_t)(g_tx_busy_until_us - now);
  if (left <= 0) return;
  if (left > 4000) left = 4000;
  const uint32_t end = now + (uint32_t)left;
  while ((int32_t)(end - (uint32_t)esp_timer_get_time()) > 0) {
  }
}
static void tx_pace_after(uint32_t frame_len) {
  g_tx_busy_until_us = (uint32_t)esp_timer_get_time() + 150 + (frame_len * 4) / 3;
}

uint32_t tx_l2(const uint8_t *hdr, const uint8_t *payload, int plen, const char *label) {
  if (plen < 0 || plen > (int)(sizeof g_txf - kTxL2)) return 0;
  if (payload != g_txf + kTxL2) memmove(g_txf + kTxL2, payload, plen);
  payload = g_txf + kTxL2;
  if (g_hwkey) {
    // Bare protected QoS data MPDU: [26B QoS 802.11 hdr, FC 0x88 0x41 = QoS + ToDS +
    // Protected][LLC/SNAP + L3 CLEARTEXT]. No CCMP header — the vendor ppTxPkt path + MAC
    // engine insert the IV, encrypt, and append the MIC. addr1=g_bssid (hdr already carries it).
    uint8_t *frame = g_txf;
    memset(frame, 0, kTxPad);            // 8-byte HW-TX-header pad (secure branch fills it)
    memcpy(frame + 8, hdr, 24);
    frame[8] = 0x88;                     // QoS data subtype (override the 0x08 the caller set)
    frame[9] = 0x41;                     // ToDS + Protected
    frame[8 + 24] = 0x00; frame[8 + 25] = 0x00; // QoS control: TID 0, normal ack
    bool ok = tx_hw_encrypt(frame, 8 + 26 + plen);
    if (label) Serial.printf("%s (HW-enc ppTxPkt %d B, ok=%d)\n", label, 8 + 26 + plen, ok);
    return 8 + 26 + plen;
  }
  // Send as a QoS Data MPDU (subtype 0x88, 26-byte header + 2-byte QoS Control) so we
  // look like an ordinary client. Confirmed over-the-air: real clients on these networks
  // send QoS Data (fc=8841); our legacy non-QoS Data (fc=0841) was ACKed but never
  // bridged — commercial APs serve QoS STAs and drop a non-QoS STA's encrypted uplink.
  // ccmp_encap keys the header length + QoS AAD off the subtype; TID 0, normal ack.
  uint8_t qhdr[26];
  memcpy(qhdr, hdr, 24);
  qhdr[0] = 0x88;                     // QoS Data subtype (caller set 0x08)
  qhdr[24] = 0x00; qhdr[25] = 0x00;   // QoS Control: TID 0, normal ack
  static uint8_t enc[1700];  // static: off the deep TLS-write stack (encrypt can't run in place)
  uint32_t el = ns_sta_encrypt(qhdr, 26, payload, plen, enc, sizeof(enc));
  if (el > 0) {
    tx_pace_before();
    ns_mac_send(enc, el, 0);
    tx_pace_after(el);
    static int dbg = 0;
    if (dbg++ < 4) {
      auto rd = [](uintptr_t a) { return *reinterpret_cast<volatile uint32_t *>(a); };
      delayMicroseconds(400);
      Serial.printf("NSDBG(good-tx) desc.w0=%08x status(54E0)=%08x plcp0(4D6C)=%08x\n",
                    ns_tx_desc_word0(0), rd(0x600A54E0), rd(0x600A4D6C));
    }
    if (label) Serial.printf("%s (SW-enc %u B)\n", label, el);
  }
  return el;
}

uint32_t g_dhcp_xid = 0;  // per-DORA transaction id (random; reused DISCOVER->REQUEST)
void send_dhcp(uint8_t msg_type, const uint8_t *req_ip, const uint8_t *server_id, const char *what) {
  // One transaction id for the whole DORA so the REQUEST correlates to the OFFER. It
  // MUST be random (RFC 2131 §4.4.1): a fixed constant, identical on every boot and
  // across sibling DUTs, collides in a server's binding/dedup table so a strict server
  // can suppress the OFFER. Draw a fresh one when the DISCOVER opens a new transaction.
  if (msg_type == 1 || g_dhcp_xid == 0) esp_fill_random(&g_dhcp_xid, 4);
  const uint32_t xid = g_dhcp_xid;
  uint8_t payload[400];
  int pn = build_dhcp(payload, OUR_MAC, xid, msg_type, req_ip, server_id);
  uint8_t hdr[24]; // 802.11 data: ToDS=1 + Protected=1; a1=g_bssid a2=us a3=broadcast
  hdr[0] = 0x08; hdr[1] = 0x41; hdr[2] = 0x00; hdr[3] = 0x00;
  // a3 (the L2 destination in a ToDS frame) MUST be the real broadcast address for a DHCP
  // DISCOVER/REQUEST — the L3 destination is 255.255.255.255. With a3 = g_bssid the AP saw
  // the frame as destined to *itself* and never flooded/bridged it to the DHCP server; on a
  // mesh, if we associated to a satellite node rather than the gateway, the DISCOVER died
  // inside the wrong node. TX still encrypts with the PAIRWISE key regardless of a3 (uplink
  // is always pairwise — see sta.rs encrypt_data), so a broadcast a3 is safe here.
  const uint8_t bcast[6] = {0xff, 0xff, 0xff, 0xff, 0xff, 0xff};
  memcpy(hdr + 4, g_bssid, 6); memcpy(hdr + 10, OUR_MAC, 6); memcpy(hdr + 16, bcast, 6);
  put_seq(hdr);
  char lbl[32]; snprintf(lbl, sizeof(lbl), "DHCP %s sent", what);
  tx_l2(hdr, payload, pn, lbl);
}

// CCMP-encrypt + transmit an ICMP echo request from `src` to the gateway (which is
// the AP itself, so the L2 destination is the g_bssid).
void send_ping(const uint8_t *src, uint16_t seq) {
  uint8_t payload[64];
  int pn = build_ping(payload, src, GATEWAY, seq);
  uint8_t hdr[24]; // ToDS=1 + Protected=1; a1=g_bssid a2=us a3=g_bssid (gateway == AP)
  hdr[0] = 0x08; hdr[1] = 0x41; hdr[2] = 0x00; hdr[3] = 0x00;
  memcpy(hdr + 4, g_bssid, 6); memcpy(hdr + 10, OUR_MAC, 6); memcpy(hdr + 16, g_bssid, 6);
  put_seq(hdr);
  tx_l2(hdr, payload, pn, "PING sent");
}

// CCMP-encrypt + transmit an IPv4 packet to the gateway (the AP), wrapping it in
// LLC/SNAP. Used for the TCP segments the tcp module produces.
// IPv4 -> L2 source address of the frames that carried it, learned from inbound FromDS
// data frames (A3 = SA). Replies MUST be addressed (A3 = DA) to the peer's own MAC: an AP
// that is also a host (the Mac's Internet Sharing AP) takes a DA=BSSID frame for ITSELF
// and never forwards it to the phone, so the C6's SYN-ACKs went nowhere (the iOS bench
// connect wedge). The Linux rig APs only worked by hairpin-routing those frames back out.
// An off-subnet peer's packets arrive with SA = the gateway's MAC, which is exactly the
// right next hop, so no netmask check is needed. Unknown -> BSSID (the old behaviour).
struct Neighbor { uint8_t ip[4]; uint8_t mac[6]; };
static Neighbor g_neigh[4];
static uint8_t g_neigh_next = 0;
static uint8_t g_rx_sa[6];
static bool g_rx_sa_ok = false;
static bool g_rx_l2_group = false;  // A1 (RA) was broadcast/multicast: never answer ICMP

// Record the SA of the frame about to be handed to handle_l3 (FromDS: A3 = SA).
static void note_rx_sa(const uint8_t *frame) {
  g_rx_l2_group = frame[4] & 0x01;
  g_rx_sa_ok = (frame[1] & 0x03) == 0x02 && memcmp(frame + 16, OUR_MAC, 6) != 0;
  if (g_rx_sa_ok) memcpy(g_rx_sa, frame + 16, 6);
}

static void learn_neighbor(const uint8_t *src_ip) {
  if (!g_rx_sa_ok) return;
  for (Neighbor &n : g_neigh)
    if (memcmp(n.ip, src_ip, 4) == 0) { memcpy(n.mac, g_rx_sa, 6); return; }
  Neighbor &n = g_neigh[g_neigh_next++ % (sizeof g_neigh / sizeof g_neigh[0])];
  memcpy(n.ip, src_ip, 4);
  memcpy(n.mac, g_rx_sa, 6);
}

static const uint8_t *neighbor_mac(const uint8_t *dst_ip) {
  for (const Neighbor &n : g_neigh)
    if (memcmp(n.ip, dst_ip, 4) == 0) return n.mac;
  return g_bssid;
}

// Transmit an IP packet. Zero-copy when `ip` is already tx_ip_slot() (the TCP pump sites
// write there); any other buffer is copied into the slot.
// Transmit an IP packet to L2 destination `da` (a3; the AP relays it there).
static void send_ip_l2(const uint8_t *ip, int iplen, const uint8_t *da) {
  if (iplen < 0 || iplen > (int)kTxIpCap) return;
  if (ip != tx_ip_slot()) memmove(tx_ip_slot(), ip, iplen);
  uint8_t *payload = g_txf + kTxL2;
  const uint8_t llc[] = {0xaa, 0xaa, 0x03, 0x00, 0x00, 0x00, 0x08, 0x00};
  memcpy(payload, llc, 8);
  uint8_t hdr[24]; // ToDS=1 + Protected=1; a1=g_bssid a2=us a3=DA
  hdr[0] = 0x08; hdr[1] = 0x41; hdr[2] = 0x00; hdr[3] = 0x00;
  memcpy(hdr + 4, g_bssid, 6); memcpy(hdr + 10, OUR_MAC, 6); memcpy(hdr + 16, da, 6);
  put_seq(hdr);
  tx_l2(hdr, payload, 8 + iplen, nullptr);
}

// Transmit an IP packet to its destination: the peer's MAC, else the BSSID (gateway).
void send_ip(const uint8_t *ip, int iplen) { send_ip_l2(ip, iplen, neighbor_mac(ip + 16)); }

// ---- mDNS (_splanc._tcp) ------------------------------------------------------------
// The responder itself is the Rust firmware/mdns crate (via lm_mdns_reply in main.cpp,
// under the player mutex); this is the UDP/IGMP plumbing. Group-addressed TX (the
// 224.0.0.251 replies, the announcement, the IGMP report) only while no wss is live —
// a broadcast/multicast frame interleaved with an established wss drops the peer's
// session (the same rule as the gratuitous ARP). Unicast replies are always safe.
extern bool g_ws_up;  // the WS session is live (defined with the TLS server below)
static const uint8_t kMdnsGroup[4] = {224, 0, 0, 251};
static const uint8_t kMdnsMac[6] = {0x01, 0x00, 0x5e, 0x00, 0x00, 0xfb};
// Native OSC input (TouchDesigner, Ableton, TouchOSC, …): the same port the vendor
// build's osc_task binds. Datagrams go to the app's latest-wins mailbox.
constexpr uint16_t kOscUdpPort = 9000;
constexpr int kUdpPayloadOff = 20 + 8;  // IPv4 (no options) + UDP, in tx_ip_slot()

// Wrap the `len` bytes already at tx_ip_slot()+kUdpPayloadOff in IPv4+UDP (from our
// leased IP) and send them to dst:dport (L2 `da`, or the neighbor/gateway when null).
static void send_udp_slot(const uint8_t *dst, uint16_t sport, uint16_t dport, int len,
                          uint8_t ttl, const uint8_t *da) {
  uint8_t *ip = tx_ip_slot();
  const int udp_len = 8 + len, ip_len = 20 + udp_len;
  ip[0] = 0x45; ip[1] = 0; ip[2] = ip_len >> 8; ip[3] = ip_len & 0xff;
  ip[4] = 0; ip[5] = 0; ip[6] = 0x40; ip[7] = 0;  // id, DF
  ip[8] = ttl; ip[9] = 17; ip[10] = 0; ip[11] = 0;
  memcpy(ip + 12, g_offer_ip, 4); memcpy(ip + 16, dst, 4);
  uint16_t c = ip_csum(ip, 20); ip[10] = c >> 8; ip[11] = c & 0xff;
  uint8_t *u = ip + 20;
  u[0] = sport >> 8; u[1] = sport & 0xff; u[2] = dport >> 8; u[3] = dport & 0xff;
  u[4] = udp_len >> 8; u[5] = udp_len & 0xff; u[6] = 0; u[7] = 0;
  // UDP checksum over the pseudo-header + datagram (0 would mean "none"; send a real one).
  uint32_t sum = 0;
  for (int i = 12; i < 20; i += 2) sum += (ip[i] << 8) | ip[i + 1];
  sum += 17 + udp_len;
  for (int i = 0; i + 1 < udp_len; i += 2) sum += (u[i] << 8) | u[i + 1];
  if (udp_len & 1) sum += u[udp_len - 1] << 8;
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  uint16_t uc = ~sum & 0xffff;
  if (uc == 0) uc = 0xffff;
  u[6] = uc >> 8; u[7] = uc & 0xff;
  if (da) send_ip_l2(ip, ip_len, da); else send_ip(ip, ip_len);
}

// IGMPv2 Membership Report for 224.0.0.251 (TTL 1, Router Alert), so an IGMP-snooping
// AP forwards the mDNS group to us. Group-addressed: callers gate it like the announce.
static void send_igmp_mdns_report() {
  uint8_t *ip = tx_ip_slot();
  const int ip_len = 24 + 8;
  ip[0] = 0x46; ip[1] = 0xc0; ip[2] = 0; ip[3] = ip_len;  // IHL=6 (Router Alert), CS6
  ip[4] = 0; ip[5] = 0; ip[6] = 0; ip[7] = 0;
  ip[8] = 1; ip[9] = 2; ip[10] = 0; ip[11] = 0;          // TTL 1, proto IGMP
  memcpy(ip + 12, g_offer_ip, 4); memcpy(ip + 16, kMdnsGroup, 4);
  ip[20] = 0x94; ip[21] = 0x04; ip[22] = 0; ip[23] = 0;  // Router Alert (RFC 2113)
  uint16_t c = ip_csum(ip, 24); ip[10] = c >> 8; ip[11] = c & 0xff;
  uint8_t *g = ip + 24;
  g[0] = 0x16; g[1] = 0; g[2] = 0; g[3] = 0; memcpy(g + 4, kMdnsGroup, 4);
  uint16_t gc = ip_csum(g, 8); g[2] = gc >> 8; g[3] = gc & 0xff;
  send_ip_l2(ip, ip_len, kMdnsMac);
}

static uint32_t g_mdns_replies = 0, g_mdns_announces = 0;

// Announce every record on the group (RFC 6762 §8.3); caller gates on no live wss.
static void send_mdns_announce() {
  int n = lm_mdns_reply(nullptr, 0, 5353, g_offer_ip, tx_ip_slot() + kUdpPayloadOff,
                        kTxIpCap - kUdpPayloadOff, nullptr);
  if (n > 0) {
    send_udp_slot(kMdnsGroup, 5353, 5353, n, 255, kMdnsMac);
    g_mdns_announces++;
  }
}

// CCMP-encrypt + transmit an EAPOL-Key frame to the AP over the established link — the
// group-key rekey ACK (Group message 2). Same protected data path as send_ip, but the
// LLC/SNAP ethertype is 0x888E (EAPOL) rather than 0x0800 (IPv4).
void send_eapol_encrypted(const uint8_t *eapol, int elen) {
  uint8_t payload[256];
  const uint8_t llc[] = {0xaa, 0xaa, 0x03, 0x00, 0x00, 0x00, 0x88, 0x8e};
  memcpy(payload, llc, 8);
  memcpy(payload + 8, eapol, elen);
  uint8_t hdr[24]; // ToDS=1 + Protected=1; a1=g_bssid a2=us a3=g_bssid (gateway == AP)
  hdr[0] = 0x08; hdr[1] = 0x41; hdr[2] = 0x00; hdr[3] = 0x00;
  memcpy(hdr + 4, g_bssid, 6); memcpy(hdr + 10, OUR_MAC, 6); memcpy(hdr + 16, g_bssid, 6);
  put_seq(hdr);
  tx_l2(hdr, payload, 8 + elen, "group-m2");
}

// Program the HW CCMP key slot for our pairwise key so the MAC hardware-decrypts
// protected unicast to us (delivering plaintext) AND keeps hardware auto-ACK.
void install_hw_key() {
  uint8_t tk[16];
  if (!ns_sta_get_tk(tk)) return;
  auto wr = [](uintptr_t a, uint32_t v) { *reinterpret_cast<volatile uint32_t *>(a) = v; };
  auto rd = [](uintptr_t a) { return *reinterpret_cast<volatile uint32_t *>(a); };
  // Hardware inline CCMP. HW_DECRYPT (cleaner form: hal_crypto_enable + natural wDev key
  // config) makes the MAC hardware-DECRYPT protected unicast from the AP — PROVEN on
  // silicon. Gated OFF by default: MAC inline crypto also re-encrypts TX, but hardware
  // TX-ENCRYPT is UNREACHABLE from our heapless direct-submission path. Exhaustively
  // reversed + tested on silicon (4 RE agents, ~20 rig iterations): the WiFi MAC only
  // encrypts frames that flow through the vendor TX path (ppTxPkt -> ppProcTxSecFrame,
  // which requires a non-NULL station/node pointer at esf_buf+0x2c that the vendor
  // association machinery builds). Our own lldesc/PLCP0 submission never engages the
  // TX-crypto engine, so a Protected outbound frame is silently dropped pre-TX (confirmed
  // 0-on-air with an unfiltered OTA sniffer). NB: descriptor word0 bit29 is the FTM
  // timestamp bit, NOT a crypto flag — setting it made the drop worse. So the WiFi-MAC
  // inline path is decrypt-only for a heapless driver; TX-encrypt needs the standalone
  // AES peripheral driving our ccmp.rs, or the vendor ppTxPkt+node struct (vendor-coupled).
  // With HW crypto OFF, the proven all-software CCMP round-trip runs (4-way -> DHCP -> TCP).
  // HW_DECRYPT=true enables HW decrypt + the WIP vendor ppTxPkt bridge for HW TX-encrypt
  // (tx_hw_encrypt). The bridge is PLUMBED but not yet emitting: ppTxPkt accepts the frame,
  // takes the secure branch (sets the 0x20000000 encrypt bit), arms PLCP0 queue 0, and the
  // TX status reaches ack-timeout — but no valid frame reaches the air (0 on an OTA sniffer
  // that DOES capture neighbours' encrypted QoS data). The vendor lmac/PHY TX pipeline isn't
  // fully live under our RX-only bring-up. See hw-crypto-tx-seam.md "ppTxPkt bridge (WIP)".
  constexpr bool HW_DECRYPT = false;
  if (!HW_DECRYPT) {
    wr(0x600A4800, 0); // disable HW crypto engine -> protected unicast passes raw (SW CCMP)
    g_hwkey = false;
    return;
  }
  // --- HW inline decrypt (the reversed vendor recipe) ---
  constexpr uint32_t SLOT = 4; // slots 0-3 are group keys; pairwise goes in a slot >= 4
  wDev_Insert_KeyEntry(4 /*CCMP*/, 1 /*enable*/, 0, g_bssid, SLOT, tk, 16, 0);
  volatile uint32_t *slot = reinterpret_cast<volatile uint32_t *>(0x600A5800 + SLOT * 40);
  slot[6] = 0; slot[7] = 0; slot[8] = 0; slot[9] = 0;   // zero RX PN replay words
  // EXPERIMENT: use the vendor's atomic engine setup instead of raw register pokes, and
  // keep the NATURAL key config (no 0x086c overwrite). Prior raw-poke attempts matched the
  // vendor's *visible* registers but the crypto engine still refused TX — internal state
  // from the enable SEQUENCE may be the missing piece.
  wr(0x600A4004, rd(0x600A4004) | 0x00010000);          // g_bssid entry "has key" bit
  hal_crypto_enable(0 /*iface0*/, 4 /*CCMP*/, 0, 0);    // vendor engine enable sequence
  ic_set_rx_policy(0, 0, 1, 1);
  ic_rx_enable_bssid_check(0);
  g_trc = ic_get_trc(0, 0); // default TRC for the ppTxPkt HW-encrypt bridge (no assoc needed)
  g_hwkey = true;
  Serial.printf("HW crypto (vendor enable): kv=%08x 4800=%08x 4810=%08x slot4w1=%08x trc=%p\n",
                rd(0x600A4814), rd(0x600A4800), rd(0x600A4810), rd(0x600A5804 + SLOT * 40), g_trc);
}

// Parse an L2 payload (LLC/SNAP + IPv4): ICMP echo (requests answered, replies to our
// gateway pings logged), TCP, mDNS and DHCP responses.
// Works for both software-decrypted and hardware-decrypted (plaintext) frames.
// Reply to an ARP request for our IP. The gateway revalidates its ARP cache with a
// UNICAST probe to our MAC (pairwise-encrypted, so we can decrypt it) — without a reply
// the entry goes FAILED and our inbound data segments get dropped. LLC/SNAP EtherType for
// ARP is 0x0806.
void handle_arp(const uint8_t *pt, int pl) {
  if (pl < 8 + 28) return;
  const uint8_t *arp = pt + 8;
  uint16_t oper = (arp[6] << 8) | arp[7];
  static uint32_t af = 0;
  if (af++ < 20)
    Serial.printf("  ARP oper=%u who-has %u.%u.%u.%u (we=%u.%u.%u.%u) from %02x:%02x:%02x\n", oper,
                  arp[24], arp[25], arp[26], arp[27], g_offer_ip[0], g_offer_ip[1], g_offer_ip[2],
                  g_offer_ip[3], arp[8], arp[9], arp[10]);
  if (oper != 1 || memcmp(arp + 24, g_offer_ip, 4) != 0) return; // not a request for our IP
  Serial.println("  ARP -> replying");
  uint8_t payload[8 + 28];
  const uint8_t llc[] = {0xaa, 0xaa, 0x03, 0x00, 0x00, 0x00, 0x08, 0x06};
  memcpy(payload, llc, 8);
  uint8_t *r = payload + 8;
  r[0] = 0x00; r[1] = 0x01;      // htype: Ethernet
  r[2] = 0x08; r[3] = 0x00;      // ptype: IPv4
  r[4] = 6; r[5] = 4;            // hlen, plen
  r[6] = 0x00; r[7] = 0x02;      // oper: reply
  memcpy(r + 8, OUR_MAC, 6);     // sha = our MAC
  memcpy(r + 14, g_offer_ip, 4); // spa = our IP
  memcpy(r + 18, arp + 8, 6);    // tha = requester's MAC
  memcpy(r + 24, arp + 14, 4);   // tpa = requester's IP
  uint8_t hdr[24];               // ToDS + Protected; a3 = DA = requester's MAC
  hdr[0] = 0x08; hdr[1] = 0x41; hdr[2] = 0; hdr[3] = 0;
  memcpy(hdr + 4, g_bssid, 6); memcpy(hdr + 10, OUR_MAC, 6); memcpy(hdr + 16, arp + 8, 6);
  put_seq(hdr);
  tx_l2(hdr, payload, 8 + 28, nullptr);
}

// Announce our IP<->MAC to the whole BSS (gratuitous ARP, RFC 5227): SPA=TPA=our IP,
// broadcast. Our ARP *responder* only helps a peer whose request reaches us AND whose
// reply gets back — on a plain AP (no proxy-ARP, unlike a commercial router that answers
// from DHCP snooping) that round-trip is unreliable for a from-scratch stack, so a peer
// (e.g. the phone joining the AP AFTER the C6 leased) can't resolve us and gets
// ERR_ADDRESS_UNREACHABLE. A proactive announcement uses only our working TX path. The
// CALLER gates this to the pre-connection window (no active wss) — a broadcast frame
// interleaved with an ESTABLISHED wss dropped the peer's session (the improv_e2e wss
// wedge), so we announce only until a client is connected, never during a live session.
void send_gratuitous_arp() {
  if (!g_leased) return;
  uint8_t payload[8 + 28];
  const uint8_t llc[] = {0xaa, 0xaa, 0x03, 0x00, 0x00, 0x00, 0x08, 0x06};
  memcpy(payload, llc, 8);
  uint8_t *r = payload + 8;
  r[0] = 0x00; r[1] = 0x01;      // htype: Ethernet
  r[2] = 0x08; r[3] = 0x00;      // ptype: IPv4
  r[4] = 6; r[5] = 4;            // hlen, plen
  r[6] = 0x00; r[7] = 0x01;      // oper: request (announcement)
  memcpy(r + 8, OUR_MAC, 6);     // sha = our MAC
  memcpy(r + 14, g_offer_ip, 4); // spa = our IP
  memset(r + 18, 0, 6);          // tha = 0
  memcpy(r + 24, g_offer_ip, 4); // tpa = our IP (gratuitous)
  const uint8_t bcast[6] = {0xff, 0xff, 0xff, 0xff, 0xff, 0xff};
  uint8_t hdr[24]; // ToDS + Protected; a3 = broadcast so the AP floods it to the BSS
  hdr[0] = 0x08; hdr[1] = 0x41; hdr[2] = 0; hdr[3] = 0;
  memcpy(hdr + 4, g_bssid, 6); memcpy(hdr + 10, OUR_MAC, 6); memcpy(hdr + 16, bcast, 6);
  put_seq(hdr);
  tx_l2(hdr, payload, 8 + 28, "gratuitous ARP");
}

// Answer an ICMP echo request (`ping <device-ip>`). icmp_echo.h validates it (our unicast
// IP, no fragments, checksums, <= kIcmpEchoMaxData data bytes); group-addressed frames are
// dropped here (no smurf amplification). The reply is built in place in the TX IP slot and
// leaves through send_ip — the same unicast path (and neighbor-table next hop: the
// requester's own MAC, or the gateway's for an off-subnet peer) as our TCP segments.
// Unicast, so it is safe beside a live wss. Rate-limited to 10/s (burst 5) so a ping flood
// can't eat the loopTask time LED output, TLS and the watchdog need; no heap, ~24 B state.
static IcmpRateLimiter g_icmp_rl;
static uint32_t g_icmp_replied = 0, g_icmp_limited = 0, g_icmp_dropped = 0;
static void answer_icmp_echo(const uint8_t *ip, int avail) {
  const IcmpEcho v = g_rx_l2_group ? IcmpEcho::kNotForUs
                                   : icmp_echo_check(ip, (size_t)avail, g_offer_ip);
  bool sent = false;
  if (v == IcmpEcho::kOk && g_icmp_rl.take((uint32_t)millis())) {
    const size_t n = icmp_echo_build_reply(ip, g_offer_ip, tx_ip_slot(), kTxIpCap);
    if (n > 0) {
      send_ip(tx_ip_slot(), (int)n);
      sent = true;
      if (g_icmp_replied++ < 4) {
        const uint8_t *ic = ip + (ip[0] & 0x0f) * 4;
        Serial.printf("[icmp] echo reply -> %u.%u.%u.%u seq=%u (%u B)\n", ip[12], ip[13],
                      ip[14], ip[15], (ic[6] << 8) | ic[7], (unsigned)n);
      }
    }
  }
  if (sent) return;
  if (v == IcmpEcho::kOk) g_icmp_limited++;
  else g_icmp_dropped++;
  // A flood never floods the console: one summary at most every 5 s, only when dropping.
  static uint32_t last_log = 0;
  if (millis() - last_log > 5000) {
    last_log = millis();
    Serial.printf("[icmp] replied=%u rate_limited=%u dropped=%u (last verdict %u)\n",
                  (unsigned)g_icmp_replied, (unsigned)g_icmp_limited, (unsigned)g_icmp_dropped,
                  (unsigned)v);
  }
}

void handle_l3(const uint8_t *pt, int pl) {
  // EAPOL-Key (ethertype 0x888E) over the established, encrypted link: the AP's periodic
  // GROUP-KEY REKEY (message 1). If we ignore it, the authenticator times out the Group
  // Key Handshake and DEAUTHs us (reason 16) — which used to strand the link mid-session
  // (the fx_bench "board unreachable" wedge). Service it: the supplicant verifies the MIC,
  // installs the fresh GTK, and returns Group message 2, which we send back CCMP-encrypted.
  // (The reason-16 auto-rejoin remains as a backstop for any deauth we can't service here.)
  if (pl > 8 + 4 && pt[6] == 0x88 && pt[7] == 0x8e) {
    uint8_t reply[160];
    uint32_t r = ns_wpa_on_eapol(pt + 8, (uint32_t)(pl - 8), reply, sizeof(reply));
    uint32_t code = r >> 16, rl = r & 0xffff;
    if (code >= 1 && rl > 0) {
      send_eapol_encrypted(reply, (int)rl);
      g_rekey_serviced++;
    }
    Serial.printf("[t=%lu] *** group-key rekey serviced #%u (code=%u reply=%u) ***\n",
                  (unsigned long)millis(), (unsigned)g_rekey_serviced, code, rl);
    return;
  }
  if (pl <= 8 || pt[6] != 0x08) return; // not an EtherType we route
  if (pt[7] == 0x06) { handle_arp(pt, pl); return; } // ARP
  if (pt[7] != 0x00) return;            // only IPv4 past here
  const uint8_t *ip = pt + 8;
  NS_TRACE(g_ns_rx_stamps.l3_reap_us = g_ns_rx_stamps.reap_us;
           g_ns_rx_stamps.l3_empty_us = g_ns_rx_stamps.empty_poll_us);
  if (pl >= 8 + 20) learn_neighbor(ip + 12);
  // Identify EVERY inbound IPv4 packet (proto + ports) — chasing why the client's TCP
  // data segment never arrives amid a flood of large frames.
  {
    static uint32_t ipf = 0;
    if (ipf++ < 40 && pl >= 8 + 20) {
      int ihl = (ip[0] & 0x0f) * 4;
      uint16_t sp = 0, dp = 0;
      if ((ip[9] == 6 || ip[9] == 17) && pl >= 8 + ihl + 4) {
        const uint8_t *l4 = ip + ihl;
        sp = (l4[0] << 8) | l4[1];
        dp = (l4[2] << 8) | l4[3];
      }
      Serial.printf("  IP proto=%u %u.%u.%u.%u:%u -> %u.%u.%u.%u:%u len=%d(pl=%d)\n", ip[9],
                    ip[12], ip[13], ip[14], ip[15], sp, ip[16], ip[17], ip[18], ip[19], dp,
                    (ip[2] << 8) | ip[3], pl);
    }
  }
  if (pl > 8 + 20 && ip[9] == 6) { // TCP -> feed the connection
    int iplen = (ip[2] << 8) | ip[3];
    if (iplen >= 20 && 8 + iplen <= pl) {
      const uint8_t *tcp = ip + ((ip[0] & 0x0f) * 4);
      int doff = (tcp[12] >> 4) * 4;
      int dlen = iplen - ((ip[0] & 0x0f) * 4) - doff;
      static uint32_t tf = 0;
      if (tf++ < 24)
        Serial.printf("  TCP %u.%u.%u.%u:%u->:%u flags=%02x seq=%08x dlen=%d st=%u\n",
                      ip[12], ip[13], ip[14], ip[15], (tcp[0] << 8) | tcp[1],
                      (tcp[2] << 8) | tcp[3], tcp[13],
                      (uint32_t)((tcp[4] << 24) | (tcp[5] << 16) | (tcp[6] << 8) | tcp[7]), dlen,
                      ns_tcp_state());
      NS_TRACE(if (dlen > 0) {
        g_ns_rx_stamps.data_reap_us = g_ns_rx_stamps.reap_us;
        g_ns_rx_stamps.data_empty_us = g_ns_rx_stamps.empty_poll_us;
      });
      uint32_t rl = ns_tcp_on_ip(millis(), ip, iplen, tx_ip_slot(), kTxIpCap);
      if (rl > 0) send_ip(tx_ip_slot(), rl);
    }
    return;
  }
  if (pl > 8 + 28 && ip[9] == 1) { // ICMP
    const uint8_t *ic = ip + ((ip[0] & 0x0f) * 4);
    if (ic[0] == 0) // echo reply
      Serial.printf("*** PING REPLY from %u.%u.%u.%u seq=%u — IP round-trip over heapless WiFi ***\n",
                    ip[12], ip[13], ip[14], ip[15], (ic[6] << 8) | ic[7]);
    else if (ic[0] == 8 && g_leased) // echo request: answer it (policy + cap in icmp_echo.h)
      answer_icmp_echo(ip, pl - 8);
  } else if (pl > 8 + 28 && ip[9] == 17) { // UDP
    const int ihl = (ip[0] & 0x0f) * 4;
    const int iplen = (ip[2] << 8) | ip[3];
    if (ihl < 20 || iplen < ihl + 8 || 8 + iplen > pl) return;
    const uint8_t *udp = ip + ihl;
    const int udplen = (udp[4] << 8) | udp[5];
    if (udplen < 8 || udplen > iplen - ihl) return;
    uint16_t sport = (udp[0] << 8) | udp[1], dport = (udp[2] << 8) | udp[3];
    if (dport == kOscUdpPort && g_leased) { // native OSC (docs/design/live-control.md)
      lm_netstack_osc_rx(udp + 8, (size_t)(udplen - 8));
      return;
    }
    if (dport == 5353 && g_leased) { // mDNS query (multicast group or unicast to us)
      bool unicast = false;
      int n = lm_mdns_reply(udp + 8, (size_t)(udplen - 8), sport, g_offer_ip,
                            tx_ip_slot() + kUdpPayloadOff, kTxIpCap - kUdpPayloadOff, &unicast);
      if (n > 0) {
        const uint8_t src_ip[4] = {ip[12], ip[13], ip[14], ip[15]};
        const bool group = !unicast && !g_ws_up;
        if (group) {
          send_udp_slot(kMdnsGroup, 5353, 5353, n, 255, kMdnsMac);
        } else {
          // A QU / legacy query, or a live wss (no group-addressed TX): answer the querier.
          send_udp_slot(src_ip, 5353, sport, n, 255, nullptr);
        }
        if (g_mdns_replies++ < 8)
          Serial.printf("[mdns] answered %u.%u.%u.%u:%u (%s, %d B)\n", src_ip[0], src_ip[1],
                        src_ip[2], src_ip[3], sport, group ? "multicast" : "unicast", n);
      }
      return;
    }
    if (sport == 67 && dport == 68) { // DHCP server -> client
      const uint8_t *dh = udp + 8;
      // A different DUT's broadcast ACK must never replace our IP or server ID.
      if (!dhcp_reply_for_client(dh, udplen - 8, OUR_MAC, g_dhcp_xid)) return;
      uint8_t mt = 0;
      const uint8_t *o = dh + 240;
      const uint8_t *end = udp + udplen;
      while (o + 1 < end && *o != 255) {
        if (*o == 0) { ++o; continue; } // DHCP padding has no length byte
        if (*o == 53) mt = o[2];
        else if (*o == 54) memcpy(g_server_id, o + 2, 4);
        else if (*o == 51 && o[1] == 4) // lease time (seconds), for T1 renewal
          g_lease_secs = ((uint32_t)o[2] << 24) | (o[3] << 16) | (o[4] << 8) | o[5];
        o += 2 + o[1];
      }
      Serial.printf("DHCP reply: type=%u yiaddr=%u.%u.%u.%u\n", mt, dh[16], dh[17], dh[18], dh[19]);
      if (mt == 2 && !g_have_offer && !g_leased) {
        memcpy(g_offer_ip, dh + 16, 4);
        g_have_offer = true;
        Serial.printf("[t=%lu] *** DHCP OFFER received — L3 over heapless CCMP link ***\n", (unsigned long)millis());
        send_dhcp(3, g_offer_ip, g_server_id, "REQUEST");
      } else if (mt == 6 && !g_leased && g_have_offer) {
        // NAK for the address we REQUESTed (the stale one a deauth left in g_offer_ip, or
        // one the server gave away meanwhile): back to a fresh DISCOVER instead of
        // re-REQUESTing it forever.
        g_have_offer = false;
        Serial.printf("[t=%lu] [dhcp] NAK -> re-DISCOVER\n", (unsigned long)millis());
      } else if (mt == 5) {
        bool first = !g_leased;
        g_leased = true;
        mark_seen();
        g_window_until = 0;  // manual: the join window did its job
        g_persist.on_lease((uint32_t)millis());  // proves freshly provisioned creds (wifi_creds.h)
        g_lease_ms = millis(); // (re)start the lease clock for T1 renewal
        memcpy(g_offer_ip, dh + 16, 4); // commit the leased IP
        // Drift fork: the TCP listener binds our IP exactly ONCE (g_tcp_started one-shot at
        // the bind site) and freezes it in g_listen_ip. Any mid-session IP change — a
        // lease-lapse re-DISCOVER (see "lease EXPIRED — re-DISCOVER"), or a T1/T2 renewal
        // that returns a DIFFERENT address — leaves the listener bound to the OLD IP, so
        // inbound SYNs to our current, ARP-defended IP get silently dropped by the tcp.rs
        // dst-IP gate forever (nothing re-arms a stuck LISTEN). The deauth path already
        // resets g_tcp_started for exactly this "re-listen on the fresh binding" reason;
        // re-DISCOVER/renewal needs the identical reset. Compare the committed lease IP to
        // g_listen_ip (what we actually bound) — NOT g_offer_ip, which the OFFER handler
        // above already advanced to the new IP before this ACK. Guarded so a same-IP renewal
        // never churns the listener or drops a live wss.
        if (g_tcp_started && memcmp(g_offer_ip, g_listen_ip, 4) != 0) {
          Serial.printf("[dhcp] IP changed %u.%u.%u.%u -> %u.%u.%u.%u — re-arming TCP listener\n",
                        g_listen_ip[0], g_listen_ip[1], g_listen_ip[2], g_listen_ip[3],
                        g_offer_ip[0], g_offer_ip[1], g_offer_ip[2], g_offer_ip[3]);
          g_tcp_started = false;    // bind site rebinds ns_tcp_listen on the NEW g_offer_ip
          g_relisten_new_ip = true; // and clears the stale TLS/WS session (globals not in scope here)
        }
        if (first)
          Serial.printf("[t=%lu] *** DHCP LEASE ACQUIRED — IP %u.%u.%u.%u over heapless WiFi ***\n",
                        (unsigned long)millis(), dh[16], dh[17], dh[18], dh[19]);
        else {
          Serial.printf("[dhcp] lease RENEWED %u.%u.%u.%u (lease=%us)\n", dh[16], dh[17], dh[18],
                        dh[19], (unsigned)g_lease_secs);
          g_mdns_renewed = true;
        }
      }
    }
  }
}

// Find an EAPOL-Key body inside a received data frame; returns len or 0.
int eapol_body(const uint8_t *f, int len, const uint8_t **out) {
  for (int i = 24; i + 8 <= len && i < 40; i++) {
    if (f[i] == 0xaa && f[i + 1] == 0xaa && f[i + 6] == 0x88 && f[i + 7] == 0x8e) {
      *out = f + i + 8;
      return len - (i + 8);
    }
  }
  return 0;
}
// ---- TLS server over the heapless TCP (mbedtls with a BIO on ns_tcp) ----------------
// Layer a real TLS 1.2 server on the proven heapless TCP server: mbedtls drives the
// handshake + records through send/recv callbacks that ride ns_tcp_send/recv (our CCMP
// data path).
//
// Identity: this device's OWN EC P-256 key + self-signed cert (device_cert.h), generated
// on first boot and persisted in littlefs — NOT a key baked into the (open-source)
// image. Every netstack build before per-device certs served one shared cert (CN=heapless)
// whose private key was in this file, so anyone could impersonate any device; clients
// that pinned that hash re-pin silently (device_cert_core.h kLegacySharedCertSha256).
// The :443 listener is not opened until the identity is installed (g_tls_setup), so a
// handshake never meets a missing/partial cert.
constexpr bool TLS_SERVER = true;
mbedtls_ssl_context g_ssl;
mbedtls_ssl_config g_conf;
mbedtls_x509_crt g_srvcert;
mbedtls_pk_context g_pk;
bool g_tls_setup = false;
bool g_tls_hs = false;

static int tls_rng(void *, unsigned char *buf, size_t len) {
  esp_fill_random(buf, len);
  return 0;
}
uint32_t g_bio_tx = 0, g_bio_rx = 0;
// Enqueue `len` bytes into the TCP send window and stream out as many segments as the
// peer's window currently allows. Returns the bytes accepted into the window.
static uint32_t tcp_send_all(const uint8_t *data, uint32_t len) {
  uint32_t acc = ns_tcp_enqueue(data, len);
  uint32_t n;
  while ((n = ns_tcp_pump_tx((uint32_t)millis(), tx_ip_slot(), kTxIpCap)) > 0) send_ip(tx_ip_slot(), n);
  return acc;
}
// BIO send: hand the TLS record bytes to the TCP send window. Returns the bytes accepted
// (mbedtls advances by that), or WANT_WRITE when the window buffer is full — ACKs drain it
// and the record is retried. Unlike the old stop-and-wait path, many segments can be in
// flight at once, so replies/streams pipeline instead of blocking one RTT per segment.
static int bio_send(void *, const unsigned char *buf, size_t len) {
  uint32_t acc = tcp_send_all(buf, (uint32_t)len);
  if (acc == 0) return MBEDTLS_ERR_SSL_WANT_WRITE;  // window full; ACKs drain it, record retried
  if (g_bio_tx++ < 24) Serial.printf("  bio_send len=%u took=%u\n", (unsigned)len, (unsigned)acc);
  return (int)acc;
}
static int bio_recv(void *, unsigned char *buf, size_t len) {
  uint32_t n = ns_tcp_recv(buf, (uint32_t)len);
  if (n == 0) return MBEDTLS_ERR_SSL_WANT_READ;
  if (g_bio_rx++ < 24) Serial.printf("  bio_recv want=%u got=%u\n", (unsigned)len, n);
  return (int)n;
}

// Abandon the current TLS session (re-listen / reclaim / deauth paths). A no-op until the
// server is set up: before the device identity exists there is no session to reset (and
// mbedtls_ssl_session_reset on a context that was never mbedtls_ssl_setup'd dereferences
// its unset conf).
static void tls_session_reset() {
  if (g_tls_setup) mbedtls_ssl_session_reset(&g_ssl);
}

// Install the device identity into the server: parse this device's DER key + cert into
// mbedtls's own copies (in the TLS region), then free the boot-time DER buffers so the
// steady state holds only the parsed structures — as it did with the baked cert. On a
// parse failure the identity is discarded and regenerated (device_cert_reject).
static bool g_identity_installed = false;
static bool tls_install_identity() {
  size_t kl = 0, cl = 0;
  const uint8_t *key = device_cert_key_der(&kl);
  const uint8_t *crt = device_cert_cert_der(&cl);
  int r = crt ? mbedtls_x509_crt_parse_der(&g_srvcert, crt, cl) : -1;
  int r2 = key ? mbedtls_pk_parse_key(&g_pk, key, kl, nullptr, 0, tls_rng, nullptr) : -1;
  device_cert_release();
  if (r != 0 || r2 != 0) {
    Serial.printf("[tls] device identity install failed: cert=%d key=%d\n", r, r2);
    mbedtls_x509_crt_free(&g_srvcert);
    mbedtls_pk_free(&g_pk);
    mbedtls_x509_crt_init(&g_srvcert);
    mbedtls_pk_init(&g_pk);
    device_cert_reject((uint32_t)millis());
    lm_publish_tls_info(device_cert_machine().state_name(), "", false);
    return false;
  }
  mbedtls_ssl_conf_own_cert(&g_conf, &g_srvcert, &g_pk);
  g_identity_installed = true;
  return true;
}

// Bind the server context to the (identity-bearing) config; :443 opens once this holds.
// Retried from netstack_loop if it fails (an allocation in the TLS region), so a
// transient failure can't strand :443 closed until reboot.
static bool tls_setup_session() {
  int r3 = mbedtls_ssl_setup(&g_ssl, &g_conf);
  if (r3 != 0) {
    Serial.printf("[tls] mbedtls_ssl_setup failed -0x%04x; retrying\n", (unsigned)-r3);
    mbedtls_ssl_free(&g_ssl);
    mbedtls_ssl_init(&g_ssl);
    return false;
  }
  mbedtls_ssl_set_bio(&g_ssl, nullptr, bio_send, bio_recv, nullptr);
  g_tls_setup = true;
  // The served cert's SHA-256 (device_cert_sha256): the manifest's tls.cert_sha256 and
  // TlsInfo's pin, so a client can pin this device's self-signed cert per device id.
  lm_publish_tls_info(device_cert_machine().state_name(), device_cert_sha256(),
                      device_cert_machine().persisted());
  Serial.printf("TLS init: setup ok (per-device identity, sha256=%s, persisted=%d)\n",
                device_cert_sha256(), device_cert_machine().persisted() ? 1 : 0);
  return true;
}

void tls_init() {
  tls_region_install();  // mbedtls allocates from its own region from here on
  mbedtls_ssl_init(&g_ssl);
  mbedtls_ssl_config_init(&g_conf);
  mbedtls_x509_crt_init(&g_srvcert);
  mbedtls_pk_init(&g_pk);
  mbedtls_ssl_config_defaults(&g_conf, MBEDTLS_SSL_IS_SERVER, MBEDTLS_SSL_TRANSPORT_STREAM,
                              MBEDTLS_SSL_PRESET_DEFAULT);
  mbedtls_ssl_conf_rng(&g_conf, tls_rng, nullptr);
  mbedtls_ssl_conf_authmode(&g_conf, MBEDTLS_SSL_VERIFY_NONE);
  // The identity is normally ready long before this (setup() loads or generates it before
  // the WiFi bring-up). If generation failed, :443 stays closed; netstack_loop retries
  // (device_cert_poll) and finishes the setup once it succeeds.
  if (device_cert_ready() && tls_install_identity() && tls_setup_session()) {
    // ready: :443 opens with the lease
  } else if (!device_cert_ready()) {
    lm_publish_tls_info(device_cert_machine().state_name(), "", false);
    Serial.printf("TLS init: device identity not ready (%s) — :443 held closed\n",
                  device_cert_machine().state_name());
  }
}

// ---- WebSocket + player: the LED Mapper protocol over the proven TLS -----------------
// When PLAYER_MODE, once TLS is up we speak RFC6455: consume the HTTP upgrade, then feed
// each binary WS message to the player session core (lm_player_handle) and frame its
// reply back. This is the transport the HITL e2e exercises (wss:443/ws): hello/welcome,
// time_sync, set_device_name, get_hardware_config — all handled inside lm_player_handle.
constexpr bool PLAYER_MODE = true;
bool g_ws_up = false;
// True once ws_pump has begun writing a RESPONSE on the current slot — the WS 101 upgrade
// OR the one-shot cert-trust-page GET. Distinguishes an actively-serving connection (which
// must NOT be killed by the pre-WS 4s wedge gate while it finishes serving + closing) from
// a genuinely silent pre-WS wedge (a tls_churn TLS-then-silent peer that never responded,
// which the 4s gate must still reclaim). The post-WS 6s peer-gone gate covers a responding
// connection instead. Cleared on every re-listen / reclaim (alongside g_ws_up).
bool g_responding = false;
// Edge tracker for "a wss client just appeared on :443". When it does, we gracefully
// disconnect the VESTIGIAL post-provision BLE link (see netstack_loop): after the central
// drops the provisioning link, the controller otherwise only fires EV_DISCONN on the ~6s
// supervision timeout (netstack hci.rs), and until then coex keeps yielding ~28% of WiFi to
// the now-dead link — the exact window the wss handshake/welcome runs in, so its packets land
// in the BLE yield slots and get dropped (RST / welcome-timeout). A wss client only appears
// AFTER provisioning (redirect + PROVISIONED went out over BLE), so the link is expendable:
// tearing it down gracefully frees the radio for the handshake, reclaims BLE heap, and the
// host re-advertises so the device stays connectable. We do NOT blanket-starve BLE — a fresh
// central reconnecting still gets normal coex priority.
bool g_wss_was_active = false;
// WS reassembly buffer. Clients shard anything over CHUNK_BYTES (4096) into UploadChunk
// windows, so a single inbound frame never exceeds ~4KB + protobuf overhead — 6KB is ample.
// Kept small on purpose: on the C6 all internal SRAM is DMA-capable, and oversized BSS here
// starves the WiFi driver's DMA RX-buffer allocation (esp_wifi_init fails, beacons=0).
uint8_t g_ws_rx[6144];
size_t g_ws_rxlen = 0;

// Receive + decrypt one link frame and drive it through the L3/TCP handler. Called from
// the TLS write spin so the peer's ACK is processed and the stop-and-wait TCP frees its
// in-flight segment — otherwise a write that spans >1 segment (or follows an unacked one)
// deadlocks: bio_send returns WANT_WRITE forever because no RX drain runs to clear tx_data.
// loopTask's link RX scratch, shared by its two receive paths: netstack_loop's drain and
// pump_link_once (the TLS-write spin). One full MPDU (ns_mac_recv truncates to the cap, and
// a truncated frame fails CCMP's MIC) plus one software-CCMP plaintext. The paths never
// nest: pump_link_once runs only under tls_write_all (ws_pump / lm_ws_send, after the
// drain), and nothing the drain calls (handle_l3, bgscan_on_frame, the EAPOL replies)
// reaches a TLS write; g_rx_draining turns a violation into a skipped RX instead of a
// clobbered frame. Static rather than on the drain's frame: those 1.6 KB were the
// biggest frame on loopTask's deepest path (stack_bound_test). Was four 1.6 KB buffers.
constexpr uint32_t kRxFrameCap = 1600;
uint8_t g_rxf[kRxFrameCap];
uint8_t g_rx_pt[kRxFrameCap];
bool g_rx_draining = false;

static void pump_link_once() {
  uint32_t n = g_rx_draining ? 0 : ns_mac_recv(g_rxf, sizeof(g_rxf));
  NS_TRACE(if (!g_rx_draining) {  // a skipped RX (see g_rx_draining) is not an empty ring
    if (n == 0) g_ns_rx_stamps.empty_poll_us = ns_now_us();
    else g_ns_rx_stamps.reap_us = ns_now_us();
  });
  if (n > 0 && (g_rxf[0] & 0x0c) == 0x08 && (g_rxf[1] & 0x40)) {  // protected data frame from the AP
    uint32_t pl = 0;
    for (uint32_t trim = 0; trim <= 4 && pl == 0; trim++)
      if (n > trim + 32) pl = ns_sta_decrypt(g_rxf, n - trim, g_rx_pt, sizeof(g_rx_pt));
    if (pl) { note_rx_sa(g_rxf); handle_l3(g_rx_pt, pl); }
  }
  // ALWAYS try to stream the send window out — whether or not a frame arrived. During a
  // TLS write-stall (snd_buf full) the only way it drains is ACKs freeing space + the RTO's
  // go-back-N resend; both need pump_tx to run every spin, not just when RX happens to land.
  uint32_t tn;
  while ((tn = ns_tcp_pump_tx((uint32_t)millis(), tx_ip_slot(), kTxIpCap)) > 0)
    send_ip(tx_ip_slot(), tn);
}

// Write all `len` bytes through TLS. On WANT_WRITE the send window is full — pump the link
// so the peer's ACKs free space (and the RTO's go-back-N resend recovers a lost segment)
// until the write can proceed.
static bool tls_write_all(const uint8_t *buf, size_t len) {
  size_t off = 0;
  uint32_t stall_since = 0;
  while (off < len) {
    int w = mbedtls_ssl_write(&g_ssl, buf + off, len - off);
    if (w > 0) {
      off += w;
      stall_since = 0;  // progress — reset the stall clock
    } else if (w == MBEDTLS_ERR_SSL_WANT_WRITE || w == MBEDTLS_ERR_SSL_WANT_READ) {
      pump_link_once();  // process ACKs (free send-window space) + stream out the window
      // Let the stack's RTO fire while we spin (a lost segment is retransmitted by the stack,
      // not this loop): go-back-N re-sends the window so a stall during a write recovers.
      uint32_t rn = ns_tcp_tick((uint32_t)millis(), tx_ip_slot(), kTxIpCap);
      if (rn > 0) send_ip(tx_ip_slot(), rn);
      // Time-based deadline, not an iteration count: a burst of small replies can legitimately
      // back-pressure for a few RTOs (300ms, backed off), and an iteration cap could trip
      // BEFORE the first RTO even fires — dropping the connection mid-sweep. Give real loss
      // several RTO/backoff cycles to recover before giving up. The clock resets on ANY
      // progress (above), so a slow-but-alive peer never trips it — only ZERO ACKs for the
      // whole window. Bounded to 3s (was 8s): this loop runs on loopTask, so while it spins
      // only pump_link_once's RX is serviced — no main-loop work, no reconnect-accept. A
      // faster give-up caps that deafness (fx_bench saw a fast effect fill the window and a
      // reply-write spin ~8s, going deaf mid-sweep); 3s is still many RTO/backoff cycles.
      uint32_t now = (uint32_t)millis();
      if (stall_since == 0) stall_since = now == 0 ? 1 : now;
      else if (now - stall_since > 3000) return false;  // peer truly vanished
    } else {
      return false;
    }
  }
  return true;
}

// Frame + send one server WS message (unmasked). Header + payload go out as ONE buffer so
// a small reply is a single TLS record / TCP segment (no mid-message stop-and-wait stall):
// the header is written into the `headroom` bytes just before `payload` (the app's tx
// buffer reserves kWsSendHeadroom; a PONG echoes in place in g_ws_rx, behind the client's
// longer masked header). Too little headroom falls back to header, then payload.
// Returns false if the write ultimately failed (tls_write_all gave up on a vanished peer) —
// the caller tears the connection down so the single server slot is freed for the next client
// instead of being held by a dead peer (a wss wedge). Best-effort callers may ignore it.
static bool ws_send(uint8_t opcode, uint8_t *payload, size_t len, size_t headroom) {
  uint8_t hdr[kWsSendHeadroom];
  size_t hn = ws_build_frame_header(opcode, len, hdr);
  if (hn <= headroom) {
    memcpy(payload - hn, hdr, hn);
    return tls_write_all(payload - hn, hn + len);
  }
  if (!tls_write_all(hdr, hn)) return false;
  return len ? tls_write_all(payload, len) : true;
}

// Drive the WS layer once: pull TLS bytes, complete the upgrade, then dispatch any
// complete frames. Returns false if the connection should be torn down.
static bool ws_pump() {
  // Drain EVERY TLS record available this call, not one. mbedtls_ssl_read returns one record's
  // plaintext; a single WS frame (e.g. a set_texture) is ~one record, so reading one per loop()
  // capped inbound throughput at one frame per cooperative render round-robin — well under what
  // the link sustains (the vendor's esp_https_server task processes many frames per render
  // cycle). Loop until WANT_READ (nothing buffered in mbedtls AND nothing new on ns_tcp) so a
  // burst of streamed frames is applied in one iteration and the per-loop overhead amortizes.
  for (int iter = 0; iter < 128; iter++) {
    int r = mbedtls_ssl_read(&g_ssl, g_ws_rx + g_ws_rxlen, sizeof(g_ws_rx) - g_ws_rxlen);
    if (r == MBEDTLS_ERR_SSL_WANT_READ || r == MBEDTLS_ERR_SSL_WANT_WRITE) return true;  // drained
    if (r <= 0) return false;  // close_notify or error
    g_ws_rxlen += r;
    NS_TRACE(g_ns_rx_stamps.decoded_us = ns_now_us());

    if (!g_ws_up) {
      // Wait for the full HTTP upgrade request (ends with a blank line), then 101.
      g_ws_rx[g_ws_rxlen < sizeof(g_ws_rx) ? g_ws_rxlen : sizeof(g_ws_rx) - 1] = 0;
      if (!strstr((char *)g_ws_rx, "\r\n\r\n")) return true;  // headers incomplete
      char key[80];
      // GET /.well-known/splanc.json: the agent discovery manifest (device identity,
      // firmware, protocol features, cert pin, agent bundle). One-shot like the cert page.
      static const char kManifestGet[] = "GET /.well-known/splanc.json";
      if (strncmp((char *)g_ws_rx, kManifestGet, sizeof kManifestGet - 1) == 0 &&
          (g_ws_rx[sizeof kManifestGet - 1] == ' ' || g_ws_rx[sizeof kManifestGet - 1] == '?')) {
        const uint8_t *body = nullptr;
        int bn = lm_agent_manifest_body(device_cert_sha256(), &body);
        char hdr[192];
        int hn = bn > 0 ? snprintf(hdr, sizeof hdr,
                                   "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                                   "Access-Control-Allow-Origin: *\r\nCache-Control: no-store\r\n"
                                   "Content-Length: %d\r\nConnection: close\r\n\r\n", bn)
                        : snprintf(hdr, sizeof hdr,
                                   "HTTP/1.1 500 Internal Server Error\r\n"
                                   "Content-Length: 0\r\nConnection: close\r\n\r\n");
        g_responding = true;
        tls_write_all((const uint8_t *)hdr, hn);
        if (bn > 0) tls_write_all(body, (size_t)bn);
        return false;
      }
      if (!ws_find_key((char *)g_ws_rx, key, sizeof key)) {
        // Not a WebSocket upgrade — this is the browser's plain GET / for the cert-trust
        // landing (the webapp's certApprovalUrl points at https://<host>/). Serve the same
        // one-shot page the vendor's wss_page_handler serves: it postMessages
        // 'ledmapper-cert-ok' to window.opener so the app's popup trust flow closes and
        // reconnects over the now-trusted cert. Without a response the browser got
        // ERR_EMPTY_RESPONSE and the trust flow dead-ended (no postMessage, no return).
        static const char kCertPage[] =
            "<!doctype html><meta charset=utf-8>"
            "<meta name=viewport content='width=device-width,initial-scale=1'>"
            "<title>LED Mapper player</title>"
            "<body style='font-family:system-ui;background:#111;color:#eee;padding:2rem'>"
            "<h2>Certificate accepted \xE2\x9C\x93</h2>"
            "<p>You can close this and return to the LED Mapper app — it connects to "
            "this device directly.</p>"
            "<script>try{if(window.opener)window.opener.postMessage("
            "'ledmapper-cert-ok','*');}catch(e){}</script>";
        char hdr[128];
        int hn = snprintf(hdr, sizeof hdr,
                          "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n"
                          "Content-Length: %u\r\nConnection: close\r\n\r\n",
                          (unsigned)(sizeof kCertPage - 1));
        g_responding = true;  // serving a response now — exempt from the pre-WS 4s wedge gate
        tls_write_all((const uint8_t *)hdr, hn);
        tls_write_all((const uint8_t *)kCertPage, sizeof kCertPage - 1);
        return false;  // one-shot: close after serving so the ~28 KB TLS session frees
      }
      char accept[29];
      ws_accept_key(key, accept);
      char resp[200];
      int n = snprintf(resp, sizeof resp,
                       "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                       "Connection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", accept);
      if (!tls_write_all((const uint8_t *)resp, n)) return false;
      g_ws_up = true;
      g_ws_rxlen = 0;  // the request body ends at the blank line; nothing after it yet
      Serial.println("*** WS UPGRADED — LED Mapper protocol over heapless TLS ***");
      continue;  // keep draining: streamed frames may already be buffered behind the upgrade
    }

    // Parse and dispatch every complete frame currently buffered.
    for (;;) {
      ws_frame_header h;
      int pr = ws_parse_frame_header(g_ws_rx, g_ws_rxlen, &h);
      if (pr > 0) break;       // need more bytes
      if (pr < 0) return false;  // protocol violation
      size_t total = h.header_len + (size_t)h.payload_len;
      if (g_ws_rxlen < total) break;  // full payload not in yet
      uint8_t *payload = g_ws_rx + h.header_len;
      if (h.masked) ws_unmask(payload, h.payload_len, h.mask, 0);
      if (h.opcode == WS_OP_BINARY || h.opcode == WS_OP_CONT) {
        // Hand the message to the SHARED app dispatch (main.cpp): upload-chunk streaming +
        // lm_player_handle + persistence + device-side polling, identical to the vendor ws/wss
        // paths. Returns the reply length; reply bytes are in *reply (the app's tx buffer).
        const uint8_t *reply = nullptr;
        int tn = lm_ws_dispatch(payload, (size_t)h.payload_len, &reply);
        // A reply that can't be delivered means the peer vanished mid-write: tear the
        // connection down (return false) so the poll loop re-listens and frees the slot,
        // rather than silently dropping the reply and holding a dead ESTABLISHED slot.
        // (The reply is the app's writable tx buffer, with headroom — see lm_ws_dispatch.)
        //
        // Except a best-effort live-control reply (a ControlAck, or a legacy set_uniforms'
        // playback_state no client awaits): when the send window can't take it right now,
        // DROP it, like an unsolicited PerfReport. Blocking in tls_write_all would leave
        // every frame behind it unread for up to seconds — exactly the input backlog a
        // knob stream builds (docs/design/live-control.md). A seq'd client whose ack is
        // dropped times out and sends its next update anyway.
        int outcome = tn > 0 && reply ? 1 : 0;
        if (tn > 0 && reply && lm_ws_reply_droppable() &&
            ns_tcp_tx_room() < (size_t)tn + kWsSendHeadroom + 96) {
          tn = 0;
          outcome = 2;
        }
        if (tn > 0 && reply &&
            !ws_send(WS_OP_BINARY, const_cast<uint8_t *>(reply), (size_t)tn, kWsSendHeadroom))
          return false;
        NS_TRACE(if (g_ns_reply_hook) g_ns_reply_hook(outcome));
        (void)outcome;
      } else if (h.opcode == WS_OP_PING) {
        if (!ws_send(WS_OP_PONG, payload, h.payload_len, h.header_len)) return false;
      } else if (h.opcode == WS_OP_CLOSE) {
        return false;
      }
      size_t rest = g_ws_rxlen - total;
      memmove(g_ws_rx, g_ws_rx + total, rest);
      g_ws_rxlen = rest;
    }
  }
  return true;
}

// Push an unsolicited server frame (a PerfReport) over the active TLS/WS, if a client is
// upgraded. Called from the app's perf-report cadence. Best-effort (drops if not connected).
bool netstack_ws_send_frame(uint8_t *data, size_t len) {
  if (!g_tls_hs || !g_ws_up) return false;
  // Best-effort: unsolicited PerfReports must NEVER starve the request/reply path. If the
  // send window doesn't comfortably hold this frame (+ TLS record overhead), drop it — a
  // full window means RPC replies are already queued, and a blocking perf write there
  // wedges tls_write_all long enough for the client to time out and reset (observed as
  // mid-sweep socket drops in fx_bench). A dropped perf sample just means one fewer report.
  if (ns_tcp_tx_room() < len + 96) return false;
  ws_send(WS_OP_BINARY, data, len, kWsSendHeadroom);
  return true;
}
bool netstack_ws_is_open() { return g_tls_hs && g_ws_up; }

} // namespace

bool netstack_ws_send(uint8_t *data, size_t len) { return netstack_ws_send_frame(data, len); }
bool netstack_ws_open() { return netstack_ws_is_open(); }
// Mode-tracking facts (main.cpp's lm_mode_observe snapshot): credentials committed (Improv
// or the wired console) and a DHCP lease held.
bool netstack_creds_ready() { return g_creds_ready; }
bool netstack_leased() { return g_leased; }

void netstack_restore_credentials(const char *ssid, const char *pass) {
  if (!lm_wifi::valid(ssid, pass)) {
    Serial.printf("[wifi] no stored credentials — waiting for Improv / wired PROV\n");
    return;
  }
  strncpy(g_ssid, ssid, sizeof g_ssid - 1);
  g_ssid[sizeof g_ssid - 1] = 0;
  strncpy(g_pass, pass, sizeof g_pass - 1);
  g_pass[sizeof g_pass - 1] = 0;
  g_creds_ready = true;  // join exactly as a wired PROV would (the loop latches the scan)
  g_restore_pending = true;
  g_using_stored = true;
  g_persist.on_restored();
  Serial.printf("[wifi] restored stored credentials (ssid=%s) -> joining\n", g_ssid);
}
// External linkage (g_rekey_serviced lives in the anonymous namespace above but is visible
// in this TU): count of AP group-key rekeys serviced, surfaced in the status line.
uint32_t netstack_rekey_count() { return g_rekey_serviced; }

// Longest gap between two netstack_loop() passes (us) since the last status line: while
// loopTask is away (render holding the CPU, a long TLS write spin, a flash write) nothing
// drains the 16-slot RX ring or the TCP window.
static uint32_t g_loop_gap_max_us = 0;
static uint32_t g_loop_last_us = 0;

int netstack_net_stats(char *buf, size_t cap) {
  uint32_t r[2] = {0, 0}, t[7] = {0, 0, 0, 0, 0, 0, 0};
  ns_mac_rx_stats(r);
  ns_tcp_stats(t);
  uint32_t gap = g_loop_gap_max_us;
  g_loop_gap_max_us = 0;
  return snprintf(buf, cap,
                  "segs=%u ooo=%u dup=%u trunc=%u zwnd=%u rto=%u frx=%u ring_hwm=%u ring_full=%u "
                  "loop_gap_max=%uus",
                  (unsigned)t[0], (unsigned)t[1], (unsigned)t[2], (unsigned)t[3], (unsigned)t[4],
                  (unsigned)t[5], (unsigned)t[6], (unsigned)r[0], (unsigned)r[1], (unsigned)gap);
}

// Bring up the heapless WiFi transport. Call from the app's setup() AFTER the shared player
// init + improv_ble_begin (BLE must init before we hijack the MAC so our radio setup wins).
// Weak default for the app's console hook (netstack_transport.h): the loader has none.
__attribute__((weak)) void netstack_console_hook(const char *, size_t) {}

void netstack_prepare_restart() {
  // OTA-specific (docs/design/ota.md): before a PLANNED restart (the app <-> loader
  // handoff, booting an installed app) say goodbye now — the same sequence-numbered
  // disassoc + deauth the join guard (join_guard.h) sends after an unplanned reset — so
  // the AP has already dropped us when the same MAC comes back, and the next boot's join
  // doesn't wait on the guard.
  if (g_ap_latched) {
    uint8_t f[32];
    for (int i = 0; i < 2; i++) {
      int n = build_disassoc(f);
      ns_mac_send(f, n, 0);
      n = build_deauth(f);
      ns_mac_send(f, n, 0);
      delay(20);
    }
  }
}

static void radio_bringup(bool at_boot);

void netstack_setup() {
  // NON-BLOCKING serial: on the C6 USB-Serial-JTAG, Serial.write BLOCKS when the TX FIFO
  // fills with no host draining the port, which would wedge loopTask mid-association during
  // the HITL provisioning phase (the harness monitors serial only during flash). 0ms TX
  // timeout drops instead of blocks so the stack runs headless. (The app routes its own logs
  // through the non-blocking Log() ring; this covers our direct Serial.printf diagnostics.)
  Serial.setTxTimeoutMs(0);
  uint8_t aesct[16];
  uint32_t aes = ns_aes_selftest(aesct);
  Serial.printf("[netstack] AES self-test: enc=%d dec=%d ct=%02x%02x%02x%02x (want 69c4e0d8)\n",
                aes & 1, (aes >> 1) & 1, aesct[0], aesct[1], aesct[2], aesct[3]);
  if (g_policy.mode == lm_wifi_scan::kModeOffline) {
    // Offline mode (a forward-deployed unit with no AP): the Wi-Fi radio is never started
    // — no scans, no RF, no TLS server heap. BLE + the console stay up; switching the mode
    // back (or provisioning) brings the radio up in place (radio_bringup from the loop).
    Serial.printf("[wifi] offline mode: radio off (BLE + console stay up for reconfiguration)\n");
    return;
  }
  radio_bringup(true);
}

// Start the Wi-Fi radio and hijack the MAC (boot, or later when leaving offline mode).
// `at_boot`: also run the RX sanity check (a 1.2 s diagnostic that would only stall the
// loop task when the radio comes up at runtime).
static void radio_bringup(bool at_boot) {
  if (g_radio_up) return;
  // The BT controller is already up (the app's improv_ble_begin ran first); hijack the MAC
  // last so our heapless RX/g_bssid/force-awake setup wins the shared radio config.
  //
  // We OWN the RX ring (ns_mac_rx_install), so the vendor WiFi driver's default static/dynamic
  // RX buffers are pure waste — and they're DMA-capable, the scarce pool the RMT LED driver +
  // our ring also draw from. Under the full player runtime those allocs FAIL (beacons=0), so
  // init esp_wifi with a minimal RX/TX buffer config instead of Arduino's WiFi.mode defaults.
  //
  // No esp_netif_init(): the heapless netstack owns TCP/IP, so lwIP's tcpip task (tiT,
  // ~5.6 KB of stack + state) would only ever idle. The default event loop IS created —
  // the vendor scan below reports through it — but deleted again once the scan is done
  // (~5.8 KB: the sys_evt task + loop); nothing after the MAC hijack consumes events.
  esp_event_loop_create_default();
  wifi_init_config_t wcfg = WIFI_INIT_CONFIG_DEFAULT();
  // Credentials live in our own store and the driver runs from RAM config only
  // (esp_wifi_set_storage below), so its NVS mirror (~4.4 KB cache) is never read.
  wcfg.nvs_enable = 0;
  wcfg.static_rx_buf_num = 2;    // default 10 — we own the RX ring, minimize the vendor's DMA
  wcfg.dynamic_rx_buf_num = 6;   // default 32
  wcfg.static_tx_buf_num = 2;
  wcfg.ampdu_rx_enable = 0;      // no block-ack reorder buffers (big DMA saving)
  wcfg.ampdu_tx_enable = 0;
  wcfg.rx_ba_win = 0;
  wcfg.cache_tx_buf_num = 0;
  esp_err_t werr = esp_wifi_init(&wcfg);
  esp_wifi_set_storage(WIFI_STORAGE_RAM);
  esp_wifi_set_mode(WIFI_MODE_STA);
  esp_err_t serr = esp_wifi_start();
  Serial.printf("[netstack] esp_wifi_init(min-bufs)=%d start=%d free=%u dma=%u\n", (int)werr,
                (int)serr, (unsigned)esp_get_free_heap_size(),
                (unsigned)heap_caps_get_free_size(MALLOC_CAP_DMA));
  // Station MAC: the chip's factory STA MAC (efuse), stable across reboots/updates so
  // the AP's DHCP keeps our lease (sta_mac.h has why the old per-boot random MAC is now
  // only an opt-in: -DLM_NETSTACK_RANDOM_MAC).
  uint8_t factory_mac[6] = {0};
  esp_read_mac(factory_mac, ESP_MAC_WIFI_STA);
  uint8_t rnd[4]; esp_fill_random(rnd, 4);
  bool factory = lm_sta_mac::choose(factory_mac, lm_sta_mac::random_mac_is_build_default(), rnd,
                                    OUR_MAC);
  g_seq.seed((uint16_t)(rnd[3] | (rnd[0] << 8)));  // a new boot never reuses the last one's
  // Through the Log() ring, not a direct Serial.printf: this is the board's identity line
  // (the stable_identity HITL gate keys on it), and a direct write at the 0 ms TX timeout
  // set above is dropped whole whenever the boot log burst is still draining (tx lock
  // held / HWCDC ring full) — every first boot after an erase on #353's main — or lands
  // spliced inside a half-drained log line. The ring keeps it ordered and delivered.
  Console().printf("MAC %02x:%02x:%02x:%02x:%02x:%02x (%s)\n", OUR_MAC[0], OUR_MAC[1],
                   OUR_MAC[2], OUR_MAC[3], OUR_MAC[4], OUR_MAC[5],
                   factory ? "factory" : "random per boot");
  g_our_mac_ptr = OUR_MAC;
  // Cache every AP in range NOW, while the vendor WiFi RX still works — after the MAC
  // hijack below we own the ring and the vendor scan can't run. scan_latch_ap() (in the
  // loop, once the provisioner gives us the SSID) then picks our AP's real BSSID+channel,
  // so the netstack joins ANY rig's AP, not just the baked rig-3 one.
  wifi_scan_cache();
  esp_err_t lerr = esp_event_loop_delete_default();
  Serial.printf("[netstack] vendor scan done; event loop released=%d free=%u\n", (int)lerr,
                (unsigned)esp_get_free_heap_size());
  // Continuous STA RX with NO promiscuous, so the hardware crypto engine stays inline:
  // stop->start the MAC, configure the STA vif, and force it awake (pm_go_to_wake) so
  // RX is continuous instead of the disconnected duty-cycle. Runs in the WiFi task via
  // the ioctl marshal (heap request, cmd@0/handler@4; the ioctl frees it).
  esp_wifi_set_ps(WIFI_PS_NONE);
  esp_wifi_set_channel(g_chan, WIFI_SECOND_CHAN_NONE);
  delay(150);
#if defined(LM_CHIP_ESP32C3)
  // ESP32-C3 bring-up milestone: everything ABOVE is the chip-agnostic vendor WiFi
  // controller init (esp_wifi_init/start/scan), which comes up fine on the
  // C3. Everything BELOW is the heapless-MAC HIJACK — it pokes the ESP32-C6 WiFi MAC
  // register map directly (firmware/netstack lmac.rs / regs.rs at 0x600A_xxxx) and
  // drives reversed C6 libpp externs. The C3's WiFi MAC lives at a DIFFERENT base, so
  // running the hijack here would write to the wrong (or unmapped) peripherals and
  // fault at boot. That register port is the remaining, deliberately-out-of-scope c3
  // netstack work (see the PR); until it lands, stop after the controller is up so the
  // image boots cleanly on real c3 silicon. The BLE/Improv path and the render loop
  // still run; only the WiFi DATA path is disabled on the C3.
  Serial.printf("[netstack] esp32c3: heapless MAC hijack not yet ported (C6 WiFi MAC "
                "register map @0x600A_xxxx); WiFi data path disabled on c3, controller "
                "up, skipping hijack+TLS.\n");
  return;
#endif
  wreg(WIFI_MAC_INTR_MAP, 0); // detach vendor ISR
  ns_mac_rx_install();
  uint32_t *req = static_cast<uint32_t *>(malloc(24));
  memset(req, 0, 24);
  reinterpret_cast<uint8_t *>(req)[0] = 23;
  req[1] = reinterpret_cast<uint32_t>(&sta_rx_start_handler);
  ieee80211_ioctl(req);
  wreg(WIFI_MAC_INTR_MAP, 0); // re-detach ISR
  mac_own_bssid();            // own-MAC + g_bssid: hardware auto-ACK
  ns_mac_rx_install();        // re-own the RX ring
  esp_wifi_set_channel(g_chan, WIFI_SECOND_CHAN_NONE);
  // Promiscuous / all-frames RX. REQUIRED for protected UNICAST on some APs: with the HW
  // crypto engine off (HW_DECRYPT=false, the SW-CCMP round-trip path), the "real STA accept
  // policy" filter drops individually-addressed protected frames while passing group ones —
  // invisible on the Pi 5 rigs but FATAL on a Pi 3's onboard AP (brcmfmac), where the DUT
  // associated + leased (broadcast DHCP) yet never saw a single unicast frame, so it never
  // answered a TCP SYN (tcpdump: SYN storm, zero SYN-ACK). All-frames RX delivers the
  // unicast RAW to our ring; the software address filter below (A1==our MAC / group, from
  // our BSSID) still scopes it, and the SW CCMP path decrypts it (with the ccmp_nonce TID
  // fix so QoS Data validates). auto-ACK stays keyed on the own-MAC register set above, so
  // association survives. The `sink` no-op keeps the vendor from double-delivering. Verified
  // on both a Pi 3 AP (recovers the SYN) and a Pi 5 AP (no regression).
  esp_wifi_set_promiscuous_rx_cb(&sink);
  esp_wifi_set_promiscuous(true);
  // The vendor driver is a shell from here on (its event loop is gone), so every
  // esp_wifi_set_channel (the background sweeps) logs "failed to post WiFi event" at
  // ERROR — 13 lines a sweep through the console, from the WiFi task (priority 23,
  // above render). Silence the vendor tag; our own [wifi]/[scan] lines say what happens.
  esp_log_level_set("wifi", ESP_LOG_NONE);
  g_radio_up = true;
  if (!at_boot) {
    tls_init();
    Serial.printf("[wifi] radio up (left offline mode)\n");
    return;
  }

  // Sanity: continuous all-frames RX into our ring (promiscuous on; see above).
  uint8_t rx[400];
  uint32_t beacons = 0;
  for (int i = 0; i < 400; i++) {
    uint32_t n = ns_mac_recv(rx, sizeof(rx));
    if (n && rx[0] == 0x80) beacons++;
    delay(3);
  }
  Serial.printf("[netstack] RX sanity (STA vif, promiscuous all-frames, SW CCMP): beacons=%u\n",
                beacons);
  tls_init();
}

enum St { AUTH, ASSOC, FOURWAY, DONE };

// Vendor PM lever (libpp): the counterpart of pm_go_to_wake — releases the hardware force-awake
// so the MAC duty-cycles and the coex silicon can hand radio slots to BLE.
extern "C" void pm_go_to_sleep();

// Activity-driven WiFi/BT coexistence for the single-core C6, which shares one 2.4 GHz radio.
// The netstack force-awakes the MAC (pm_go_to_wake in sta_rx_start_handler) for continuous RX,
// because our stack does NOT implement connected-mode power-save (no TIM/PS-poll) and would miss
// buffered downlink if the MAC slept. But that force-awake pins the shared radio to WiFi and
// starves the BLE controller's connection events.
//
// The failure this fixes (root-caused on rig-2 via a BLE link-state trace): during the ~3-5s WiFi
// join (assoc + 4-way + DHCP) the force-awake MAC starves BLE so completely that the central's
// supervision timer expires and it DROPS the link ~2s in — BEFORE the DHCP lease, so the Improv
// redirect (gated on a connected central) is never even sent, and provisioning times out.
//
// The C6's native coex (enabled by the vendor BT controller) protects BLE by TIME-SLICING the WiFi
// MAC off the radio; our force-awake (for continuous RX, since we do no connected-mode power-save)
// suppresses that, so the ESP-IDF coex knobs are no-ops and BLE would be starved. So while a BLE
// central is connected we duty-cycle the radio ourselves via the vendor PM force-awake toggle
// (pm_go_to_sleep/pm_go_to_wake — the only lever that reaches the coex silicon).
//
// The amount handed to BLE is PHASE-AWARE. The provisioning join has two very different phases:
//   1. PMK derivation (PBKDF2 c=4096, ~1.8s) — this is PURE CPU; association is gated until it
//      finishes (see the ns_pmk_ready() gate on the auth send), so WiFi needs almost no radio.
//      Hand BLE the lion's share so the link is rock-solid going into the join.
//   2. Association + DHCP + session — WiFi is actively on-air; give BLE a ~20% keep-alive slice,
//      enough to service its connection events (reset the supervision timer) without stalling the
//      join. (This ~20% was reliable ONCE the 1.8s PBKDF2 freeze that used to sabotage it — a
//      synchronous derive on the loop — was moved off the hot path via ns_pmk_step.)
// With NO central connected the MAC stays fully force-awake, so a streaming session is unaffected.
//
// This runs on a high-frequency esp_timer (COEX_TICK_US, in the high-priority esp_timer TASK — task
// context, so calling the vendor PM lever is safe, unlike a raw ISR) rather than being polled once
// per netstack_loop. The loop's ~22ms period was too coarse to time the BLE yield; a 4ms tick lets
// us place a SHORT slice precisely. Decoupled from the loop, it keeps ticking through the RX drain
// and the PMK chunks.
//
// The WiFi-active join needs the slice ALIGNED to the BLE connection event: a fixed-phase duty-cycle
// (measured 0/3) misses, because the event interval (50ms) and any fixed tick period aren't harmonic
// so the event drifts through the gaps. So predict the event anchors from the negotiated interval
// (improv_ble_conn_interval) and the last inbound-ACL timestamp (improv_ble_last_acl_ms — every ACL
// rides a connection event, a hard phase anchor) and yield BLE in a window STRADDLING each predicted
// anchor, wide enough (+-7ms) to absorb the controller's delivery offset and clock drift so the
// event is always covered. During PMK derivation WiFi is idle, so just hand BLE ~80% (no alignment
// needed). Falls back to a fine fixed duty-cycle only until a phase lock exists.
static const uint32_t COEX_TICK_US = 4000;  // 4ms
static void coex_timer_cb(void *) {
  static int mode = 0;  // 0 = MAC force-awake (WiFi), 1 = MAC asleep (BLE owns the slice)
  // Offline at runtime: the MAC was released to sleep (netstack_set_wifi_policy) — keep
  // it there (no force-awake), BLE has the radio.
  if (g_silent) {
    mode = 1;
    return;
  }
  // Normal coex: yield the radio to BLE only around a LIVE connection's events. The
  // vestigial post-provision link that used to steal airtime here is now torn down
  // gracefully the moment a wss client appears (see netstack_loop), so there's no dead
  // link to yield to — and a fresh central that reconnects still gets its slice.
  if (!improv_ble_central_connected()) {
    if (mode != 0) { pm_go_to_wake(); mode = 0; }
    return;
  }
  uint32_t now = millis();
  int want;
  if (g_creds_ready && !ns_pmk_ready()) {
    want = ((now % 20) < 16) ? 1 : 0;  // PMK derive (WiFi idle): ~80% to BLE, no alignment needed
  } else {
    uint32_t iv_u = improv_ble_conn_interval();  // 1.25ms units
    uint32_t anchor = improv_ble_last_acl_ms();
    if (iv_u >= 12 && anchor) {
      uint32_t iv = iv_u + (iv_u >> 2);          // *1.25 -> ms (e.g. 40 units = 50ms)
      uint32_t phase = (now - anchor) % iv;      // 0 == a predicted connection-event anchor
      want = (phase <= 7 || (iv - phase) <= 7) ? 1 : 0;  // +-7ms window straddling the anchor
    } else {
      want = ((now % 16) < 4) ? 1 : 0;           // no phase lock yet: fine fixed duty-cycle
    }
  }
  if (want == mode) return;
  if (want == 1) pm_go_to_sleep();  // release the force-awake so BLE gets its slice
  else pm_go_to_wake();             // reclaim the radio for WiFi RX
  mode = want;
}

// Service the transport once per app loop(): RX drain + on_ip + DHCP + BLE-Improv join +
// TLS handshake + WS pump (dispatched via lm_ws_dispatch). Non-blocking; returns quickly.
// A provision for a DIFFERENT network (wired PROV / BLE Improv kJoin): the lease, TCP and
// TLS/WS state belonged to the old network. Without this a board that had leased once kept
// g_leased set, so on the new network it never ran DHCP (and BLE answered the redirect with
// the OLD IP) — e.g. re-provisioning a board away from a network that has gone, or from
// mistyped credentials back to the right ones. Mirrors the deauth re-join reset.
static void drop_link_for_new_network() {
  g_leased = false;
  g_have_offer = false;
  g_tcp_started = false;
  if (TLS_SERVER) {
    tls_session_reset();
    g_tls_hs = false;
    g_ws_up = false;
    g_responding = false;
    g_ws_rxlen = 0;
  }
  g_bio_tx = g_bio_rx = 0;
}

// New credentials (wired PROV / BLE Improv) are the user's intent to join: an offline
// board brings its radio up and goes back to auto (the app persists the change); a
// manual board opens a join window. Credentials themselves are never dropped by a mode.
static void on_provisioned() {
  if (g_policy.mode == lm_wifi_scan::kModeOffline) {
    g_policy.mode = lm_wifi_scan::kModeAuto;
    g_policy_changed = true;
    Serial.printf("[wifi] provisioned while offline -> mode auto\n");
  }
  if (g_silent) {
    g_silent = false;
    pm_go_to_wake();
  }
  if (!g_radio_up) radio_bringup(false);
  if (g_policy.mode == lm_wifi_scan::kModeManual)
    g_window_until = (uint32_t)millis() + lm_wifi_scan::kJoinWindowMs;
}

void netstack_set_wifi_policy(const NetstackWifiPolicy *p) {
  if (!p) return;
  lm_wifi_scan::Policy np;
  np.mode = p->mode <= lm_wifi_scan::kModeOffline ? p->mode : lm_wifi_scan::kModeAuto;
  np.cap_s = p->scan_cap_s;
  np.interval_s = p->interval_s;
  np.decay_h = p->decay_after_h;
  np.sparse_s = p->sparse_interval_s;
  bool to_offline = np.mode == lm_wifi_scan::kModeOffline && g_policy.mode != np.mode;
  bool from_offline = g_policy.mode == lm_wifi_scan::kModeOffline && np.mode != g_policy.mode;
  g_policy = np;
  g_scan_sched.due(false, 0);  // the next need re-arms under the new rules
  if (to_offline && g_radio_up) {
    // Go silent now: say goodbye to the AP, drop the link, stop sweeping, release the
    // MAC to sleep. The radio is fully off from the next boot (offline is persisted);
    // the board never reboots for it.
    netstack_prepare_restart();
    g_link_reset_pending = true;
    bgscan_cancel();
    g_silent = true;
    pm_go_to_sleep();
    Serial.printf("[wifi] offline mode: Wi-Fi silent now (no scans, no TX), radio off from the "
                  "next boot; credentials kept\n");
  } else if (from_offline && g_radio_up && g_silent) {
    g_silent = false;
    pm_go_to_wake();
    Serial.printf("[wifi] leaving offline mode: rejoining\n");
  } else if (from_offline && !g_radio_up) {
    // Booted offline (radio never started): bring it up in place now.
    Serial.printf("[wifi] leaving offline mode: starting the radio\n");
    radio_bringup(false);
  }
  if (g_policy.mode != lm_wifi_scan::kModeManual) g_window_until = 0;
}

void netstack_wifi_rejoin() {
  if (g_policy.mode == lm_wifi_scan::kModeOffline) {
    Serial.printf("[wifi] rejoin ignored: offline mode (switch the mode first)\n");
    return;
  }
  if (g_policy.mode == lm_wifi_scan::kModeManual)
    g_window_until = (uint32_t)millis() + lm_wifi_scan::kJoinWindowMs;
  if (!g_radio_up) radio_bringup(false);
  g_scan_sched.kick((uint32_t)millis());
  if (!g_scan_matched) g_force_sweep = true;
  Serial.printf("[wifi] rejoin requested%s\n",
                g_policy.mode == lm_wifi_scan::kModeManual ? " (manual: 2 min join window)" : "");
}

bool netstack_take_policy_change(NetstackWifiPolicy *out) {
  if (!g_policy_changed || !out) return false;
  g_policy_changed = false;
  out->mode = g_policy.mode;
  out->scan_cap_s = g_policy.cap_s;
  out->interval_s = g_policy.interval_s;
  out->decay_after_h = g_policy.decay_h;
  out->sparse_interval_s = g_policy.sparse_s;
  return true;
}

// A network is "expected" only when the policy lets the board join on its own AND the
// network was actually seen this boot. An AP that is simply absent (a unit moved to the
// field right after an update) is no evidence against a fresh image, so the OTA health
// check must not hold the missing lease against it; an AP that IS there but can't be
// joined is, and still rolls a broken image back.
bool netstack_wifi_wants_network() { return autonomous((uint32_t)millis()) && g_seen_this_boot; }

bool netstack_service_due() {
  if (!g_radio_up) return false;
  bool rx = ns_mac_rx_pending() != 0;
  // An empty poll here is an empty-ring observation like netstack_loop's own (the trace
  // attributes a frame's ring wait from the last empty poll before its reap).
  NS_TRACE(if (!rx) g_ns_rx_stamps.empty_poll_us = ns_now_us());
  // Data still in the send window: only netstack_loop streams it out and runs its RTO
  // (a lost ControlAck is resent from ns_tcp_tick), so it must not wait for the frame end.
  return rx || (g_tcp_started && ns_tcp_tx_pending() != 0);
}

bool netstack_data_plane_active() {
  if (!(g_radio_up && !g_silent && g_leased && !g_hop.active() && ns_pmk_ready())) return false;
  if (g_tls_hs && g_ws_up) return true;  // a live wss session
  // A client on the :443 slot that isn't streaming yet: mid-accept (SynRcvd), mid-TLS
  // handshake / WS upgrade (Established), or a one-shot GET being served. A NEW client's
  // handshake (~0.5 s of ECDHE/ECDSA CPU) must not live on render's leftovers: below
  // render it only ran in the sleeps between frames, and under a near-budget effect it
  // never finished inside a client's timeout — no session, so the loop never rose
  // (1.12.3 field: players stayed unreachable). A stalled handshake is reclaimed after
  // 4 s without progress (netstack_loop), so this can't pin the loop up.
  if (!g_tcp_started) return false;
  uint32_t s = ns_tcp_state();
  return s == 2 || s == 6 || g_responding;
}

void netstack_set_unseen_base(uint32_t seconds) { g_unseen_base_s = seconds; }

void netstack_wifi_status(NetstackWifiStatus *o) {
  if (!o) return;
  memset(o, 0, sizeof *o);
  uint32_t now = (uint32_t)millis();
  bool joined = g_leased && !g_authenticating;
  if (!g_radio_up || g_silent) o->state = 1;           // OFFLINE
  else if (!g_creds_ready) o->state = 2;               // UNPROVISIONED
  else if (joined) o->state = 6;                       // JOINED
  else if (!autonomous(now)) o->state = 3;             // IDLE (manual, no window)
  else if (g_scan_matched && !g_hop.active()) o->state = 5;  // JOINING
  else o->state = 4;                                   // SEARCHING
  o->radio_on = g_radio_up && !g_silent;
  o->decayed = g_scan_decayed && !joined;
  if (o->state == 4 && g_scan_sched.armed() && !g_hop.active()) {
    int32_t d = (int32_t)(g_scan_sched.next_ms() - now);
    o->next_scan_s = d > 0 ? (uint32_t)(d + 999) / 1000u : 0;
  }
  o->scans = joined ? 0 : g_scan_sched.attempt();
  o->unseen_s = joined ? 0 : unseen_s();
  if (g_creds_ready) memcpy(o->ssid, g_ssid, sizeof o->ssid);
  o->ssid[32] = 0;
}

void netstack_loop() {
  {
    uint32_t now_us = (uint32_t)micros();
    if (g_loop_last_us != 0 && now_us - g_loop_last_us > g_loop_gap_max_us)
      g_loop_gap_max_us = now_us - g_loop_last_us;
    g_loop_last_us = now_us;
  }
  static St st = AUTH;
  static uint32_t t = 0;
  static bool inited = false;
  if (g_link_reset_pending) {  // offline at runtime: forget the join (netstack_set_wifi_policy)
    g_link_reset_pending = false;
    st = AUTH;
    inited = false;
    t = 0;
    drop_link_for_new_network();
  }
  g_authenticating = st == AUTH;
  // Start the high-frequency coex tick once (defined above; the vendor PM lever it calls is only
  // declared after netstack_setup, so arm it here on the first loop rather than in setup).
  static esp_timer_handle_t coex_timer = nullptr;
  if (!coex_timer && g_radio_up) {
    esp_timer_create_args_t a = {};
    a.callback = &coex_timer_cb;
    a.dispatch_method = ESP_TIMER_TASK;
    a.name = "coex";
    if (esp_timer_create(&a, &coex_timer) == ESP_OK)
      esp_timer_start_periodic(coex_timer, COEX_TICK_US);
  }
  // Service the heapless BLE host (drain the controller's HCI queue, run the Improv
  // GATT state machine). No-op after onboarding once the central disconnects.
  improv_ble_poll();
  // Drain + reply to any player-protocol frame received over the BLE transport
  // (offline configuration). Must follow improv_ble_poll, which pumps the HCI
  // packets that feed the RX reassembler.
  player_ble_poll();
  // NB: WiFi/BT coex arbitration runs on its own high-frequency esp_timer (coex_timer_cb), not here
  // — the ~22ms loop period was too coarse to time the BLE-yield slices. See coex_timer_cb.
  // Advance the incremental PMK derivation a small chunk per loop (once creds arrive). 64 HMAC-
  // SHA1s is ~14ms — under a BLE connection interval — so improv_ble_poll above keeps the link
  // alive between chunks instead of the loop freezing ~1.8s in one synchronous PBKDF2 (which was
  // the real cause of the rig-2 provisioning flake: a mid-join loop stall dropped the BLE link).
  if (g_restore_pending) {  // boot-restored creds: start the PMK like a PROV does
    g_restore_pending = false;
    ns_pmk_begin((const uint8_t *)g_ssid, strlen(g_ssid), (const uint8_t *)g_pass, strlen(g_pass));
  }
  // (Only with the radio up: offline mode has no use for it until it joins.)
  //
  // Measured on hitl-rig-2 (wifi_cadence, logic analyzer on the strip): when the loop ran
  // at the render task's priority these ~14 ms PBKDF2 chunks were time-sliced 1:1
  // against rendering for the ~2 s a derivation takes — a heavy effect's frames
  // stretched 184 -> 196 ms, a light one's 13 -> 16 ms, on every new provision /
  // wrong-PSK retry. The player now runs the whole loop below render (main.cpp); the
  // derivation additionally drops one more level, so it is the first thing to yield.
  if (g_radio_up && g_creds_ready && !ns_pmk_ready()) {
    UBaseType_t prio = uxTaskPriorityGet(nullptr);
    if (prio > tskIDLE_PRIORITY + 1) vTaskPrioritySet(nullptr, prio - 1);
    ns_pmk_step(64);
    vTaskPrioritySet(nullptr, prio);
  }
  // rx must hold a FULL MPDU: ns_mac_recv truncates to cap, and a truncated frame fails
  // CCMP's MIC (silently dropped, no ACK) — which stalled inbound data segments >~360B
  // (e.g. a 410-byte TLS ClientHello -> ~498-byte MPDU) while small control frames passed.
  // It is the shared static g_rxf (see pump_link_once), not a stack array.
  uint8_t f[256];
  uint8_t *const rx = g_rxf;

  // Keep own-MAC valid the whole time so hardware auto-ACK stays on (no retransmit
  // storm). Post-link we DISABLE the HW crypto engine (CTRL0=0) so the MAC passes
  // protected unicast to us raw — no HW-decrypt attempt, no drop — for software CCMP
  // decap, while still auto-ACKing. (Set once on entering DONE.)
  if (g_radio_up) mac_own_bssid();
  // Post-link: HW crypto stays ENABLED (install_hw_key replicated the vendor's
  // connected-STA crypto state) so the MAC hardware-decrypts protected unicast to us
  // and delivers plaintext (handled by the g_hwkey branch).

  // Drain up to N frames per loop() so a burst (e.g. dnsmasq's DHCP retransmits) can't
  // fill the fixed RX ring and drop an inbound SYN/data segment before we service it.
  uint32_t n = 0;
  int drained = 0;
  g_rx_draining = true;
  while (g_radio_up && drained++ < 32 && (n = ns_mac_recv(rx, kRxFrameCap)) > 0) {
  NS_TRACE(g_ns_rx_stamps.reap_us = ns_now_us());
  bgscan_on_frame(rx, n);  // a background sweep listens to every BSS (wifi_scan.h)
  // Broad DONE-state RX trace: what frames actually reach our ring post-link?
  static uint32_t allf = 0;
  if (st == DONE && n >= 10 && allf < 30) {
    allf++;
    Serial.printf("  rx fc=%02x%02x a1=%02x:%02x:%02x len=%u\n", rx[0], rx[1], rx[4], rx[5], rx[6], n);
  }
  // Diagnostic: after we enter FOURWAY, log every frame from the AP addressed to us
  // (any FC), so we can see whether M3 (a data frame) actually reaches our ring.
  static uint32_t apf = 0;
  if (st == FOURWAY && n >= 16 && memcmp(rx + 4, OUR_MAC, 6) == 0 &&
      (memcmp(rx + 10, g_bssid, 6) == 0 || memcmp(rx + 16, g_bssid, 6) == 0)) {
    if (apf++ < 12) Serial.printf("  AP->us fc=%02x%02x len=%u\n", rx[0], rx[1], n);
  }
  // Accept frames addressed to us (A1 == our MAC) OR group-addressed (A1 I/G bit set:
  // broadcast/multicast), as long as they come from our AP (A2 == BSSID) — or, for the
  // legacy unicast path, A3 == BSSID. The group-addressed case is essential: a commercial
  // AP returns the DHCP OFFER (and ARPs for our IP, and floods IPv4 multicast) as a
  // BROADCAST data frame with A1 = ff:ff:ff:ff:ff:ff, which the old A1==OUR_MAC-only gate
  // silently dropped before it could reach the GTK decrypt path below — assoc + 4-way OK,
  // DISCOVER ACKed, but the OFFER we requested (broadcast flag, build_dhcp) was thrown away
  // unread. The rig's dnsmasq unicast the OFFER to us, which masked this everywhere.
  bool a1_us = memcmp(rx + 4, OUR_MAC, 6) == 0;
  bool a1_group = (rx[4] & 0x01) != 0;
  if (n >= 24 && (a1_us || a1_group) &&
      (memcmp(rx + 10, g_bssid, 6) == 0 || memcmp(rx + 16, g_bssid, 6) == 0)) {
    if (rx[0] == 0xb0 && st == AUTH) { // auth resp
      uint16_t status = rx[28] | (rx[29] << 8);
      g_authw.on_auth_response();
      g_improv_scan.on_ap_answered();  // it's on the air: no Improv not-found report
      if (status == 0) {
        int a = build_assoc(f); ns_mac_send(f, a, 0); st = ASSOC; t = millis();
        Serial.printf("[t=%lu] auth ok -> assoc\n", (unsigned long)millis());
      } else {
        static uint32_t arl = 0;
        if (arl++ < 8) Serial.printf("[t=%lu] auth refused status=%u\n", (unsigned long)millis(), status);
      }
    } else if (rx[0] == 0x10 && st == ASSOC) { // assoc resp
      uint16_t status = rx[26] | (rx[27] << 8);
      Serial.printf("assoc status=%u\n", status);
      if (status == 0) { st = FOURWAY; t = millis(); Serial.println("ASSOCIATED -> 4-way"); }
    } else if ((rx[0] == 0xc0 || rx[0] == 0xa0) && st == AUTH) {
      // The AP tearing down (its view of) our old association while we try to re-auth:
      // log it (rate-limited) — it says the AP heard us and dropped the stale station.
      static uint32_t adl = 0;
      if (adl++ < 8)
        Serial.printf("[t=%lu] [join] AP %s (reason=%u) while authenticating\n", (unsigned long)millis(),
                      rx[0] == 0xc0 ? "deauth" : "disassoc",
                      (unsigned)((n >= 26) ? (rx[24] | (rx[25] << 8)) : 0));
    } else if ((rx[0] == 0xc0 || rx[0] == 0xa0) && st != AUTH) { // deauth / disassoc from our AP
      // The AP dropped us mid-session (missed beacons under heavy FULL-perf render load,
      // an AP inactivity/keepalive timeout, roaming, or RF). Nothing used to handle this:
      // `st` stayed DONE, so TX kept going into the void and RX was dead — we never
      // re-joined, so the board rendered on but was PERMANENTLY UNREACHABLE and never
      // rebooted. This is the fx_bench "board unreachable" wedge, confirmed via a
      // non-resetting serial capture (frames kept logging + PINGs went out but zero
      // replies came back). Re-drive the join from AUTH — the PMK is cached, so
      // re-auth/assoc/4-way is quick — and reset the now-dead lease + TCP/TLS/WS so the
      // server re-listens on the fresh link.
      uint16_t reason = (n >= 26) ? (uint16_t)(rx[24] | (rx[25] << 8)) : 0;
      Serial.printf("[t=%lu] *** WiFi %s (reason=%u) — re-joining ***\n",
                    (unsigned long)millis(), rx[0] == 0xc0 ? "DEAUTH" : "DISASSOC", reason);
      st = AUTH;
      inited = false;
      t = 0;
      g_leased = false;
      g_tcp_started = false;
      if (TLS_SERVER) {
        tls_session_reset();
        g_tls_hs = false;
        g_ws_up = false;
        g_responding = false;
        g_ws_rxlen = 0;
      }
      g_bio_tx = g_bio_rx = 0;
    } else if ((rx[0] & 0x0c) == 0x08 && st == FOURWAY) { // EAPOL data
      const uint8_t *eb; int el = eapol_body(rx, n, &eb);
      if (el > 4) {
        if (!inited) {
          if (!ns_pmk_ready()) {
            // The PMK (PBKDF2 c=4096) is still deriving off the hot path (ns_pmk_step above).
            // Do NOT init the supplicant here — ns_wpa_init would then derive it synchronously and
            // FREEZE the loop ~1.8s, dropping the BLE link mid-join (the rig-2 flake). Skip this
            // M1; the AP retransmits EAPOL-M1 until we answer, by which point the PMK is ready.
            static uint32_t waitlog = 0;
            if (millis() - waitlog > 500) { waitlog = millis();
              Serial.printf("[t=%lu] 4-way: PMK deriving, deferring M2 (AP retransmits M1)\n", (unsigned long)millis()); }
            continue;
          }
          uint8_t sn[32]; esp_fill_random(sn, 32);
          ns_wpa_init((const uint8_t *)g_ssid, strlen(g_ssid), (const uint8_t *)g_pass, strlen(g_pass), g_bssid, OUR_MAC, sn);
          inited = true;
        }
        uint8_t e[256]; int elen = el; memcpy(e, eb, elen);
        int exact = 4 + ((e[2] << 8) | e[3]); if (exact > 0 && exact <= elen) elen = exact;
        uint16_t kinfo = (e[5] << 8) | e[6]; // 802.1X(4) + desc_type(1) then key_info BE
        uint32_t dg = ns_wpa_diag(e, elen);
        Serial.printf("4-way: diag=%02x (parse=%u mic=%u install=%u ack=%u secure=%u micok=%u)\n",
                      dg & 0xff, dg & 1, (dg >> 1) & 1, (dg >> 2) & 1, (dg >> 3) & 1,
                      (dg >> 4) & 1, (dg >> 5) & 1);
        uint8_t reply[160];
        uint32_t r = ns_wpa_on_eapol(e, elen, reply, sizeof(reply));
        uint32_t code = r >> 16, rl = r & 0xffff;
        Serial.printf("4-way: EAPOL %dB key_info=%04x -> code=%u reply=%u\n", elen, kinfo, code, rl);
        if (code >= 1 && rl > 0) {
          int dl = build_eapol_data(f, reply, rl);
          ns_mac_send(f, dl, 0);
          delayMicroseconds(500);
          static bool once = false;
          if (!once) { once = true; dump_txstat("eapol-good"); } // baseline: this TX succeeds
          for (int k = 0; k < 2; k++) { delay(3); ns_mac_send(f, dl, 0); }
        }
        if (code == 2) {
          st = DONE;
          Serial.printf("[t=%lu] *** 4-WAY COMPLETE — CCMP KEYS INSTALLED, LINK UP ***\n", (unsigned long)millis());
          install_hw_key(); // program HW slot so auto-ACK + HW decrypt coexist
        }
      }
    } else if ((rx[0] & 0x0c) == 0x08 && (rx[1] & 0x40) && st == DONE) {
      // Protected data frame from the AP: CCMP-decrypt and look for a DHCP reply.
      // The RX frame carries a trailing 4-byte FCS that would corrupt CCMP's MIC
      // (it lives in the last 8 bytes), so trim it before decap.
      uint8_t *const pt = g_rx_pt;  // shared with pump_link_once (never nested)
      // The RX MPDU has no trailing FCS here, so decap over the full length; fall
      // back to an FCS-trimmed length in case a driver variant appends one.
      // The RX hardware pads odd-length MPDUs to even (and some paths append a 4-byte
      // FCS), so frame_len can be 1-4 bytes longer than the real MPDU — which makes CCMP
      // over-read the ciphertext and fail the MIC. Try trimming 0..4 trailing bytes until
      // the MIC validates. (Was: only n and n-4, which missed the odd->even +1 pad.)
      uint32_t pl = 0;
      for (uint32_t trim = 0; trim <= 4 && pl == 0; trim++) {
        if (n > trim + 32) pl = ns_sta_decrypt(rx, n - trim, pt, kRxFrameCap);
      }
      static uint32_t pf = 0;
      if (pf++ < 8)
        Serial.printf("  prot AP->us fc=%02x%02x len=%u ccmp@24=[%02x %02x %02x %02x] decrypt=%u\n",
                      rx[0], rx[1], n, rx[24], rx[25], rx[26], rx[27], pl);
      note_rx_sa(rx);
      handle_l3(pt, pl);
    } else if ((rx[0] & 0x0c) == 0x08 && !(rx[1] & 0x40) && st == DONE && g_hwkey && n > 32) {
      // HW-decrypted data frame from the AP (Protected bit cleared, CCMP header
      // stripped by hardware): the LLC/SNAP + L3 payload follows the 24-byte header.
      static uint32_t hwf = 0;
      if (hwf++ < 6) Serial.printf("  HW-DECRYPTED fc=%02x%02x len=%u llc=[%02x %02x .. %02x %02x]\n",
                                   rx[0], rx[1], n, rx[24], rx[25], rx[30], rx[31]);
      note_rx_sa(rx);
      handle_l3(rx + 24, n - 24);
    }
  }
  } // end RX drain loop
  g_rx_draining = false;
  NS_TRACE(if (n == 0) g_ns_rx_stamps.empty_poll_us = ns_now_us());

  // Commit WiFi credentials before associating. Two runtime provisioning paths, no baked creds:
  //  (1) BLE Improv — the provisioner writes wifi-settings over GATT (handled below); and
  //  (2) wired serial — the rig writes "PROV <ssid> <pass>\n" to the DUT's USB-serial console
  //      (see just below), the no-BLE HITL path that replaced the old baked rig creds.
  // (Association coexists fine with an active BLE link — the earlier "join timeout" was NOT
  //  coex but blocking Serial.printf wedging loopTask when the port wasn't drained; see
  //  Serial.setTxTimeoutMs(0) in setup. Either association order works now.)
  //
  // Wired provisioning: read the DUT's USB-serial console for a "PROV <ssid> <pass>" line and
  // commit exactly like the BLE take path (re-latch the scan cache, restart the join from AUTH,
  // derive the PMK off the hot path). Reads are non-blocking and independent of the async log
  // drain task's writes, so this can't stall the render loop. Unmatched input is ignored.
  if (PLAYER_MODE) {
    static char pbuf[128];
    static uint8_t plen = 0;
    while (Serial.available() > 0) {
      int c = Serial.read();
      if (c < 0) break;
      if (c == '\n' || c == '\r') {
        pbuf[plen] = '\0';
        char *sp;
        if (plen > 5 && strncmp(pbuf, "PROV ", 5) == 0 &&
            (sp = strchr(pbuf + 5, ' ')) != nullptr) {
          *sp = '\0';
          const char *nssid = pbuf + 5, *npass = sp + 1;
          // The network we're already on / already joining (a board that rejoined from
          // its stored creds, then got PROV'd again by a harness) is a no-op: tearing the
          // link down would only re-run auth/4-way/DHCP. The re-received line carries the
          // IP so a provisioner still learns where we are without a fresh lease line.
          // (Wired PROV only — BLE Improv always starts a fresh join, see below.)
          lm_wifi::Provision pa = lm_wifi::on_provision(g_creds_ready, g_leased, g_ssid, g_pass,
                                                        nssid, npass);
          if (pa == lm_wifi::Provision::kKeepJoined) {
            Serial.printf("[t=%lu] [wire] PROV received (ssid=%s) — already joined, link kept; "
                          "PROV re-received at IP %u.%u.%u.%u\n", (unsigned long)millis(),
                          nssid, g_offer_ip[0], g_offer_ip[1], g_offer_ip[2], g_offer_ip[3]);
          } else if (pa == lm_wifi::Provision::kKeepJoining) {
            Serial.printf("[t=%lu] [wire] PROV received (ssid=%s) — already joining that "
                          "network, join continues\n", (unsigned long)millis(), nssid);
          } else {
            strncpy(g_ssid, nssid, sizeof g_ssid - 1);
            strncpy(g_pass, npass, sizeof g_pass - 1);
            g_ssid[sizeof g_ssid - 1] = 0;
            g_pass[sizeof g_pass - 1] = 0;
            g_creds_ready = true;
            g_using_stored = false;
            g_persist.on_committed();  // written to NVS once this network leases
            g_improv_join.forget();    // the next Improv write is fresh, whatever it carries
            g_improv_scan.cancel();    // and owes the Improv central no not-found report
            g_ap_latched = false;  // re-latch THIS SSID's BSSID/channel from the scan cache
            st = AUTH;             // restart the join from AUTH (mirrors the BLE take path)
            inited = false;        // the 4-way re-inits for the new AP / PMK
            drop_link_for_new_network();
            on_provisioned();
            ns_pmk_begin((const uint8_t *)g_ssid, strlen(g_ssid), (const uint8_t *)g_pass,
                         strlen(g_pass));
            Serial.printf("[t=%lu] [wire] PROV received (ssid=%s) -> associating\n",
                          (unsigned long)millis(), g_ssid);
          }
        } else if (plen >= 5 && strncmp(pbuf, "WIFI ", 5) == 0) {
          // Link diagnostics on the console (the HITL wifi_cadence gate drives each
          // recovery path on demand to time the LED output across it):
          //   WIFI SCAN    run one background sweep now
          //   WIFI DHCP    drop the lease and re-DISCOVER (the DHCP retry path)
          //   WIFI GIVEUP  re-join through the random-MAC fallback (stable-address loss)
          //   WIFI SCANMISS <n>  the next n sweeps hear nothing (0 clears): the HITL
          //                improv_fresh_join gate's "AP not seen by the first sweeps"
          // Anything else goes to the app's console hook (Wi-Fi policy: WIFI MODE …).
          const char *arg = pbuf + 5;
          uint32_t nowc = (uint32_t)millis();
          if (strcmp(arg, "SCAN") == 0) {
            g_force_sweep = true;
            Serial.printf("[t=%lu] [wifi] console: sweep requested\n", (unsigned long)nowc);
          } else if (strcmp(arg, "DHCP") == 0) {
            drop_link_for_new_network();
            Serial.printf("[t=%lu] [wifi] console: lease dropped -> re-DISCOVER\n",
                          (unsigned long)nowc);
          } else if (strncmp(arg, "SCANMISS ", 9) == 0) {
            g_scan_blind = (uint32_t)strtoul(arg + 9, nullptr, 10);
            Serial.printf("[t=%lu] [wifi] console: the next %lu sweep(s) hear nothing\n",
                          (unsigned long)nowc, (unsigned long)g_scan_blind);
          } else if (strcmp(arg, "GIVEUP") == 0) {
            st = AUTH;
            inited = false;
            t = 0;
            drop_link_for_new_network();
            g_force_giveup = true;
            Serial.printf("[t=%lu] [wifi] console: re-joining via the random-MAC fallback\n",
                          (unsigned long)nowc);
          } else {
            netstack_console_hook(pbuf, plen);
          }
        }
        plen = 0;
      } else if (plen < sizeof(pbuf) - 1) {
        pbuf[plen++] = (char)c;
      } else {
        plen = 0;  // oversized line — drop it
      }
    }
  }
  // Log BLE link-state transitions (e.g. 7->6 = central dropped). A drop while leased==0 means the
  // link died mid-join before we could send the Improv redirect — the failure the PMK-off-the-hot-
  // path + coex duty-cycle defend against; low-noise telemetry (fires only on change, not per loop).
  {
    static uint32_t diag_last_state = 999;
    uint32_t st_now = ns_ble_state();
    if (st_now != diag_last_state) {
      Serial.printf("[t=%lu] [ble] link state=%lu connected=%d leased=%d\n",
                    (unsigned long)millis(), (unsigned long)st_now,
                    improv_ble_central_connected(), g_leased ? 1 : 0);
      diag_last_state = st_now;
    }
  }
  if (!PLAYER_MODE) g_creds_ready = true;  // non-player transport demo associates immediately
  // As soon as the SSID is committed, latch the AP's real BSSID + channel from the scan
  // cache (once) BEFORE the first auth — so auth/assoc go out on the right channel to the
  // right BSS on ANY rig, not just the baked rig-3 default.
  if (g_creds_ready && !g_ap_latched && g_radio_up) {
    bgscan_cancel();  // new credentials: a sweep for the old SSID is moot
    scan_latch_ap();
    g_ap_latched = true;
  }
  // Persist freshly provisioned credentials once they have leased (never on receipt, so a
  // mistyped passphrase is never stored) and the provisioning central has left — or after
  // a grace window — so the NVS write can't land inside the BLE redirect exchange. This is
  // what lets a reboot or a firmware update (no erase) rejoin on its own (wifi_creds.h).
  if (g_persist.due(improv_ble_central_connected(), (uint32_t)millis())) {
    bool ok = lm_store_wifi_credentials(g_ssid, g_pass);
    g_persist.on_written(ok, (uint32_t)millis());
    if (ok)
      Serial.printf("[t=%lu] [wifi] credentials stored (ssid=%s)\n", (unsigned long)millis(), g_ssid);
    else
      Serial.printf("[t=%lu] [wifi] storing credentials FAILED (ssid=%s) — will retry\n",
                    (unsigned long)millis(), g_ssid);
  }
  // The committed network isn't reachable where we last looked: missing from the boot scan
  // (the router still booting after a power cut), or a latched AP that stopped answering
  // auth (rebooted onto another channel/BSSID, or gone). Find it again IN PLACE with a
  // background sweep on a 5 s -> 60 s backoff, forever — never esp_restart: the effect
  // keeps rendering, BLE Improv + the wired PROV console stay up the whole time, and a
  // match re-latches the AP and restarts the join, so the board rejoins on its own as soon
  // as the AP is back (wifi_scan.h). Also in the OTA loader (same transport).
  if (g_ap_latched) {
    uint32_t now_ms = (uint32_t)millis();
    // (A lease only counts once past AUTH: re-authenticating means we hold no link.)
    bool wanted = autonomous(now_ms) &&
                  lm_wifi_scan::scan_wanted(g_creds_ready, st == AUTH, g_leased && st != AUTH,
                                            g_scan_matched, g_authw.waited_ms(now_ms));
    // Improv fresh join: retry the sweep a few seconds apart before reporting the SSID
    // not found (a hotspot that beacons slowly), while the join is still waiting on it.
    if (!g_hop.active() && g_radio_up && !g_silent && st == AUTH && !g_scan_matched &&
        g_improv_scan.take_retry(now_ms)) {
      g_force_sweep = true;
      Serial.printf("[t=%lu] [ble] \"%s\" not seen yet — Improv retry sweep %lu (%lu s into "
                    "the join; reported unreachable after %lu s)%s\n", (unsigned long)now_ms,
                    g_ssid, (unsigned long)(g_improv_scan.misses() + 1),
                    (unsigned long)((now_ms - g_improv_scan.started_ms()) / 1000),
                    (unsigned long)(lm_wifi_scan::kImprovReportMs / 1000),
                    g_latch_known ? "; auth to the latched BSSID continues between sweeps" : "");
    }
    bool forced = g_force_sweep && !g_hop.active() && g_radio_up && !g_silent;
    g_force_sweep = false;
    uint32_t first_gap = lm_wifi_scan::policy_delay_ms(g_policy, 0, unseen_s());
    if (forced || (!g_hop.active() && g_scan_sched.due(wanted, now_ms, first_gap))) {
      g_hop.start();
      g_sweep_forced = forced;
      // (A forced sweep is the Improv fresh join's live scan, its retries, or the console's
      // WIFI SCAN — not a verdict on the AP: the old label called the fresh join's first
      // sweep "not answering auth" before a single auth had gone out.)
      Serial.printf("[t=%lu] [wifi] \"%s\" %s — background scan %u (effect keeps running)\n",
                    (unsigned long)now_ms, g_ssid,
                    forced                 ? "forced sweep"
                    : g_scan_matched       ? "not answering auth"
                                           : "not in the last scan",
                    (unsigned)(g_scan_sched.attempt() + 1));
    }
    uint8_t ch = 0;
    lm_wifi_scan::ChannelHop::Step hs = g_hop.step(now_ms, &ch);
    if (hs == lm_wifi_scan::ChannelHop::Step::kTune) {
      bgscan_tune(ch);
    } else if (hs == lm_wifi_scan::ChannelHop::Step::kDone && g_sweep_forced && st != AUTH) {
      // A diagnostic sweep while associated: report, change nothing about the link.
      if (g_scan_blind) g_scan_blind--;
      Serial.printf("[t=%lu] [wifi] background scan (forced): \"%s\" %s\n", (unsigned long)now_ms,
                    g_ssid, g_hop.found() ? "seen" : "not seen");
      esp_wifi_set_channel(g_chan, WIFI_SECOND_CHAN_NONE);
    } else if (hs == lm_wifi_scan::ChannelHop::Step::kDone) {
      if (g_scan_blind) g_scan_blind--;
      if (!g_sweep_forced) {
        g_scan_sched.on_scan_done(
            now_ms, lm_wifi_scan::policy_delay_ms(g_policy, g_scan_sched.attempt() + 1, unseen_s(),
                                                  &g_scan_decayed));
      }
      if (g_hop.found()) {
        const uint8_t *b = g_hop.found_bssid();
        uint8_t fch = g_hop.found_chan();
        bool moved = memcmp(b, g_bssid, 6) != 0 || fch != g_chan;
        scan_cache_put(g_ssid, b, fch);
        memcpy(g_bssid, b, 6);
        g_chan = fch;
        g_scan_matched = true;
        g_latch_known = true;
        mark_seen();
        mac_own_bssid();
        if (moved) g_authw.reset();  // a new AP/channel: its own unanswered-auth clock
        Serial.printf("[t=%lu] [wifi] background scan found \"%s\" bssid=%02x:%02x:%02x:%02x:%02x:%02x "
                      "ch=%u%s — joining\n", (unsigned long)now_ms, g_ssid, g_bssid[0], g_bssid[1],
                      g_bssid[2], g_bssid[3], g_bssid[4], g_bssid[5], g_chan,
                      moved ? "" : " (unchanged)");
      } else {
        g_scan_matched = false;
        Serial.printf("[t=%lu] [wifi] background scan: \"%s\" not found; next in %lu s%s (BLE "
                      "Improv stays up to re-provision)\n", (unsigned long)now_ms, g_ssid,
                      g_scan_sched.armed()
                          ? (unsigned long)((g_scan_sched.next_ms() - now_ms) / 1000)
                          : (unsigned long)(lm_wifi_scan::policy_delay_ms(g_policy, 0, unseen_s()) / 1000),
                      g_scan_decayed ? " (decayed: network unseen for a long time)" : "");
      }
      if (g_improv_scan.on_sweep_done(g_hop.found(), now_ms) ==
          lm_wifi_scan::ImprovScanReport::Action::kReportNotFound) {
        // Tell the provisioning app instead of letting it time out on "waiting for the
        // device to join": Improv error UNABLE_TO_CONNECT (state back to AUTHORIZED, so
        // it can re-send). The creds stay committed and the background rescan goes on —
        // the board still joins if the AP appears, and that lease clears the error.
        improv_ble_set_error(IMPROV_ERROR_UNABLE_TO_CONNECT);
        g_improv_join.forget();  // the app's retry SendWifi is a fresh join, never a ride
        Serial.printf("[t=%lu] [ble] \"%s\" not found in %lu sweeps over %lu s (directed probe "
                      "incl.) — Improv error UNABLE_TO_CONNECT; creds kept, background rescan "
                      "continues\n", (unsigned long)now_ms, g_ssid,
                      (unsigned long)g_improv_scan.misses(),
                      (unsigned long)((now_ms - g_improv_scan.started_ms()) / 1000));
      }
      esp_wifi_set_channel(g_chan, WIFI_SECOND_CHAN_NONE);  // back on the join channel
    }
  }
  // Kick the state machine: (re)send auth periodically until associated (once creds committed AND
  // the PMK is derived). Gating on ns_pmk_ready() sequences the ~1.8s PBKDF2 (pure CPU, radio
  // yielded to BLE by coex_update) BEFORE the WiFi-active join, so the join is short + the 4-way's
  // first EAPOL finds the PMK ready (immediate M2) — the link isn't dragged through a long join.
  // Only toward an AP a scan actually saw (g_scan_matched): with no match g_bssid is
  // whatever the previous network left there — auth to that AP got answered, the assoc for
  // the new SSID then stalled, and the AUTH<->ASSOC churn kept the background rescan from
  // ever coming due. The rescan finds the AP and sets the match. Not while a sweep has the
  // radio on another channel either.
  // Exception: an Improv fresh join still looking for its AP (g_improv_scan armed) keeps
  // authenticating toward the BSSID latched for THIS SSID (scan cache / an earlier sweep —
  // never a previous network's) between its sweeps. A sweep can miss an AP that is there:
  // on the iOS bench, with the iPhone holding the BLE link, every sweep for ~8 s missed the
  // AP the board had been leased on a second earlier, the join never sent an auth, and the
  // app got UNABLE_TO_CONNECT. An auth answer proves the AP and disarms the report.
  bool auth_target = g_scan_matched || (g_improv_scan.armed() && g_latch_known);
  if (st == AUTH && g_creds_ready && ns_pmk_ready() && auth_target && !g_hop.active() &&
      autonomous((uint32_t)millis()) && millis() - t > 200) {
    static bool deauthed = false;  // once per boot, to this AP (see build_deauth)
    uint32_t now_ms = (uint32_t)millis();
    bool stable = !lm_sta_mac::random_mac_is_build_default() && !g_mac_fallback;
    bool resend = deauthed && g_authw.resend_due(now_ms);
    if (stable && (!deauthed || resend)) {
      // Goodbye for any association the AP still holds for our MAC (a reset never sends
      // one): disassoc + deauth, each with a fresh sequence number (join_guard.h). On a
      // re-send, first jump the sequence counter out of any "already seen" window.
      if (resend) g_seq.jump();
      int d = build_disassoc(f);
      ns_mac_send(f, d, 0);
      d = build_deauth(f);
      ns_mac_send(f, d, 0);
      if (!deauthed) {
        Serial.printf("[t=%lu] deauth sent to clear any stale association for our MAC\n",
                      (unsigned long)now_ms);
      } else {
        Serial.printf("[t=%lu] [join] no auth response after %lu tries (%lu ms) — re-sending "
                      "disassoc+deauth, seq -> %u\n", (unsigned long)now_ms,
                      (unsigned long)g_authw.tries(), (unsigned long)g_authw.waited_ms(now_ms),
                      (unsigned)((g_seq.peek() + 1024) & 0x0fff));
      }
      deauthed = true;
    }
    // Only when a scan actually saw the AP: an absent AP (powered off, still booting) isn't
    // ignoring our MAC, so it must not cost the board its stable MAC/IP once it is back.
    if (stable && g_scan_matched && (g_force_giveup || g_authw.give_up(now_ms, g_mac_fallback))) {
      g_force_giveup = false;
      // Last resort: this AP won't talk to the factory MAC (it is still holding a stale
      // station for it). Join as a per-boot random MAC instead — a new lease/IP, but online.
      uint8_t rnd[4];
      esp_fill_random(rnd, 4);
      lm_sta_mac::random_mac(rnd, OUR_MAC);
      g_mac_fallback = true;
      mac_own_bssid();
      g_authw.reset();
      Serial.printf("[t=%lu] [join] no auth response for %lu ms — falling back to random MAC "
                    "%02x:%02x:%02x:%02x:%02x:%02x for this boot\n", (unsigned long)now_ms,
                    (unsigned long)lm_join::kGiveUpMs, OUR_MAC[0], OUR_MAC[1], OUR_MAC[2],
                    OUR_MAC[3], OUR_MAC[4], OUR_MAC[5]);
    }
    g_authw.on_auth_sent(now_ms);
    t = millis(); int a = build_auth(f); ns_mac_send(f, a, 0);
  }

  // Join watchdog: auth is re-sent every 200ms above, but the Association Request and the
  // 4-way go out ONCE. A single lost Association Request/Response (seen on the Mac Internet
  // Sharing AP: "auth ok -> assoc" then silence) or a stalled 4-way used to park the join in
  // ASSOC/FOURWAY forever. Re-drive it from AUTH (the PMK is cached, so it's quick).
  if ((st == ASSOC && millis() - t > 1000) || (st == FOURWAY && millis() - t > 4000)) {
    Serial.printf("[t=%lu] join stalled in %s — re-joining from auth\n", (unsigned long)millis(),
                  st == ASSOC ? "assoc" : "4-way");
    st = AUTH;
    inited = false;
    t = 0;
  }
  // Stream out any send-window segments the just-processed ACKs now allow (the send
  // window pipelines many segments in flight rather than one-per-RTT).
  {
    uint32_t tn;
    while ((tn = ns_tcp_pump_tx((uint32_t)millis(), tx_ip_slot(), kTxIpCap)) > 0)
      send_ip(tx_ip_slot(), tn);
  }
  // TCP retransmission is the STACK's job: ns_tcp owns its RTO and ns_tcp_tick(now) emits a
  // retransmit when it fires. The app just provides the clock + carries the bytes — a
  // correctness backstop for genuine loss, not something the app should hand-roll.
  {
    uint32_t rn = ns_tcp_tick((uint32_t)millis(), tx_ip_slot(), kTxIpCap);
    if (rn > 0) send_ip(tx_ip_slot(), rn);
  }
  // BLE Improv: the harness writes wifi-settings over GATT. Commit those creds + START
  // associating, then answer with the redirect URL once leased (Improv result FIRST, then
  // PROVISIONED — spec order) so a no-override e2e completes its provisioning phase.
  if (PLAYER_MODE) {
    static bool ble_creds_pending = false;
    static uint32_t redirect_first_ms = 0, redirect_last_ms = 0;
    char s[33], p[65];
    if (improv_ble_take_credentials(s, sizeof s, p, sizeof p)) {
      // The user's rule: a Wi-Fi join triggered through Improv is ALWAYS fresh — scan and
      // join right then — even for the network the board is already on, or already joining
      // from its stored creds. (Waiting on that stored join left the Improv central to time
      // out: the join runs on the background rescan backoff, 5 s up to 60 s, and may be
      // aimed at a cached BSSID/channel a phone hotspot has since moved off.) A duplicate
      // SendWifi therefore drops an in-flight WSS session — the accepted trade-off. The only
      // exception (wifi_creds.h ImprovJoin): the same creds re-sent within
      // kImprovCoalesceMs of the fresh join they would restart ride it, so a central that
      // missed the result and re-sends in a burst can't restart the join forever — that
      // join still reaches its lease and answers the redirect below.
      uint32_t now_ms = (uint32_t)millis();
      bool same_creds = g_creds_ready && lm_wifi::same(g_ssid, g_pass, s, p);
      lm_wifi::ImprovProvision pa =
          g_improv_join.on_receive(g_creds_ready, g_ssid, g_pass, s, p, now_ms);
      if (pa == lm_wifi::ImprovProvision::kRideFreshJoin) {
        redirect_first_ms = 0;  // re-arm the resend window so the central gets another redirect
        redirect_last_ms = 0;
        ble_creds_pending = true;
        if (!g_leased) improv_ble_set_state(IMPROV_STATE_PROVISIONING);
        Serial.printf("[t=%lu] [ble] wifi-settings re-received (ssid=%s) — riding the fresh join "
                      "started %lu ms ago (%s)\n", (unsigned long)now_ms, s,
                      (unsigned long)(now_ms - g_improv_join.started_ms()),
                      g_leased ? "leased: re-answering redirect" : "still joining");
      } else {
        // Tear down the association we hold (or are building): disassoc + deauth to the AP
        // we're latched to, so it drops us before the new auth (same AP or not).
        bool was_linked = st != AUTH;
        if (g_ap_latched && was_linked) netstack_prepare_restart();
        strncpy(g_ssid, s, sizeof g_ssid - 1);
        strncpy(g_pass, p, sizeof g_pass - 1);
        g_ssid[sizeof g_ssid - 1] = 0;
        g_pass[sizeof g_pass - 1] = 0;
        g_creds_ready = true;  // trigger association with the provisioner's creds
        g_using_stored = false;
        g_persist.on_committed();  // written to NVS once this network leases
        // The provisioned SSID may differ from an AP we already latched — most often the
        // baked-cred fallback fired first (its 45s grace elapsed while the central was still
        // connecting) and latched hitl-rig-3. g_ap_latched is a one-shot, so without this the
        // radio stays aimed at the OLD BSSID/channel and the real network is never attempted.
        // Re-latch the scan cache for THIS SSID and restart the join from AUTH.
        g_ap_latched = false;
        st = AUTH;
        inited = false;  // the 4-way re-inits for the new AP / PMK
        drop_link_for_new_network();
        on_provisioned();
        // Scan NOW, whatever the cache says: the cached BSSID/channel may be stale (a phone
        // hotspot picks its channel each time it starts). The forced sweep runs on the next
        // pass right after the latch, holding the auth until it lands; the reset schedule
        // means a miss rescans on the backoff's FIRST step (5 s), not wherever the stored
        // join's backoff had reached (up to 60 s).
        g_scan_sched.due(false, 0);  // disarm + reset the backoff
        g_force_sweep = true;
        g_improv_scan.on_fresh_join(now_ms);  // an SSID no sweep sees is reported (wifi_scan.h)
        g_authw.reset();  // a fresh join gets a fresh unanswered-auth clock
        // Start deriving the PMK NOW (off the hot path), overlapped with auth/assoc, so it's
        // ready by the 4-way and we never freeze the loop (which would drop the BLE link
        // mid-join). Same creds as committed: the PMK (derived, or deriving) is already theirs.
        if (!same_creds)
          ns_pmk_begin((const uint8_t *)g_ssid, strlen(g_ssid), (const uint8_t *)g_pass,
                       strlen(g_pass));
        ble_creds_pending = true;
        redirect_first_ms = 0;  // the redirect goes out on THIS join's lease
        redirect_last_ms = 0;
        improv_ble_set_state(IMPROV_STATE_PROVISIONING);
        Serial.printf("[t=%lu] [ble] wifi-settings received (ssid=%s%s) -> fresh join: %sscan "
                      "now, associating + PROVISIONING\n", (unsigned long)now_ms, s,
                      same_creds ? ", same as committed" : "",
                      was_linked ? "link dropped, " : "");
      }
    }
    // Send the Provisioned redirect on first lease, then RE-SEND it a few times/sec while the
    // central is still connected. On a marginal BLE link the single post-join notification is
    // often dropped even though the join SUCCEEDED — e.g. rig-2's RTL8851BU BT dongle, whose
    // reception the C6's now-active WiFi interferes with (verified: 4/5 provisions there reached
    // DHCP-lease + sent the redirect, but the central never saw STATE 04; rig-3's onboard BT is
    // reliable). Re-advertising for a short window gives the central many chances to catch one
    // copy; it stops once the central disconnects (it got it). Harmless on a good link — the
    // provisioner completes on the first copy and drops the link.
    if (g_leased && g_improv_scan.take_clear_on_lease()) {
      // The AP showed up after we reported it not found: clear the Improv error. With the
      // central still connected the redirect below does it (PROVISIONED + result); with
      // it gone, set the same state now so a central that reconnects reads success.
      Serial.printf("[t=%lu] [ble] \"%s\" joined after the not-found report — clearing the "
                    "Improv error\n", (unsigned long)millis(), g_ssid);
      if (!improv_ble_central_connected()) {
        char url[40];
        snprintf(url, sizeof url, "http://%u.%u.%u.%u/", g_offer_ip[0], g_offer_ip[1],
                 g_offer_ip[2], g_offer_ip[3]);
        improv_ble_send_redirect(url);
        improv_ble_set_state(IMPROV_STATE_PROVISIONED);
      }
    }
    if (ble_creds_pending && g_leased && improv_ble_central_connected()) {
      uint32_t now = millis();
      if (redirect_first_ms == 0) redirect_first_ms = now;
      if (now - redirect_first_ms < 12000 && (redirect_last_ms == 0 || now - redirect_last_ms >= 400)) {
        char url[40];
        snprintf(url, sizeof url, "http://%u.%u.%u.%u/", g_offer_ip[0], g_offer_ip[1],
                 g_offer_ip[2], g_offer_ip[3]);
        improv_ble_send_redirect(url);
        improv_ble_set_state(IMPROV_STATE_PROVISIONED);
        if (redirect_last_ms == 0)
          Serial.printf("[t=%lu] [ble] PROVISIONED -> redirect %s (retrying until central acks)\n",
                        (unsigned long)now, url);
        redirect_last_ms = now;
      }
    }
  }
  // Once linked, resend DISCOVER (until an OFFER) or REQUEST (until the ACK). Retransmit FAST
  // (~350ms): DHCP is the last WiFi-active stretch before the lease, and while a BLE central is
  // connected the coex duty-cycle can drop an OFFER/ACK into a sleep window — a slow (1.2s) retry
  // then stretches the join to ~4-5s, long enough for the central's supervision timer to drop the
  // link mid-DHCP (the remaining rig-2 failure mode). A tight retry recovers a lost packet quickly
  // so the lease lands fast and the redirect goes out while the link is still up.
  uint32_t dhcp_retry = improv_ble_central_connected() ? 350 : 1200;
  // A deauth keeps the last offer (g_have_offer) so a rejoin REQUESTs its old address
  // straight away; if the server neither ACKs nor NAKs it within ~8 REQUESTs, start over
  // with a DISCOVER (a stale offer must never pin the board lease-less).
  static uint8_t s_req_tries = 0;
  if (st == DONE && !g_leased && millis() - t > dhcp_retry) {
    t = millis();
    if (g_have_offer && ++s_req_tries > 8) {
      g_have_offer = false;
      Serial.printf("[t=%lu] [dhcp] no ACK for the REQUEST -> re-DISCOVER\n",
                    (unsigned long)millis());
    }
    if (g_have_offer) send_dhcp(3, g_offer_ip, g_server_id, "REQUEST");
    else {
      s_req_tries = 0;
      send_dhcp(1, nullptr, nullptr, "DISCOVER");
    }
  }
  if (g_leased) s_req_tries = 0;
  // DHCP T1 renewal: once leased, renew at half the lease so a short-lease commercial AP
  // never lets our binding lapse — otherwise the AP reclaims the IP and we go silently
  // unreachable a lease-time after provisioning (the CoolerKids drop). Reuse the broadcast
  // REQUEST (a3=bcast reaches the server); dnsmasq/home routers re-ACK a REQUEST for the
  // IP we already hold, which refreshes g_lease_ms via the mt==5 handler.
  if (st == DONE && g_leased && g_lease_secs > 0) {
    uint32_t age = (millis() - g_lease_ms) / 1000;
    // Renew at T1 — but ONLY while no wss is up: send_dhcp broadcasts (a3=bcast), and a
    // broadcast frame interleaved with a LIVE wss drops the peer's session (same reason
    // the gratuitous ARP is gated). The rig/home lease is long vs a session, so deferring
    // the renewal until the wss is idle is safe.
    if (age >= g_lease_secs / 2 && !g_ws_up && millis() - g_last_renew_ms > 5000) {
      g_last_renew_ms = millis();
      Serial.printf("[dhcp] T1 renew (age=%us/%us)\n", (unsigned)age, (unsigned)g_lease_secs);
      send_dhcp(3, g_offer_ip, g_server_id, "RENEW");
    }
    if (age >= g_lease_secs) { // expired with no ACK — fall back to a fresh DORA
      Serial.println("[dhcp] lease EXPIRED — re-DISCOVER");
      g_leased = false;
      g_have_offer = false;
    }
  }
  // Gratuitous-ARP announce, ONLY while no wss client is connected. A peer that joins
  // the AP after us (the phone joining amd-rig-ap after the C6 leased) can't resolve us
  // via our unreliable responder round-trip on a plain AP, so re-announce every ~3s so it
  // learns us before it connects. Gated on !g_ws_up: a broadcast frame interleaved with a
  // LIVE wss dropped the session (the improv_e2e wedge), so once a client is up we go
  // quiet and never perturb it.
  {
    uint32_t ts = ns_tcp_state();
    bool idle = (ts != 2 && ts != 6) && !g_ws_up;  // no client Established/SynRcvd, no wss
    static uint32_t garp_ms = 0;
    if (st == DONE && g_leased && idle && millis() - garp_ms > 3000) {
      garp_ms = millis();
      send_gratuitous_arp();
    }
    // mDNS: join the group + announce on a (new) lease — three announcements 1 s apart
    // (RFC 6762 §8.3), then refresh every 60 s (an IGMP-snooping AP ages out a silent
    // member in ~260 s) — all only while idle, like the gratuitous ARP.
    static uint32_t mdns_ms = 0, mdns_sent = 0;
    static uint8_t mdns_ip[4] = {0};
    if (memcmp(mdns_ip, g_offer_ip, 4) != 0) {
      // New address (first lease, or a re-DISCOVER / renewal that moved us): restart the
      // 3-announcement burst so browsers (the bridge) learn the new A record promptly.
      if (mdns_ip[0] != 0)
        Serial.printf("[mdns] IP changed %u.%u.%u.%u -> %u.%u.%u.%u — re-announcing\n",
                      mdns_ip[0], mdns_ip[1], mdns_ip[2], mdns_ip[3], g_offer_ip[0],
                      g_offer_ip[1], g_offer_ip[2], g_offer_ip[3]);
      memcpy(mdns_ip, g_offer_ip, 4);
      mdns_sent = 0;
      mdns_ms = 0;
    } else if (g_mdns_renewed) {
      g_mdns_renewed = false;
      if (mdns_sent >= 3) {
        mdns_sent = 2;  // one more announcement on the next idle tick
        mdns_ms = 0;
      }
    }
    if (st == DONE && g_leased && idle && millis() - mdns_ms > (mdns_sent < 3 ? 1000u : 60000u)) {
      mdns_ms = millis();
      send_igmp_mdns_report();
      send_mdns_announce();
      if (mdns_sent++ == 0)
        Serial.printf("[mdns] announcing _splanc._tcp on %u.%u.%u.%u\n", g_offer_ip[0],
                      g_offer_ip[1], g_offer_ip[2], g_offer_ip[3]);
    }
  }
  // TLS identity gate. The listener below opens ONLY once this device's key + cert are
  // installed (g_tls_setup): there is no window in which :443 accepts a handshake with no
  // or a partial cert — a client meanwhile sees the port closed (SYN unanswered) and the
  // manifest-less paths (mDNS TXT tls=, TlsInfo over BLE) report "generating". Normally
  // the identity was loaded/generated in setup() and this is a no-op; it only does work
  // when that generation failed (e.g. no heap), retrying on the machine's backoff.
  // (Not in offline mode: no radio, no :443 — radio_bringup runs tls_init when it leaves.)
  if (TLS_SERVER && !g_tls_setup && g_radio_up) {
    if (!g_identity_installed) {
      if (device_cert_poll((uint32_t)millis()) && tls_install_identity()) tls_setup_session();
    } else {
      static uint32_t setup_retry_ms = 0;
      if (millis() - setup_retry_ms > 1000) {
        setup_retry_ms = millis();
        tls_setup_session();
      }
    }
    static uint32_t gate_log_ms = 0;
    if (st == DONE && g_leased && millis() - gate_log_ms > 5000) {
      gate_log_ms = millis();
      Serial.printf("[tls] :443 held closed — device identity %s\n",
                    device_cert_machine().state_name());
    }
  }
  // With a lease: prove ICMP a few times, then open a TCP connection to the rig echo
  // server (10.42.0.1:7777) and exchange data over the heapless stack.
  if (st == DONE && g_leased && !g_tcp_started && (!TLS_SERVER || g_tls_setup) &&
      millis() - t > 700) {
    t = millis();
    if (TCP_SERVER) {
      ns_tcp_listen(g_offer_ip, SERVER_PORT, 0x3000);
      g_tcp_started = true;
      memcpy(g_listen_ip, g_offer_ip, 4); // remember the bound IP for the drift-fork check
      // If this bind is a re-arm forced by a mid-session IP change, drop any stale TLS/WS
      // session that was bound to the OLD IP (mirror the reclaim/deauth clean-relisten reset)
      // so a fresh client on the new IP is never matched against a dead session. A long-lived
      // wss defers DHCP renewal (renewal is gated on !g_ws_up), so an IP change with g_ws_up
      // still set is a realistic case, not just an edge one.
      if (g_relisten_new_ip) {
        if (TLS_SERVER) { tls_session_reset(); g_tls_hs = false; g_ws_up = false; g_responding = false; g_ws_rxlen = 0; }
        g_bio_tx = g_bio_rx = 0;
        g_relisten_new_ip = false;
      }
      Serial.printf("*** TCP LISTEN on %u.%u.%u.%u:%u — heapless server ***\n",
                    g_offer_ip[0], g_offer_ip[1], g_offer_ip[2], g_offer_ip[3], SERVER_PORT);
    } else {
      static int pc = 0;
      if (pc < 3) { send_ping(g_offer_ip, pc + 1); pc++; }
      else {
        uint8_t syn[80];
        uint32_t n = ns_tcp_connect(g_offer_ip, GATEWAY, 5001, 7777, 0x2000, syn, sizeof(syn));
        Serial.printf("TCP connect: pc=%d n=%u\n", pc, n);
        if (n > 0) { send_ip(syn, n); g_tcp_started = true; Serial.println("TCP SYN -> 10.42.0.1:7777"); }
      }
    }
  }
  if (st == DONE && g_tcp_started && TCP_SERVER) {
    // Keepalive: we have no ARP, so periodically send a frame to the gateway (our MAC as
    // L2 source) to keep its ARP cache warm — otherwise inbound SYNs to us aren't delivered
    // once the cache goes stale.
    static uint32_t ka = 0;
    if (millis() - ka > 4000) { ka = millis(); send_ping(g_offer_ip, 200); }
    // Server: handle_l3 already drove on_ip (SYN-ACK, ACKs); drain + echo any request.
    static uint32_t last_state = 99;
    uint32_t s = ns_tcp_state();
    // On the RISING edge of a wss client appearing (LISTEN -> SynRcvd=6 / Established=2),
    // gracefully tear down the vestigial post-provision BLE link so coex stops yielding
    // airtime to a dead link during the TLS handshake (the RST / welcome-timeout flake).
    // Edge-triggered so we issue exactly one HCI_Disconnect per wss session; a no-op if the
    // central already dropped. The host re-advertises on EV_DISCONN, so BLE stays connectable.
    bool wss_active = (s == 2 || s == 6);
    if (wss_active && !g_wss_was_active && improv_ble_central_connected()) {
      improv_ble_request_disconnect();
    }
    g_wss_was_active = wss_active;
    if (s != last_state) { Serial.printf("*** SERVER state -> %u ***\n", s); last_state = s; }
    // Graceful load-shedding gate. Arm the tcp layer to fast-REJECT (RST|ACK) a SYN from a
    // DIFFERENT peer ONLY while this slot is a live, established, actively-serving session —
    // s==2 AND the WS/TLS session is up. Disarm otherwise (LISTEN, SynRcvd, pre-WS
    // Established, closing). This is the load-bearing guard against the reverted #199/#204
    // e2e regression: the SAME client reconnects on a fresh source port for the post-WS
    // cert-trust-page GET right after its wss session closes, arriving during the
    // close->re-LISTEN transition; if we rejected a busy-slot SYN unconditionally we'd reset
    // that legitimate reconnect. We disarm the instant the session is no longer up (and
    // explicitly before close_notify below), so the cert-GET reconnect is never rejected —
    // it either latches a fresh LISTEN or, if the old slot is still closing, is silently
    // dropped and retried (its previous behavior), never RST-refused.
    {
      bool live = (s == 2) && (TLS_SERVER ? (PLAYER_MODE ? g_ws_up : g_tls_hs) : true);
      ns_tcp_set_serving_live(live ? 1u : 0u);
    }
    // Reclaim a wedged half-open connection. A concurrent-handshake burst (the tls_churn
    // stress) can leave the single connection slot stuck mid-accept: the DOMINANT wedge is
    // SynRcvd (s==6) — the client that won the LISTEN race sent no final ACK (the host fired
    // several handshakes and abandoned the losers), so the slot sits in SynRcvd forever. The
    // Rust dead-peer RTO only arms when sent>0 (SynRcvd has nothing queued), and a mismatched
    // second SYN is dropped at the peer-match gate, so EVERY later client times out. The
    // less-common wedge is ESTABLISHED-but-not-up (the peer vanished mid-TLS/pre-WS). Neither
    // is covered by the s==4/0 re-listen below (no FIN) nor the tls_write_all stall guard
    // (that's the reply phase). So bound the not-yet-serving stretch — SynRcvd OR pre-WS
    // Established — and once it exceeds ~3s (a real handshake+WS completes in <3s on the LAN),
    // force a fresh listener (ns_tcp_listen swaps the conn to a clean LISTEN), abandoning the
    // dead peer and freeing the slot. This is the tls_churn anti-wedge gate.
    {
      static uint32_t hs_since = 0;
      static uint32_t last_prog = 0;
      bool up = TLS_SERVER ? (PLAYER_MODE ? g_ws_up : g_tls_hs) : true;
      // SynRcvd, or Established pre-WS — BUT never a connection that's actively serving a
      // response (g_responding: the one-shot cert-trust GET, which never sets g_ws_up). A
      // served cert-GET waiting to close under contention would otherwise trip this 4s gate
      // and get RST mid-close (the "cert-trust page GET ... Connection reset" e2e flake); it
      // is instead covered by the post-WS 6s peer-gone gate below. A genuinely silent pre-WS
      // wedge (tls_churn TLS-then-silent) never sets g_responding, so it's still reclaimed.
      bool handshaking = (s == 6) || (s == 2 && !up && !g_responding);
      if (handshaking) {
        // Reclaim on a STALLED handshake, not wall-clock. Progress = TLS bytes moving in
        // EITHER direction (g_bio_rx + g_bio_tx): a live handshake alternates — the client
        // sends ClientHello/Finished (bio_rx), the server sends its cert flight (bio_tx) —
        // so keying on rcv-only would murder the slot while the SERVER is talking and the
        // client is legitimately quiet. In SynRcvd no TLS has started so both are 0/const
        // and the timer runs on wall-clock (a true no-final-ACK wedge). Reset on any TLS
        // progress; fire only when nothing has flowed either way for 4s.
        uint32_t prog = (uint32_t)g_bio_rx + (uint32_t)g_bio_tx + ns_tcp_rcv_nxt();
        if (hs_since == 0 || prog != last_prog) {
          hs_since = millis() == 0 ? 1 : millis();
          last_prog = prog;
        } else if (millis() - hs_since > 4000) {
          Serial.println("*** SERVER handshake wedge (peer silent pre-WS) — reclaiming ***");
          static uint32_t riss = 0x5000;
          ns_tcp_listen(g_offer_ip, SERVER_PORT, riss);
          riss += 0x1000;
          if (TLS_SERVER) { tls_session_reset(); g_tls_hs = false; g_ws_up = false; g_responding = false; g_ws_rxlen = 0; }
          g_bio_tx = g_bio_rx = 0;
          hs_since = 0;
          last_state = 99;      // re-log SERVER state on the next scan
          s = ns_tcp_state();   // now LISTEN — skip the stale handshake drive below this scan
        }
      } else {
        hs_since = 0;
      }
    }
    // Post-WS peer-gone reclaim. The block above only catches a wedge BEFORE the WS is up.
    // Once UPGRADED (up==true), a peer that vanishes mid-stream — a client crash, a network
    // drop, or a benchmark host that stopped reading (fx_bench's "board unreachable after
    // sweep16") — sends no FIN, and unsolicited perf pushes are best-effort (dropped on a full
    // window, not torn down), so nothing frees the single slot and every later client is
    // rejected. Liveness signal: a live reader keeps ACKing, so our send window keeps draining
    // and tx_room recovers; a dead peer never ACKs and the window stays pinned near-empty. If
    // it can't hold even a small frame for 6s straight (well past any legitimate LAN burst),
    // treat the peer as gone and re-listen — dropping at most one genuinely slow client, which
    // simply reconnects, in exchange for never staying permanently unreachable.
    {
      static uint32_t txstuck_since = 0;
      static uint32_t last_una = 0;
      // Cover a live WS session (g_ws_up) OR a responding cert-GET (g_responding): both can
      // have unacked data whose ACKs must keep flowing, and a dead peer mid-serve must be
      // reclaimed here (keyed on snd_una freeze) rather than by the pre-WS 4s gate above.
      bool up = TLS_SERVER ? (PLAYER_MODE ? (g_ws_up || g_responding) : g_tls_hs) : true;
      // Only meaningful when we have UNACKED data outstanding (tx_room < SND_BUF=2048): a
      // live reader ACKs it, so snd_una advances — even on a SATURATING stream that keeps
      // the window pinned full (the old tx_room<512 test murdered healthy backlogged
      // streams: led_capture/fx_bench). Key on snd_una FROZEN, not on window occupancy.
      // Idle (nothing outstanding) → skip; only a peer that stopped ACKing for 6s is gone.
      if (s == 2 && up && ns_tcp_tx_room() < 2048) {
        uint32_t una = ns_tcp_snd_una();
        if (txstuck_since == 0 || una != last_una) {
          txstuck_since = millis() == 0 ? 1 : millis();
          last_una = una;
        } else if (millis() - txstuck_since > 6000) {
          Serial.println("*** SERVER post-WS peer-gone (no ACK 6s) — reclaiming ***");
          static uint32_t piss = 0x6000;
          ns_tcp_listen(g_offer_ip, SERVER_PORT, piss);
          piss += 0x1000;
          if (TLS_SERVER) { tls_session_reset(); g_tls_hs = false; g_ws_up = false; g_responding = false; g_ws_rxlen = 0; }
          g_bio_tx = g_bio_rx = 0;
          txstuck_since = 0;
          last_state = 99;      // re-log SERVER state on the next scan
          s = ns_tcp_state();   // now LISTEN — skip the stale handshake drive below this scan
        }
      } else {
        txstuck_since = 0;  // idle (nothing unacked) or not up — peer is fine
      }
    }
    // Idle-session keepalive. A client that gave up mid-connect (its handshake outlasted
    // its timeout while the loop was starved) or vanished without a FIN/RST that reached us
    // can still complete the upgrade: the slot then holds a ghost wss session with nothing
    // in flight, so the peer-gone gate above never arms, and every NEW client's SYN is
    // RST-refused by load-shedding (serving_live) until a reboot — measured on 1.12.3 under
    // a heavy effect (heavy_effect_reachability). After 15 s without a byte from the peer,
    // send a WebSocket ping: a live client's stack ACKs it (and its WS layer pongs), a
    // closed socket answers with a RST (the slot re-listens), and a vanished host never
    // ACKs, so the peer-gone gate reclaims the slot 6 s later.
    {
      static uint32_t quiet_since = 0;
      static uint32_t last_rx = 0;
      if (s == 2 && TLS_SERVER && g_tls_hs && g_ws_up && ns_tcp_tx_room() >= 2048) {
        uint32_t rx = ns_tcp_rcv_nxt();
        if (quiet_since == 0 || rx != last_rx) {
          quiet_since = millis() == 0 ? 1 : millis();
          last_rx = rx;
        } else if (millis() - quiet_since > 15000) {
          uint8_t ping[kWsSendHeadroom + 1];
          ws_send(WS_OP_PING, ping + kWsSendHeadroom, 0, kWsSendHeadroom);
          quiet_since = millis() == 0 ? 1 : millis();
        }
      } else {
        quiet_since = 0;
      }
    }
    // Served-and-closing reclaim. A one-shot GET (the agent's /.well-known/splanc.json
    // manifest, the cert-trust page) sets g_responding, writes its reply + close_notify and
    // then waits for the client's FIN. If that FIN (or the client's RST) is lost — e.g. the
    // 16-slot RX ring overflowed while the loop was starved under a heavy effect, or the
    // client timed out and dropped its socket — nothing else frees the single slot: the
    // pre-WS gate above exempts g_responding, the peer-gone gate only fires with unacked
    // data, and TCP has no keepalive. Every later SYN is then dropped at the peer-match gate
    // (serving_live is 0) while mDNS and ping still answer: the device looks present but
    // never accepts a client again. So once the reply is fully ACKed and nothing has moved
    // either way for 8 s (a live client FINs within milliseconds), re-listen.
    {
      static uint32_t close_since = 0;
      static uint32_t last_prog = 0;
      if (s == 2 && TLS_SERVER && g_responding && !g_ws_up && ns_tcp_tx_room() >= 2048) {
        uint32_t prog = ns_tcp_snd_una() + ns_tcp_rcv_nxt();
        if (close_since == 0 || prog != last_prog) {
          close_since = millis() == 0 ? 1 : millis();
          last_prog = prog;
        } else if (millis() - close_since > 8000) {
          Serial.println("*** SERVER served-and-closing, no FIN 8s — reclaiming ***");
          static uint32_t ciss = 0x7000;
          ns_tcp_listen(g_offer_ip, SERVER_PORT, ciss);
          ciss += 0x1000;
          tls_session_reset(); g_tls_hs = false; g_ws_up = false; g_responding = false; g_ws_rxlen = 0;
          g_bio_tx = g_bio_rx = 0;
          close_since = 0;
          last_state = 99;
          s = ns_tcp_state();
        }
      } else {
        close_since = 0;
      }
    }
    if (s == 2 && TLS_SERVER) { // Established: drive the TLS handshake, then read+echo
      if (!g_tls_hs) {
        static int last_hstate = -1;
        int hs = g_ssl.MBEDTLS_PRIVATE(state);
        if (hs != last_hstate) { Serial.printf("  TLS hs state -> %d\n", hs); last_hstate = hs; }
        int r = mbedtls_ssl_handshake(&g_ssl);
        if (r == 0) {
          g_tls_hs = true;
          Serial.printf("*** TLS HANDSHAKE COMPLETE (%s) ***\n", mbedtls_ssl_get_ciphersuite(&g_ssl));
        } else if (r != MBEDTLS_ERR_SSL_WANT_READ && r != MBEDTLS_ERR_SSL_WANT_WRITE) {
          Serial.printf("*** TLS handshake err -0x%04x ***\n", (unsigned)-r);
          tls_session_reset();
          g_bio_tx = g_bio_rx = 0;
        }
      } else if (PLAYER_MODE) {
        if (!ws_pump()) {
          // Peer torn/ungraceful, OR a one-shot GET / (the cert-trust page) that ws_pump
          // served and asked to close. Send close_notify and let the clean FIN drive the
          // s==4/0 re-listen path below. An earlier revision re-listened INLINE here for
          // faster recovery, but that abandoned the connection before close_notify was
          // transmitted — which broke the cert-trust GET that immediately follows a WS
          // session (e2e_netstack): the next GET / went unanswered (read timeout). The
          // stalled-wedge cases are already covered by the pre-WS and post-WS
          // progress-keyed reclaim gates above, so the fast inline path wasn't buying
          // robustness — only the regression. Close cleanly and re-listen on the FIN.
          //
          // Disarm load-shedding BEFORE we close: g_ws_up is still true here (the session was
          // serving up to this instant), but we are now closing, so any SYN that arrives from
          // a different source port during this close->re-LISTEN window is the SAME client's
          // post-WS cert-trust-page reconnect and MUST NOT be RST-refused (the reverted e2e
          // regression). Clearing it here — ahead of the scan-top update next loop — makes the
          // no-reject guarantee hold across the whole transition, not just from the next scan.
          ns_tcp_set_serving_live(0u);
          mbedtls_ssl_close_notify(&g_ssl);
        } else {
          // The WS pump just drained the TCP rx (mbedtls read the record) — if that re-opened
          // a window we'd shrunk to ~0 on a big inbound upload frame, announce it so the peer
          // resumes (prevents a zero-window deadlock on large client->device transfers).
          uint8_t wack[80];
          uint32_t wn = ns_tcp_window_ack(wack, sizeof wack);
          if (wn > 0) send_ip(wack, wn);
        }
      } else {
        uint8_t rb[600];
        int r = mbedtls_ssl_read(&g_ssl, rb, sizeof(rb));
        if (r > 0) {
          Serial.printf("*** TLS RX %d B — echoing ***\n", r);
          int off = 0;
          while (off < r) {
            int w = mbedtls_ssl_write(&g_ssl, rb + off, r - off);
            if (w > 0) off += w;
            else if (w != MBEDTLS_ERR_SSL_WANT_WRITE && w != MBEDTLS_ERR_SSL_WANT_READ) break;
          }
        }
      }
    } else if (s == 2) { // raw-TCP echo (TLS off)
      uint8_t rb[600];
      uint32_t rn = ns_tcp_recv(rb, sizeof(rb));
      if (rn > 0) {
        Serial.printf("*** SERVER RX %u B — echoing ***\n", rn);
        tcp_send_all(rb, rn);
      }
    } else if (s == 4 || s == 0) { // Done/Closed: re-arm the listener for the next client
      static uint32_t niss = 0x4000;
      ns_tcp_listen(g_offer_ip, SERVER_PORT, niss);
      niss += 0x1000;
      if (TLS_SERVER) { tls_session_reset(); g_tls_hs = false; g_ws_up = false; g_responding = false; g_ws_rxlen = 0; }
      Serial.println("*** SERVER re-listening ***");
    }
  } else if (st == DONE && g_tcp_started) {
    // Client mode (original outbound echo test).
    if (ns_tcp_state() == 2 && !g_tcp_requested) {
      const char *req = "HELLO-FROM-HEAPLESS\n";
      if (tcp_send_all((const uint8_t *)req, strlen(req)) > 0) {
        g_tcp_requested = true;
        Serial.println("TCP ESTABLISHED — request sent");
      }
    }
    uint8_t rb[256];
    uint32_t rn = ns_tcp_recv(rb, sizeof(rb) - 1);
    if (rn > 0) { rb[rn] = 0; Serial.printf("*** TCP RX (%u B): %s ***\n", rn, (char *)rb); }
  }
}
