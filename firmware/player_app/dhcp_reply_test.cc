#include "firmware/player_app/dhcp_reply.h"
#include <array>
#include <cassert>
#include "rr_case.h"

static const uint8_t mac[] = {2, 12, 106, 1, 2, 3};
static std::array<uint8_t, 256> reply() {
  std::array<uint8_t, 256> p{};
  p[0] = 2; p[1] = 1; p[2] = 6;
  p[4] = 0x12; p[5] = 0x34; p[6] = 0x56; p[7] = 0x78;
  std::memcpy(p.data() + 28, mac, 6);
  const uint8_t cookie[] = {0x63, 0x82, 0x53, 0x63};
  std::memcpy(p.data() + 236, cookie, 4);
  const uint8_t options[] = {0, 53, 1, 5, 54, 4, 10, 42, 0, 1, 255};
  std::memcpy(p.data() + 240, options, sizeof(options));
  return p;
}
static void accepts_own_ack_with_padding() {
  const auto p = reply();
  assert(dhcp_reply_for_client(p.data(), p.size(), mac, 0x12345678));
}
static void rejects_other_client_and_transaction() {
  auto p = reply();
  assert(!dhcp_reply_for_client(p.data(), p.size(), mac, 0x12345679));
  p[33] ^= 1;
  assert(!dhcp_reply_for_client(p.data(), p.size(), mac, 0x12345678));
}
static void rejects_truncated_or_malformed_packets() {
  auto p = reply();
  for (size_t n = 0; n < 251; ++n)
    assert(!dhcp_reply_for_client(p.data(), n, mac, 0x12345678));
  p[245] = 3; // wrong server identifier size
  assert(!dhcp_reply_for_client(p.data(), p.size(), mac, 0x12345678));
  p = reply(); p[236] = 0;
  assert(!dhcp_reply_for_client(p.data(), p.size(), mac, 0x12345678));
}
int main(int argc, char **argv) {
  return rr::RunCases(argc, argv, "dhcp_reply", {
    {"accepts_own_ack_with_padding", accepts_own_ack_with_padding},
    {"rejects_other_client_and_transaction", rejects_other_client_and_transaction},
    {"rejects_truncated_or_malformed_packets", rejects_truncated_or_malformed_packets},
  });
}
