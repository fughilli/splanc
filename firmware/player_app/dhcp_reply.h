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
