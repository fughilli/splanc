// Per-device TLS identity: on-device EC P-256 keygen + self-signed cert, persisted in
// littlefs. See device_cert.h and docs/design/per-device-cert.md.
//
// Compiled against the ledmapper mbedtls config (BUILD: -DMBEDTLS_CONFIG_FILE=...),
// which turns on the X.509/PK writers the stock ESP config prunes. The writers are
// additive (no ssl-context struct change), so this TU links against the same
// from-source mbedtls the TLS server uses.
#include "device_cert.h"

#include <Arduino.h>
#include <esp_random.h>
#include <esp_timer.h>
#include <stdlib.h>
#include <string.h>

#include "mbedtls/asn1.h"
#include "mbedtls/ecp.h"
#include "mbedtls/oid.h"
#include "mbedtls/pk.h"
#include "mbedtls/platform_util.h"
#include "mbedtls/sha256.h"
#include "mbedtls/x509_crt.h"
#include "serial_log.h"

namespace {

lm_cert::Machine g_machine;
const DeviceCertStore *g_store = nullptr;
char g_id[24] = {0};
// The identity as one encoded blob (exactly what is persisted); key/cert point into it.
// Heap, not .bss: it lives only from boot until the TLS server has parsed its own
// copies (device_cert_release), so the steady state carries none of it.
uint8_t *g_blob = nullptr;
lm_cert::BlobView g_view;
char g_sha[65] = {0};
uint32_t g_gen_ms = 0;

int hw_rng(void *, unsigned char *buf, size_t len) {
  // The C6 RNG is a true RNG while the radio is on (BLE is up before we run; see
  // setup()), the same source mbedtls's own entropy poll uses.
  esp_fill_random(buf, len);
  return 0;
}

void set_sha(const uint8_t *cert, size_t len) {
  uint8_t d[32];
  mbedtls_sha256(cert, len, d, 0);
  lm_cert::hex_lower(d, sizeof d, g_sha);
}

// Adopt `blob` (already validated) as the live identity.
void adopt(uint8_t *blob, const lm_cert::BlobView &v) {
  free(g_blob);
  g_blob = blob;
  g_view = v;
  set_sha(v.cert, v.cert_len);
}

bool load() {
  if (g_store == nullptr || g_store->read == nullptr) return false;
  uint8_t *buf = static_cast<uint8_t *>(malloc(lm_cert::kMaxBlob + 1));
  if (buf == nullptr) return false;
  size_t n = g_store->read(buf, lm_cert::kMaxBlob + 1);
  if (n == 0) {
    Log().printf("[tls] no stored device identity (first boot / factory reset)\n");
    free(buf);
    return false;
  }
  lm_cert::BlobView v;
  lm_cert::BlobError e = lm_cert::decode_blob(buf, n, &v);
  if (e != lm_cert::BlobError::kOk) {
    Log().printf("[tls] stored device identity unusable (%s, %u B); regenerating\n",
                 lm_cert::blob_error_name(e), (unsigned)n);
    free(buf);
    return false;
  }
  adopt(buf, v);
  return true;
}

// Generate key + cert into a fresh blob. Returns 0 or an mbedtls error. `t0_us` is
// when the attempt started (esp_timer), so the blob records the keygen+sign time.
int generate(uint8_t **out_blob, size_t *out_len, int64_t t0_us) {
  int ret;
  mbedtls_pk_context key;
  mbedtls_x509write_cert crt;
  mbedtls_pk_init(&key);
  mbedtls_x509write_crt_init(&crt);
  uint8_t *scratch = static_cast<uint8_t *>(malloc(lm_cert::kMaxCertDer));
  uint8_t keyder[lm_cert::kMaxKeyDer];
  int klen = 0, clen = 0;
  char dn[64], san[32];
  uint8_t serial[16];
  if (scratch == nullptr) {
    ret = MBEDTLS_ERR_X509_ALLOC_FAILED;
    goto done;
  }

  // EC P-256: the curve the server's ECDHE_ECDSA suites already use (the old shared
  // cert was P-256 too), cheap on the C6's ECC accelerator.
  if ((ret = mbedtls_pk_setup(&key, mbedtls_pk_info_from_type(MBEDTLS_PK_ECKEY))) != 0) goto done;
  if ((ret = mbedtls_ecp_gen_key(MBEDTLS_ECP_DP_SECP256R1, mbedtls_pk_ec(key), hw_rng, nullptr)) != 0)
    goto done;
  klen = mbedtls_pk_write_key_der(&key, keyder, sizeof keyder);  // written at the END
  if (klen <= 0) {
    ret = klen < 0 ? klen : MBEDTLS_ERR_PK_BAD_INPUT_DATA;
    goto done;
  }

  snprintf(dn, sizeof dn, "CN=%s,O=splanc", g_id[0] ? g_id : "splanc-player");
  mbedtls_x509write_crt_set_version(&crt, MBEDTLS_X509_CRT_VERSION_3);
  mbedtls_x509write_crt_set_md_alg(&crt, MBEDTLS_MD_SHA256);
  mbedtls_x509write_crt_set_subject_key(&crt, &key);
  mbedtls_x509write_crt_set_issuer_key(&crt, &key);
  if ((ret = mbedtls_x509write_crt_set_subject_name(&crt, dn)) != 0) goto done;
  if ((ret = mbedtls_x509write_crt_set_issuer_name(&crt, dn)) != 0) goto done;
  // RANDOM serial: Firefox hard-fails (SEC_ERROR_REUSED_ISSUER_AND_SERIAL, no override)
  // when one issuer+serial maps to two different certs — exactly what a factory reset
  // would produce with a fixed serial and the same CN. Positive, 128 bits.
  esp_fill_random(serial, sizeof serial);
  serial[0] = (uint8_t)((serial[0] & 0x7f) | 0x40);
  if ((ret = mbedtls_x509write_crt_set_serial_raw(&crt, serial, sizeof serial)) != 0) goto done;
  // The device has no RTC: validity is judged by the CLIENT's clock, so the window is
  // the device's working life. (Long-validity limits apply to publicly-trusted certs,
  // not to a self-signed identity the client pins.)
  if ((ret = mbedtls_x509write_crt_set_validity(&crt, "20250101000000", "20491231235959")) != 0)
    goto done;
  if ((ret = mbedtls_x509write_crt_set_basic_constraints(&crt, 0, -1)) != 0) goto done;
  if ((ret = mbedtls_x509write_crt_set_key_usage(&crt, MBEDTLS_X509_KU_DIGITAL_SIGNATURE)) != 0)
    goto done;
  {
    mbedtls_asn1_sequence eku = {};
    eku.buf.tag = MBEDTLS_ASN1_OID;
    eku.buf.p = (unsigned char *)MBEDTLS_OID_SERVER_AUTH;
    eku.buf.len = MBEDTLS_OID_SIZE(MBEDTLS_OID_SERVER_AUTH);
    if ((ret = mbedtls_x509write_crt_set_ext_key_usage(&crt, &eku)) != 0) goto done;
  }
  // SAN: DNS:<mdns-host>.local only. Browsers ignore CN, so a SAN must exist; an IP SAN
  // would have to be re-issued on every DHCP change (the vendor build's
  // reissue_cert_for_lan race) and would rotate the pinned hash. The MAC-derived mDNS
  // name never changes.
  if (!lm_cert::san_dns_name(g_id, san, sizeof san)) {
    ret = MBEDTLS_ERR_X509_BAD_INPUT_DATA;
    goto done;
  }
  {
    mbedtls_x509_san_list sans = {};
    sans.node.type = MBEDTLS_X509_SAN_DNS_NAME;
    sans.node.san.unstructured_name.p = (unsigned char *)san;
    sans.node.san.unstructured_name.len = strlen(san);
    if ((ret = mbedtls_x509write_crt_set_subject_alternative_name(&crt, &sans)) != 0) goto done;
  }
  clen = mbedtls_x509write_crt_der(&crt, scratch, lm_cert::kMaxCertDer, hw_rng, nullptr);
  if (clen <= 0) {
    ret = clen < 0 ? clen : MBEDTLS_ERR_X509_BAD_INPUT_DATA;
    goto done;
  }
  {
    uint8_t *blob = static_cast<uint8_t *>(malloc(lm_cert::kMaxBlob));
    if (blob == nullptr) {
      ret = MBEDTLS_ERR_X509_ALLOC_FAILED;
      goto done;
    }
    size_t bn = lm_cert::encode_blob(keyder + sizeof keyder - klen, (size_t)klen,
                                     scratch + lm_cert::kMaxCertDer - clen, (size_t)clen, blob,
                                     lm_cert::kMaxBlob,
                                     (uint32_t)((esp_timer_get_time() - t0_us) / 1000));
    if (bn == 0) {
      free(blob);
      ret = MBEDTLS_ERR_X509_BUFFER_TOO_SMALL;
      goto done;
    }
    *out_blob = blob;
    *out_len = bn;
    ret = 0;
  }

done:
  mbedtls_platform_zeroize(keyder, sizeof keyder);
  mbedtls_x509write_crt_free(&crt);
  mbedtls_pk_free(&key);
  free(scratch);
  return ret;
}

// One generation attempt: keygen + sign + persist. Feeds the machine.
void attempt(uint32_t now_ms) {
  int64_t t0 = esp_timer_get_time();
  uint8_t *blob = nullptr;
  size_t bn = 0;
  int ret = generate(&blob, &bn, t0);
  uint32_t gen_ms = (uint32_t)((esp_timer_get_time() - t0) / 1000);
  if (ret != 0) {
    Log().printf("[tls] device identity generation FAILED: -0x%04X after %u ms (heap=%u); "
                 "retrying, :443 stays closed\n",
                 (unsigned)-ret, (unsigned)gen_ms, (unsigned)esp_get_free_heap_size());
    g_machine.on_generated(false, false, now_ms);
    return;
  }
  lm_cert::BlobView v;
  lm_cert::decode_blob(blob, bn, &v);  // just encoded: cannot fail
  adopt(blob, v);
  g_gen_ms = gen_ms;
  int64_t t1 = esp_timer_get_time();
  bool persisted = g_store != nullptr && g_store->write != nullptr && g_store->write(blob, bn);
  uint32_t write_ms = (uint32_t)((esp_timer_get_time() - t1) / 1000);
  g_machine.on_generated(true, persisted, now_ms);
  Log().printf("[tls] generated per-device identity in %u ms (keygen+sign), persist=%s in %u ms "
               "(%u B); cert sha256=%s\n",
               (unsigned)gen_ms, persisted ? "ok" : "FAILED (RAM-only this boot)",
               (unsigned)write_ms, (unsigned)bn, g_sha);
}

}  // namespace

void device_cert_begin(const char *id, const DeviceCertStore *store) {
  g_store = store;
  strncpy(g_id, id ? id : "", sizeof g_id - 1);
  int64_t t0 = esp_timer_get_time();
  bool loaded = load();
  uint32_t now = millis();
  g_machine.on_boot(loaded, now);
  if (loaded) {
    Log().printf("[tls] loaded per-device identity in %u ms (first-boot keygen+sign took %u ms); "
                 "cert sha256=%s\n",
                 (unsigned)((esp_timer_get_time() - t0) / 1000), (unsigned)g_view.gen_ms, g_sha);
    return;
  }
  attempt(now);
}

bool device_cert_poll(uint32_t now_ms) {
  if (!g_machine.due(now_ms)) return false;
  attempt(now_ms);
  return g_machine.listener_allowed();
}

const lm_cert::Machine &device_cert_machine() { return g_machine; }

const uint8_t *device_cert_key_der(size_t *len) {
  *len = g_blob ? g_view.key_len : 0;
  return g_blob ? g_view.key : nullptr;
}

const uint8_t *device_cert_cert_der(size_t *len) {
  *len = g_blob ? g_view.cert_len : 0;
  return g_blob ? g_view.cert : nullptr;
}

void device_cert_release() {
  if (g_blob != nullptr) {
    mbedtls_platform_zeroize(g_blob, lm_cert::kHeaderLen + g_view.key_len);
    free(g_blob);
  }
  g_blob = nullptr;
  g_view = lm_cert::BlobView();
}

void device_cert_reject(uint32_t now_ms) {
  Log().printf("[tls] device identity rejected by mbedtls; regenerating\n");
  device_cert_release();
  g_sha[0] = 0;
  g_machine.on_install_failed(now_ms);
}

const char *device_cert_sha256() { return g_machine.listener_allowed() ? g_sha : ""; }

uint32_t device_cert_gen_ms() { return g_gen_ms; }
