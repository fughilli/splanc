// wifi_hw_rx_test — RE probe for the non-promiscuous STA RX bring-up (so the hardware
// crypto engine stays inline instead of the software-CCMP tax).
//
// FULL TRACE (reversed from libnet80211 / libpp):
//   esp_wifi_set_promiscuous -> ieee80211_ioctl(cmd 23) -> wifi_set_promis_process,
//   which does ic_set_vif(monitor) + wifi_hw_start(vif). wifi_hw_start(vif) is the real
//   "start receiving": chip_enable + pm_disconnected_start + pm_mac_wakeup.
//
// FINDINGS on silicon:
//   - The STA RX filter+enable alone (ic_set_mac/ic_set_bssid/ic_set_rx_policy/
//     ic_enable_rx) programs the registers correctly but frames=0 — the baseband RX is
//     never started.
//   - wifi_hw_start(vif) HANGS if called from the loop task; ieee80211_ioctl marshals it
//     into the WiFi-task context (current_task_is_wifi_task check), but it still needs
//     ic_set_vif(vif, mode) to run FIRST or it spins on a PM/hardware ready condition.
//   - The managed-STA ic_set_vif call (ieee80211_sta.o wifi_station_start) is
//     ic_set_vif(0, 0, vif_iface_ptr, 0, bit, ...): arg2 is a pointer to the vendor's
//     STA vif/interface struct (deep connection state), which is the remaining coupling.
//   - Promiscuous puts the vif in MONITOR mode (ic_set_vif a1=2 path), and the monitor
//     RX path bypasses the crypto stage regardless of key/policy.
//
// This code leaves the ioctl attempt in place (it blocks, since ic_set_vif is skipped)
// as the documented reproduction. Meanwhile wifi_sta_own uses HW auto-ACK + software
// CCMP, which is proven end to end (4-way -> DHCP -> TCP).

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
// ieee80211_ioctl marshals a handler into the WiFi-task context (where wifi_hw_start
// must run — it hangs if called from the loop task). Struct: cmd@0, handler@4, arg@8.
int ieee80211_ioctl(void *req);
}

// Custom ioctl handler: run the baseband RX-start in the WiFi-task context.
extern "C" void rx_start_handler(void *req) {
  (void)req;
  wifi_hw_start(0);
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

  // Run wifi_hw_start in the WiFi-task context via the ioctl marshal (24-byte req:
  // cmd@0, handler@4, arg@8). This starts the baseband RX without promiscuous.
  Serial.println("ioctl(rx_start_handler)...");
  static uint32_t req[6] = {0};
  reinterpret_cast<uint8_t *>(req)[0] = 23; // cmd id
  req[1] = reinterpret_cast<uint32_t>(&rx_start_handler); // handler @ +4
  reinterpret_cast<uint8_t *>(req)[8] = 0; // arg
  int r = ieee80211_ioctl(req);
  Serial.printf("ioctl returned %d\n", r);
  delay(50);
  wreg(0x60010000, 0); // detach vendor ISR now (hw_start re-installed it)

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
