// wifi_rx_driver — Milestone 0b: receive real 802.11 beacons into OUR heapless
// MAC RX ring on silicon.
//
// The vendor esp_wifi brings up the closed PHY blob, the MAC clock/power, the
// channel, and a promiscuous RX filter (all the parts the heapless design keeps
// as vendor — "from the PHY blob up"). We then HAND THE RX DESCRIPTOR RING OVER
// to the heapless driver: point RX_DSCR_BASE at our RxRing and poll it. If our
// descriptors fill with real beacons, the RE'd MAC RX path is proven end-to-end.
//
// To keep the vendor's RX ISR from fighting us over the ring, we silence the
// promiscuous callback (set it to a no-op) before the handover; the hardware DMAs
// into whatever ring RX_DSCR_BASE names, and we poll rather than interrupt.

#include <Arduino.h>
#include <WiFi.h>
#include <esp_wifi.h>

SET_LOOP_TASK_STACK_SIZE(16384);

extern "C" {
void ns_rx_install();
struct RxReport {
  uint32_t reaped, beacons, first_len, first_fc, parsed, dscr_base, rx_ctrl,
      dscr_next, desc0_w0, beacon_off;
  uint8_t first96[96];
};
RxReport ns_rx_poll();
}

// INTMTX_CORE0_WIFI_MAC_INTR_MAP_REG (ETS_WIFI_MAC_INTR_SOURCE=0 -> base+0).
// Writing 0 detaches the WiFi MAC interrupt from the CPU, silencing the vendor
// RX ISR (wDev_ProcessRxSucData) so it can't consume/recycle the completions the
// hardware DMAs into OUR ring before we poll them.
constexpr uintptr_t WIFI_MAC_INTR_MAP = 0x60010000;
inline uint32_t reg(uintptr_t a) { return *reinterpret_cast<volatile uint32_t *>(a); }
inline void wreg(uintptr_t a, uint32_t v) { *reinterpret_cast<volatile uint32_t *>(a) = v; }

namespace {
// A no-op promiscuous sink: keeps the MAC in all-frames RX filter but stops the
// vendor path from doing real work over the ring we are about to steal.
void IRAM_ATTR sink(void *, wifi_promiscuous_pkt_type_t) {}
} // namespace

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("wifi_rx_driver: boot (M0b — heapless MAC RX ring on silicon)");

  // Vendor bring-up: PHY blob + MAC clock + channel + promiscuous RX filter.
  WiFi.mode(WIFI_STA);
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_promiscuous_rx_cb(&sink);
  esp_wifi_set_channel(1, WIFI_SECOND_CHAN_NONE);
  delay(400); // let the vendor settle + prove frames are flowing on this channel
  Serial.println("wifi_rx_driver: vendor up on ch1 — handing RX ring to heapless driver");

  // Silence the vendor RX ISR so it can't steal our completions, THEN take over
  // the ring (order: detach first, so no ISR runs between install and detach).
  uint32_t old_map = reg(WIFI_MAC_INTR_MAP);
  wreg(WIFI_MAC_INTR_MAP, 0);
  Serial.printf("wifi_rx_driver: detached vendor WiFi-MAC ISR (map %u -> 0)\n", old_map);
  ns_rx_install();
  Serial.println("wifi_rx_driver: our RxRing installed, RX armed (RX_CTRL|=0x88000000)");
}

void loop() {
  static uint32_t total_reaped = 0, total_beacons = 0, total_parsed = 0;
  static uint32_t chan = 1;
  RxReport r = ns_rx_poll();
  total_reaped += r.reaped;
  total_beacons += r.beacons;
  total_parsed += r.parsed;
  Serial.printf(
      "poll: reaped=%u beacons=%u parsed=%u beacon_off=%d first(len=%u fc=0x%02x) | totals "
      "r=%u b=%u p=%u | NEXT=0x%08x d0.w0=0x%08x ch=%u\n",
      r.reaped, r.beacons, r.parsed, (int)r.beacon_off, r.first_len, r.first_fc,
      total_reaped, total_beacons, total_parsed, r.dscr_next, r.desc0_w0, chan);
  if (r.first_len) {
    Serial.print("  first96:");
    for (int i = 0; i < 96; i++) Serial.printf(" %02x", r.first96[i]);
    Serial.println();
  }
  // If nothing after a couple seconds, hop channels in case ch1 is quiet.
  static uint32_t quiet = 0;
  if (total_reaped == 0 && ++quiet % 4 == 0) {
    chan = (chan == 1) ? 6 : (chan == 6) ? 11 : 1;
    esp_wifi_set_channel(chan, WIFI_SECOND_CHAN_NONE);
  }
  delay(500);
}
