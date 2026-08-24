// wifi_hw_rx_test — bring up the STA RX datapath the PROPER way (no promiscuous) via
// the vendor lower-MAC surface, so the hardware crypto engine stays inline. If our RX
// ring receives beacons/frames with this path, HW-accelerated CCMP becomes viable.
//
//   ic_set_mac(0, our_mac)      -> own-address filter slot 0
//   ic_set_bssid(0, bssid)      -> BSSID filter slot 0
//   ic_set_rx_policy(0, 0, 1, 1)-> connected-STA accept policy (from wifi_set_rx_policy)
//   ic_enable_rx()              -> RX enable (0x600A_4080 bit31)

#include <Arduino.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <string.h>

SET_LOOP_TASK_STACK_SIZE(16384);

extern "C" {
void ns_mac_rx_install();
uint32_t ns_mac_recv(uint8_t *out, uint32_t cap);
// Vendor lower-MAC RX bring-up (libpp).
void ic_set_mac(uint32_t slot, const uint8_t *mac);
void ic_set_bssid(uint32_t slot, const uint8_t *bssid);
uint32_t ic_set_rx_policy(uint32_t vif, uint32_t a1, uint32_t a2, uint32_t a3);
void ic_enable_rx();
void ic_rx_enable_bssid_check(uint32_t vif);
}

namespace {
const uint8_t BSSID[6] = {0xb8, 0x27, 0xeb, 0xbb, 0x8d, 0xf8};
uint8_t OUR_MAC[6] = {0x02, 0x0c, 0x6a, 0x11, 0x22, 0x33};
constexpr uint8_t CHAN = 6;
inline void wreg(uintptr_t a, uint32_t v) { *reinterpret_cast<volatile uint32_t *>(a) = v; }
} // namespace

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("wifi_hw_rx_test: STA RX via vendor lower-MAC (NO promiscuous)");
  WiFi.mode(WIFI_STA);
  esp_wifi_start();
  esp_wifi_set_channel(CHAN, WIFI_SECOND_CHAN_NONE);
  delay(200);
  wreg(0x60010000, 0); // detach vendor ISR

  // Program the STA RX filter the vendor way (no promiscuous).
  ic_set_mac(0, OUR_MAC);
  ic_set_bssid(0, BSSID);
  ic_set_rx_policy(0, 0, 1, 1);
  ic_rx_enable_bssid_check(0);
  ic_enable_rx();
  ns_mac_rx_install();
  esp_wifi_set_channel(CHAN, WIFI_SECOND_CHAN_NONE);

  Serial.printf("rx_ctrl(0x600a4080)=%08x policy(0x600a40d8)=%08x\n",
                *(volatile uint32_t *)0x600A4080, *(volatile uint32_t *)0x600A40D8);

  uint8_t rx[400];
  uint32_t beacons = 0, frames = 0;
  for (int i = 0; i < 800; i++) {
    uint32_t n = ns_mac_recv(rx, sizeof(rx));
    if (n) { frames++; if (rx[0] == 0x80) beacons++; }
    delay(3);
  }
  Serial.printf("NON-PROMISCUOUS RX: frames=%u beacons=%u\n", frames, beacons);
}

void loop() { delay(1000); }
