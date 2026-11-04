// The LM_LINK (P4 player) build's stand-ins for what the front end owns
// (docs/design/p4-c6-split.md §2.1): BLE Improv, the TLS identity and its region, and
// OTA. main.cpp's LM_NETSTACK paths call these; on the P4 they report "not here".
// P4 OTA (its own A/B slots, the image relayed by the C6) is Phase C (§5.1).
#include <stddef.h>
#include <stdint.h>

#include "device_cert.h"
#include "improv_ble.h"
#include "ota_app.h"
#include "tls_region.h"

void improv_ble_begin(const char *, uint8_t) {}
void improv_ble_poll() {}
void improv_ble_set_name(const char *) {}
bool improv_ble_take_credentials(char *, size_t, char *, size_t) { return false; }
bool improv_ble_central_connected() { return false; }
void improv_ble_request_disconnect() {}
extern "C" uint32_t ns_ble_state() { return 0; }
uint32_t improv_ble_last_acl_ms() { return 0; }
uint32_t improv_ble_conn_interval() { return 0; }
void improv_ble_set_state(uint8_t) {}
void improv_ble_set_error(uint8_t) {}
void improv_ble_send_redirect(const char *) {}
void player_ble_poll() {}
void player_ble_push(const uint8_t *, size_t) {}

namespace {
lm_cert::Machine g_cert;  // never leaves its boot state: no TLS listener on the P4
TlsRegionStats g_tls = {};
}  // namespace

void device_cert_begin(const char *, const DeviceCertStore *) {}
bool device_cert_poll(uint32_t) { return false; }
const lm_cert::Machine &device_cert_machine() { return g_cert; }
const uint8_t *device_cert_key_der(size_t *len) {
  *len = 0;
  return nullptr;
}
const uint8_t *device_cert_cert_der(size_t *len) {
  *len = 0;
  return nullptr;
}
void device_cert_release() {}
void device_cert_reject(uint32_t) {}
const char *device_cert_sha256() { return ""; }
uint32_t device_cert_gen_ms() { return 0; }

void tls_region_install() {}
const TlsRegionStats &tls_region_stats() { return g_tls; }

void ota_app_boot() {}
void ota_app_poll(bool, bool, bool) {}
bool ota_app_pending() { return false; }
int ota_app_dispatch(const uint8_t *, size_t, uint8_t *, size_t) { return 0; }
