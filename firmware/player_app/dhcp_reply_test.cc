#include "firmware/player_app/dhcp_reply.h"
#include <array>
#include <cassert>
#include "rr_case.h"

static const uint8_t mac[] = {2, 12, 106, 1, 2, 3};
static std::array<uint8_t, 320> reply() {
  std::array<uint8_t, 320> p{};
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
static void reads_mask_router_dns_and_ntp() {
  auto p = reply();
  const uint8_t options[] = {
      53, 1, 5, 0,                                  // ACK, a pad
      1, 4, 255, 255, 255, 0,                       // mask
      3, 8, 10, 42, 0, 1, 10, 42, 0, 2,             // two routers: the first wins
      6, 12, 10, 42, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1,  // DNS: 0.0.0.0 skipped
      42, 12, 10, 42, 0, 5, 10, 42, 0, 6, 10, 42, 0, 7,  // NTP: three, two kept
      255};
  std::memcpy(p.data() + 240, options, sizeof(options));
  assert(dhcp_reply_for_client(p.data(), p.size(), mac, 0x12345678));
  const DhcpLeaseOptions o = dhcp_reply_options(p.data(), p.size());
  const uint8_t mask[] = {255, 255, 255, 0}, gw[] = {10, 42, 0, 1}, d1[] = {1, 1, 1, 1},
                n1[] = {10, 42, 0, 5}, n2[] = {10, 42, 0, 6};
  assert(o.has_mask && std::memcmp(o.mask, mask, 4) == 0);
  assert(o.has_router && std::memcmp(o.router, gw, 4) == 0);
  assert(o.n_dns == 2 && std::memcmp(o.dns[0], gw, 4) == 0 && std::memcmp(o.dns[1], d1, 4) == 0);
  assert(o.n_ntp == 2 && std::memcmp(o.ntp[0], n1, 4) == 0 && std::memcmp(o.ntp[1], n2, 4) == 0);
}
static void lease_options_survive_bad_lengths() {
  // No NTP option (the rig's dnsmasq), an odd-length DNS list, a truncated option at the end.
  auto p = reply();
  const uint8_t options[] = {53, 1, 5, 6, 3, 10, 42, 0, 3, 4, 10, 42, 0, 1, 42, 9};
  std::memcpy(p.data() + 240, options, sizeof(options));
  DhcpLeaseOptions o = dhcp_reply_options(p.data(), 240 + sizeof(options));
  assert(o.n_dns == 0 && o.n_ntp == 0 && !o.has_mask);
  assert(o.has_router);
  for (size_t n = 0; n <= 240 + sizeof(options); ++n) o = dhcp_reply_options(p.data(), n);
  // A zero router is no router.
  const uint8_t zero[] = {3, 4, 0, 0, 0, 0, 255};
  std::memcpy(p.data() + 240, zero, sizeof(zero));
  assert(!dhcp_reply_options(p.data(), p.size()).has_router);
}
int main(int argc, char **argv) {
  return rr::RunCases(argc, argv, "dhcp_reply", {
    {"accepts_own_ack_with_padding", accepts_own_ack_with_padding},
    {"rejects_other_client_and_transaction", rejects_other_client_and_transaction},
    {"rejects_truncated_or_malformed_packets", rejects_truncated_or_malformed_packets},
    {"reads_mask_router_dns_and_ntp", reads_mask_router_dns_and_ntp},
    {"lease_options_survive_bad_lengths", lease_options_survive_bad_lengths},
  });
}
