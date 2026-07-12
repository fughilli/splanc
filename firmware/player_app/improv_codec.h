// Improv Wi-Fi BLE packet codec (https://www.improv-wifi.com/ble/) —
// dependency-free so the bytes are host-testable (improv_codec_test.cc pins
// the SAME vectors as the web app's improv.test.ts; app and device cannot
// drift). The BLE/GATT glue lives in improv_ble.cpp; this header owns only
// the RPC payload layout: [cmd, len, data..., checksum(sum & 0xff)].
#ifndef FIRMWARE_PLAYER_APP_IMPROV_CODEC_H_
#define FIRMWARE_PLAYER_APP_IMPROV_CODEC_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
  IMPROV_CMD_WIFI_SETTINGS = 0x01,
  IMPROV_CMD_IDENTIFY = 0x02,
};

enum {
  IMPROV_STATE_AUTHORIZED = 0x02,
  IMPROV_STATE_PROVISIONING = 0x03,
  IMPROV_STATE_PROVISIONED = 0x04,
};

enum {
  IMPROV_ERROR_NONE = 0x00,
  IMPROV_ERROR_INVALID_RPC = 0x01,
  IMPROV_ERROR_UNKNOWN_COMMAND = 0x02,
  IMPROV_ERROR_UNABLE_TO_CONNECT = 0x03,
};

static inline uint8_t improv_checksum_(const uint8_t *p, size_t n) {
  unsigned sum = 0;
  for (size_t i = 0; i < n; i++) sum += p[i];
  return (uint8_t)(sum & 0xff);
}

// Validate an RPC packet; on success returns the command and points *data
// at the payload (*data_len bytes). Returns -1 on structural/checksum error.
static inline int improv_parse_rpc(const uint8_t *pkt, size_t len, const uint8_t **data,
                                   uint8_t *data_len) {
  if (len < 3) return -1;
  uint8_t dl = pkt[1];
  if (len < (size_t)(2 + dl + 1)) return -1;
  if (pkt[2 + dl] != improv_checksum_(pkt, 2 + dl)) return -1;
  *data = pkt + 2;
  *data_len = dl;
  return pkt[0];
}

// Extract SSID + password from a CMD_WIFI_SETTINGS payload
// (ssid_len, ssid…, pass_len, pass…). NUL-terminates both.
static inline bool improv_parse_wifi(const uint8_t *data, uint8_t data_len, char *ssid,
                                     size_t ssid_cap, char *pass, size_t pass_cap) {
  if (data_len < 2) return false;
  uint8_t sl = data[0];
  if ((size_t)(1 + sl + 1) > data_len) return false;
  uint8_t pl = data[1 + sl];
  if ((size_t)(1 + sl + 1 + pl) != data_len) return false;
  if (sl == 0 || (size_t)sl + 1 > ssid_cap || (size_t)pl + 1 > pass_cap) return false;
  memcpy(ssid, data + 1, sl);
  ssid[sl] = '\0';
  memcpy(pass, data + 2 + sl, pl);
  pass[pl] = '\0';
  return true;
}

// Build an RPC result packet carrying one string (the redirect URL):
// [cmd, total, len, str…, checksum]. Returns the packet length, or 0 if it
// doesn't fit `cap` (URL longer than 253 bytes can't be encoded).
static inline size_t improv_build_result(uint8_t cmd, const char *str, uint8_t *out, size_t cap) {
  size_t n = strlen(str);
  if (n > 253) return 0;
  size_t total = 1 + n;           // len byte + string
  size_t pkt = 2 + total + 1;     // cmd, total, payload, checksum
  if (pkt > cap) return 0;
  out[0] = cmd;
  out[1] = (uint8_t)total;
  out[2] = (uint8_t)n;
  memcpy(out + 3, str, n);
  out[2 + total] = improv_checksum_(out, 2 + total);
  return pkt;
}

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // FIRMWARE_PLAYER_APP_IMPROV_CODEC_H_
