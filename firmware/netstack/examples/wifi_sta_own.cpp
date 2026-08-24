// wifi_sta_own — full heapless STA that OWNS the RX path, NO promiscuous. We bring up
// CONTINUOUS STA RX the vendor way (reversed): via the ieee80211_ioctl marshal in the
// WiFi-task context we run wifi_hw_stop -> wifi_hw_start -> ic_set_vif(STA) ->
// pm_disconnected_stop -> pm_go_to_wake (force the MAC awake so RX is continuous, not
// duty-cycled), then install our own RX ring and pull frames directly. This uses the
// real STA vif (crypto-capable, unlike monitor/promiscuous), is deterministic (fixed
// the 4-way flakiness the promiscuous callback caused), and keeps hardware auto-ACK via
// the own-MAC/BSSID registers. TX + auth/assoc + WPA2 4-way + CCMP are all ours.
//
// Software CCMP (HW crypto engine disabled post-link) currently drives the data plane;
// the HW crypto slot programs (valid=1) but RX-decrypt needs ic_set_key's key-info
// table, not the raw wDev_Insert_KeyEntry — that's the remaining acceleration step.

#include <Arduino.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <string.h>

SET_LOOP_TASK_STACK_SIZE(20480);

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
uint32_t ns_tcp_send(const uint8_t *data, uint32_t len, uint8_t *out, uint32_t cap);
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

// ioctl handler: bring up continuous STA RX in the WiFi-task context.
const uint8_t *g_our_mac_ptr = nullptr;
extern "C" void sta_rx_start_handler(void *req) {
  (void)req;
  wifi_hw_stop(0);
  wifi_hw_start(0);
  ic_set_vif(0, 0, g_our_mac_ptr, 0, 0);
  pm_disconnected_stop();
  pm_go_to_wake();
}

// No-op promiscuous sink: keeps the RX hardware + all-frames filter enabled but
// stops the vendor from processing/delivering packets, so our ring owns RX.
void IRAM_ATTR sink(void *, wifi_promiscuous_pkt_type_t) {}

namespace {
constexpr uintptr_t WIFI_MAC_INTR_MAP = 0x60010000;
const char *SSID = "hitl-rig-3";
const char *PASS = "hitl-rig-3-provision";
const uint8_t BSSID[6] = {0xb8, 0x27, 0xeb, 0xbb, 0x8d, 0xf8};
constexpr uint8_t CHAN = 6;
uint8_t OUR_MAC[6];

// DHCP lease state (DORA).
uint8_t g_offer_ip[4] = {0}, g_server_id[4] = {0};
bool g_have_offer = false, g_leased = false;
const uint8_t GATEWAY[4] = {10, 42, 0, 1};
bool g_pinged = false;
bool g_hwkey = false;
void *g_trc = nullptr; // default TRC (ic_get_trc(0,0)) for the ppTxPkt HW-encrypt bridge
bool g_tcp_started = false, g_tcp_requested = false;
// De-risk the WSS server path: after the lease, LISTEN on :4433 and echo, instead of the
// outbound TCP-client test. Validates the inbound TCP path (SYN->SYN-ACK->data->ACK) on
// silicon before layering mbedtls TLS on top.
constexpr bool TCP_SERVER = true;
constexpr uint16_t SERVER_PORT = 4433;

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
// our MAC; BSSID slot 0 (0x600a4000/04, valid 0x80000000) marks our BSS.
void mac_own_bssid() {
  uint32_t lo = OUR_MAC[0] | (OUR_MAC[1] << 8) | (OUR_MAC[2] << 16) | ((uint32_t)OUR_MAC[3] << 24);
  wreg(0x600A405C, lo);
  wreg(0x600A4060, (uint32_t)(OUR_MAC[4] | (OUR_MAC[5] << 8)) | 0x10000);
  uint32_t blo = BSSID[0] | (BSSID[1] << 8) | (BSSID[2] << 16) | ((uint32_t)BSSID[3] << 24);
  wreg(0x600A4000, blo);
  volatile uint32_t *b = reinterpret_cast<volatile uint32_t *>(0x600A4004);
  *b = (*b & 0xffff0000) | (BSSID[4] | (BSSID[5] << 8)) | 0x80000000;
}

int mgmt_hdr(uint8_t *f, uint8_t fc) {
  int n = 0;
  f[n++] = fc; f[n++] = 0x00;
  f[n++] = 0x00; f[n++] = 0x00;
  memcpy(f + n, BSSID, 6); n += 6;
  memcpy(f + n, OUR_MAC, 6); n += 6;
  memcpy(f + n, BSSID, 6); n += 6;
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
  int sl = strlen(SSID); f[n++] = 0x00; f[n++] = (uint8_t)sl;
  memcpy(f + n, SSID, sl); n += sl;
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
  memcpy(f + n, BSSID, 6); n += 6;
  memcpy(f + n, OUR_MAC, 6); n += 6;
  memcpy(f + n, BSSID, 6); n += 6;
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
// data MPDU: [26-byte 802.11 QoS header, FC Protected bit set, addr1=BSSID][LLC/SNAP + L3
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
    // engine insert the IV, encrypt, and append the MIC. addr1=BSSID (hdr already carries it).
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
  uint8_t hdr[24]; // 802.11 data: ToDS=1 + Protected=1; a1=BSSID a2=us a3=broadcast
  hdr[0] = 0x08; hdr[1] = 0x41; hdr[2] = 0x00; hdr[3] = 0x00;
  // a3 = BSSID (unicast to the AP at L2, L3 is still 255.255.255.255) so hardware TX
  // encrypt uses the pairwise key (it keys off the destination address).
  memcpy(hdr + 4, BSSID, 6); memcpy(hdr + 10, OUR_MAC, 6); memcpy(hdr + 16, BSSID, 6);
  hdr[22] = 0x00; hdr[23] = 0x00;
  char lbl[32]; snprintf(lbl, sizeof(lbl), "DHCP %s sent", what);
  tx_l2(hdr, payload, pn, lbl);
}

// CCMP-encrypt + transmit an ICMP echo request from `src` to the gateway (which is
// the AP itself, so the L2 destination is the BSSID).
void send_ping(const uint8_t *src, uint16_t seq) {
  uint8_t payload[64];
  int pn = build_ping(payload, src, GATEWAY, seq);
  uint8_t hdr[24]; // ToDS=1 + Protected=1; a1=BSSID a2=us a3=BSSID (gateway == AP)
  hdr[0] = 0x08; hdr[1] = 0x41; hdr[2] = 0x00; hdr[3] = 0x00;
  memcpy(hdr + 4, BSSID, 6); memcpy(hdr + 10, OUR_MAC, 6); memcpy(hdr + 16, BSSID, 6);
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
  uint8_t hdr[24]; // ToDS=1 + Protected=1; a1=BSSID a2=us a3=BSSID (gateway == AP)
  hdr[0] = 0x08; hdr[1] = 0x41; hdr[2] = 0x00; hdr[3] = 0x00;
  memcpy(hdr + 4, BSSID, 6); memcpy(hdr + 10, OUR_MAC, 6); memcpy(hdr + 16, BSSID, 6);
  hdr[22] = 0x00; hdr[23] = 0x00;
  tx_l2(hdr, payload, 8 + iplen, nullptr);
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
  wDev_Insert_KeyEntry(4 /*CCMP*/, 1 /*enable*/, 0, BSSID, SLOT, tk, 16, 0);
  volatile uint32_t *slot = reinterpret_cast<volatile uint32_t *>(0x600A5800 + SLOT * 40);
  slot[6] = 0; slot[7] = 0; slot[8] = 0; slot[9] = 0;   // zero RX PN replay words
  // EXPERIMENT: use the vendor's atomic engine setup instead of raw register pokes, and
  // keep the NATURAL key config (no 0x086c overwrite). Prior raw-poke attempts matched the
  // vendor's *visible* registers but the crypto engine still refused TX — internal state
  // from the enable SEQUENCE may be the missing piece.
  wr(0x600A4004, rd(0x600A4004) | 0x00010000);          // BSSID entry "has key" bit
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
  memcpy(hdr + 4, BSSID, 6); memcpy(hdr + 10, OUR_MAC, 6); memcpy(hdr + 16, arp + 8, 6);
  hdr[22] = 0; hdr[23] = 0;
  tx_l2(hdr, payload, 8 + 28, nullptr);
}

void handle_l3(const uint8_t *pt, int pl) {
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
      uint8_t reply[1600];
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
        Serial.println("*** DHCP OFFER received — L3 over heapless CCMP link ***");
        send_dhcp(3, g_offer_ip, g_server_id, "REQUEST");
      } else if (mt == 5) {
        g_leased = true;
        memcpy(g_offer_ip, dh + 16, 4);
        Serial.printf("*** DHCP LEASE ACQUIRED — IP %u.%u.%u.%u over heapless WiFi ***\n",
                      dh[16], dh[17], dh[18], dh[19]);
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
} // namespace

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("wifi_sta_own: heapless STA owning the MAC (no promiscuous)");
  uint8_t aesct[16];
  uint32_t aes = ns_aes_selftest(aesct);
  Serial.printf("AES self-test: enc=%d dec=%d ct=%02x%02x%02x%02x (want 69c4e0d8)\n",
                aes & 1, (aes >> 1) & 1, aesct[0], aesct[1], aesct[2], aesct[3]);
  WiFi.mode(WIFI_STA);
  esp_wifi_start();
  uint8_t rnd[4]; esp_fill_random(rnd, 4);
  OUR_MAC[0] = 0x02; OUR_MAC[1] = 0x0c; OUR_MAC[2] = 0x6a;
  OUR_MAC[3] = rnd[0]; OUR_MAC[4] = rnd[1]; OUR_MAC[5] = rnd[2];
  Serial.printf("MAC %02x:%02x:%02x:%02x:%02x:%02x\n", OUR_MAC[0], OUR_MAC[1], OUR_MAC[2],
                OUR_MAC[3], OUR_MAC[4], OUR_MAC[5]);
  g_our_mac_ptr = OUR_MAC;
  // Continuous STA RX with NO promiscuous, so the hardware crypto engine stays inline:
  // stop->start the MAC, configure the STA vif, and force it awake (pm_go_to_wake) so
  // RX is continuous instead of the disconnected duty-cycle. Runs in the WiFi task via
  // the ioctl marshal (heap request, cmd@0/handler@4; the ioctl frees it).
  esp_wifi_set_ps(WIFI_PS_NONE);
  esp_wifi_set_channel(CHAN, WIFI_SECOND_CHAN_NONE);
  delay(150);
  wreg(WIFI_MAC_INTR_MAP, 0); // detach vendor ISR
  ns_mac_rx_install();
  uint32_t *req = static_cast<uint32_t *>(malloc(24));
  memset(req, 0, 24);
  reinterpret_cast<uint8_t *>(req)[0] = 23;
  req[1] = reinterpret_cast<uint32_t>(&sta_rx_start_handler);
  ieee80211_ioctl(req);
  wreg(WIFI_MAC_INTR_MAP, 0); // re-detach ISR
  mac_own_bssid();            // own-MAC + BSSID: hardware auto-ACK
  ns_mac_rx_install();        // re-own the RX ring
  esp_wifi_set_channel(CHAN, WIFI_SECOND_CHAN_NONE);

  // Sanity: continuous RX into our ring, no promiscuous.
  uint8_t rx[400];
  uint32_t beacons = 0;
  for (int i = 0; i < 400; i++) {
    uint32_t n = ns_mac_recv(rx, sizeof(rx));
    if (n && rx[0] == 0x80) beacons++;
    delay(3);
  }
  Serial.printf("RX sanity (STA vif, no promiscuous, HW crypto inline): beacons=%u\n", beacons);
}

enum St { AUTH, ASSOC, FOURWAY, DONE };
void loop() {
  static St st = AUTH;
  static uint32_t t = 0;
  static bool inited = false;
  uint8_t f[256], rx[400];

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
      (memcmp(rx + 10, BSSID, 6) == 0 || memcmp(rx + 16, BSSID, 6) == 0)) {
    if (apf++ < 12) Serial.printf("  AP->us fc=%02x%02x len=%u\n", rx[0], rx[1], n);
  }
  if (n >= 24 && memcmp(rx + 4, OUR_MAC, 6) == 0 &&
      (memcmp(rx + 10, BSSID, 6) == 0 || memcmp(rx + 16, BSSID, 6) == 0)) {
    if (rx[0] == 0xb0 && st == AUTH) { // auth resp
      uint16_t status = rx[28] | (rx[29] << 8);
      if (status == 0) { int a = build_assoc(f); ns_mac_send(f, a, 0); st = ASSOC; Serial.println("auth ok -> assoc"); }
    } else if (rx[0] == 0x10 && st == ASSOC) { // assoc resp
      uint16_t status = rx[26] | (rx[27] << 8);
      Serial.printf("assoc status=%u\n", status);
      if (status == 0) { st = FOURWAY; Serial.println("ASSOCIATED -> 4-way"); }
    } else if ((rx[0] & 0x0c) == 0x08 && st == FOURWAY) { // EAPOL data
      const uint8_t *eb; int el = eapol_body(rx, n, &eb);
      if (el > 4) {
        if (!inited) { uint8_t sn[32]; esp_fill_random(sn, 32);
          ns_wpa_init((const uint8_t *)SSID, strlen(SSID), (const uint8_t *)PASS, strlen(PASS), BSSID, OUR_MAC, sn);
          inited = true; }
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
          Serial.println("*** 4-WAY COMPLETE — CCMP KEYS INSTALLED, LINK UP ***");
          install_hw_key(); // program HW slot so auto-ACK + HW decrypt coexist
        }
      }
    } else if ((rx[0] & 0x0c) == 0x08 && (rx[1] & 0x40) && st == DONE) {
      // Protected data frame from the AP: CCMP-decrypt and look for a DHCP reply.
      // The RX frame carries a trailing 4-byte FCS that would corrupt CCMP's MIC
      // (it lives in the last 8 bytes), so trim it before decap.
      uint8_t pt[600];
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

  // Kick the state machine: (re)send auth periodically until associated.
  if (st == AUTH && millis() - t > 200) { t = millis(); int a = build_auth(f); ns_mac_send(f, a, 0); }
  // Once linked, resend DISCOVER (until an OFFER) or REQUEST (until the ACK) ~1.2s.
  if (st == DONE && !g_leased && millis() - t > 1200) {
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
    if (s == 2) { // Established: echo any request bytes
      uint8_t rb[600];
      uint32_t rn = ns_tcp_recv(rb, sizeof(rb));
      if (rn > 0) {
        Serial.printf("*** SERVER RX %u B — echoing ***\n", rn);
        uint8_t seg[700];
        uint32_t sn = ns_tcp_send(rb, rn, seg, sizeof(seg));
        if (sn > 0) send_ip(seg, sn);
      }
    } else if (s == 4 || s == 0) { // Done/Closed: re-arm the listener for the next client
      static uint32_t niss = 0x4000;
      ns_tcp_listen(g_offer_ip, SERVER_PORT, niss);
      niss += 0x1000;
      Serial.println("*** SERVER re-listening ***");
    }
  } else if (st == DONE && g_tcp_started) {
    // Client mode (original outbound echo test).
    if (ns_tcp_state() == 2 && !g_tcp_requested) {
      const char *req = "HELLO-FROM-HEAPLESS\n";
      uint8_t seg[128];
      uint32_t n = ns_tcp_send((const uint8_t *)req, strlen(req), seg, sizeof(seg));
      if (n > 0) { send_ip(seg, n); g_tcp_requested = true; Serial.println("TCP ESTABLISHED — request sent"); }
    }
    uint8_t rb[256];
    uint32_t rn = ns_tcp_recv(rb, sizeof(rb) - 1);
    if (rn > 0) { rb[rn] = 0; Serial.printf("*** TCP RX (%u B): %s ***\n", rn, (char *)rb); }
  }
}
