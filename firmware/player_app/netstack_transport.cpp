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
#include <esp_netif.h>
#include <esp_heap_caps.h>
#include <esp_random.h>
#include <string.h>
#include <mbedtls/ssl.h>
#include <mbedtls/x509_crt.h>
#include <mbedtls/pk.h>
#include "ws_codec.h"        // RFC6455 server codec
#include "improv_ble.h"      // BLE Improv onboarding (advertise + creds)
#include "improv_codec.h"    // IMPROV_STATE_* constants
#include "netstack_transport.h"  // our public API + the shared lm_ws_dispatch seam

extern "C" {
void ns_mac_rx_install();
uint32_t ns_aes_selftest(uint8_t *out); // FIPS-197 AES-128: bit0=enc ok, bit1=dec ok; out=ciphertext
uint32_t ns_mac_recv(uint8_t *out, uint32_t cap);
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
uint32_t ns_tcp_on_ip(const uint8_t *ip, uint32_t len, uint8_t *out, uint32_t cap);
uint32_t ns_tcp_enqueue(const uint8_t *data, uint32_t len);          // buffer into the send window
uint32_t ns_tcp_pump_tx(uint32_t now_ms, uint8_t *out, uint32_t cap); // emit next windowed segment
uint32_t ns_tcp_tx_room(void);                                       // free send-window bytes
uint32_t ns_tcp_tick(uint32_t now_ms, uint8_t *out, uint32_t cap); // stack RTO: emits a retransmit when it fires
uint32_t ns_tcp_window_ack(uint8_t *out, uint32_t cap); // window-update ACK after draining rx
uint32_t ns_tcp_recv(uint8_t *out, uint32_t cap);
void ns_tcp_listen(const uint8_t *src, uint16_t sport, uint32_t iss); // passive open (server)
uint32_t ns_tcp_state();
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

namespace {
constexpr uintptr_t WIFI_MAC_INTR_MAP = 0x60010000;
const char *SSID = "hitl-rig-3";
const char *PASS = "hitl-rig-3-provision";
// Default to rig-3's AP; a WiFi scan (scan_and_latch_ap) overwrites these once the
// provisioned SSID is known, so the netstack joins ANY rig's AP, not just this baked one.
uint8_t g_bssid[6] = {0xb8, 0x27, 0xeb, 0xbb, 0x8d, 0xf8};
uint8_t g_chan = 6;
uint8_t OUR_MAC[6];
// Active WiFi credentials for the WPA2 PMK. Default to the baked rig AP so a no-BLE
// (--skip-improv) run still associates; BLE Improv overwrites these from the provisioner
// (same AP here). We only START associating once these are "committed" — see g_creds_ready.
char g_ssid[33];
char g_pass[65];
bool g_creds_ready = false;  // creds committed (from BLE, or the baked fallback)

// DHCP lease state (DORA).
uint8_t g_offer_ip[4] = {0}, g_server_id[4] = {0};
bool g_have_offer = false, g_leased = false;
const uint8_t GATEWAY[4] = {10, 42, 0, 1};
bool g_pinged = false;
bool g_hwkey = false;
uint32_t g_rekey_serviced = 0; // count of AP group-key rekeys we ACKed (see handle_l3)
void *g_trc = nullptr; // default TRC (ic_get_trc(0,0)) for the ppTxPkt HW-encrypt bridge
bool g_tcp_started = false, g_tcp_requested = false;
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
  static wifi_ap_record_t recs[24];
  esp_wifi_scan_get_ap_records(&n, recs);
  g_scan_n = 0;
  for (uint16_t i = 0; i < n && g_scan_n < 24; i++) {
    memcpy(g_scan[g_scan_n].ssid, recs[i].ssid, 32);
    g_scan[g_scan_n].ssid[32] = 0;
    memcpy(g_scan[g_scan_n].bssid, recs[i].bssid, 6);
    g_scan[g_scan_n].chan = recs[i].primary;
    g_scan_n++;
  }
  Serial.printf("[scan] err=%d found=%u AP(s)\n", (int)e, (unsigned)g_scan_n);
  for (uint8_t i = 0; i < g_scan_n; i++)
    Serial.printf("[scan]   ssid=\"%s\" bssid=%02x:%02x:%02x:%02x:%02x:%02x ch=%u\n", g_scan[i].ssid,
                  g_scan[i].bssid[0], g_scan[i].bssid[1], g_scan[i].bssid[2], g_scan[i].bssid[3],
                  g_scan[i].bssid[4], g_scan[i].bssid[5], g_scan[i].chan);
}

// Once g_ssid is known, find its cached AP and latch the real BSSID + channel + reprogram
// the hardware. Keeps the baked default if the SSID wasn't seen in the scan (e.g. rig-3
// fallback where they already match). Returns whether a scan match was applied.
bool scan_latch_ap() {
  for (uint8_t i = 0; i < g_scan_n; i++) {
    if (strncmp(g_scan[i].ssid, g_ssid, 32) == 0) {
      memcpy(g_bssid, g_scan[i].bssid, 6);
      g_chan = g_scan[i].chan;
      esp_wifi_set_channel(g_chan, WIFI_SECOND_CHAN_NONE);
      mac_own_bssid();  // re-program the hardware BSSID register for the scanned AP
      Serial.printf("[t=%lu] [scan] latched \"%s\" -> bssid=%02x:%02x:%02x:%02x:%02x:%02x ch=%u\n", (unsigned long)millis(), g_ssid,
                    g_bssid[0], g_bssid[1], g_bssid[2], g_bssid[3], g_bssid[4], g_bssid[5], g_chan);
      return true;
    }
  }
  Serial.printf("[scan] no scan match for \"%s\" — keeping baked bssid ch=%u\n", g_ssid, g_chan);
  return false;
}

int mgmt_hdr(uint8_t *f, uint8_t fc) {
  int n = 0;
  f[n++] = fc; f[n++] = 0x00;
  f[n++] = 0x00; f[n++] = 0x00;
  memcpy(f + n, g_bssid, 6); n += 6;
  memcpy(f + n, OUR_MAC, 6); n += 6;
  memcpy(f + n, g_bssid, 6); n += 6;
  f[n++] = 0x00; f[n++] = 0x00;
  return n;
}
int build_auth(uint8_t *f) {
  int n = mgmt_hdr(f, 0xb0);
  f[n++] = 0x00; f[n++] = 0x00; f[n++] = 0x01; f[n++] = 0x00; f[n++] = 0x00; f[n++] = 0x00;
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
  const uint8_t rsn[] = {0x30, 0x14, 0x01, 0x00, 0x00, 0x0f, 0xac, 0x02, 0x01, 0x00, 0x00,
                         0x0f, 0xac, 0x04, 0x01, 0x00, 0x00, 0x0f, 0xac, 0x02, 0x00, 0x00};
  memcpy(f + n, rsn, sizeof(rsn)); n += sizeof(rsn);
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
  dhcp[d++] = 0x00; dhcp[d++] = 0x00;       // flags: unicast reply (we can RX unicast)
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

// Build + CCMP-encrypt + transmit a DHCP message (DISCOVER/REQUEST) to the AP.
// Transmit an L2 frame: `hdr` is the 24-byte 802.11 header (Protected bit set), `payload`
// is LLC/SNAP + L3. With HW crypto active (g_hwkey) hand a plaintext QoS MPDU to the vendor
// ppTxPkt bridge and let the MAC insert the CCMP header + encrypt; otherwise software-
// encrypt. Returns the enc'd length or the plaintext length. `label` is logged.
uint32_t tx_l2(const uint8_t *hdr, const uint8_t *payload, int plen, const char *label) {
  if (g_hwkey) {
    // Bare protected QoS data MPDU: [26B QoS 802.11 hdr, FC 0x88 0x41 = QoS + ToDS +
    // Protected][LLC/SNAP + L3 CLEARTEXT]. No CCMP header — the vendor ppTxPkt path + MAC
    // engine insert the IV, encrypt, and append the MIC. addr1=g_bssid (hdr already carries it).
    uint8_t frame[1700];
    memset(frame, 0, 8);                  // 8-byte HW-TX-header pad (secure branch fills it)
    memcpy(frame + 8, hdr, 24);
    frame[8] = 0x88;                     // QoS data subtype (override the 0x08 the caller set)
    frame[9] = 0x41;                     // ToDS + Protected
    frame[8 + 24] = 0x00; frame[8 + 25] = 0x00; // QoS control: TID 0, normal ack
    memcpy(frame + 8 + 26, payload, plen);
    bool ok = tx_hw_encrypt(frame, 8 + 26 + plen);
    if (label) Serial.printf("%s (HW-enc ppTxPkt %d B, ok=%d)\n", label, 8 + 26 + plen, ok);
    return 8 + 26 + plen;
  }
  uint8_t enc[1700];
  uint32_t el = ns_sta_encrypt(hdr, 24, payload, plen, enc, sizeof(enc));
  if (el > 0) {
    ns_mac_send(enc, el, 0);
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

void send_dhcp(uint8_t msg_type, const uint8_t *req_ip, const uint8_t *server_id, const char *what) {
  // One transaction id for the whole DORA so the REQUEST correlates to the OFFER.
  const uint32_t xid = 0x5e7a9c01;
  uint8_t payload[400];
  int pn = build_dhcp(payload, OUR_MAC, xid, msg_type, req_ip, server_id);
  uint8_t hdr[24]; // 802.11 data: ToDS=1 + Protected=1; a1=g_bssid a2=us a3=broadcast
  hdr[0] = 0x08; hdr[1] = 0x41; hdr[2] = 0x00; hdr[3] = 0x00;
  // a3 = g_bssid (unicast to the AP at L2, L3 is still 255.255.255.255) so hardware TX
  // encrypt uses the pairwise key (it keys off the destination address).
  memcpy(hdr + 4, g_bssid, 6); memcpy(hdr + 10, OUR_MAC, 6); memcpy(hdr + 16, g_bssid, 6);
  hdr[22] = 0x00; hdr[23] = 0x00;
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
  hdr[22] = 0x00; hdr[23] = 0x00;
  tx_l2(hdr, payload, pn, "PING sent");
}

// CCMP-encrypt + transmit an IPv4 packet to the gateway (the AP), wrapping it in
// LLC/SNAP. Used for the TCP segments the tcp module produces.
void send_ip(const uint8_t *ip, int iplen) {
  uint8_t payload[1600];
  const uint8_t llc[] = {0xaa, 0xaa, 0x03, 0x00, 0x00, 0x00, 0x08, 0x00};
  memcpy(payload, llc, 8);
  memcpy(payload + 8, ip, iplen);
  uint8_t hdr[24]; // ToDS=1 + Protected=1; a1=g_bssid a2=us a3=g_bssid (gateway == AP)
  hdr[0] = 0x08; hdr[1] = 0x41; hdr[2] = 0x00; hdr[3] = 0x00;
  memcpy(hdr + 4, g_bssid, 6); memcpy(hdr + 10, OUR_MAC, 6); memcpy(hdr + 16, g_bssid, 6);
  hdr[22] = 0x00; hdr[23] = 0x00;
  tx_l2(hdr, payload, 8 + iplen, nullptr);
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
  hdr[22] = 0x00; hdr[23] = 0x00;
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

// Parse an L2 payload (LLC/SNAP + IPv4) for our ICMP echo replies and DHCP responses.
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
  hdr[22] = 0; hdr[23] = 0;
  tx_l2(hdr, payload, 8 + 28, nullptr);
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
      static uint8_t reply[1600];  // static: handle_l3 is never re-entered (single thread)
      uint32_t rl = ns_tcp_on_ip(ip, iplen, reply, sizeof(reply));
      if (rl > 0) send_ip(reply, rl);
    }
    return;
  }
  if (pl > 8 + 28 && ip[9] == 1) { // ICMP
    const uint8_t *ic = ip + ((ip[0] & 0x0f) * 4);
    if (ic[0] == 0) // echo reply
      Serial.printf("*** PING REPLY from %u.%u.%u.%u seq=%u — IP round-trip over heapless WiFi ***\n",
                    ip[12], ip[13], ip[14], ip[15], (ic[6] << 8) | ic[7]);
  } else if (pl > 8 + 28 && ip[9] == 17) { // UDP
    const uint8_t *udp = ip + ((ip[0] & 0x0f) * 4);
    uint16_t sport = (udp[0] << 8) | udp[1], dport = (udp[2] << 8) | udp[3];
    if (sport == 67 && dport == 68) { // DHCP server -> client
      const uint8_t *dh = udp + 8;
      uint8_t mt = 0;
      const uint8_t *o = dh + 240;
      const uint8_t *end = pt + pl;
      while (o + 1 < end && *o != 255) {
        if (*o == 53) mt = o[2];
        else if (*o == 54) memcpy(g_server_id, o + 2, 4);
        o += 2 + o[1];
      }
      Serial.printf("DHCP reply: type=%u yiaddr=%u.%u.%u.%u\n", mt, dh[16], dh[17], dh[18], dh[19]);
      if (mt == 2 && !g_have_offer && !g_leased) {
        memcpy(g_offer_ip, dh + 16, 4);
        g_have_offer = true;
        Serial.printf("[t=%lu] *** DHCP OFFER received — L3 over heapless CCMP link ***\n", (unsigned long)millis());
        send_dhcp(3, g_offer_ip, g_server_id, "REQUEST");
      } else if (mt == 5) {
        g_leased = true;
        memcpy(g_offer_ip, dh + 16, 4);
        Serial.printf("[t=%lu] *** DHCP LEASE ACQUIRED — IP %u.%u.%u.%u over heapless WiFi ***\n",
                      (unsigned long)millis(), dh[16], dh[17], dh[18], dh[19]);
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
// Layer a real TLS 1.2/1.3 server on the proven heapless TCP server: mbedtls drives the
// handshake + records through send/recv callbacks that ride ns_tcp_send/recv (our CCMP
// data path). Self-signed EC cert (the e2e client uses CERT_NONE, so identity doesn't
// matter here). Stop-and-wait TCP carries the multi-KB cert flight one segment per ACK.
constexpr bool TLS_SERVER = true;
static const char TLS_CERT[] =
    "-----BEGIN CERTIFICATE-----\n"
    "MIIBfDCCASGgAwIBAgIUYfPx+3+VCjLBTz9xuRRdR2kBVS4wCgYIKoZIzj0EAwIw\n"
    "EzERMA8GA1UEAwwIaGVhcGxlc3MwHhcNMjYwODI0MTg0NjIyWhcNMzYwODIxMTg0\n"
    "NjIyWjATMREwDwYDVQQDDAhoZWFwbGVzczBZMBMGByqGSM49AgEGCCqGSM49AwEH\n"
    "A0IABMYrmea00slBUqpcl1iPe9krK06bYMhL/B6ppK3zGESwPW+6W9HGYcC4aTnL\n"
    "NSMEvqyHiu94agvA+pyDs/0FozWjUzBRMB0GA1UdDgQWBBTo/KTgeh0O7hupqPDh\n"
    "hhWN5OIN2TAfBgNVHSMEGDAWgBTo/KTgeh0O7hupqPDhhhWN5OIN2TAPBgNVHRMB\n"
    "Af8EBTADAQH/MAoGCCqGSM49BAMCA0kAMEYCIQD3kGEsK2MPWe1uYErGZgAaKyON\n"
    "yGs7v+2EV+5lW0UyGwIhAL0WuN6eqZ9watBZpEo2H2AA7Y0a6j7lBCxEGx/nnXW5\n"
    "-----END CERTIFICATE-----\n";
static const char TLS_KEY[] =
    "-----BEGIN EC PRIVATE KEY-----\n"
    "MHcCAQEEIOEorPYc267y2s0hNmX9QDcFs2wWkH9Tv+UdemPcwYFxoAoGCCqGSM49\n"
    "AwEHoUQDQgAExiuZ5rTSyUFSqlyXWI972SsrTptgyEv8HqmkrfMYRLA9b7pb0cZh\n"
    "wLhpOcs1IwS+rIeK73hqC8D6nIOz/QWjNQ==\n"
    "-----END EC PRIVATE KEY-----\n";
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
  uint8_t seg[1600];
  uint32_t n;
  while ((n = ns_tcp_pump_tx((uint32_t)millis(), seg, sizeof seg)) > 0) send_ip(seg, n);
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

void tls_init() {
  mbedtls_ssl_init(&g_ssl);
  mbedtls_ssl_config_init(&g_conf);
  mbedtls_x509_crt_init(&g_srvcert);
  mbedtls_pk_init(&g_pk);
  int r = mbedtls_x509_crt_parse(&g_srvcert, (const unsigned char *)TLS_CERT, sizeof(TLS_CERT));
  int r2 = mbedtls_pk_parse_key(&g_pk, (const unsigned char *)TLS_KEY, sizeof(TLS_KEY), nullptr, 0,
                                tls_rng, nullptr);
  mbedtls_ssl_config_defaults(&g_conf, MBEDTLS_SSL_IS_SERVER, MBEDTLS_SSL_TRANSPORT_STREAM,
                              MBEDTLS_SSL_PRESET_DEFAULT);
  mbedtls_ssl_conf_rng(&g_conf, tls_rng, nullptr);
  mbedtls_ssl_conf_authmode(&g_conf, MBEDTLS_SSL_VERIFY_NONE);
  mbedtls_ssl_conf_own_cert(&g_conf, &g_srvcert, &g_pk);
  int r3 = mbedtls_ssl_setup(&g_ssl, &g_conf);
  mbedtls_ssl_set_bio(&g_ssl, nullptr, bio_send, bio_recv, nullptr);
  g_tls_setup = true;
  Serial.printf("TLS init: cert=%d key=%d setup=%d\n", r, r2, r3);
}

// ---- WebSocket + player: the LED Mapper protocol over the proven TLS -----------------
// When PLAYER_MODE, once TLS is up we speak RFC6455: consume the HTTP upgrade, then feed
// each binary WS message to the player session core (lm_player_handle) and frame its
// reply back. This is the transport the HITL e2e exercises (wss:443/ws): hello/welcome,
// time_sync, set_device_name, get_hardware_config — all handled inside lm_player_handle.
constexpr bool PLAYER_MODE = true;
bool g_ws_up = false;
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
static void pump_link_once() {
  static uint8_t rxb[1600];
  uint32_t n = ns_mac_recv(rxb, sizeof(rxb));
  if (n > 0 && (rxb[0] & 0x0c) == 0x08 && (rxb[1] & 0x40)) {  // protected data frame from the AP
    static uint8_t pt[1600];  // static: single-threaded, and keeps this off the deep TLS-write stack
    uint32_t pl = 0;
    for (uint32_t trim = 0; trim <= 4 && pl == 0; trim++)
      if (n > trim + 32) pl = ns_sta_decrypt(rxb, n - trim, pt, sizeof(pt));
    if (pl) handle_l3(pt, pl);
  }
  // ALWAYS try to stream the send window out — whether or not a frame arrived. During a
  // TLS write-stall (snd_buf full) the only way it drains is ACKs freeing space + the RTO's
  // go-back-N resend; both need pump_tx to run every spin, not just when RX happens to land.
  static uint8_t tseg[1600];
  uint32_t tn;
  while ((tn = ns_tcp_pump_tx((uint32_t)millis(), tseg, sizeof tseg)) > 0) send_ip(tseg, tn);
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
      static uint8_t rseg[1600];
      uint32_t rn = ns_tcp_tick((uint32_t)millis(), rseg, sizeof rseg);
      if (rn > 0) send_ip(rseg, rn);
      // Time-based deadline, not an iteration count: a burst of small replies can legitimately
      // back-pressure for a few RTOs (300ms, backed off), and an iteration cap could trip
      // BEFORE the first RTO even fires — dropping the connection mid-sweep. Give real loss
      // several RTO/backoff cycles to recover before giving up. The clock resets on ANY
      // progress (above), so a slow-but-alive peer never trips it — only ZERO ACKs for the
      // whole window. Bounded to 3s (was 8s): this loop runs on loopTask, so while it spins
      // NOTHING else in the netstack is serviced — no RX, no ICMP, no reconnect-accept. A
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
// a small reply is a single TLS record / TCP segment (no mid-message stop-and-wait stall).
// Returns false if the write ultimately failed (tls_write_all gave up on a vanished peer) —
// the caller tears the connection down so the single server slot is freed for the next client
// instead of being held by a dead peer (a wss wedge). Best-effort callers may ignore it.
static bool ws_send(uint8_t opcode, const uint8_t *payload, size_t len) {
  // Server replies come from the app's tx buffer (<=2KB); size the coalesce buffer to match
  // (the oversized path below handles anything larger). Small on purpose — see g_ws_rx note.
  static uint8_t frame[2560];
  uint8_t hdr[10];
  size_t hn = ws_build_frame_header(opcode, len, hdr);
  if (hn + len <= sizeof(frame)) {
    memcpy(frame, hdr, hn);
    if (len) memcpy(frame + hn, payload, len);
    return tls_write_all(frame, hn + len);
  }
  // oversized: header then payload (tls_write_all pumps the link between segments)
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

    if (!g_ws_up) {
      // Wait for the full HTTP upgrade request (ends with a blank line), then 101.
      g_ws_rx[g_ws_rxlen < sizeof(g_ws_rx) ? g_ws_rxlen : sizeof(g_ws_rx) - 1] = 0;
      if (!strstr((char *)g_ws_rx, "\r\n\r\n")) return true;  // headers incomplete
      char key[80];
      if (!ws_find_key((char *)g_ws_rx, key, sizeof key)) return false;
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
        if (tn > 0 && reply && !ws_send(WS_OP_BINARY, reply, (size_t)tn)) return false;
      } else if (h.opcode == WS_OP_PING) {
        if (!ws_send(WS_OP_PONG, payload, h.payload_len)) return false;
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
bool netstack_ws_send_frame(const uint8_t *data, size_t len) {
  if (!g_tls_hs || !g_ws_up) return false;
  // Best-effort: unsolicited PerfReports must NEVER starve the request/reply path. If the
  // send window doesn't comfortably hold this frame (+ TLS record overhead), drop it — a
  // full window means RPC replies are already queued, and a blocking perf write there
  // wedges tls_write_all long enough for the client to time out and reset (observed as
  // mid-sweep socket drops in fx_bench). A dropped perf sample just means one fewer report.
  if (ns_tcp_tx_room() < len + 96) return false;
  ws_send(WS_OP_BINARY, data, len);
  return true;
}
bool netstack_ws_is_open() { return g_tls_hs && g_ws_up; }

} // namespace

bool netstack_ws_send(const uint8_t *data, size_t len) { return netstack_ws_send_frame(data, len); }
bool netstack_ws_open() { return netstack_ws_is_open(); }
// External linkage (g_rekey_serviced lives in the anonymous namespace above but is visible
// in this TU): count of AP group-key rekeys serviced, surfaced in the status line.
uint32_t netstack_rekey_count() { return g_rekey_serviced; }

// Bring up the heapless WiFi transport. Call from the app's setup() AFTER the shared player
// init + improv_ble_begin (BLE must init before we hijack the MAC so our radio setup wins).
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
  // The BT controller is already up (the app's improv_ble_begin ran first); hijack the MAC
  // last so our heapless RX/g_bssid/force-awake setup wins the shared radio config.
  //
  // We OWN the RX ring (ns_mac_rx_install), so the vendor WiFi driver's default static/dynamic
  // RX buffers are pure waste — and they're DMA-capable, the scarce pool the RMT LED driver +
  // our ring also draw from. Under the full player runtime those allocs FAIL (beacons=0), so
  // init esp_wifi with a minimal RX/TX buffer config instead of Arduino's WiFi.mode defaults.
  esp_netif_init();
  esp_event_loop_create_default();  // BLE may have created it already (ESP_ERR_INVALID_STATE ok)
  wifi_init_config_t wcfg = WIFI_INIT_CONFIG_DEFAULT();
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
  uint8_t rnd[4]; esp_fill_random(rnd, 4);
  OUR_MAC[0] = 0x02; OUR_MAC[1] = 0x0c; OUR_MAC[2] = 0x6a;
  OUR_MAC[3] = rnd[0]; OUR_MAC[4] = rnd[1]; OUR_MAC[5] = rnd[2];
  Serial.printf("MAC %02x:%02x:%02x:%02x:%02x:%02x\n", OUR_MAC[0], OUR_MAC[1], OUR_MAC[2],
                OUR_MAC[3], OUR_MAC[4], OUR_MAC[5]);
  g_our_mac_ptr = OUR_MAC;
  // Cache every AP in range NOW, while the vendor WiFi RX still works — after the MAC
  // hijack below we own the ring and the vendor scan can't run. scan_latch_ap() (in the
  // loop, once the provisioner gives us the SSID) then picks our AP's real BSSID+channel,
  // so the netstack joins ANY rig's AP, not just the baked rig-3 one.
  wifi_scan_cache();
  // Continuous STA RX with NO promiscuous, so the hardware crypto engine stays inline:
  // stop->start the MAC, configure the STA vif, and force it awake (pm_go_to_wake) so
  // RX is continuous instead of the disconnected duty-cycle. Runs in the WiFi task via
  // the ioctl marshal (heap request, cmd@0/handler@4; the ioctl frees it).
  esp_wifi_set_ps(WIFI_PS_NONE);
  esp_wifi_set_channel(g_chan, WIFI_SECOND_CHAN_NONE);
  delay(150);
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

  // Sanity: continuous RX into our ring, no promiscuous.
  uint8_t rx[400];
  uint32_t beacons = 0;
  for (int i = 0; i < 400; i++) {
    uint32_t n = ns_mac_recv(rx, sizeof(rx));
    if (n && rx[0] == 0x80) beacons++;
    delay(3);
  }
  Serial.printf("[netstack] RX sanity (STA vif, no promiscuous, HW crypto inline): beacons=%u\n",
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
void netstack_loop() {
  static St st = AUTH;
  static uint32_t t = 0;
  static bool inited = false;
  // Start the high-frequency coex tick once (defined above; the vendor PM lever it calls is only
  // declared after netstack_setup, so arm it here on the first loop rather than in setup).
  static esp_timer_handle_t coex_timer = nullptr;
  if (!coex_timer) {
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
  // NB: WiFi/BT coex arbitration runs on its own high-frequency esp_timer (coex_timer_cb), not here
  // — the ~22ms loop period was too coarse to time the BLE-yield slices. See coex_timer_cb.
  // Advance the incremental PMK derivation a small chunk per loop (once creds arrive). 64 HMAC-
  // SHA1s is ~14ms — under a BLE connection interval — so improv_ble_poll above keeps the link
  // alive between chunks instead of the loop freezing ~1.8s in one synchronous PBKDF2 (which was
  // the real cause of the rig-2 provisioning flake: a mid-join loop stall dropped the BLE link).
  if (g_creds_ready && !ns_pmk_ready()) ns_pmk_step(64);
  // rx must hold a FULL MPDU: ns_mac_recv truncates to cap, and a truncated frame fails
  // CCMP's MIC (silently dropped, no ACK) — which stalled inbound data segments >~360B
  // (e.g. a 410-byte TLS ClientHello -> ~498-byte MPDU) while small control frames passed.
  uint8_t f[256], rx[1600];

  // Keep own-MAC valid the whole time so hardware auto-ACK stays on (no retransmit
  // storm). Post-link we DISABLE the HW crypto engine (CTRL0=0) so the MAC passes
  // protected unicast to us raw — no HW-decrypt attempt, no drop — for software CCMP
  // decap, while still auto-ACKing. (Set once on entering DONE.)
  mac_own_bssid();
  // Post-link: HW crypto stays ENABLED (install_hw_key replicated the vendor's
  // connected-STA crypto state) so the MAC hardware-decrypts protected unicast to us
  // and delivers plaintext (handled by the g_hwkey branch).

  // Drain up to N frames per loop() so a burst (e.g. dnsmasq's DHCP retransmits) can't
  // fill the fixed RX ring and drop an inbound SYN/data segment before we service it.
  uint32_t n;
  int drained = 0;
  while (drained++ < 32 && (n = ns_mac_recv(rx, sizeof(rx))) > 0) {
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
  if (n >= 24 && memcmp(rx + 4, OUR_MAC, 6) == 0 &&
      (memcmp(rx + 10, g_bssid, 6) == 0 || memcmp(rx + 16, g_bssid, 6) == 0)) {
    if (rx[0] == 0xb0 && st == AUTH) { // auth resp
      uint16_t status = rx[28] | (rx[29] << 8);
      if (status == 0) { int a = build_assoc(f); ns_mac_send(f, a, 0); st = ASSOC; Serial.println("auth ok -> assoc"); }
    } else if (rx[0] == 0x10 && st == ASSOC) { // assoc resp
      uint16_t status = rx[26] | (rx[27] << 8);
      Serial.printf("assoc status=%u\n", status);
      if (status == 0) { st = FOURWAY; Serial.println("ASSOCIATED -> 4-way"); }
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
        mbedtls_ssl_session_reset(&g_ssl);
        g_tls_hs = false;
        g_ws_up = false;
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
      static uint8_t pt[1600];  // static: keep the drain's decrypt buffer off the deep stack
      // The RX MPDU has no trailing FCS here, so decap over the full length; fall
      // back to an FCS-trimmed length in case a driver variant appends one.
      // The RX hardware pads odd-length MPDUs to even (and some paths append a 4-byte
      // FCS), so frame_len can be 1-4 bytes longer than the real MPDU — which makes CCMP
      // over-read the ciphertext and fail the MIC. Try trimming 0..4 trailing bytes until
      // the MIC validates. (Was: only n and n-4, which missed the odd->even +1 pad.)
      uint32_t pl = 0;
      for (uint32_t trim = 0; trim <= 4 && pl == 0; trim++) {
        if (n > trim + 32) pl = ns_sta_decrypt(rx, n - trim, pt, sizeof(pt));
      }
      static uint32_t pf = 0;
      if (pf++ < 8)
        Serial.printf("  prot AP->us fc=%02x%02x len=%u ccmp@24=[%02x %02x %02x %02x] decrypt=%u\n",
                      rx[0], rx[1], n, rx[24], rx[25], rx[26], rx[27], pl);
      handle_l3(pt, pl);
    } else if ((rx[0] & 0x0c) == 0x08 && !(rx[1] & 0x40) && st == DONE && g_hwkey && n > 32) {
      // HW-decrypted data frame from the AP (Protected bit cleared, CCMP header
      // stripped by hardware): the LLC/SNAP + L3 payload follows the 24-byte header.
      static uint32_t hwf = 0;
      if (hwf++ < 6) Serial.printf("  HW-DECRYPTED fc=%02x%02x len=%u llc=[%02x %02x .. %02x %02x]\n",
                                   rx[0], rx[1], n, rx[24], rx[25], rx[30], rx[31]);
      handle_l3(rx + 24, n - 24);
    }
  }
  } // end RX drain loop

  // Commit WiFi credentials before associating — the proper Improv flow: on BLE provisioning
  // associate with the creds the provisioner writes; with no BLE central (e.g. --skip-improv)
  // fall back to the baked rig creds after a short grace so the transport still comes up.
  // (Association coexists fine with an active BLE link — the earlier "join timeout" was NOT
  //  coex but blocking Serial.printf wedging loopTask when the port wasn't drained; see
  //  Serial.setTxTimeoutMs(0) in setup. Either association order works now.)
  //
  // CRITICAL: once a central has EVER connected, suppress the baked fallback entirely. A
  // connected central means a harness is actively provisioning us over BLE; the baked SSID
  // is only this rig's default and on a shared bench (multiple rigs in radio range) it names
  // a DIFFERENT rig's AP. Falling back mid-provisioning (e.g. between failed Improv attempts,
  // when no central is momentarily connected) would latch+associate to the wrong rig's AP and
  // lease an IP on that rig's subnet — unreachable from this rig's host (the wss ConnectionReset
  // on rig-2). --skip-improv runs never connect a central, so the fallback still fires for them.
  static bool g_ble_central_ever = false;
  if (improv_ble_central_connected()) g_ble_central_ever = true;
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
  // Grace must outlast BLE provisioning: from boot a central has to scan+connect+subscribe+RPC,
  // which routinely takes >15s — an 8s grace fired mid-provisioning and latched the baked
  // (wrong-rig) SSID before the real creds arrived. 45s comfortably clears a successful
  // provision (real creds set g_creds_ready via path 2 the instant they arrive, so provisioning
  // is NOT delayed by this); the ever-connected guard suppresses it entirely once a central
  // shows up. Only genuinely central-less --skip-improv runs wait out the full grace.
  static const uint32_t kBakedFallbackMs = 45000;
  if (PLAYER_MODE && !g_creds_ready && !g_ble_central_ever && millis() > kBakedFallbackMs) {
    strncpy(g_ssid, SSID, sizeof g_ssid - 1);
    strncpy(g_pass, PASS, sizeof g_pass - 1);
    g_creds_ready = true;
    ns_pmk_begin((const uint8_t *)g_ssid, strlen(g_ssid), (const uint8_t *)g_pass, strlen(g_pass));
    Serial.printf("[assoc] no BLE central — associating with baked creds ssid=%s\n", g_ssid);
  }
  if (!PLAYER_MODE) g_creds_ready = true;  // non-player transport demo associates immediately
  // As soon as the SSID is committed, latch the AP's real BSSID + channel from the scan
  // cache (once) BEFORE the first auth — so auth/assoc go out on the right channel to the
  // right BSS on ANY rig, not just the baked rig-3 default.
  if (g_creds_ready && !g_ap_latched) {
    scan_latch_ap();
    g_ap_latched = true;
  }
  // Kick the state machine: (re)send auth periodically until associated (once creds committed AND
  // the PMK is derived). Gating on ns_pmk_ready() sequences the ~1.8s PBKDF2 (pure CPU, radio
  // yielded to BLE by coex_update) BEFORE the WiFi-active join, so the join is short + the 4-way's
  // first EAPOL finds the PMK ready (immediate M2) — the link isn't dragged through a long join.
  if (st == AUTH && g_creds_ready && ns_pmk_ready() && millis() - t > 200) {
    t = millis(); int a = build_auth(f); ns_mac_send(f, a, 0);
  }
  // Stream out any send-window segments the just-processed ACKs now allow (the send
  // window pipelines many segments in flight rather than one-per-RTT).
  {
    static uint8_t tseg[1600];
    uint32_t tn;
    while ((tn = ns_tcp_pump_tx((uint32_t)millis(), tseg, sizeof tseg)) > 0) send_ip(tseg, tn);
  }
  // TCP retransmission is the STACK's job: ns_tcp owns its RTO and ns_tcp_tick(now) emits a
  // retransmit when it fires. The app just provides the clock + carries the bytes — a
  // correctness backstop for genuine loss, not something the app should hand-roll.
  {
    static uint8_t rseg[1600];
    uint32_t rn = ns_tcp_tick((uint32_t)millis(), rseg, sizeof rseg);
    if (rn > 0) send_ip(rseg, rn);
  }
  // BLE Improv: the harness writes wifi-settings over GATT. Commit those creds + START
  // associating, then answer with the redirect URL once leased (Improv result FIRST, then
  // PROVISIONED — spec order) so a no-override e2e completes its provisioning phase.
  if (PLAYER_MODE) {
    static bool ble_creds_pending = false;
    static uint32_t redirect_first_ms = 0, redirect_last_ms = 0;
    char s[33], p[65];
    if (improv_ble_take_credentials(s, sizeof s, p, sizeof p)) {
      strncpy(g_ssid, s, sizeof g_ssid - 1);
      strncpy(g_pass, p, sizeof g_pass - 1);
      g_creds_ready = true;  // trigger association with the provisioner's creds
      // Start deriving the PMK NOW (off the hot path), overlapped with auth/assoc, so it's ready
      // by the 4-way and we never freeze the loop (which would drop the BLE link mid-join).
      ns_pmk_begin((const uint8_t *)g_ssid, strlen(g_ssid), (const uint8_t *)g_pass, strlen(g_pass));
      ble_creds_pending = true;
      improv_ble_set_state(IMPROV_STATE_PROVISIONING);
      Serial.printf("[t=%lu] [ble] wifi-settings received (ssid=%s) -> associating + PROVISIONING\n", (unsigned long)millis(), s);
    }
    // Send the Provisioned redirect on first lease, then RE-SEND it a few times/sec while the
    // central is still connected. On a marginal BLE link the single post-join notification is
    // often dropped even though the join SUCCEEDED — e.g. rig-2's RTL8851BU BT dongle, whose
    // reception the C6's now-active WiFi interferes with (verified: 4/5 provisions there reached
    // DHCP-lease + sent the redirect, but the central never saw STATE 04; rig-3's onboard BT is
    // reliable). Re-advertising for a short window gives the central many chances to catch one
    // copy; it stops once the central disconnects (it got it). Harmless on a good link — the
    // provisioner completes on the first copy and drops the link.
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
  if (st == DONE && !g_leased && millis() - t > dhcp_retry) {
    t = millis();
    if (g_have_offer) send_dhcp(3, g_offer_ip, g_server_id, "REQUEST");
    else send_dhcp(1, nullptr, nullptr, "DISCOVER");
  }
  // With a lease: prove ICMP a few times, then open a TCP connection to the rig echo
  // server (10.42.0.1:7777) and exchange data over the heapless stack.
  if (st == DONE && g_leased && !g_tcp_started && millis() - t > 700) {
    t = millis();
    if (TCP_SERVER) {
      ns_tcp_listen(g_offer_ip, SERVER_PORT, 0x3000);
      g_tcp_started = true;
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
    if (s != last_state) { Serial.printf("*** SERVER state -> %u ***\n", s); last_state = s; }
    // Reclaim a wedged half-open connection. A concurrent-handshake burst (the tls_churn
    // stress) can leave the single connection slot stuck ESTABLISHED with the client gone
    // mid-TLS-handshake (or pre-WS): the s==4/0 re-listen below never fires (the peer sent no
    // FIN), so every later client is rejected — a persistent wss wedge. The write-stall guard
    // (tls_write_all) only covers a stalled reply, not the accept/handshake phase. So bound
    // the not-yet-serving stretch: once ESTABLISHED-but-not-up exceeds a few seconds (a real
    // handshake+WS completes in <3s), force a fresh listener — ns_tcp_listen swaps the conn to
    // a clean LISTEN state — abandoning the dead peer and freeing the slot for the next client.
    {
      static uint32_t est_since = 0;
      bool up = TLS_SERVER ? (PLAYER_MODE ? g_ws_up : g_tls_hs) : true;
      if (s == 2 && !up) {
        if (est_since == 0) est_since = millis() == 0 ? 1 : millis();
        else if (millis() - est_since > 8000) {
          Serial.println("*** SERVER half-open handshake wedge — reclaiming (re-listen) ***");
          static uint32_t riss = 0x5000;
          ns_tcp_listen(g_offer_ip, SERVER_PORT, riss);
          riss += 0x1000;
          if (TLS_SERVER) { mbedtls_ssl_session_reset(&g_ssl); g_tls_hs = false; g_ws_up = false; g_ws_rxlen = 0; }
          g_bio_tx = g_bio_rx = 0;
          est_since = 0;
          last_state = 99;      // re-log SERVER state on the next scan
          s = ns_tcp_state();   // now LISTEN — skip the stale handshake drive below this scan
        }
      } else {
        est_since = 0;
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
      bool up = TLS_SERVER ? (PLAYER_MODE ? g_ws_up : g_tls_hs) : true;
      if (s == 2 && up && ns_tcp_tx_room() < 512) {
        if (txstuck_since == 0) txstuck_since = millis() == 0 ? 1 : millis();
        else if (millis() - txstuck_since > 6000) {
          Serial.println("*** SERVER post-WS peer-gone wedge (tx window pinned) — reclaiming (re-listen) ***");
          static uint32_t piss = 0x6000;
          ns_tcp_listen(g_offer_ip, SERVER_PORT, piss);
          piss += 0x1000;
          if (TLS_SERVER) { mbedtls_ssl_session_reset(&g_ssl); g_tls_hs = false; g_ws_up = false; g_ws_rxlen = 0; }
          g_bio_tx = g_bio_rx = 0;
          txstuck_since = 0;
          last_state = 99;      // re-log SERVER state on the next scan
          s = ns_tcp_state();   // now LISTEN — skip the stale handshake drive below this scan
        }
      } else {
        txstuck_since = 0;  // window draining (or not up) — peer is alive
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
          mbedtls_ssl_session_reset(&g_ssl);
          g_bio_tx = g_bio_rx = 0;
        }
      } else if (PLAYER_MODE) {
        if (!ws_pump()) { mbedtls_ssl_close_notify(&g_ssl); }
        // The WS pump just drained the TCP rx (mbedtls read the record) — if that re-opened a
        // window we'd shrunk to ~0 on a big inbound upload frame, announce it so the peer
        // resumes (prevents a zero-window deadlock on large client->device transfers).
        uint8_t wack[80];
        uint32_t wn = ns_tcp_window_ack(wack, sizeof wack);
        if (wn > 0) send_ip(wack, wn);
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
      if (TLS_SERVER) { mbedtls_ssl_session_reset(&g_ssl); g_tls_hs = false; g_ws_up = false; g_ws_rxlen = 0; }
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
