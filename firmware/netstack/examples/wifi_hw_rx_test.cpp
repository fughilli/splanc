// wifi_hw_rx_test — RE probe for the non-promiscuous STA RX bring-up (so the hardware
// crypto engine stays inline instead of the software-CCMP tax).
//
// FULL TRACE (reversed from libnet80211 / libpp):
//   esp_wifi_set_promiscuous -> ieee80211_ioctl(cmd 23) -> wifi_set_promis_process,
//   which does ic_set_vif(monitor) + wifi_hw_start(vif). wifi_hw_start(vif) is the real
//   "start receiving": chip_enable + pm_disconnected_start + pm_mac_wakeup.
//
// PROGRESS (all cracked this pass — the full vendor STA RX bring-up sequence now runs
// with no hangs and no crashes):
//   1. ieee80211_ioctl marshals a handler into the WiFi-task context (it checks
//      current_task_is_wifi_task and posts otherwise). The request struct must be
//      HEAP-allocated (24 B) — ieee80211_ioctl frees it (heap_caps_free assert if not).
//      Layout: cmd@0, handler@4, arg@8.
//   2. wifi_hw_start(vif) has assert-spins (j .) when g_ic[589]/[590] bit(vif) is set
//      ("hw already started"). esp_wifi_start sets them, so we must wifi_hw_stop(vif)
//      first, then wifi_hw_start(vif) — the stop->start cycle promiscuous also does.
//   3. ic_set_vif(0, 0, mac_ptr, 0, 0): arg2 is just a 6-byte MAC (memcpy'd), NOT a
//      deep struct. STA path (a1=0) calls wifi_set_rx_policy, marks the vif active in
//      wDevCtrl[49] (== g_ic[589]) — so it must run AFTER wifi_hw_start or it re-trips
//      the assert. Monitor path (a1=2, promiscuous) skips that bit.
//
// REMAINING WALL: even after stop->start->ic_set_vif(STA)->ic_set_sta_auth_flag +
// pm_disable_disconnected_sleep_delay_timer + esp_wifi_set_ps(NONE), the RX descriptor
// NEXT pointer (0x600A_4088) never advances and INT_STATUS stays 0 — the baseband does
// not actually RECEIVE in disconnected-STA mode. Monitor mode gets continuous RX for
// free; a managed STA only receives continuously once its PHY RX/TSF is tied to a live
// connection (beacon timing). That continuous-RX enable is the last piece.
//
// Meanwhile wifi_sta_own uses HW auto-ACK + software CCMP, proven end to end
// (4-way -> DHCP -> TCP).

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
// esp_wifi_start already set the "started" bits, and wifi_hw_start asserts if they are
// set — so promiscuous does a stop->start cycle. We mirror that.
void wifi_hw_start(uint32_t vif);
void wifi_hw_stop(uint32_t vif);
// Mark the STA authenticated/connected (wDev_SetAuthed) so the PM does CONTINUOUS RX
// instead of the disconnected/connectionless duty-cycled wake windows.
void ic_set_sta_auth_flag(uint32_t vif, uint32_t authed);
void pm_disable_disconnected_sleep_delay_timer();
// Configure a vif in MANAGED-STA mode (a1=0): sets the STA RX policy, copies our MAC
// (arg2 points at a 6-byte MAC — NOT a big struct), marks the vif active, enables RX.
// This is the state wifi_hw_start needs so it does not spin.
uint32_t ic_set_vif(uint32_t vif, uint32_t mode, const uint8_t *mac, uint32_t a3, uint32_t a4);
// ieee80211_ioctl marshals a handler into the WiFi-task context (where wifi_hw_start
// must run — it hangs if called from the loop task). Struct: cmd@0, handler@4, arg@8.
int ieee80211_ioctl(void *req);
}

const uint8_t OUR_MAC_G[6] = {0x02, 0x0c, 0x6a, 0x11, 0x22, 0x33};

// Custom ioctl handler: bring up the STA vif then start the baseband RX, both in the
// WiFi-task context.
extern "C" uint8_t g_ic[];

extern "C" void rx_start_handler(void *req) {
  (void)req;
  // wifi_hw_start asserts-spins if g_ic[589]/[590] bit(vif) is already set. The STA
  // ic_set_vif sets that bit, so start the baseband FIRST, then configure the vif.
  Serial.printf("  [handler] g_ic[589]=%02x [590]=%02x\n", g_ic[589], g_ic[590]);
  wifi_hw_stop(0); // clear the "started" bits esp_wifi_start set
  Serial.println("  [handler] wifi_hw_stop done");
  wifi_hw_start(0); // full baseband RX start
  Serial.println("  [handler] wifi_hw_start done");
  ic_set_vif(0, 0, OUR_MAC_G, 0, 0); // STA vif config + filter
  Serial.println("  [handler] ic_set_vif done");
  ic_set_sta_auth_flag(0, 1); // mark connected -> continuous RX
  pm_disable_disconnected_sleep_delay_timer();
  Serial.println("  [handler] auth flag + no-sleep done");
}

namespace {
const uint8_t BSSID[6] = {0xb8, 0x27, 0xeb, 0xbb, 0x8d, 0xf8};
const uint8_t *const OUR_MAC = OUR_MAC_G;
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
  esp_wifi_set_ps(WIFI_PS_NONE); // disconnected STA duty-cycles RX; disable PS for
                                 // continuous receive (monitor mode gets this for free)
  esp_wifi_set_channel(CHAN, WIFI_SECOND_CHAN_NONE);
  delay(150);

  // Detach the vendor ISR and install OUR RX ring BEFORE enabling RX, so incoming
  // frames DMA into our ring and no vendor ISR fires on state we don't own.
  wreg(0x60010000, 0);
  ns_mac_rx_install();

  // Bring up the STA vif in the WiFi-task context (ic_set_vif marks the vif active +
  // sets the STA RX policy + enables RX). ieee80211_ioctl marshals it there. Struct:
  // cmd@0, handler@4, arg@8.
  Serial.println("ioctl(rx_start_handler)...");
  // ieee80211_ioctl FREES the request struct after running the handler, so it must be
  // heap-allocated (one-time bring-up allocation, not per-packet).
  uint32_t *req = static_cast<uint32_t *>(malloc(24));
  memset(req, 0, 24);
  reinterpret_cast<uint8_t *>(req)[0] = 23;
  req[1] = reinterpret_cast<uint32_t>(&rx_start_handler);
  reinterpret_cast<uint8_t *>(req)[8] = 0;
  int r = ieee80211_ioctl(req);
  Serial.printf("ioctl returned %d\n", r);
  wreg(0x60010000, 0); // re-detach in case the ioctl path re-armed it

  // Override the filter with OUR MAC/BSSID (ic_set_vif's wifi_set_rx_policy used the
  // vendor's configured address) and re-point the RX DMA at our ring.
  ic_set_mac(0, OUR_MAC);
  ic_set_bssid(0, BSSID);
  ic_set_rx_policy(0, 0, 1, 1);
  ic_rx_enable_bssid_check(0);
  ic_enable_rx();
  ns_mac_rx_install();
  esp_wifi_set_channel(CHAN, WIFI_SECOND_CHAN_NONE);

  auto rd = [](uintptr_t a) { return *reinterpret_cast<volatile uint32_t *>(a); };
  Serial.printf("rx_ctrl=%08x policy=%08x dscr_base=%08x next=%08x int=%08x\n",
                rd(0x600A4080), rd(0x600A40D8), rd(0x600A4084), rd(0x600A4088), rd(0x600A4C48));
  // Sample RX-activity registers over time: does DSCR_NEXT advance / INT show RX-done?
  for (int k = 0; k < 5; k++) {
    delay(200);
    Serial.printf("  t=%d: next=%08x int=%08x\n", k, rd(0x600A4088), rd(0x600A4C48));
  }
  uint32_t beacons = 0;
  uint32_t frames = count_rx(700, &beacons);
  Serial.printf("STA RX (no promiscuous, HW crypto inline): frames=%u beacons=%u\n", frames, beacons);
}

void loop() { delay(1000); }
