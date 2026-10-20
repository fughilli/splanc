#include "device_cert_core.h"

#include <string.h>

namespace lm_cert {

namespace {

void put16(uint8_t *p, uint16_t v) {
  p[0] = (uint8_t)v;
  p[1] = (uint8_t)(v >> 8);
}
uint16_t get16(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }
void put32(uint8_t *p, uint32_t v) {
  for (int i = 0; i < 4; i++) p[i] = (uint8_t)(v >> (8 * i));
}
uint32_t get32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

}  // namespace

uint32_t crc32(const uint8_t *data, size_t len) {
  uint32_t c = 0xFFFFFFFFu;
  for (size_t i = 0; i < len; i++) {
    c ^= data[i];
    for (int k = 0; k < 8; k++) c = (c >> 1) ^ (0xEDB88320u & (0u - (c & 1u)));
  }
  return ~c;
}

size_t encode_blob(const uint8_t *key, size_t key_len, const uint8_t *cert, size_t cert_len,
                   uint8_t *out, size_t cap, uint32_t gen_ms) {
  if (key == nullptr || cert == nullptr || out == nullptr) return 0;
  if (key_len == 0 || key_len > kMaxKeyDer || cert_len == 0 || cert_len > kMaxCertDer) return 0;
  size_t total = kHeaderLen + key_len + cert_len + 4;
  if (cap < total) return 0;
  memcpy(out, kMagic, 4);
  out[4] = kVersion;
  out[5] = 0;
  put16(out + 6, (uint16_t)key_len);
  put16(out + 8, (uint16_t)cert_len);
  put16(out + 10, (uint16_t)(gen_ms > 0xFFFF ? 0xFFFF : gen_ms));
  memcpy(out + kHeaderLen, key, key_len);
  memcpy(out + kHeaderLen + key_len, cert, cert_len);
  put32(out + total - 4, crc32(out, total - 4));
  return total;
}

BlobError decode_blob(const uint8_t *in, size_t n, BlobView *out) {
  if (in == nullptr || n < kHeaderLen + 4) return BlobError::kShort;
  if (memcmp(in, kMagic, 4) != 0) return BlobError::kMagic;
  if (in[4] != kVersion) return BlobError::kVersion;
  size_t kl = get16(in + 6), cl = get16(in + 8);
  if (kl == 0 || kl > kMaxKeyDer || cl == 0 || cl > kMaxCertDer) return BlobError::kLength;
  size_t total = kHeaderLen + kl + cl + 4;
  if (n < total) return BlobError::kShort;
  if (n != total) return BlobError::kLength;  // trailing garbage: not a file we wrote
  if (get32(in + total - 4) != crc32(in, total - 4)) return BlobError::kCrc;
  if (out != nullptr) {
    out->key = in + kHeaderLen;
    out->key_len = kl;
    out->cert = in + kHeaderLen + kl;
    out->cert_len = cl;
    out->gen_ms = get16(in + 10);
  }
  return BlobError::kOk;
}

const char *blob_error_name(BlobError e) {
  switch (e) {
    case BlobError::kOk: return "ok";
    case BlobError::kShort: return "short";
    case BlobError::kMagic: return "bad-magic";
    case BlobError::kVersion: return "bad-version";
    case BlobError::kLength: return "bad-length";
    case BlobError::kCrc: return "bad-crc";
  }
  return "?";
}

void hex_lower(const uint8_t *data, size_t n, char *out) {
  static const char kHex[] = "0123456789abcdef";
  for (size_t i = 0; i < n; i++) {
    out[2 * i] = kHex[data[i] >> 4];
    out[2 * i + 1] = kHex[data[i] & 15];
  }
  out[2 * n] = 0;
}

bool san_dns_name(const char *mac, char *out, size_t cap) {
  // Mirror firmware/mdns host_label: "splanc-" + the last six hex digits of the MAC
  // (lowercase); no MAC -> "splanc".
  char hex[12];
  size_t n = 0;
  for (const char *p = mac; p != nullptr && *p != 0; ++p) {
    char c = *p;
    bool is_hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
    if (!is_hex || n >= sizeof hex) continue;
    hex[n++] = (c >= 'A' && c <= 'F') ? (char)(c - 'A' + 'a') : c;
  }
  char label[16];
  if (n >= 6) {
    memcpy(label, "splanc-", 7);
    memcpy(label + 7, hex + n - 6, 6);
    label[13] = 0;
  } else {
    memcpy(label, "splanc", 7);
  }
  size_t ll = strlen(label);
  if (cap < ll + sizeof(".local")) return false;
  memcpy(out, label, ll);
  memcpy(out + ll, ".local", sizeof(".local"));
  return true;
}

// -- state machine ------------------------------------------------------------------

uint32_t Machine::backoff_ms(uint32_t failures) {
  if (failures == 0) return 0;
  uint32_t ms = 1000;
  for (uint32_t i = 1; i < failures && ms < 30000; i++) ms *= 2;
  return ms > 30000 ? 30000 : ms;
}

void Machine::on_boot(bool loaded_ok, uint32_t now_ms) {
  loaded_ = loaded_ok;
  failures_ = 0;
  if (loaded_ok) {
    state_ = State::kReady;
    persisted_ = true;
  } else {
    state_ = State::kGenerating;
    persisted_ = false;
    next_try_ms_ = now_ms;
  }
}

bool Machine::due(uint32_t now_ms) const {
  // Wrap-safe "now >= next_try" (millis() wraps after ~49 days).
  return state_ == State::kGenerating && (int32_t)(now_ms - next_try_ms_) >= 0;
}

void Machine::on_generated(bool ok, bool persisted, uint32_t now_ms) {
  if (state_ != State::kGenerating) return;
  if (ok) {
    state_ = State::kReady;
    persisted_ = persisted;
    failures_ = 0;
    return;
  }
  failures_++;
  next_try_ms_ = now_ms + backoff_ms(failures_);
}

void Machine::on_install_failed(uint32_t now_ms) {
  state_ = State::kGenerating;
  persisted_ = false;
  loaded_ = false;
  failures_++;
  next_try_ms_ = now_ms + backoff_ms(failures_);
}

const char *Machine::state_name() const {
  return state_ == State::kReady ? "ready" : "generating";
}

}  // namespace lm_cert
