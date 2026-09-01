// wifi_auth_replay — replay the vendor's captured auth frame + its rate registers
// via our TX mechanism, to confirm the frame/PLCP1 diff is what makes the AP answer
// the vendor's auth but not ours. If an auth response to our (real) MAC arrives,
// the fix is: match the vendor's PLCP1 (802.11 length + FCS) / frame bytes.

#include <Arduino.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <string.h>

SET_LOOP_TASK_STACK_SIZE(16384);

namespace {
constexpr uintptr_t TXQ_PLCP0_BASE = 0x600A4D6C;
const uint8_t AP_BSSID[6] = {0xb8, 0x27, 0xeb, 0xbb, 0x8d, 0xf8};
uint8_t OUR_MAC[6];
inline void wreg(uintptr_t a, uint32_t v) { *reinterpret_cast<volatile uint32_t *>(a) = v; }
inline uint32_t plcp0_for_desc(uint32_t d) {
  return ((d - 0x40800000u) & 0x7ffffu) | 0x00600000u | 0xC0000000u;
}

// 8-byte TX header + the 30-byte standard open-auth 802.11 frame (we rebuild it
// with our real MAC; the vendor's captured trailer 04 42 was FCS-space padding).
uint8_t g_buf[64] __attribute__((aligned(4)));
uint32_t g_desc[3] __attribute__((aligned(16)));
uint32_t g_flen = 0;

volatile uint32_t g_auth_resp = 0, g_probe_resp = 0;
void IRAM_ATTR on_rx(void *buf, wifi_promiscuous_pkt_type_t) {
  auto *p = static_cast<wifi_promiscuous_pkt_t *>(buf);
  const uint8_t *f = p->payload;
  if (p->rx_ctrl.sig_len < 24) return;
  bool from_ap = !memcmp(f + 10, AP_BSSID, 6), to_us = !memcmp(f + 4, OUR_MAC, 6);
  if (from_ap && to_us && f[0] == 0xb0) g_auth_resp++;
  if (from_ap && to_us && f[0] == 0x50) g_probe_resp++;
}

int build_auth(uint8_t *f) {
  int n = 0;
  f[n++] = 0xb0; f[n++] = 0x00; f[n++] = 0x00; f[n++] = 0x00;
  memcpy(f + n, AP_BSSID, 6); n += 6;
  memcpy(f + n, OUR_MAC, 6); n += 6;
  memcpy(f + n, AP_BSSID, 6); n += 6;
  f[n++] = 0x00; f[n++] = 0x00;             // seq
  f[n++] = 0x00; f[n++] = 0x00;             // algo = open
  f[n++] = 0x01; f[n++] = 0x00;             // trans seq = 1
  f[n++] = 0x00; f[n++] = 0x00;             // status = 0
  return n; // 30
}

// Arm a TX of g_buf via our descriptor+PLCP0, with PLCP1 = 802.11 length + FCS(4).
void tx_auth() {
  uint32_t q = 0, s = 0;
  wreg(0x600A4D68, 0x120013ff);             // seq/dur (vendor value)
  wreg(0x600A5488 - s, (g_flen + 4) & 0xfff); // PLCP1 = length + FCS  <-- the fix
  wreg(0x600A548C - s, 0x00020000);
  wreg(0x600A5490 - s, 0x00111110);
  wreg(0x600A54AC - s, 0x14140014);
  wreg(0x600A54B0 - s, 0x00004081);
  wreg(0x600A54B4 - s, 0x00400000);
  wreg(0x600A54B8 - s, 0x00400000);
  wreg(0x600A54BC - s, 0x00400004);
  uint32_t total = 8 + g_flen;
  g_desc[0] = 0x80000000u | 0x40000000u | ((total & 0x3fff) << 14) | (total & 0x3fff);
  g_desc[1] = reinterpret_cast<uint32_t>(&g_buf[0]);
  g_desc[2] = 0;
  wreg(TXQ_PLCP0_BASE - q * 0x10, plcp0_for_desc(reinterpret_cast<uint32_t>(&g_desc[0])));
}
} // namespace

void setup() {
  Serial.begin(115200);
  delay(300);
  WiFi.mode(WIFI_STA);
  esp_wifi_start();
  esp_wifi_get_mac(WIFI_IF_STA, OUR_MAC);
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_promiscuous_rx_cb(&on_rx);
  esp_wifi_set_channel(6, WIFI_SECOND_CHAN_NONE);
  Serial.printf("wifi_auth_replay: our MAC %02x:%02x:%02x:%02x:%02x:%02x, PLCP1=len+4 (FCS)\n",
                OUR_MAC[0], OUR_MAC[1], OUR_MAC[2], OUR_MAC[3], OUR_MAC[4], OUR_MAC[5]);
  uint8_t f[40];
  g_flen = build_auth(f);
  memset(g_buf, 0, 8);
  g_buf[0] = (uint8_t)g_flen;
  memcpy(g_buf + 8, f, g_flen);
}

void loop() {
  esp_wifi_set_channel(6, WIFI_SECOND_CHAN_NONE);
  for (int i = 0; i < 40; i++) { tx_auth(); delay(20); }
  Serial.printf("auth_resp_to_us=%u (probe_resp=%u)\n", g_auth_resp, g_probe_resp);
}
