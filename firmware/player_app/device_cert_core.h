// Per-device TLS identity, the host-testable half (docs/design/per-device-cert.md).
//
// Every netstack player generates its own EC P-256 key + self-signed certificate on
// first boot and persists both in ONE littlefs file (power-loss safe: temp + fsync +
// rename, see main.cpp fs_write_file). This header is the pure part — the on-flash
// blob format and the readiness state machine that gates the :443 listener — so it
// is unit-tested on the host (device_cert_core_test.cc). The mbedtls keygen/signing
// and the file I/O are firmware-only (device_cert.cpp).
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace lm_cert {

// -- the persisted blob ---------------------------------------------------------
// Little-endian, fixed header, then the two DER bodies, then a CRC32 over all of it:
//   [0..4)   magic "SPDC"
//   [4]      version (kVersion)
//   [5]      flags (0; reserved)
//   [6..8)   key DER length
//   [8..10)  cert DER length
//   [10..12) first-boot keygen+sign time, ms (saturating; 0 = unknown) — kept so a
//            later boot can still report what generation cost on this device
//   key DER | cert DER
//   CRC32 (IEEE, as zlib) of every preceding byte
// A torn/truncated/foreign file fails decode() and the device regenerates.
constexpr uint8_t kMagic[4] = {'S', 'P', 'D', 'C'};
constexpr uint8_t kVersion = 1;
constexpr size_t kHeaderLen = 12;
constexpr size_t kMaxKeyDer = 160;   // SEC1 EC P-256 private key DER is ~121 B
constexpr size_t kMaxCertDer = 768;  // our leaf is ~450 B
constexpr size_t kMaxBlob = kHeaderLen + kMaxKeyDer + kMaxCertDer + 4;

enum class BlobError : uint8_t { kOk, kShort, kMagic, kVersion, kLength, kCrc };

struct BlobView {
  const uint8_t *key = nullptr;
  size_t key_len = 0;
  const uint8_t *cert = nullptr;
  size_t cert_len = 0;
  uint16_t gen_ms = 0;
};

// Serialize key + cert into `out`. Returns the blob length, or 0 when an input is
// empty/oversized or `cap` is too small.
size_t encode_blob(const uint8_t *key, size_t key_len, const uint8_t *cert, size_t cert_len,
                   uint8_t *out, size_t cap, uint32_t gen_ms = 0);

// Validate + split a blob read back from flash. On kOk `*out` points into `in`.
BlobError decode_blob(const uint8_t *in, size_t n, BlobView *out);

const char *blob_error_name(BlobError e);

uint32_t crc32(const uint8_t *data, size_t len);

// Lowercase hex of `n` bytes into `out` (2n+1 bytes, NUL-terminated).
void hex_lower(const uint8_t *data, size_t n, char *out);

// The certificate's DNS SAN: "<mdns host label>.local", the label being the one the
// mDNS responder advertises (firmware/mdns host_label: "splanc-" + the MAC's last six
// hex digits, lowercase). It is derived from the immutable MAC — not the renameable
// display name and not the DHCP-assigned IP — so the cert never needs re-issuing.
// Returns false if `cap` is too small.
bool san_dns_name(const char *mac, char *out, size_t cap);

// SHA-256 of the shared certificate every netstack image shipped before per-device
// certs (CN=heapless, key baked into the open-source firmware). Clients that pinned
// it re-pin silently ("legacy") instead of warning. Kept in sync with
// agent/src/trust.ts and web/src/net/deviceTrust.ts.
constexpr const char kLegacySharedCertSha256[] =
    "9a2b1729debfa516f1b3a5ade76df3a3332b97868ed667f89298ffc574a1d641";

// -- readiness state machine ----------------------------------------------------
// kBooting -> (stored blob valid) -> kReady
//          -> (missing/corrupt)   -> kGenerating, due now
// kGenerating --(generated ok)----> kReady (persisted = the write landed)
//             --(failed)----------> kGenerating, retry after a capped backoff
// kReady --(installed cert rejected by mbedtls)--> kGenerating (regenerate)
// The :443 listener opens only in kReady, so no handshake ever sees a missing or
// partial cert; until then the manifest/BLE/mDNS report tls "generating".
enum class State : uint8_t { kBooting, kGenerating, kReady };

class Machine {
 public:
  void on_boot(bool loaded_ok, uint32_t now_ms);
  // A generation attempt is due (kGenerating and the backoff has elapsed).
  bool due(uint32_t now_ms) const;
  void on_generated(bool ok, bool persisted, uint32_t now_ms);
  // The (loaded or generated) cert/key failed to install into mbedtls: regenerate.
  void on_install_failed(uint32_t now_ms);

  bool listener_allowed() const { return state_ == State::kReady; }
  State state() const { return state_; }
  // "generating" until kReady, then "ready" (the manifest / TlsInfo / mDNS value).
  const char *state_name() const;
  bool persisted() const { return persisted_; }
  bool loaded_from_store() const { return loaded_; }
  uint32_t failures() const { return failures_; }

  // Backoff after the n-th consecutive failure: 1 s, 2 s, 4 s ... capped at 30 s.
  static uint32_t backoff_ms(uint32_t failures);

 private:
  State state_ = State::kBooting;
  bool persisted_ = false;
  bool loaded_ = false;
  uint32_t failures_ = 0;
  uint32_t next_try_ms_ = 0;
};

}  // namespace lm_cert
