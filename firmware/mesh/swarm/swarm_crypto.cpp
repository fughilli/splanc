// Ported from fughilli/indoor_localization apps/common/swarm_crypto.cpp at 5a906e78 (Splanc owns this
// copy; firmware/mesh/swarm/PROVENANCE.md lists what changed).
// The crypto backend swarm_net calls on the device (firmware/mesh/swarm/src/crypto.rs,
// feature "mbedtls"): ESP-IDF's MbedTLS, whose SHA-256 runs on the ESP32's
// SHA accelerator.
#include "firmware/mesh/swarm/swarm_crypto.h"

#include <mbedtls/ecdsa.h>
#include <mbedtls/md.h>
#include <mbedtls/sha256.h>
#include <stdlib.h>
#include <string.h>

extern "C" {

void *swarm_crypto_sha256_begin()
{
  auto *ctx = static_cast<mbedtls_sha256_context *>(malloc(sizeof(mbedtls_sha256_context)));
  if (!ctx)
    return nullptr;
  mbedtls_sha256_init(ctx);
  if (mbedtls_sha256_starts(ctx, 0) != 0)
  {
    mbedtls_sha256_free(ctx);
    free(ctx);
    return nullptr;
  }
  return ctx;
}

void swarm_crypto_sha256_update(void *ctx, const uint8_t *data, size_t len)
{
  mbedtls_sha256_update(static_cast<mbedtls_sha256_context *>(ctx), data, len);
}

void swarm_crypto_sha256_finish(void *ctx, uint8_t *out)
{
  auto *c = static_cast<mbedtls_sha256_context *>(ctx);
  mbedtls_sha256_finish(c, out);
  mbedtls_sha256_free(c);
  free(c);
}

int32_t swarm_crypto_hmac_sha256(const uint8_t *key, size_t key_len, const uint8_t *msg, size_t len,
                                 uint8_t *out)
{
  return mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), key, key_len, msg, len, out);
}

int32_t swarm_crypto_p256_verify(const uint8_t *public_key, const uint8_t *hash, const uint8_t *sig)
{
  mbedtls_ecp_group grp;
  mbedtls_ecp_point q;
  mbedtls_mpi r, s;
  mbedtls_ecp_group_init(&grp);
  mbedtls_ecp_point_init(&q);
  mbedtls_mpi_init(&r);
  mbedtls_mpi_init(&s);
  int ret = mbedtls_ecp_group_load(&grp, MBEDTLS_ECP_DP_SECP256R1);
  if (ret == 0)
    ret = mbedtls_ecp_point_read_binary(&grp, &q, public_key, 65);
  if (ret == 0)
    ret = mbedtls_mpi_read_binary(&r, sig, 32);
  if (ret == 0)
    ret = mbedtls_mpi_read_binary(&s, sig + 32, 32);
  if (ret == 0)
    ret = mbedtls_ecdsa_verify(&grp, hash, 32, &q, &r, &s);
  mbedtls_mpi_free(&s);
  mbedtls_mpi_free(&r);
  mbedtls_ecp_point_free(&q);
  mbedtls_ecp_group_free(&grp);
  return ret;
}

}  // extern "C"

namespace swarm_crypto {
namespace {

// RFC 4231 test case 2.
const uint8_t kHmacWant[32] = {
    0x5b, 0xdc, 0xc1, 0x46, 0xbf, 0x60, 0x75, 0x4e, 0x6a, 0x04, 0x24, 0x26, 0x08, 0x95, 0x75, 0xc7,
    0x5a, 0x00, 0x3f, 0x08, 0x9d, 0x27, 0x39, 0x83, 0x9d, 0xec, 0x58, 0xb9, 0x64, 0xec, 0x38, 0x43,
};

// P-256 key from scalar 0x0707...07 and a signature over
// "swarm crypto self-test", made with Python's cryptography package (an
// implementation independent of both backends).
const uint8_t kKatPublic[65] = {
    0x04, 0x1e, 0x18, 0x53, 0x2f, 0xd4, 0x75, 0x4c, 0x02, 0xf3, 0x04, 0x1d, 0x9c, 0x75, 0xce, 0xb3, 0x3b,
    0x83, 0xff, 0xd8, 0x1a, 0xc7, 0xce, 0x4f, 0xe8, 0x82, 0xcc, 0xb1, 0xc9, 0x8b, 0xc5, 0x89, 0x6e, 0xa4,
    0x6c, 0x31, 0x1c, 0x4e, 0x2f, 0xf4, 0x0d, 0xd9, 0x6a, 0x36, 0x53, 0xe6, 0xe4, 0x54, 0x45, 0xd3, 0x2d,
    0xfe, 0x48, 0x6e, 0xce, 0xd7, 0x5c, 0x7a, 0x90, 0xc6, 0xa1, 0x88, 0x81, 0xc0, 0xa3,
};
const uint8_t kKatSig[64] = {
    0xd7, 0xd7, 0x26, 0xa6, 0x21, 0x15, 0x88, 0x7d, 0xf8, 0xe3, 0xf4, 0xbb, 0x45, 0x50, 0xdf, 0x4a,
    0xa6, 0x7b, 0xb4, 0x8b, 0x40, 0x35, 0x5e, 0x8e, 0x07, 0xf3, 0x5a, 0x72, 0x56, 0x66, 0x9d, 0xfa,
    0x01, 0xf8, 0xf3, 0x5e, 0x83, 0x1d, 0x03, 0x4a, 0x85, 0xf1, 0xf5, 0x3a, 0x2d, 0xcc, 0x10, 0x15,
    0xcc, 0x29, 0x12, 0x23, 0x9e, 0x90, 0x88, 0x80, 0x81, 0x8b, 0x12, 0x8f, 0x8e, 0x6a, 0xeb, 0xee,
};
const char kKatMsg[] = "swarm crypto self-test";

}  // namespace

SelfTest RunSelfTest()
{
  SelfTest r = {};
  uint8_t out[32];
  const char *key = "Jefe", *msg = "what do ya want for nothing?";
  r.hmac = swarm_crypto_hmac_sha256(reinterpret_cast<const uint8_t *>(key), 4,
                                    reinterpret_cast<const uint8_t *>(msg), strlen(msg), out) == 0 &&
           memcmp(out, kHmacWant, 32) == 0;

  uint8_t hash[32];
  void *h = swarm_crypto_sha256_begin();
  if (h)
  {
    swarm_crypto_sha256_update(h, reinterpret_cast<const uint8_t *>(kKatMsg), strlen(kKatMsg));
    swarm_crypto_sha256_finish(h, hash);
    r.p256 = swarm_crypto_p256_verify(kKatPublic, hash, kKatSig) == 0;
    hash[0] ^= 1;
    r.p256 &= swarm_crypto_p256_verify(kKatPublic, hash, kKatSig) != 0;
  }
  return r;
}

}  // namespace swarm_crypto
