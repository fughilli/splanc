// Ported from fughilli/indoor_localization apps/common/swarm_crypto.h at 5a906e78 (Splanc owns this
// copy; firmware/mesh/swarm/PROVENANCE.md lists what changed).
// MbedTLS backend for swarm_net's crypto (firmware/mesh/swarm/src/crypto.rs). The
// extern "C" functions are what the Rust side links against; RunSelfTest
// checks them against known answers at boot.
#ifndef FIRMWARE_MESH_SWARM_SWARM_CRYPTO_H
#define FIRMWARE_MESH_SWARM_SWARM_CRYPTO_H

#include <stddef.h>
#include <stdint.h>

extern "C" {
void *swarm_crypto_sha256_begin();
void swarm_crypto_sha256_update(void *ctx, const uint8_t *data, size_t len);
void swarm_crypto_sha256_finish(void *ctx, uint8_t *out);
int32_t swarm_crypto_hmac_sha256(const uint8_t *key, size_t key_len, const uint8_t *msg, size_t len,
                                 uint8_t *out);
int32_t swarm_crypto_p256_verify(const uint8_t *public_key, const uint8_t *hash, const uint8_t *sig);
}

namespace swarm_crypto {

struct SelfTest
{
  bool hmac;  // RFC 4231 case 2
  bool p256;  // a host-made signature verifies, a corrupted hash doesn't
};

SelfTest RunSelfTest();

}  // namespace swarm_crypto

#endif  // FIRMWARE_MESH_SWARM_SWARM_CRYPTO_H
