// Host tests for the Improv packet codec — the vectors here MATCH the web
// app's (web/tests/improv.test.ts), pinning both ends to one wire.
#include "firmware/player_app/improv_codec.h"

#include <cassert>
#include <cstdio>
#include <cstring>

static void test_wifi_settings_vector() {
  // buildWifiSettings("net", "pw") from improv.test.ts.
  const uint8_t pkt[] = {0x01, 0x07, 0x03, 0x6e, 0x65, 0x74, 0x02, 0x70, 0x77,
                         (uint8_t)((0x01 + 0x07 + 0x03 + 0x6e + 0x65 + 0x74 + 0x02 + 0x70 + 0x77) &
                                   0xff)};
  const uint8_t *data;
  uint8_t data_len;
  assert(improv_parse_rpc(pkt, sizeof pkt, &data, &data_len) == IMPROV_CMD_WIFI_SETTINGS);
  char ssid[33], pass[65];
  assert(improv_parse_wifi(data, data_len, ssid, sizeof ssid, pass, sizeof pass));
  assert(strcmp(ssid, "net") == 0);
  assert(strcmp(pass, "pw") == 0);
}

static void test_open_network() {
  // Empty password (open network) is allowed; empty SSID is not.
  const uint8_t data_open[] = {0x04, 'o', 'p', 'e', 'n', 0x00};
  char ssid[33], pass[65];
  assert(improv_parse_wifi(data_open, sizeof data_open, ssid, sizeof ssid, pass, sizeof pass));
  assert(strcmp(ssid, "open") == 0 && pass[0] == '\0');
  const uint8_t data_noname[] = {0x00, 0x02, 'p', 'w'};
  assert(!improv_parse_wifi(data_noname, sizeof data_noname, ssid, sizeof ssid, pass, sizeof pass));
}

static void test_bad_packets() {
  const uint8_t *data;
  uint8_t data_len;
  const uint8_t bad_sum[] = {0x01, 0x02, 0x01, 0x41, 0x00};
  assert(improv_parse_rpc(bad_sum, sizeof bad_sum, &data, &data_len) == -1);
  const uint8_t truncated[] = {0x01, 0x10, 0x01};
  assert(improv_parse_rpc(truncated, sizeof truncated, &data, &data_len) == -1);
  // Payload length lies about the string sizes.
  char ssid[33], pass[65];
  const uint8_t lying[] = {0x05, 'a', 'b', 0x00};
  assert(!improv_parse_wifi(lying, sizeof lying, ssid, sizeof ssid, pass, sizeof pass));
}

static void test_result_roundtrip_matches_web_vector() {
  // parseRpcResult vector from improv.test.ts: one string
  // "http://192.168.1.50/".
  const char *url = "http://192.168.1.50/";
  uint8_t out[64];
  size_t n = improv_build_result(IMPROV_CMD_WIFI_SETTINGS, url, out, sizeof out);
  assert(n == 2 + 1 + strlen(url) + 1);
  assert(out[0] == 0x01);
  assert(out[1] == 1 + strlen(url));
  assert(out[2] == strlen(url));
  assert(memcmp(out + 3, url, strlen(url)) == 0);
  assert(out[n - 1] == improv_checksum_(out, n - 1));
  // Too-small buffer refuses.
  assert(improv_build_result(IMPROV_CMD_WIFI_SETTINGS, url, out, 5) == 0);
}

int main() {
  test_wifi_settings_vector();
  test_open_network();
  test_bad_packets();
  test_result_roundtrip_matches_web_vector();
  printf("PASS\n");
  return 0;
}
