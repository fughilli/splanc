#pragma once
#include <cstdint>

// esp_read_mac returns a six-byte address in display order; HCI expects LE.
// Set the static-random bits in the MSB, preserving the chip-specific suffix.
inline void ble_static_random_address(const uint8_t (&factory)[6], uint8_t (&address)[6]) {
  for (unsigned i = 0; i < 6; ++i) address[i] = factory[5 - i];
  address[5] |= 0xc0;
}
