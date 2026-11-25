#pragma once
#include <cstddef>
#include <cstdint>
#include <cstring>

// Broadcast replies belong to every station at L2, but only one DHCP client.
// Validate the fixed header and complete option stream before changing lease state.
inline bool dhcp_reply_for_client(const uint8_t *data, size_t size,
                                  const uint8_t *mac, uint32_t xid) {
  if (size < 240 || data[0] != 2 || data[1] != 1 || data[2] != 6) return false;
  const uint32_t reply_xid = (uint32_t(data[4]) << 24) | (uint32_t(data[5]) << 16) |
                             (uint32_t(data[6]) << 8) | data[7];
  const uint8_t cookie[] = {0x63, 0x82, 0x53, 0x63};
  if (reply_xid != xid || std::memcmp(data + 28, mac, 6) != 0 ||
      std::memcmp(data + 236, cookie, 4) != 0) return false;
  for (size_t i = 240; i < size;) {
    const uint8_t code = data[i++];
    if (code == 255) return true;
    if (code == 0) continue;
    if (i == size) return false;
    const uint8_t len = data[i++];
    if (len > size - i) return false;
    if ((code == 53 && len != 1) || ((code == 54 || code == 51) && len != 4)) return false;
    i += len;
  }
  return false;
}

// The lease's network options a client needs past its address (RFC 2132): the subnet mask
// (1), the routers (3), the DNS servers (6) and the NTP servers (42; the SNTP client,
// sntp_ffi.rs). Up to two addresses each; zero-length or odd-length lists are ignored.
struct DhcpLeaseOptions {
  uint8_t mask[4];
  bool has_mask;
  uint8_t router[4];
  bool has_router;
  uint8_t dns[2][4];
  uint8_t n_dns;
  uint8_t ntp[2][4];
  uint8_t n_ntp;
};

// Read those options from a reply that dhcp_reply_for_client accepted (any reply: stops
// at the end option or a truncated one, never reads past `size`).
inline DhcpLeaseOptions dhcp_reply_options(const uint8_t *data, size_t size) {
  DhcpLeaseOptions o{};
  auto list = [](const uint8_t *v, uint8_t len, uint8_t (*out)[4], uint8_t *n) {
    if (len == 0 || len % 4 != 0) return;
    for (uint8_t k = 0; k < len / 4 && *n < 2; ++k) {
      const uint8_t *a = v + 4 * k;
      if (!(a[0] | a[1] | a[2] | a[3])) continue;  // 0.0.0.0 is no server
      std::memcpy(out[(*n)++], a, 4);
    }
  };
  for (size_t i = 240; i < size;) {
    const uint8_t code = data[i++];
    if (code == 255) break;
    if (code == 0) continue;
    if (i == size) break;
    const uint8_t len = data[i++];
    if (len > size - i) break;
    const uint8_t *v = data + i;
    if (code == 1 && len == 4) {
      std::memcpy(o.mask, v, 4);
      o.has_mask = true;
    } else if (code == 3 && len >= 4 && len % 4 == 0 && !o.has_router) {
      std::memcpy(o.router, v, 4);
      o.has_router = (v[0] | v[1] | v[2] | v[3]) != 0;
    } else if (code == 6) {
      list(v, len, o.dns, &o.n_dns);
    } else if (code == 42) {
      list(v, len, o.ntp, &o.n_ntp);
    }
    i += len;
  }
  return o;
}
