#pragma once
// ICMP echo (ping) responder for the heapless netstack: a pure validator, a reply
// builder and a token-bucket limiter, with no allocation and no hardware access, so the
// host test (icmp_echo_test.cc) covers exactly what the firmware runs.
//
// Policy (see netstack_transport.cpp handle_l3):
//   - answer only type 8 / code 0, addressed to our own unicast IPv4 address, from a
//     unicast source. The firmware also drops frames that arrived group-addressed at L2,
//     so a broadcast/multicast ping can't be amplified (smurf);
//   - drop fragments (we don't reassemble), bad IHL/length and bad IP/ICMP checksums;
//   - echo at most kIcmpEchoMaxData bytes of ICMP data (1472: a full 1500-byte MTU
//     packet, `ping -s 1472`). That fits the existing 1600-byte TX IP slot, so a reply is
//     built in place with no new buffer. Anything larger can only arrive fragmented and
//     is dropped;
//   - replies are rate-limited (IcmpRateLimiter: 10/s sustained, burst 5), so a flood
//     can't starve LED output, TLS or the watchdog.
#include <cstddef>
#include <cstdint>
#include <cstring>

constexpr size_t kIcmpEchoMaxData = 1472;  // ICMP data bytes (after the 8-byte header)

// RFC 1071 ones'-complement sum; 0 when `d` already carries a valid checksum.
inline uint16_t icmp_inet_csum(const uint8_t *d, size_t len) {
  uint32_t s = 0;
  for (size_t i = 0; i + 1 < len; i += 2) s += (uint32_t(d[i]) << 8) | d[i + 1];
  if (len & 1) s += uint32_t(d[len - 1]) << 8;
  while (s >> 16) s = (s & 0xffff) + (s >> 16);
  return uint16_t(~s & 0xffff);
}

enum class IcmpEcho : uint8_t {
  kOk,         // a valid echo request for us: build the reply
  kNotEcho,    // not ICMP, or ICMP but not an echo request (the caller may handle it)
  kMalformed,  // bad version/IHL/length/checksum, or a fragment
  kNotForUs,   // not our unicast address, or from a group/unspecified source
  kTooBig,     // more than kIcmpEchoMaxData bytes of data
};

// Classify the IPv4 packet `ip` (`avail` bytes available; the packet's own total length
// may be shorter — link padding is ignored). `our_ip` is our leased address.
inline IcmpEcho icmp_echo_check(const uint8_t *ip, size_t avail, const uint8_t *our_ip) {
  if (avail < 20 || (ip[0] >> 4) != 4) return IcmpEcho::kMalformed;
  if (ip[9] != 1) return IcmpEcho::kNotEcho;
  const size_t ihl = size_t(ip[0] & 0x0f) * 4;
  const size_t tot = (size_t(ip[2]) << 8) | ip[3];
  if (ihl < 20 || tot < ihl + 8 || tot > avail) return IcmpEcho::kMalformed;
  const uint8_t *ic = ip + ihl;
  if (ic[0] != 8 || ic[1] != 0) return IcmpEcho::kNotEcho;
  if (icmp_inet_csum(ip, ihl) != 0) return IcmpEcho::kMalformed;
  if ((ip[6] & 0x20) || ((ip[6] & 0x1f) | ip[7])) return IcmpEcho::kMalformed;  // MF / offset
  static const uint8_t kZero[4] = {0, 0, 0, 0};
  if (std::memcmp(our_ip, kZero, 4) == 0 || std::memcmp(ip + 16, our_ip, 4) != 0)
    return IcmpEcho::kNotForUs;
  const uint8_t *src = ip + 12;
  if (src[0] >= 224 || src[0] == 0 || src[0] == 127) return IcmpEcho::kNotForUs;
  if (tot - ihl - 8 > kIcmpEchoMaxData) return IcmpEcho::kTooBig;
  if (icmp_inet_csum(ic, tot - ihl) != 0) return IcmpEcho::kMalformed;
  return IcmpEcho::kOk;
}

// Build the echo reply for a request that icmp_echo_check() accepted, into `out` (`cap`
// bytes; must not overlap `ip`). Fresh 20-byte IP header (options are not echoed): TOS
// copied, DF, TTL 64, our address -> the requester. The ICMP id/seq/data are copied and
// the type flipped to 0 with a recomputed checksum. Returns the IP length, 0 if no room.
inline size_t icmp_echo_build_reply(const uint8_t *ip, const uint8_t *our_ip, uint8_t *out,
                                    size_t cap) {
  const size_t ihl = size_t(ip[0] & 0x0f) * 4;
  const size_t icmp_len = ((size_t(ip[2]) << 8) | ip[3]) - ihl;
  const size_t tot = 20 + icmp_len;
  if (tot > cap) return 0;
  out[0] = 0x45; out[1] = ip[1]; out[2] = uint8_t(tot >> 8); out[3] = uint8_t(tot);
  out[4] = 0; out[5] = 0; out[6] = 0x40; out[7] = 0;  // id 0, DF (never fragmented)
  out[8] = 64; out[9] = 1; out[10] = 0; out[11] = 0;  // TTL, proto ICMP, csum below
  std::memcpy(out + 12, our_ip, 4);
  std::memcpy(out + 16, ip + 12, 4);
  const uint16_t c = icmp_inet_csum(out, 20);
  out[10] = uint8_t(c >> 8); out[11] = uint8_t(c);
  uint8_t *ic = out + 20;
  std::memcpy(ic, ip + ihl, icmp_len);
  ic[0] = 0; ic[2] = 0; ic[3] = 0;  // echo reply, csum below
  const uint16_t ic_c = icmp_inet_csum(ic, icmp_len);
  ic[2] = uint8_t(ic_c >> 8); ic[3] = uint8_t(ic_c);
  return tot;
}

// Token bucket in milliseconds of credit: one reply costs kCostMs, credit refills in real
// time and is capped at kBurst replies. Starts full; wrap-safe on a uint32 millis() clock.
struct IcmpRateLimiter {
  static constexpr uint32_t kCostMs = 100;  // 10 replies/s sustained
  static constexpr uint32_t kBurst = 5;
  uint32_t credit_ms = kCostMs * kBurst;
  uint32_t last_ms = 0;
  bool started = false;

  bool take(uint32_t now_ms) {
    if (started) {
      const uint32_t dt = now_ms - last_ms;
      const uint32_t cap = kCostMs * kBurst;
      credit_ms = dt >= cap - credit_ms ? cap : credit_ms + dt;
    }
    started = true;
    last_ms = now_ms;
    if (credit_ms < kCostMs) return false;
    credit_ms -= kCostMs;
    return true;
  }
};
