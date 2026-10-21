#pragma once
// The heapless netstack's Wi-Fi station MAC: the chip's factory STA MAC (efuse), so a
// player keeps ONE address across reboots, updates and power cuts — the AP's DHCP
// server then hands it the same lease (and a DHCP reservation works), the bridge's
// remembered IP stays right, and no stale ARP/neighbour entries pile up for dead
// per-boot MACs. Pure (no efuse/RNG access) so the host test covers the decision.
//
// History: the netstack bring-up (bea2fe7f) used a random locally-administered MAC
// (02:0c:6a:xx:xx:xx) every boot "so the AP has no stale 4-way state", i.e. to dodge a
// same-MAC re-association meeting a PMF SA-Query / status 30 (assoc comeback). That
// can't happen here: our RSN IE advertises no PMF capability (caps=0), so the AP never
// runs SA-Query for us, and a re-auth from a known non-PMF STA just replaces its old
// state. The random MAC is kept as an opt-in build flag (-DLM_NETSTACK_RANDOM_MAC) for
// that bring-up scenario; a factory MAC that is unusable (all zero / multicast, i.e. an
// unread or blank efuse) also falls back to it.
#include <cstdint>
#include <cstring>

namespace lm_sta_mac {

// Whether `mac` is a usable unicast station address (not all-zero, not group, not ff..).
inline bool usable(const uint8_t mac[6]) {
  static const uint8_t zero[6] = {0, 0, 0, 0, 0, 0};
  if (memcmp(mac, zero, 6) == 0) return false;
  if (mac[0] & 0x01) return false;  // group (multicast/broadcast) bit
  return true;
}

// The per-boot random locally-administered address (the old behaviour).
inline void random_mac(const uint8_t rnd[3], uint8_t out[6]) {
  out[0] = 0x02;
  out[1] = 0x0c;
  out[2] = 0x6a;
  out[3] = rnd[0];
  out[4] = rnd[1];
  out[5] = rnd[2];
}

// Pick the STA MAC. Returns true when the factory MAC was used.
inline bool choose(const uint8_t factory[6], bool want_random, const uint8_t rnd[3],
                   uint8_t out[6]) {
  if (!want_random && usable(factory)) {
    memcpy(out, factory, 6);
    return true;
  }
  random_mac(rnd, out);
  return false;
}

// Whether this build opted into the per-boot random MAC.
constexpr bool random_mac_is_build_default() {
#if defined(LM_NETSTACK_RANDOM_MAC)
  return true;
#else
  return false;
#endif
}

}  // namespace lm_sta_mac
