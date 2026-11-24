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

// The mesh member's status (HEARTBEAT body) and a relayed control's result (REPLY to
// LK_MESH): little-endian, exact sizes, and an empty (older) body carries no status.
static void test_mesh_bodies() {
  lk_status s = {61, 200, 0x8badf00d, LK_ST_KIOSK};
  uint8_t b[LK_STATUS_EXT_LEN];
  lk_status_pack(&s, b);
  assert(memcmp(b, unhex("3d000000c80000000df0ad8b01000000").data(), LK_STATUS_LEN) == 0);
  lk_status got = {};
  // A step-2 P4's 16-byte body: the status, no extension.
  assert(lk_status_parse(b, LK_STATUS_LEN, &got));
  assert(got.fps == 61 && got.brightness == 200 && got.firmware == 0x8badf00d && got.flags == LK_ST_KIOSK);
  assert(!got.has_ext && got.tb_seq == 0 && got.fx_gen == 0);
  assert(!lk_status_parse(b, 0, &got));
  assert(!lk_status_parse(b, LK_STATUS_LEN - 1, &got));

  // Step 3's extension: the time base (negative epochs too), the TIMEBASE echo, fx.pb's counter.
  s.flags = LK_ST_KIOSK | lk_unlock_bit(2) | lk_unlock_bit(LK_SESSION_BLE);
  s.tb_epoch_ms = -2;
  s.tb_seq = 0x1234;
  s.tb_flags = LK_TB_SET | LK_TB_ALIGN;
  s.tb_shift_total = -5;
  s.fx_gen = 7;
  lk_status_pack(&s, b);
  assert(memcmp(b, unhex("3d000000c80000000df0ad8b0b000000feffffffffffffff34120300fbffffff07000000").data(),
                sizeof b) == 0);
  assert(lk_status_parse(b, sizeof b, &got) && got.has_ext);
  assert(got.tb_epoch_ms == -2 && got.tb_seq == 0x1234 && got.tb_flags == (LK_TB_SET | LK_TB_ALIGN));
  assert(got.tb_shift_total == -5 && got.fx_gen == 7);
  assert((got.flags & lk_unlock_bit(2)) && (got.flags & LK_ST_UNLOCKED_BLE) && !(got.flags & lk_unlock_bit(1)));
  // Session ids without an unlock bit: the mesh's own, and wss sessions past 3.
  assert(lk_unlock_bit(LK_SESSION_MESH) == 0 && lk_unlock_bit(4) == 0 && lk_unlock_bit(0) == 0);
  assert(lk_unlock_bit(1) == LK_ST_UNLOCKED_WS1 && lk_unlock_bit(3) == LK_ST_UNLOCKED_WS1 << 2);

  lk_timebase t = {7, LK_TB_SET, 1700000000123LL, -3};
  uint8_t tb[LK_TIMEBASE_LEN];
  lk_timebase_pack(&t, tb);
  assert(memcmp(tb, unhex("070001007b68e5cf8b010000fdffffff").data(), sizeof tb) == 0);
  lk_timebase tg = {};
  assert(lk_timebase_parse(tb, sizeof tb, &tg));
  assert(tg.seq == 7 && tg.flags == LK_TB_SET && tg.epoch_ms == 1700000000123LL && tg.shift_total == -3);
  assert(!lk_timebase_parse(tb, sizeof tb - 1, &tg));

  uint8_t sr[LK_STAGE_RESULT_LEN];
  lk_stage_result_pack(-1, 0x01020304, sr);
  assert(memcmp(sr, unhex("ff04030201").data(), sizeof sr) == 0);
  int8_t sres = 0;
  uint32_t rid = 0;
  assert(lk_stage_result_parse(sr, sizeof sr, &sres, &rid) && sres == -1 && rid == 0x01020304);
  sr[0] = 2;
  assert(!lk_stage_result_parse(sr, sizeof sr, &sres, &rid));
  assert(!lk_stage_result_parse(sr, sizeof sr - 1, &sres, &rid));

  uint8_t r[LK_MESH_RESULT_LEN];
  lk_mesh_result_pack(1, 0xfffe, r);
  assert(memcmp(r, unhex("01feff0000").data(), sizeof r) == 0);
  uint8_t st = 9;
  uint32_t code = 0;
  assert(lk_mesh_result_parse(r, sizeof r, &st, &code) && st == 1 && code == 0xfffe);
  // A ServerMessage (an older P4 answering it as a player message) is not a result.
  const uint8_t welcome[] = {0x0a, 0x03, 0x01, 0x02, 0x03};
  assert(!lk_mesh_result_parse(welcome, sizeof welcome, &st, &code));
  assert(!lk_mesh_result_parse(r, sizeof r - 1, &st, &code));
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
                          {"mesh_bodies", test_mesh_bodies},
                      });
}
