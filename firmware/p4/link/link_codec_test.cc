// Host tests for the link frames: the exact bytes (tools/p4_link_test.py pins the
// same vectors for the host bridge), COBS edge cases, and stream resync.
#include "firmware/p4/link/link_codec.h"

#include <cassert>
#include <cstring>
#include <vector>

#include "rr_case.h"

static std::vector<uint8_t> unhex(const char *s) {
  std::vector<uint8_t> v;
  for (; s[0] && s[1]; s += 2) {
    auto nib = [](char c) { return c <= '9' ? c - '0' : c - 'a' + 10; };
    v.push_back((uint8_t)(nib(s[0]) << 4 | nib(s[1])));
  }
  return v;
}

static std::vector<uint8_t> encode(const lk_header &h, const uint8_t *payload) {
  std::vector<uint8_t> out(lk_stream_max(h.len));
  out.resize(lk_encode(&h, payload, out.data()));
  return out;
}

static void test_crc_check_value() { assert(lk_crc16(0xffff, (const uint8_t *)"123456789", 9) == 0x29b1); }

static void test_vectors() {
  // A PLAYER frame with a zero in the payload and a session.
  const uint8_t p1[] = {0x0a, 0x00, 0x12, 0x34};
  lk_header h1 = {LK_VERSION, LK_PLAYER, 0, 0, 0x0102, 7, sizeof p1};
  uint8_t hdr[LK_HEADER];
  lk_header_pack(&h1, p1, hdr);
  assert(memcmp(hdr, unhex("010100000201070004008bda").data(), LK_HEADER) == 0);
  assert(encode(h1, p1) == unhex("0003010101040201070204048bda0a03123400"));
  // A LOG line.
  lk_header h2 = {LK_VERSION, LK_LOG, 0, 0, 0, 0, 3};
  assert(encode(h2, (const uint8_t *)"hi\n") == unhex("000301060101010101020306e81168690a00"));
}

static void roundtrip(size_t n) {
  std::vector<uint8_t> payload(n);
  for (size_t i = 0; i < n; i++) payload[i] = (uint8_t)((i * 7 + 1) % 256);  // zeros every 256
  lk_header h = {LK_VERSION, LK_REPLY, 1, LK_MORE, 9, 300, (uint16_t)n};
  auto wire = encode(h, payload.data());
  assert(wire.size() <= lk_stream_max(n));
  assert(wire.front() == 0 && wire.back() == 0);
  for (size_t i = 1; i + 1 < wire.size(); i++) assert(wire[i] != 0);
  std::vector<uint8_t> buf(lk_stream_max(LK_MTU));
  lk_rx rx;
  lk_rx_init(&rx, buf.data(), buf.size());
  lk_header got;
  const uint8_t *pl = nullptr;
  int frames = 0;
  for (uint8_t b : wire) {
    int r = lk_rx_push(&rx, b, &got, &pl);
    assert(r != LK_RX_NOISE);
    if (r == LK_RX_FRAME) {
      frames++;
      assert(got.type == LK_REPLY && got.lane == 1 && got.flags == LK_MORE && got.session == 9 && got.seq == 300);
      assert(got.len == n && memcmp(pl, payload.data(), n) == 0);
    }
  }
  assert(frames == 1);
}

static void test_roundtrips() {
  // Around the COBS block boundary (254 non-zero bytes) and the MTU.
  for (size_t n : {0, 1, 241, 242, 243, 253, 254, 255, 600, 4095, 4096}) roundtrip(n);
}

static void test_resync_after_noise() {
  std::vector<uint8_t> buf(lk_stream_max(LK_MTU));
  lk_rx rx;
  lk_rx_init(&rx, buf.data(), buf.size());
  const uint8_t p[] = {1, 2, 3};
  lk_header h = {LK_VERSION, LK_PLAYER, 0, 0, 0, 1, 3};
  auto frame = encode(h, p);
  // Console text, then half a frame cut by a reset, then a whole frame.
  std::vector<uint8_t> s;
  for (const char *t = "ESP-ROM:esp32p4\r\n"; *t; t++) s.push_back((uint8_t)*t);
  s.insert(s.end(), frame.begin(), frame.begin() + frame.size() / 2);
  s.insert(s.end(), frame.begin(), frame.end());
  int frames = 0, noise = 0;
  lk_header got;
  const uint8_t *pl;
  for (uint8_t b : s) {
    int r = lk_rx_push(&rx, b, &got, &pl);
    frames += r == LK_RX_FRAME;
    noise += r == LK_RX_NOISE;
  }
  assert(frames == 1 && noise == 2);
  // A corrupted byte fails the CRC.
  auto bad = frame;
  bad[5] ^= 0x40;
  frames = 0;
  for (uint8_t b : bad) frames += lk_rx_push(&rx, b, &got, &pl) == LK_RX_FRAME;
  assert(frames == 0);
}

static void test_overflow_is_noise() {
  uint8_t small[16];
  lk_rx rx;
  lk_rx_init(&rx, small, sizeof small);
  lk_header got;
  const uint8_t *pl;
  for (int i = 0; i < 40; i++) assert(lk_rx_push(&rx, 0x55, &got, &pl) == LK_RX_NONE);
  assert(lk_rx_push(&rx, 0, &got, &pl) == LK_RX_NOISE);
  assert(rx.n == 0 && !rx.overflow);
}

static void test_bad_cobs() {
  uint8_t out[8];
  const uint8_t truncated[] = {5, 1, 2};
  assert(lk_cobs_decode(truncated, sizeof truncated, out) == -1);
}

int main(int argc, char **argv) {
  return rr::RunCases(argc, argv, "link_codec",
                      {
                          {"crc_check_value", test_crc_check_value},
                          {"vectors", test_vectors},
                          {"roundtrips", test_roundtrips},
                          {"resync_after_noise", test_resync_after_noise},
                          {"overflow_is_noise", test_overflow_is_noise},
                          {"bad_cobs", test_bad_cobs},
                      });
}
