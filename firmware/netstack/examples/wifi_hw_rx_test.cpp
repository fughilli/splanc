// wifi_hw_rx_test — start the baseband RX the way promiscuous does, but WITHOUT the
// accept-all filter, so the hardware crypto engine stays inline. The promiscuous ioctl
// (wifi_set_promis_process) calls wifi_hw_start(vif) -> chip_enable + pm_disconnected_
// start + pm_mac_wakeup: that is the actual "start receiving" step. We call it directly,
// then apply a real STA RX filter, and check that frames land in our ring.

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
// The baseband RX-start the promiscuous ioctl uses (reversed from wifi_set_promis_process).
void wifi_hw_start(uint32_t vif);
}

namespace {
const uint8_t BSSID[6] = {0xb8, 0x27, 0xeb, 0xbb, 0x8d, 0xf8};
uint8_t OUR_MAC[6] = {0x02, 0x0c, 0x6a, 0x11, 0x22, 0x33};
constexpr uint8_t CHAN = 6;
inline void wreg(uintptr_t a, uint32_t v) { *reinterpret_cast<volatile uint32_t *>(a) = v; }

uint32_t count_rx(int iters, uint32_t *beacons) {
  uint8_t rx[400];
  uint32_t frames = 0;
  *beacons = 0;
  for (int i = 0; i < iters; i++) {
    uint32_t n = ns_mac_recv(rx, sizeof(rx));
    if (n) { frames++; if (rx[0] == 0x80) (*beacons)++; }
    delay(2);
  }
  return frames;
}
} // namespace

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("wifi_hw_rx_test: wifi_hw_start(vif) RX-start, NO promiscuous");
  WiFi.mode(WIFI_STA);
  esp_wifi_start();
  esp_wifi_set_channel(CHAN, WIFI_SECOND_CHAN_NONE);
  delay(150);

  // Start the WiFi hardware RX for vif 0 (chip_enable + pm_disconnected_start). This
  // (re)installs the vendor ISR, so detach it AFTER and poll our ring instead.
  Serial.println("calling wifi_hw_start(0)...");
  wifi_hw_start(0);
  Serial.println("wifi_hw_start returned");
  delay(50);
  wreg(0x60010000, 0); // detach vendor ISR now

  // STA RX filter (no accept-all) + our ring.
  esp_wifi_set_channel(CHAN, WIFI_SECOND_CHAN_NONE);
  ic_set_mac(0, OUR_MAC);
  ic_set_bssid(0, BSSID);
  ic_set_rx_policy(0, 0, 1, 1);
  ic_rx_enable_bssid_check(0);
  ic_enable_rx();
  ns_mac_rx_install();
  esp_wifi_set_channel(CHAN, WIFI_SECOND_CHAN_NONE);

  Serial.printf("rx_ctrl=%08x policy=%08x\n",
                *(volatile uint32_t *)0x600A4080, *(volatile uint32_t *)0x600A40D8);
  uint32_t beacons = 0;
  uint32_t frames = count_rx(700, &beacons);
  Serial.printf("wifi_hw_start RX (no promiscuous): frames=%u beacons=%u\n", frames, beacons);
}

void loop() { delay(1000); }
