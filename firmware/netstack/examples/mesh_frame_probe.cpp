// mesh_frame_probe — the C6's view of Splanc mesh frames, for the Pi transport bench
// (docs/design/mesh-pi-transport.md §4). Vendor esp_wifi, not our netstack: an oracle for
// RSSI and frame bytes until M3's netstack backhaul exists.
//
// On channel MESH_CH, unassociated, promiscuous on management frames:
//   RX: every Splanc mesh frame (Public Action 04 09 + CID 0A 5C 4D + kind 01, or the first
//       draft's 7F + CID) -> "mrx,<sa>,<probe seq or -1>,<rssi>,<rate>,<len>,<t_us>"
//   TX: every TX_MS a broadcast Splanc frame (the reference layout of
//       pi/mesh_radio/src/frame.rs) carrying a "PRB" probe -> "mtx,<seq>,<err>"
// A Pi running `pimesh listen` logs the C6's frames with its RSSI, so both views of the one
// link are compared.

#include <Arduino.h>
#include <WiFi.h>
#include <esp_timer.h>
#include <esp_wifi.h>

SET_LOOP_TASK_STACK_SIZE(16384);

#ifndef MESH_CH
#define MESH_CH 1
#endif
// Stop transmitting (and go quiet) after this long, so a probe left on a shared rig
// does not keep using its channel's airtime.
#ifndef RUN_MS
#define RUN_MS 150000
#endif
#ifndef TX_MS
#define TX_MS 100
#endif

namespace {

struct Rec {
  uint8_t sa[6];
  uint8_t a1[6];
  uint8_t a3[6];
  uint16_t seqctl;
  int32_t seq;
  int8_t rssi;
  uint8_t rate;
  uint16_t len;
  int64_t t_us;
};
constexpr int kRing = 64;
Rec g_ring[kRing];
volatile uint32_t g_head = 0, g_tail = 0, g_dropped = 0, g_seen = 0;

constexpr uint8_t kPublic[6] = {0x04, 0x09, 0x0a, 0x5c, 0x4d, 0x01};
constexpr uint8_t kVendor[5] = {0x7f, 0x0a, 0x5c, 0x4d, 0x01};

void IRAM_ATTR on_rx(void *buf, wifi_promiscuous_pkt_type_t type) {
  if (type != WIFI_PKT_MGMT) return;
  auto *p = static_cast<wifi_promiscuous_pkt_t *>(buf);
  const uint8_t *f = p->payload;
  int len = p->rx_ctrl.sig_len - 4;  // without FCS
  if (len < 24 + 6 || f[0] != 0xd0) return;
  const uint8_t *body = f + 24;
  int off;
  if (memcmp(body, kPublic, 6) == 0) {
    off = 6;
  } else if (memcmp(body, kVendor, 5) == 0) {
    off = 5;
  } else {
    return;
  }
  g_seen++;
  uint32_t h = g_head;
  if (h - g_tail >= kRing) {
    g_dropped++;
    return;
  }
  Rec &r = g_ring[h % kRing];
  memcpy(r.sa, f + 10, 6);
  memcpy(r.a1, f + 4, 6);
  memcpy(r.a3, f + 16, 6);
  r.seqctl = f[22] | (f[23] << 8);
  const uint8_t *m = body + off;
  int mlen = len - 24 - off;
  r.seq = (mlen >= 8 && m[0] == 'P' && m[1] == 'R' && m[2] == 'B')
              ? (int32_t)(m[4] | (m[5] << 8) | (m[6] << 16) | ((uint32_t)m[7] << 24))
              : -1;
  r.rssi = p->rx_ctrl.rssi;
  r.rate = p->rx_ctrl.rate;
  r.len = len;
  r.t_us = esp_timer_get_time();
  g_head = h + 1;
}

uint8_t g_mac[6];
uint32_t g_tx_seq = 0;

void send_probe() {
  uint8_t f[24 + 6 + 64] = {0};
  f[0] = 0xd0;
  memset(f + 4, 0xff, 6);
  memcpy(f + 10, g_mac, 6);
  memset(f + 16, 0xff, 6);
  memcpy(f + 24, kPublic, 6);
  uint8_t *m = f + 30;
  m[0] = 'P'; m[1] = 'R'; m[2] = 'B'; m[3] = 1;
  memcpy(m + 4, &g_tx_seq, 4);
  int64_t t = esp_timer_get_time();
  memcpy(m + 8, &t, 8);
  esp_err_t e = esp_wifi_80211_tx(WIFI_IF_STA, f, sizeof(f), true);
  Serial.printf("mtx,%lu,%d\n", (unsigned long)g_tx_seq, (int)e);
  g_tx_seq++;
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(200);
  WiFi.mode(WIFI_STA);
  esp_wifi_start();
  esp_wifi_get_mac(WIFI_IF_STA, g_mac);
  wifi_promiscuous_filter_t filt = {.filter_mask = WIFI_PROMIS_FILTER_MASK_MGMT};
  esp_wifi_set_promiscuous_filter(&filt);
  esp_wifi_set_promiscuous_rx_cb(&on_rx);
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_channel(MESH_CH, WIFI_SECOND_CHAN_NONE);
  Serial.printf("mesh_frame_probe ch=%d mac=%02x:%02x:%02x:%02x:%02x:%02x\n", MESH_CH, g_mac[0], g_mac[1],
                g_mac[2], g_mac[3], g_mac[4], g_mac[5]);
}

void loop() {
  static int64_t next_tx = 0;
  while (g_tail != g_head) {
    const Rec &r = g_ring[g_tail % kRing];
    Serial.printf("mrx,%02x:%02x:%02x:%02x:%02x:%02x,%ld,%d,%u,%u,%lld,a1=%02x:%02x:%02x:%02x:%02x:%02x,a3=%02x:%02x:%02x:%02x:%02x:%02x,sc=%04x\n",
                  r.sa[0], r.sa[1], r.sa[2], r.sa[3], r.sa[4], r.sa[5], (long)r.seq, r.rssi, r.rate, r.len, (long long)r.t_us,
                  r.a1[0], r.a1[1], r.a1[2], r.a1[3], r.a1[4], r.a1[5], r.a3[0], r.a3[1], r.a3[2], r.a3[3], r.a3[4], r.a3[5],
                  r.seqctl);
    g_tail++;
  }
  int64_t now = esp_timer_get_time();
  static bool stopped = false;
  if (!stopped && now >= (int64_t)RUN_MS * 1000) {
    esp_wifi_set_promiscuous(false);
    esp_wifi_stop();
    Serial.println("mesh_frame_probe: run time over, radio off");
    stopped = true;
  }
  if (stopped) {
    delay(1000);
    return;
  }
  if (now >= next_tx) {
    send_probe();
    next_tx = now + TX_MS * 1000;
  }
  static int64_t next_stat = 0;
  if (now >= next_stat) {
    Serial.printf("mstat,seen=%lu,dropped=%lu\n", (unsigned long)g_seen, (unsigned long)g_dropped);
    next_stat = now + 5000000;
  }
  delay(2);
}
