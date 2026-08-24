// wifi_hw_rx_test — bring up CONTINUOUS STA RX (no promiscuous) so the hardware crypto
// engine stays inline. A scan proved continuous RX reaches our ring; the disconnected
// STA otherwise duty-cycles (sleeps) and RX stalls. Sequence (all in the WiFi-task
// context via the ioctl marshal): wifi_hw_stop -> wifi_hw_start -> ic_set_vif(STA) ->
// pm_disconnected_stop + pm_go_to_wake (stop the sleep, force the MAC awake).

#include <Arduino.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <string.h>

SET_LOOP_TASK_STACK_SIZE(16384);

extern "C" {
void ns_mac_rx_install();
uint32_t ns_mac_recv(uint8_t *out, uint32_t cap);
void ic_set_mac(uint32_t slot, const uint8_t *mac);
void ic_set_bssid(uint32_t slot, const uint8_t *bssid);
uint32_t ic_set_rx_policy(uint32_t vif, uint32_t a1, uint32_t a2, uint32_t a3);
void ic_enable_rx();
void ic_rx_enable_bssid_check(uint32_t vif);
void wifi_hw_start(uint32_t vif);
void wifi_hw_stop(uint32_t vif);
uint32_t ic_set_vif(uint32_t vif, uint32_t mode, const uint8_t *mac, uint32_t a3, uint32_t a4);
int ieee80211_ioctl(void *req);
// PM: stop the disconnected duty-cycle sleep + force the MAC awake -> continuous RX.
void pm_disconnected_stop();
void pm_go_to_wake();
}

const uint8_t OUR_MAC_G[6] = {0x02, 0x0c, 0x6a, 0x11, 0x22, 0x33};

extern "C" void rx_start_handler(void *req) {
  (void)req;
  wifi_hw_stop(0);
  wifi_hw_start(0);
  ic_set_vif(0, 0, OUR_MAC_G, 0, 0);
  pm_disconnected_stop(); // stop the disconnected duty-cycled sleep
  pm_go_to_wake();        // force awake -> RX stays on
  Serial.println("  [handler] sequence done");
}

namespace {
const uint8_t BSSID[6] = {0xb8, 0x27, 0xeb, 0xbb, 0x8d, 0xf8};
const uint8_t *const OUR_MAC = OUR_MAC_G;
constexpr uint8_t CHAN = 6;
inline void wreg(uintptr_t a, uint32_t v) { *reinterpret_cast<volatile uint32_t *>(a) = v; }
inline uint32_t rreg(uintptr_t a) { return *reinterpret_cast<volatile uint32_t *>(a); }
} // namespace

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("wifi_hw_rx_test: continuous STA RX via pm_go_to_wake (no promiscuous)");
  WiFi.mode(WIFI_STA);
  esp_wifi_start();
  esp_wifi_set_ps(WIFI_PS_NONE);
  esp_wifi_set_channel(CHAN, WIFI_SECOND_CHAN_NONE);
  delay(150);

  wreg(0x60010000, 0);
  ns_mac_rx_install();

  Serial.println("ioctl(rx_start_handler)...");
  uint32_t *req = static_cast<uint32_t *>(malloc(24));
  memset(req, 0, 24);
  reinterpret_cast<uint8_t *>(req)[0] = 23;
  req[1] = reinterpret_cast<uint32_t>(&rx_start_handler);
  int r = ieee80211_ioctl(req);
  Serial.printf("ioctl returned %d\n", r);
  wreg(0x60010000, 0);

  ic_set_mac(0, OUR_MAC);
  ic_set_bssid(0, BSSID);
  ic_set_rx_policy(0, 0, 1, 1);
  ic_rx_enable_bssid_check(0);
  ic_enable_rx();
  ns_mac_rx_install();
  esp_wifi_set_channel(CHAN, WIFI_SECOND_CHAN_NONE);

  uint8_t rx[400];
  uint32_t frames = 0, beacons = 0;
  for (int i = 0; i < 1000; i++) {
    uint32_t n = ns_mac_recv(rx, sizeof(rx));
    if (n) { frames++; if (rx[0] == 0x80) beacons++; }
    if (i % 250 == 0)
      Serial.printf("  i=%d next=%08x int=%08x frames=%u\n", i, rreg(0x600A4088), rreg(0x600A4C48), frames);
    delay(2);
  }
  Serial.printf("CONTINUOUS STA RX (no promiscuous, crypto inline): frames=%u beacons=%u\n", frames, beacons);
}

void loop() { delay(1000); }
