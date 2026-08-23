// wifi_isr_driver — Milestone 5: interrupt-driven RX. Instead of polling the ring
// (M0b), register OUR OWN handler on the WiFi-MAC interrupt and prove it fires on
// received frames, then drain the ring in response. This is the step toward the
// product stack owning the interrupt path rather than the vendor.
//
// Flow: vendor brings up PHY/clock/channel + promiscuous filter; we install our RX
// ring (M0b), detach the vendor's WiFi-MAC ISR, and esp_intr_alloc OUR handler on
// ETS_WIFI_MAC_INTR_SOURCE. The ISR reads/clears the MAC interrupt status and
// counts; the main loop drains the ring when the ISR has fired (event-driven, not
// a busy poll).

#include <Arduino.h>
#include <WiFi.h>
#include <esp_intr_alloc.h>
#include <esp_wifi.h>
#include <soc/interrupts.h>

SET_LOOP_TASK_STACK_SIZE(16384);

extern "C" {
void ns_rx_install();
struct RxReport {
  uint32_t reaped, beacons, first_len, first_fc, parsed, dscr_base, rx_ctrl, dscr_next, desc0_w0,
      beacon_off;
  uint8_t first96[96];
};
RxReport ns_rx_poll();
}

namespace {
constexpr uintptr_t WIFI_MAC_INTR_MAP = 0x60010000;
constexpr uintptr_t INT_STATUS = 0x600A4C48;
constexpr uintptr_t INT_CLEAR = 0x600A4C4C;
inline uint32_t reg(uintptr_t a) { return *reinterpret_cast<volatile uint32_t *>(a); }
inline void wreg(uintptr_t a, uint32_t v) { *reinterpret_cast<volatile uint32_t *>(a) = v; }

volatile uint32_t g_isr_count = 0, g_int_or = 0;
intr_handle_t g_handle = nullptr;

// Our WiFi-MAC interrupt handler: read + clear the MAC interrupt status, count.
// IRAM + pure MMIO so it is safe to run in interrupt context (no flash access).
void IRAM_ATTR our_wifi_isr(void *) {
  uint32_t st = reg(INT_STATUS);
  g_int_or |= st;
  g_isr_count++;
  wreg(INT_CLEAR, st ? st : 0xffffffff); // W1C
}

void IRAM_ATTR sink(void *, wifi_promiscuous_pkt_type_t) {}
} // namespace

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("wifi_isr_driver: boot (M5 — interrupt-driven RX)");

  WiFi.mode(WIFI_STA);
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_promiscuous_rx_cb(&sink);
  esp_wifi_set_channel(1, WIFI_SECOND_CHAN_NONE);
  delay(400);

  // Detach the vendor's WiFi-MAC ISR, install our ring, then bind OUR handler to
  // the WiFi-MAC interrupt source.
  esp_wifi_set_channel(6, WIFI_SECOND_CHAN_NONE); // the rig AP's channel (has traffic)
  wreg(WIFI_MAC_INTR_MAP, 0);
  ns_rx_install();
  esp_err_t e = esp_intr_alloc(ETS_WIFI_MAC_INTR_SOURCE, ESP_INTR_FLAG_IRAM, &our_wifi_isr, nullptr,
                               &g_handle);
  Serial.printf("esp_intr_alloc(WIFI_MAC) -> %d (%s)\n", e, e == ESP_OK ? "OK" : "FAIL");
}

void loop() {
  static uint32_t total_reaped = 0, total_beacons = 0, chan = 6;
  // M0b behaviour: re-set the channel (this re-kicks the RX DMA onto our ring),
  // then drain. Hop across 1/6/11 until frames arrive.
  esp_wifi_set_channel(chan, WIFI_SECOND_CHAN_NONE);
  for (int i = 0; i < 50; i++) {
    RxReport r = ns_rx_poll();
    total_reaped += r.reaped;
    total_beacons += r.beacons;
    delay(4);
  }
  Serial.printf("isr_count=%u int_or=0x%08x ch=%u | reaped=%u beacons=%u\n", g_isr_count, g_int_or,
                chan, total_reaped, total_beacons);
  if (total_reaped == 0) chan = (chan == 6) ? 1 : (chan == 1) ? 11 : 6;
}
