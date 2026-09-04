// wifi_sniff — a promiscuous 802.11 data-frame sniffer (diagnostic oracle).
//
// Runs the vendor esp_wifi in promiscuous mode on a fixed channel and prints a
// one-line summary of every DATA frame involving a target BSSID: direction
// (uplink/downlink), QoS vs non-QoS subtype, Protected bit, source MAC, 802.11
// sequence number, and length. Purpose: compare, byte-visible, how our heapless
// netstack STA frames the air vs how a real client does — e.g. QoS (0x88) vs
// non-QoS (0x08) data, and whether our transmit sequence numbers increment.
//
// Not part of the stack; a measurement tool. Flash on a SPARE C6 near the AP while
// the DUT under test associates, and read its serial. Channel + BSSID prefix are
// compile-time constants below (default: CoolerKids mesh, 3c:52:a1:fe:39, ch 9).

#include <Arduino.h>
#include <WiFi.h>
#include <string.h>

#include "esp_wifi.h"

namespace {

// The mesh advertises several BSSIDs sharing this 5-byte OUI+prefix; match any.
const uint8_t BSSID_PREFIX[5] = {0x3c, 0x52, 0xa1, 0xfe, 0x39};
constexpr uint8_t CHANNEL = 9;

struct Rec {
  uint16_t len;
  uint16_t seq;
  uint8_t fc0, fc1;
  uint8_t a2[6];
};
volatile uint32_t g_head = 0, g_tail = 0;
Rec g_ring[256];

inline bool is_target(const uint8_t *m) { return memcmp(m, BSSID_PREFIX, 5) == 0; }

// Promiscuous RX callback (WiFi-task context). Keep it cheap: filter + enqueue.
void on_rx(void *buf, wifi_promiscuous_pkt_type_t /*type*/) {
  auto *p = static_cast<wifi_promiscuous_pkt_t *>(buf);
  const uint8_t *f = p->payload;
  int len = p->rx_ctrl.sig_len;
  if (!f || len < 24) return;
  if ((f[0] & 0x0c) != 0x08) return;  // Data frames only (type = 10b)
  const uint8_t *a1 = f + 4, *a2 = f + 10, *a3 = f + 16;
  if (!is_target(a1) && !is_target(a2) && !is_target(a3)) return;  // our BSSID only
  uint32_t h = g_head;
  if (h - g_tail >= 256) return;  // ring full; drop
  Rec &r = g_ring[h & 255];
  r.len = static_cast<uint16_t>(len);
  r.seq = static_cast<uint16_t>((f[23] << 4) | (f[22] >> 4));  // SeqNum bits 15:4
  r.fc0 = f[0];
  r.fc1 = f[1];
  memcpy(r.a2, a2, 6);
  g_head = h + 1;
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.printf("wifi_sniff: promiscuous DATA sniffer, BSSID %02x:%02x:%02x:%02x:%02x:xx, ch %u\n",
                BSSID_PREFIX[0], BSSID_PREFIX[1], BSSID_PREFIX[2], BSSID_PREFIX[3], BSSID_PREFIX[4],
                CHANNEL);
  WiFi.mode(WIFI_STA);
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_channel(CHANNEL, WIFI_SECOND_CHAN_NONE);
  esp_wifi_set_promiscuous_rx_cb(&on_rx);
  Serial.println("wifi_sniff: up. columns = dir fc qos/P src seq len");
}

void loop() {
  while (g_tail != g_head) {
    Rec r = g_ring[g_tail & 255];
    g_tail++;
    const char *dir = (r.fc1 & 0x01) ? "up" : ((r.fc1 & 0x02) ? "dn" : "??");
    bool qos = (r.fc0 & 0xf0) == 0x80;  // subtype 8 within Data type = QoS Data
    bool prot = r.fc1 & 0x40;
    Serial.printf("[D] %s fc=%02x%02x %s%s src=%02x:%02x:%02x:%02x:%02x:%02x seq=%u len=%u\n", dir,
                  r.fc0, r.fc1, qos ? "QOS" : "non", prot ? "/P" : "  ", r.a2[0], r.a2[1], r.a2[2],
                  r.a2[3], r.a2[4], r.a2[5], r.seq, r.len);
  }
  delay(40);
}
