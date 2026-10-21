// Host unit tests for the netstack's station-MAC choice (sta_mac.h).
#include "firmware/player_app/sta_mac.h"

#include <cassert>
#include <cstring>

#include "rr_case.h"

static const uint8_t kFactory[6] = {0x8c, 0xfd, 0x49, 0x10, 0x3a, 0x84};
static const uint8_t kRnd[3] = {0x95, 0x10, 0xf2};

static void test_factory_mac_is_used_by_default() {
  // The field report: PixieLamp's IP moved .155 -> .159 -> .163 ... because every boot
  // got a new random MAC and so a new DHCP lease. The same chip must get the same MAC.
  uint8_t a[6], b[6];
  assert(lm_sta_mac::choose(kFactory, false, kRnd, a));
  const uint8_t other_rnd[3] = {1, 2, 3};
  assert(lm_sta_mac::choose(kFactory, false, other_rnd, b));
  assert(memcmp(a, kFactory, 6) == 0 && memcmp(a, b, 6) == 0);
}

static void test_random_is_opt_in() {
  uint8_t m[6];
  assert(!lm_sta_mac::choose(kFactory, true, kRnd, m));
  const uint8_t want[6] = {0x02, 0x0c, 0x6a, 0x95, 0x10, 0xf2};
  assert(memcmp(m, want, 6) == 0);
  assert(m[0] & 0x02);  // locally administered
}

static void test_unusable_factory_falls_back() {
  uint8_t m[6];
  const uint8_t zero[6] = {0, 0, 0, 0, 0, 0};
  const uint8_t group[6] = {0x01, 0x00, 0x5e, 0, 0, 1};
  const uint8_t bcast[6] = {0xff, 0xff, 0xff, 0xff, 0xff, 0xff};
  assert(!lm_sta_mac::choose(zero, false, kRnd, m) && m[0] == 0x02);
  assert(!lm_sta_mac::choose(group, false, kRnd, m) && m[0] == 0x02);
  assert(!lm_sta_mac::choose(bcast, false, kRnd, m) && m[0] == 0x02);
  assert(lm_sta_mac::usable(kFactory));
}

int main(int argc, char **argv) {
  return rr::RunCases(argc, argv, "sta_mac",
                      {
                          {"factory_mac_is_used_by_default", test_factory_mac_is_used_by_default},
                          {"random_is_opt_in", test_random_is_opt_in},
                          {"unusable_factory_falls_back", test_unusable_factory_falls_back},
                      });
}
