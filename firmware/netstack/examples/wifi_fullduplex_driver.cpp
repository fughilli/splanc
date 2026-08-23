// wifi_fullduplex_driver — validate the FULL heapless MAC data path at once:
// our RX descriptor ring (M0b) + our own WiFi-MAC ISR (M5) + our TX recipe (M1),
// with NO vendor RX callback. The vendor only owns the PHY/clock/channel; every
// frame in and out goes through our reverse-engineered rings.
//
// Proof: receive real beacons on our ring AND transmit probe requests whose
// responses (to our unique SA) also land on our ring — bidirectional heapless MAC
// on a single radio. This is the combined path live STA association will run on.

#include <Arduino.h>
#include <WiFi.h>
#include <esp_intr_alloc.h>
#include <esp_wifi.h>
#include <soc/interrupts.h>
#include <string.h>

SET_LOOP_TASK_STACK_SIZE(20480);

extern "C" {
void ns_mac_rx_install();
uint32_t ns_mac_recv(uint8_t *out, uint32_t cap);
uint32_t ns_mac_send(const uint8_t *frame, uint32_t len, uint32_t queue);
}

namespace {
constexpr uintptr_t WIFI_MAC_INTR_MAP = 0x60010000;
constexpr uintptr_t INT_STATUS = 0x600A4C48, INT_CLEAR = 0x600A4C4C;
const uint8_t OUR_MAC[6] = {0x02, 0x11, 0x22, 0x33, 0x44, 0x77};
inline uint32_t reg(uintptr_t a) { return *reinterpret_cast<volatile uint32_t *>(a); }
inline void wreg(uintptr_t a, uint32_t v) { *reinterpret_cast<volatile uint32_t *>(a) = v; }

volatile uint32_t g_isr = 0;
intr_handle_t g_h = nullptr;
void IRAM_ATTR our_isr(void *) {
  uint32_t st = reg(INT_STATUS);
  g_isr++;
  wreg(INT_CLEAR, st ? st : 0xffffffff);
}
void IRAM_ATTR sink(void *, wifi_promiscuous_pkt_type_t) {}

int build_probe(uint8_t *f) {
  int n = 0;
  f[n++] = 0x40; f[n++] = 0x00; f[n++] = 0x00; f[n++] = 0x00;
  for (int i = 0; i < 6; i++) f[n++] = 0xff;          // DA broadcast
  for (int i = 0; i < 6; i++) f[n++] = OUR_MAC[i];    // SA = our unique MAC
  for (int i = 0; i < 6; i++) f[n++] = 0xff;          // BSSID broadcast
  f[n++] = 0x00; f[n++] = 0x00;                       // seq
  f[n++] = 0x00; f[n++] = 0x00;                       // wildcard SSID
  const uint8_t r[] = {0x01, 0x08, 0x82, 0x84, 0x8b, 0x96, 0x12, 0x24, 0x48, 0x6c};
  memcpy(f + n, r, sizeof(r)); n += sizeof(r);
  return n;
}
} // namespace

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("wifi_fullduplex_driver: heapless RX ring + our ISR + heapless TX");
  WiFi.mode(WIFI_STA);
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_promiscuous_rx_cb(&sink);
  esp_wifi_set_channel(6, WIFI_SECOND_CHAN_NONE);
  delay(400);
  wreg(WIFI_MAC_INTR_MAP, 0);
  ns_mac_rx_install();
  esp_err_t e = esp_intr_alloc(ETS_WIFI_MAC_INTR_SOURCE, ESP_INTR_FLAG_IRAM, &our_isr, nullptr, &g_h);
  Serial.printf("our ISR: %s\n", e == ESP_OK ? "installed" : "FAILED");
}

void loop() {
  static uint32_t beacons = 0, probe_resp = 0, other = 0;
  uint8_t pf[64];
  int pn = build_probe(pf);
  esp_wifi_set_channel(6, WIFI_SECOND_CHAN_NONE); // re-kick the RX DMA onto our ring
  uint8_t rx[512];
  for (int i = 0; i < 60; i++) {
    ns_mac_send(pf, pn, 0); // TX a probe via our heapless TX
    // Drain our RX ring (fed by our ISR/DMA).
    for (int k = 0; k < 4; k++) {
      uint32_t n = ns_mac_recv(rx, sizeof(rx));
      if (!n) break;
      if (rx[0] == 0x80) beacons++;
      else if (rx[0] == 0x50 && !memcmp(rx + 4, OUR_MAC, 6)) probe_resp++;
      else other++;
    }
    delay(3);
  }
  Serial.printf("HEAPLESS full-duplex: isr=%u | RX beacons=%u probe_resp_to_us=%u other=%u\n",
                g_isr, beacons, probe_resp, other);
}
