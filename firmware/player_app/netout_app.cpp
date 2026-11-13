// The P4 player's Ethernet + network LED outputs: see netout_app.h.
#include "netout_app.h"

#include <Preferences.h>
#include <string.h>

#include "eth_p4.h"
#include "firmware/netout/netout_ffi.h"
#include "player_ffi.h"
#include "serial_log.h"
#include "wled_discovery.h"

namespace {

constexpr const char *kNvsNamespace = "netout";
constexpr const char *kNvsKey = "cfg";

uint32_t s_gen = 0;  // the last netout_gen() applied
SemaphoreHandle_t s_core = nullptr;  // main.cpp's player_mutex

// Push the stored settings to the hardware: Ethernet (only when its config
// changed, since a restart drops the link), the targets, and the pins the
// player core must refuse as LED pins.
void apply(bool eth_changed) {
  NetoutEthConfig cfg;
  netout_config(&cfg);
  if (eth_changed) {
    eth_p4_apply(cfg);
    wled_discovery_forget();
  }
  int32_t busy[16];
  const size_t n = netout_busy_pins(busy, 16);
  if (s_core) xSemaphoreTake(s_core, portMAX_DELAY);
  lm_set_reserved_gpios(busy, n);
  if (s_core) xSemaphoreGive(s_core);
  NetoutTarget t[NET_OUTPUT_CHANNELS];
  const int32_t first = netout_first_channel();
  for (int i = 0; i < NET_OUTPUT_CHANNELS; i++) {
    if (!netout_output(first + i, &t[i])) t[i] = NetoutTarget{};
  }
  net_output_set_targets(t);
}

void save() {
  uint8_t blob[512];
  const size_t n = netout_save(blob, sizeof blob);
  if (n == 0) return;
  Preferences p;
  if (!p.begin(kNvsNamespace, false)) return;
  p.putBytes(kNvsKey, blob, n);
  p.end();
}

bool same_eth(const NetoutEthConfig &a, const NetoutEthConfig &b) {
  return a.enabled == b.enabled && a.phy == b.phy && a.phy_addr == b.phy_addr && a.mdc == b.mdc &&
         a.mdio == b.mdio && a.reset == b.reset && a.clock == b.clock &&
         a.clock_gpio == b.clock_gpio && a.ip_mode == b.ip_mode && a.ip == b.ip &&
         a.netmask == b.netmask && a.gateway == b.gateway;
}

size_t encode_state(const char *err, uint8_t *out, size_t cap) {
  NetoutLinkStatus st;
  eth_p4_status(&st);
  net_output_counters(&st.tx_frames, &st.tx_errors);
  if (err == nullptr || *err == 0) err = eth_p4_error();
  return netout_encode_state(&st, err, out, cap);
}

}  // namespace

void netout_app_begin(uint32_t max_leds, SemaphoreHandle_t core_mutex) {
  s_core = core_mutex;
  {
    Preferences p;
    if (p.begin(kNvsNamespace, true)) {
      uint8_t blob[512];
      const size_t n = p.isKey(kNvsKey) ? p.getBytes(kNvsKey, blob, sizeof blob) : 0;
      p.end();
      if (n > 0 && !netout_load(blob, n)) Log().printf("[net] stored settings unreadable: defaults\n");
    }
  }
  s_gen = netout_gen();
  net_output_begin(max_leds);
  apply(true);
}

int netout_app_dispatch(const uint8_t *msg, size_t len, uint8_t *out, size_t cap, int led_gpio0,
                        int led_gpio1) {
  const int32_t arm = netout_arm(msg, len);
  if (arm == 0) return 0;
  if (arm == NETOUT_ARM_DISCOVER_CONTROLLERS) {
    static NetoutController found[WLED_DISCOVERY_MAX];
    const char *err = nullptr;
    const size_t n = wled_discover(netout_discover_timeout_ms(msg, len), found, WLED_DISCOVERY_MAX, &err);
    return (int)netout_encode_controllers(found, n, err, out, cap);
  }
  const char *err = nullptr;
  if (arm == NETOUT_ARM_SET_ETHERNET_CONFIG || arm == NETOUT_ARM_SET_NETWORK_OUTPUT) {
    NetoutEthConfig before;
    netout_config(&before);
    const int32_t busy[2] = {led_gpio0, led_gpio1};
    err = netout_apply(msg, len, busy, 2);
    if (err == nullptr && netout_gen() != s_gen) {
      s_gen = netout_gen();
      NetoutEthConfig after;
      netout_config(&after);
      apply(!same_eth(before, after));
      if (netout_commit()) save();
    }
  }
  return (int)encode_state(err, out, cap);
}

void netout_app_counts(uint32_t counts[NET_OUTPUT_CHANNELS]) {
  const int32_t first = netout_first_channel();
  for (int i = 0; i < NET_OUTPUT_CHANNELS; i++) {
    const int32_t n = lm_led_count((uint32_t)(first + i));
    counts[i] = n > 0 ? (uint32_t)n : 0;
  }
}
