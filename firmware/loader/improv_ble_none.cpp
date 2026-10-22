// The loader has no BLE (docs/design/ota.md "Loader"): the ~250 KB BLE controller +
// host don't fit next to a 2 MB+ app and a littlefs big enough for 2048-LED maps. Wi-Fi
// comes from the credentials the app stored (NVS ledmapper/ssid,pass) or the wired
// console's PROV line; this satisfies the transport's improv_ble.h seam with no-ops.
#include "improv_ble.h"

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
