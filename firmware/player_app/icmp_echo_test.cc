#include "firmware/player_app/icmp_echo.h"
#include <array>
#include <vector>
#include "rr_case.h"

static const uint8_t kUs[4] = {10, 42, 0, 17};
static const uint8_t kPeer[4] = {10, 42, 0, 1};

// A standard `ping` request (56 data bytes by default) from kPeer to `dst`.
static std::vector<uint8_t> request(size_t data_len = 56, const uint8_t *dst = kUs) {
  std::vector<uint8_t> p(20 + 8 + data_len);
  const size_t tot = p.size();
  p[0] = 0x45; p[1] = 0x10; p[2] = uint8_t(tot >> 8); p[3] = uint8_t(tot);
  p[4] = 0xab; p[5] = 0xcd; p[6] = 0x40; p[8] = 63; p[9] = 1;
  std::memcpy(&p[12], kPeer, 4);
  std::memcpy(&p[16], dst, 4);
  const uint16_t c = icmp_inet_csum(p.data(), 20);
  p[10] = uint8_t(c >> 8); p[11] = uint8_t(c);
  uint8_t *ic = &p[20];
  ic[0] = 8; ic[4] = 0x12; ic[5] = 0x34; ic[6] = 0x00; ic[7] = 0x07;
  for (size_t i = 0; i < data_len; ++i) ic[8 + i] = uint8_t(i * 7 + 3);
  const uint16_t icc = icmp_inet_csum(ic, 8 + data_len);
  ic[2] = uint8_t(icc >> 8); ic[3] = uint8_t(icc);
  return p;
}

static void refix_ip_csum(std::vector<uint8_t> &p) {
  p[10] = p[11] = 0;
  const uint16_t c = icmp_inet_csum(p.data(), size_t(p[0] & 0x0f) * 4);
  p[10] = uint8_t(c >> 8); p[11] = uint8_t(c);
}

static void replies_to_standard_ping() {
  auto req = request();
  req.resize(req.size() + 6, 0xee);  // link padding past the IP total length is ignored
  RR_CHECK(icmp_echo_check(req.data(), req.size(), kUs) == IcmpEcho::kOk);
  std::array<uint8_t, 1600> out{};
  const size_t n = icmp_echo_build_reply(req.data(), kUs, out.data(), out.size());
  RR_CHECK(n == 20 + 8 + 56);
  RR_CHECK(out[0] == 0x45 && out[1] == 0x10 && out[8] == 64 && out[9] == 1);
  RR_CHECK(((out[2] << 8) | out[3]) == int(n));
  RR_CHECK(std::memcmp(&out[12], kUs, 4) == 0 && std::memcmp(&out[16], kPeer, 4) == 0);
  RR_CHECK(icmp_inet_csum(out.data(), 20) == 0);
  RR_CHECK(out[20] == 0 && out[21] == 0);
  RR_CHECK(icmp_inet_csum(&out[20], n - 20) == 0);
  // Same id, seq and data.
  RR_CHECK(std::memcmp(&out[24], &req[24], n - 24) == 0);
}

static void handles_ip_options_and_odd_lengths() {
  // IHL 6 (one 4-byte option word) and an odd data length: options are not echoed.
  auto base = request(57);
  std::vector<uint8_t> p(base.size() + 4);
  std::memcpy(p.data(), base.data(), 20);
  p[20] = 0x01; p[21] = 0x01; p[22] = 0x01; p[23] = 0x00;  // NOP NOP NOP EOL
  std::memcpy(&p[24], &base[20], base.size() - 20);
  p[0] = 0x46; p[2] = uint8_t(p.size() >> 8); p[3] = uint8_t(p.size());
  refix_ip_csum(p);
  RR_CHECK(icmp_echo_check(p.data(), p.size(), kUs) == IcmpEcho::kOk);
  std::array<uint8_t, 1600> out{};
  const size_t n = icmp_echo_build_reply(p.data(), kUs, out.data(), out.size());
  RR_CHECK(n == 20 + 8 + 57 && out[0] == 0x45);
  RR_CHECK(icmp_inet_csum(&out[20], n - 20) == 0);
  RR_CHECK(std::memcmp(&out[24], &p[28], 4 + 57) == 0);
}

static void caps_payload_at_mtu() {
  auto max = request(kIcmpEchoMaxData);
  RR_CHECK(max.size() == 1500);
  RR_CHECK(icmp_echo_check(max.data(), max.size(), kUs) == IcmpEcho::kOk);
  std::array<uint8_t, 1600> out{};
  RR_CHECK(icmp_echo_build_reply(max.data(), kUs, out.data(), out.size()) == 1500);
  RR_CHECK(icmp_echo_build_reply(max.data(), kUs, out.data(), 1499) == 0);  // no room
  auto big = request(kIcmpEchoMaxData + 1);
  RR_CHECK(icmp_echo_check(big.data(), big.size(), kUs) == IcmpEcho::kTooBig);
}

static void ignores_other_destinations_and_sources() {
  const uint8_t bcast[4] = {255, 255, 255, 255};
  const uint8_t subnet_bcast[4] = {10, 42, 0, 255};
  const uint8_t mcast[4] = {224, 0, 0, 1};
  for (const uint8_t *dst : {bcast, subnet_bcast, mcast, kPeer}) {
    auto p = request(56, dst);
    RR_CHECK(icmp_echo_check(p.data(), p.size(), kUs) == IcmpEcho::kNotForUs);
  }
  const uint8_t unleased[4] = {0, 0, 0, 0};
  auto p = request();
  RR_CHECK(icmp_echo_check(p.data(), p.size(), unleased) == IcmpEcho::kNotForUs);
  for (uint8_t first : {uint8_t(0), uint8_t(127), uint8_t(224), uint8_t(255)}) {
    auto q = request();
    q[12] = first;
    refix_ip_csum(q);
    RR_CHECK(icmp_echo_check(q.data(), q.size(), kUs) == IcmpEcho::kNotForUs);
  }
}

static void ignores_non_requests() {
  auto reply = request();
  reply[20] = 0;  // an echo REPLY (the gateway-ping diagnostic's path) is not ours to answer
  RR_CHECK(icmp_echo_check(reply.data(), reply.size(), kUs) == IcmpEcho::kNotEcho);
  auto code = request();
  code[21] = 1;
  RR_CHECK(icmp_echo_check(code.data(), code.size(), kUs) == IcmpEcho::kNotEcho);
  auto udp = request();
  udp[9] = 17;
  refix_ip_csum(udp);
  RR_CHECK(icmp_echo_check(udp.data(), udp.size(), kUs) == IcmpEcho::kNotEcho);
}

static void rejects_malformed() {
  const auto good = request();
  for (size_t n = 0; n < good.size(); ++n)  // truncated anywhere
    RR_CHECK(icmp_echo_check(good.data(), n, kUs) != IcmpEcho::kOk);
  auto p = good; p[0] = 0x65; refix_ip_csum(p);  // IPv6 version nibble
  RR_CHECK(icmp_echo_check(p.data(), p.size(), kUs) == IcmpEcho::kMalformed);
  p = good; p[0] = 0x44;  // IHL < 5
  RR_CHECK(icmp_echo_check(p.data(), p.size(), kUs) == IcmpEcho::kMalformed);
  p = good; p[3] = 20 + 7; refix_ip_csum(p);  // total length shorter than an ICMP header
  RR_CHECK(icmp_echo_check(p.data(), p.size(), kUs) == IcmpEcho::kMalformed);
  p = good; p[11] ^= 1;  // IP checksum
  RR_CHECK(icmp_echo_check(p.data(), p.size(), kUs) == IcmpEcho::kMalformed);
  p = good; p[40] ^= 1;  // ICMP checksum (data corrupted)
  RR_CHECK(icmp_echo_check(p.data(), p.size(), kUs) == IcmpEcho::kMalformed);
  p = good; p[6] = 0x20; refix_ip_csum(p);  // more-fragments
  RR_CHECK(icmp_echo_check(p.data(), p.size(), kUs) == IcmpEcho::kMalformed);
  p = good; p[6] = 0x00; p[7] = 0x10; refix_ip_csum(p);  // non-zero fragment offset
  RR_CHECK(icmp_echo_check(p.data(), p.size(), kUs) == IcmpEcho::kMalformed);
}

static void rate_limits_floods() {
  IcmpRateLimiter rl;
  uint32_t t = 0xffffff00u;  // straddle the millis() wrap
  int ok = 0;
  for (int i = 0; i < 10; ++i) ok += rl.take(t);  // burst at one instant
  RR_CHECK(ok == int(IcmpRateLimiter::kBurst));
  // A 1 ms flood for 2 s: 10/s sustained on top of the (already spent) burst.
  ok = 0;
  for (int i = 1; i <= 2000; ++i) ok += rl.take(t + uint32_t(i));
  RR_CHECK(ok == 20);
  // An idle second refills to the burst cap, not beyond.
  t += 2000 + 10000;
  ok = 0;
  for (int i = 0; i < 10; ++i) ok += rl.take(t);
  RR_CHECK(ok == int(IcmpRateLimiter::kBurst));
  // A standard 1/s ping is never limited.
  for (int i = 1; i <= 60; ++i) RR_CHECK(rl.take(t + uint32_t(i) * 1000));
}

int main(int argc, char **argv) {
  return rr::RunCases(argc, argv, "icmp_echo", {
    {"replies_to_standard_ping", replies_to_standard_ping},
    {"handles_ip_options_and_odd_lengths", handles_ip_options_and_odd_lengths},
    {"caps_payload_at_mtu", caps_payload_at_mtu},
    {"ignores_other_destinations_and_sources", ignores_other_destinations_and_sources},
    {"ignores_non_requests", ignores_non_requests},
    {"rejects_malformed", rejects_malformed},
    {"rate_limits_floods", rate_limits_floods},
  });
}
