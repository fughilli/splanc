#include "firmware/player_app/ble_address.h"
#include <cassert>
#include <cstring>
#include "rr_case.h"

static void address_order_and_type() {
  const uint8_t factory[6] = {0x8c, 0xfd, 0x49, 0x12, 0x31, 0x72};
  uint8_t address[6];
  ble_static_random_address(factory, address);
  const uint8_t expected[6] = {0x72, 0x31, 0x12, 0x49, 0xfd, 0xcc};
  assert(std::memcmp(address, expected, 6) == 0);
}
static void nearby_boards_keep_distinct_suffixes() {
  const uint8_t first[6] = {0x8c, 0xfd, 0x49, 0x12, 0x31, 0x70};
  const uint8_t second[6] = {0x8c, 0xfd, 0x49, 0x12, 0x7d, 0x10};
  uint8_t a[6], b[6], again[6];
  ble_static_random_address(first, a);
  ble_static_random_address(second, b);
  ble_static_random_address(first, again);
  assert(std::memcmp(a, b, 6) != 0);
  assert(std::memcmp(a, again, 6) == 0);
}
int main(int argc, char **argv) {
  return rr::RunCases(argc, argv, "ble_address", {
    {"address_order_and_type", address_order_and_type},
    {"nearby_boards_keep_distinct_suffixes", nearby_boards_keep_distinct_suffixes},
  });
}
