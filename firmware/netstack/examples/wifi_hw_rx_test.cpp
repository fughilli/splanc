// wifi_hw_rx_test — channel-6 promiscuous SNIFFER (v2, unfiltered). Runs on a SECOND DUT
// to capture the first DUT's transmitted frames. v2 resolves the "is the HW-encrypt frame
// on the air?" question: it accepts ALL promiscuous frame types, matches our OUI 02:0c:6a
// in ANY address field (a1/a2/a3), logs the frame-control, rate/sig_mode, protected bit,
// and the payload after the CCMP header (ciphertext vs "aa aa 03" LLC), and separately
// flags any Deauth/Disassoc from the AP (b8:27:eb).

#include <Arduino.h>
#include <WiFi.h>
#include <esp_wifi.h>

SET_LOOP_TASK_STACK_SIZE(16384);

namespace {
volatile uint32_t g_seen = 0, g_total = 0, g_beacon = 0, g_from_ap = 0, g_our_any = 0, g_deauth = 0;

bool is_our_oui(const uint8_t *a) { return a[0] == 0x02 && a[1] == 0x0c && a[2] == 0x6a; }

void IRAM_ATTR on_rx(void *buf, wifi_promiscuous_pkt_type_t type) {
  auto *p = static_cast<wifi_promiscuous_pkt_t *>(buf);
  const uint8_t *f = p->payload;
  int len = p->rx_ctrl.sig_len;
  g_total++;
  if (len < 16) return;
  if (f[0] == 0x80) g_beacon++;
  if (f[10] == 0xb8 && f[11] == 0x27 && f[12] == 0xeb) g_from_ap++;

  // Deauth (0xc0) / Disassoc (0xa0) from the AP -> log the reason code (MIC failure = 15).
  if ((f[0] == 0xc0 || f[0] == 0xa0) && len >= 26 &&
      f[16] == 0xb8 && f[17] == 0x27 && f[18] == 0xeb) {
    if (g_deauth++ < 8)
      Serial.printf("AP DEAUTH/DISASSOC fc=%02x reason=%u\n", f[0], f[24] | (f[25] << 8));
    return;
  }

  // Any QoS-data frame (fc byte0 == 0x88) — log full addr2/addr1 + protected bit + payload,
  // to catch a vendor-path TX even if addr2 was rewritten off our OUI.
  if (f[0] == 0x88 && len >= 34) {
    static uint32_t qd = 0;
    if (qd++ < 20) {
      const uint8_t *pl = f + 26 + 8; // after 26B QoS hdr + 8B CCMP IV
      Serial.printf("QOSDATA prot=%d a1=%02x:%02x:%02x:%02x:%02x:%02x a2=%02x:%02x:%02x:%02x:%02x:%02x len=%d pay=[%02x %02x %02x %02x]\n",
                    (f[1] & 0x40) ? 1 : 0, f[4], f[5], f[6], f[7], f[8], f[9],
                    f[10], f[11], f[12], f[13], f[14], f[15], len, pl[0], pl[1], pl[2], pl[3]);
    }
  }
  // Any frame with our OUI in addr1, addr2, or addr3.
  bool a1 = is_our_oui(f + 4), a2 = is_our_oui(f + 10), a3 = len >= 22 && is_our_oui(f + 16);
  if (!(a1 || a2 || a3)) return;
  g_our_any++;
  if ((f[0] & 0x0c) != 0x08) return; // only dump DATA frames past here
  if (g_seen++ > 60) return;
  int hl = (f[0] & 0x88) == 0x88 ? 26 : 24; // QoS?
  const uint8_t *ccmp = f + hl;
  const uint8_t *pl = ccmp + 8;
  Serial.printf("OURTX fc=%02x%02x prot=%d a1a2a3=%d%d%d len=%d rate=%d ccmp=[%02x %02x %02x %02x] pay=[%02x %02x %02x %02x %02x %02x]\n",
                f[0], f[1], (f[1] & 0x40) ? 1 : 0, a1, a2, a3, len, p->rx_ctrl.rate,
                ccmp[0], ccmp[1], ccmp[2], ccmp[3],
                pl[0], pl[1], pl[2], pl[3], pl[4], pl[5]);
}
} // namespace

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("wifi_hw_rx_test v2: ch6 UNFILTERED sniffer, OUI 02:0c:6a in any addr");
  WiFi.mode(WIFI_STA);
  esp_wifi_start();
  wifi_promiscuous_filter_t filt = {.filter_mask = WIFI_PROMIS_FILTER_MASK_ALL};
  esp_wifi_set_promiscuous_filter(&filt);
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_promiscuous_rx_cb(&on_rx);
  esp_wifi_set_channel(6, WIFI_SECOND_CHAN_NONE);
  Serial.println("sniffing ch6...");
}

void loop() {
  delay(2000);
  Serial.printf("total=%u beacons=%u from_ap=%u our_any=%u our_data=%u deauth=%u\n",
                g_total, g_beacon, g_from_ap, g_our_any, g_seen, g_deauth);
}
