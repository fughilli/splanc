// Host unit tests for the RFC 6455 codec the firmware speaks — the bytes
// are checked here so the on-device debugging surface is WiFi, not framing.
#include "firmware/player_app/ws_codec.h"

#include <cassert>
#include <cstdio>
#include <cstring>

static void test_accept_key_rfc_vector() {
  // RFC 6455 §1.3's worked example.
  char out[29];
  ws_accept_key("dGhlIHNhbXBsZSBub25jZQ==", out);
  assert(strcmp(out, "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=") == 0);
}

static void test_find_key() {
  const char req[] =
      "GET /ws HTTP/1.1\r\n"
      "Host: 192.168.4.1\r\n"
      "Upgrade: websocket\r\n"
      "sec-websocket-key:  dGhlIHNhbXBsZSBub25jZQ==\r\n"
      "\r\n";
  char key[64];
  assert(ws_find_key(req, key, sizeof key));
  assert(strcmp(key, "dGhlIHNhbXBsZSBub25jZQ==") == 0);
  assert(!ws_find_key("GET / HTTP/1.1\r\n\r\n", key, sizeof key));
}

static void roundtrip(uint64_t payload_len) {
  // Build a server header, re-parse it (server frames are unmasked, which
  // the parser only tolerates for a bare close — so parse as if a client
  // sent it by appending a mask).
  uint8_t hdr[14];
  size_t n = ws_build_frame_header(WS_OP_BINARY, payload_len, hdr);
  hdr[1] |= 0x80;  // set MASK bit
  const uint8_t mask[4] = {0xde, 0xad, 0xbe, 0xef};
  memcpy(hdr + n, mask, 4);
  ws_frame_header h;
  assert(ws_parse_frame_header(hdr, n + 4, &h) == 0);
  assert(h.fin && h.opcode == WS_OP_BINARY && h.masked);
  assert(h.payload_len == payload_len);
  assert(h.header_len == n + 4);
  assert(memcmp(h.mask, mask, 4) == 0);
}

static void test_header_lengths() {
  roundtrip(0);
  roundtrip(125);
  roundtrip(126);      // 16-bit length form
  roundtrip(0xffff);   // largest 16-bit
  roundtrip(0x10000);  // 64-bit length form
  roundtrip(45000);    // a 1024-LED submit_map upload
}

static void test_short_buffers_ask_for_more() {
  uint8_t hdr[14];
  size_t n = ws_build_frame_header(WS_OP_BINARY, 45000, hdr);
  hdr[1] |= 0x80;
  const uint8_t mask[4] = {1, 2, 3, 4};
  memcpy(hdr + n, mask, 4);
  ws_frame_header h;
  for (size_t have = 0; have < n + 4; have++) {
    int need = ws_parse_frame_header(hdr, have, &h);
    assert(need > 0);
    assert(have + (size_t)need <= n + 4);
  }
  assert(ws_parse_frame_header(hdr, n + 4, &h) == 0);
}

static void test_violations() {
  ws_frame_header h;
  // RSV bit set.
  const uint8_t rsv[2] = {0xc2, 0x81};
  assert(ws_parse_frame_header(rsv, 2, &h) == -1);
  // Unmasked client data frame.
  const uint8_t unmasked[2] = {0x82, 0x05};
  assert(ws_parse_frame_header(unmasked, 2, &h) == -1);
  // Bare unmasked close is tolerated (some clients send it).
  const uint8_t close_frame[2] = {0x88, 0x00};
  assert(ws_parse_frame_header(close_frame, 2, &h) == 0);
}

static void test_unmask_incremental() {
  const uint8_t mask[4] = {0x37, 0xfa, 0x21, 0x3d};
  // "Hello" masked, from RFC 6455 §5.7.
  uint8_t masked[5] = {0x7f, 0x9f, 0x4d, 0x51, 0x58};
  uint8_t whole[5];
  memcpy(whole, masked, 5);
  ws_unmask(whole, 5, mask, 0);
  assert(memcmp(whole, "Hello", 5) == 0);
  // Same payload unmasked in two pieces with offsets.
  uint8_t parts[5];
  memcpy(parts, masked, 5);
  ws_unmask(parts, 2, mask, 0);
  ws_unmask(parts + 2, 3, mask, 2);
  assert(memcmp(parts, "Hello", 5) == 0);
}

int main() {
  test_accept_key_rfc_vector();
  test_find_key();
  test_header_lengths();
  test_short_buffers_ask_for_more();
  test_violations();
  test_unmask_incremental();
  printf("PASS\n");
  return 0;
}
