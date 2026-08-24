// wifi_hw_rx_test — channel-6 promiscuous SNIFFER. Runs on a second DUT to capture the
// FIRST DUT's transmitted data frames (from OUI 02:0c:6a) and show whether the payload
// after the CCMP header is CIPHERTEXT (HW encrypted) or "aa aa 03" LLC (cleartext) —
// the definitive test of whether our HW-encrypt TX actually encrypts.

#include <Arduino.h>
#include <WiFi.h>
#include <esp_wifi.h>

SET_LOOP_TASK_STACK_SIZE(16384);

namespace {
volatile uint32_t g_seen = 0, g_total = 0, g_beacon = 0, g_from_ap = 0;
void IRAM_ATTR on_rx(void *buf, wifi_promiscuous_pkt_type_t type) {
  auto *p = static_cast<wifi_promiscuous_pkt_t *>(buf);
  const uint8_t *f = p->payload;
  int len = p->rx_ctrl.sig_len;
  g_total++;
  if (len >= 16) {
    if (f[0] == 0x80) g_beacon++;
    // any frame involving the rig-3 AP (b8:27:eb) in a1/a2/a3
    if (f[10] == 0xb8 && f[11] == 0x27 && f[12] == 0xeb) g_from_ap++;
  }
  if (len < 40) return;
  // Data frame whose a2 (transmitter) is our OUI 02:0c:6a (the STA-under-test).
  if ((f[0] & 0x0c) != 0x08) return;
  if (!(f[10] == 0x02 && f[11] == 0x0c && f[12] == 0x6a)) return;
  if (g_seen++ > 40) return;
  int hl = (f[0] & 0x88) == 0x88 ? 26 : 24; // QoS?
  const uint8_t *ccmp = f + hl;
  const uint8_t *pl = ccmp + 8; // payload after CCMP header
  Serial.printf("TX fc=%02x%02x prot=%d len=%d ccmp=[%02x %02x %02x %02x %02x] payload=[%02x %02x %02x %02x %02x %02x]\n",
                f[0], f[1], (f[1] & 0x40) ? 1 : 0, len,
                ccmp[0], ccmp[1], ccmp[2], ccmp[3], ccmp[4],
                pl[0], pl[1], pl[2], pl[3], pl[4], pl[5]);
}
} // namespace

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("wifi_hw_rx_test: channel-6 sniffer for OUI 02:0c:6a TX frames");
  WiFi.mode(WIFI_STA);
  esp_wifi_start();
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_promiscuous_rx_cb(&on_rx);
  esp_wifi_set_channel(6, WIFI_SECOND_CHAN_NONE);
  Serial.println("sniffing ch6...");
}

void loop() {
  delay(2000);
  Serial.printf("total=%u beacons=%u from_ap(b8:27:eb)=%u our_tx=%u\n",
                g_total, g_beacon, g_from_ap, g_seen);
}
