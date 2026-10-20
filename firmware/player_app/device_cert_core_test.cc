// Host unit tests for the per-device TLS identity's pure half: the persisted blob
// (round trip + every corruption a torn write or a foreign file can produce) and the
// readiness state machine that keeps :443 closed until a cert exists.
#include "firmware/player_app/device_cert_core.h"

#include <cassert>
#include <cstring>

#include "rr_case.h"

using lm_cert::BlobError;
using lm_cert::BlobView;
using lm_cert::Machine;
using lm_cert::State;

namespace {

uint8_t g_key[121], g_cert[452], g_blob[lm_cert::kMaxBlob];

size_t make_blob() {
  for (size_t i = 0; i < sizeof g_key; i++) g_key[i] = (uint8_t)(i * 7 + 1);
  for (size_t i = 0; i < sizeof g_cert; i++) g_cert[i] = (uint8_t)(i * 13 + 5);
  return lm_cert::encode_blob(g_key, sizeof g_key, g_cert, sizeof g_cert, g_blob, sizeof g_blob,
                              74);
}

}  // namespace

static void test_blob_round_trip() {
  size_t n = make_blob();
  assert(n == lm_cert::kHeaderLen + sizeof g_key + sizeof g_cert + 4);
  BlobView v;
  assert(lm_cert::decode_blob(g_blob, n, &v) == BlobError::kOk);
  assert(v.key_len == sizeof g_key && memcmp(v.key, g_key, sizeof g_key) == 0);
  assert(v.cert_len == sizeof g_cert && memcmp(v.cert, g_cert, sizeof g_cert) == 0);
  assert(v.gen_ms == 74);  // the first-boot generation time survives in the blob
  uint8_t big[lm_cert::kMaxBlob];
  size_t m = lm_cert::encode_blob(g_key, sizeof g_key, g_cert, sizeof g_cert, big, sizeof big,
                                  100000);
  assert(lm_cert::decode_blob(big, m, &v) == BlobError::kOk && v.gen_ms == 0xFFFF);
}

static void test_blob_rejects_every_truncation() {
  // A reset mid-write can only leave a short temp file (the rename never ran), but
  // a short destination must still never decode.
  size_t n = make_blob();
  for (size_t cut = 0; cut < n; cut++) {
    assert(lm_cert::decode_blob(g_blob, cut, nullptr) != BlobError::kOk);
  }
}

static void test_blob_rejects_any_flipped_bit() {
  size_t n = make_blob();
  for (size_t i = 0; i < n; i++) {
    for (int b = 0; b < 8; b++) {
      g_blob[i] ^= (uint8_t)(1u << b);
      assert(lm_cert::decode_blob(g_blob, n, nullptr) != BlobError::kOk);
      g_blob[i] ^= (uint8_t)(1u << b);
    }
  }
  assert(lm_cert::decode_blob(g_blob, n, nullptr) == BlobError::kOk);
}

static void test_blob_rejects_foreign_and_trailing() {
  size_t n = make_blob();
  uint8_t copy[lm_cert::kMaxBlob + 8];
  memcpy(copy, g_blob, n);
  copy[n] = 0;
  assert(lm_cert::decode_blob(copy, n + 1, nullptr) == BlobError::kLength);
  copy[0] = 'X';
  assert(lm_cert::decode_blob(copy, n, nullptr) == BlobError::kMagic);
  memcpy(copy, g_blob, n);
  copy[4] = 2;
  assert(lm_cert::decode_blob(copy, n, nullptr) == BlobError::kVersion);
  assert(lm_cert::decode_blob(nullptr, 0, nullptr) == BlobError::kShort);
}

static void test_encode_bounds() {
  uint8_t out[lm_cert::kMaxBlob];
  uint8_t big[lm_cert::kMaxCertDer + 1] = {};
  assert(lm_cert::encode_blob(g_key, 0, g_cert, 10, out, sizeof out) == 0);
  assert(lm_cert::encode_blob(g_key, 10, big, sizeof big, out, sizeof out) == 0);
  assert(lm_cert::encode_blob(g_key, 10, g_cert, 10, out, 20) == 0);  // cap too small
  assert(lm_cert::encode_blob(big, lm_cert::kMaxKeyDer, big, lm_cert::kMaxCertDer, out,
                              sizeof out) == sizeof out);
}

static void test_crc32_matches_zlib() {
  const char *s = "123456789";
  assert(lm_cert::crc32(reinterpret_cast<const uint8_t *>(s), 9) == 0xCBF43926u);
}

static void test_hex_and_san() {
  const uint8_t d[3] = {0x00, 0xab, 0xff};
  char hex[7];
  lm_cert::hex_lower(d, 3, hex);
  assert(strcmp(hex, "00abff") == 0);
  char san[32];
  // Same label as firmware/mdns host_label ("AA:BB:CC:DD:EE:FF" -> splanc-ddeeff).
  assert(lm_cert::san_dns_name("AA:BB:CC:DD:EE:FF", san, sizeof san));
  assert(strcmp(san, "splanc-ddeeff.local") == 0);
  assert(lm_cert::san_dns_name("", san, sizeof san));
  assert(strcmp(san, "splanc.local") == 0);
  assert(!lm_cert::san_dns_name("AA:BB:CC:DD:EE:FF", san, 19));  // needs 20 incl NUL
  assert(lm_cert::san_dns_name("AA:BB:CC:DD:EE:FF", san, 20));
}

static void test_legacy_hash_is_well_formed() {
  assert(strlen(lm_cert::kLegacySharedCertSha256) == 64);
}

static void test_machine_stored_cert_is_ready_immediately() {
  Machine m;
  assert(!m.listener_allowed());
  assert(strcmp(m.state_name(), "generating") == 0);  // nothing served before boot decides
  m.on_boot(true, 100);
  assert(m.state() == State::kReady && m.listener_allowed());
  assert(m.persisted() && m.loaded_from_store());
  assert(!m.due(100));
  assert(strcmp(m.state_name(), "ready") == 0);
}

static void test_machine_first_boot_generates_and_gates_listener() {
  Machine m;
  m.on_boot(false, 100);
  assert(m.state() == State::kGenerating && !m.listener_allowed());
  assert(m.due(100));
  m.on_generated(true, true, 180);
  assert(m.listener_allowed() && m.persisted() && !m.loaded_from_store());
  assert(!m.due(1000));
}

static void test_machine_failure_backs_off_then_recovers() {
  Machine m;
  m.on_boot(false, 0);
  m.on_generated(false, false, 10);  // e.g. the keygen alloc failed
  assert(!m.listener_allowed());
  assert(!m.due(10) && !m.due(1009) && m.due(1010));  // 1 s backoff
  m.on_generated(false, false, 1010);
  assert(!m.due(3009) && m.due(3010));  // 2 s
  assert(m.failures() == 2);
  m.on_generated(true, false, 3010);  // generated, but the flash write failed
  assert(m.listener_allowed() && !m.persisted());
  assert(m.failures() == 0);
}

static void test_machine_backoff_caps() {
  assert(Machine::backoff_ms(0) == 0);
  assert(Machine::backoff_ms(1) == 1000);
  assert(Machine::backoff_ms(2) == 2000);
  assert(Machine::backoff_ms(5) == 16000);
  assert(Machine::backoff_ms(6) == 30000);
  assert(Machine::backoff_ms(100) == 30000);
}

static void test_machine_due_is_wrap_safe() {
  Machine m;
  m.on_boot(false, 0xFFFFFF00u);
  m.on_generated(false, false, 0xFFFFFF00u);  // next try wraps past 0
  assert(!m.due(0xFFFFFFF0u));
  assert(!m.due(0x000002E7u));
  assert(m.due(0x000002E8u));  // 0xFFFFFF00 + 1000 mod 2^32
}

static void test_machine_install_failure_regenerates() {
  Machine m;
  m.on_boot(true, 0);
  m.on_install_failed(5);  // stored blob passed CRC but mbedtls rejected it
  assert(!m.listener_allowed() && m.state() == State::kGenerating);
  assert(m.due(1005));
  m.on_generated(true, true, 1005);
  assert(m.listener_allowed());
}

static void test_machine_ignores_late_results_when_ready() {
  Machine m;
  m.on_boot(true, 0);
  m.on_generated(false, false, 1);
  assert(m.listener_allowed() && m.failures() == 0);
}

int main(int argc, char **argv) {
  return rr::RunCases(
      argc, argv, "device_cert_core",
      {
          {"blob_round_trip", test_blob_round_trip},
          {"blob_rejects_every_truncation", test_blob_rejects_every_truncation},
          {"blob_rejects_any_flipped_bit", test_blob_rejects_any_flipped_bit},
          {"blob_rejects_foreign_and_trailing", test_blob_rejects_foreign_and_trailing},
          {"encode_bounds", test_encode_bounds},
          {"crc32_matches_zlib", test_crc32_matches_zlib},
          {"hex_and_san", test_hex_and_san},
          {"legacy_hash_is_well_formed", test_legacy_hash_is_well_formed},
          {"machine_stored_cert_is_ready_immediately", test_machine_stored_cert_is_ready_immediately},
          {"machine_first_boot_generates_and_gates_listener",
           test_machine_first_boot_generates_and_gates_listener},
          {"machine_failure_backs_off_then_recovers", test_machine_failure_backs_off_then_recovers},
          {"machine_backoff_caps", test_machine_backoff_caps},
          {"machine_due_is_wrap_safe", test_machine_due_is_wrap_safe},
          {"machine_install_failure_regenerates", test_machine_install_failure_regenerates},
          {"machine_ignores_late_results_when_ready", test_machine_ignores_late_results_when_ready},
      });
}
